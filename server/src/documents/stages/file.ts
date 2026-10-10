import { createHash } from 'node:crypto';
import { ServerError } from '@protontech/drive-sdk';
import { FolderNameTakenError } from '../../drive/client.js';
import { logger } from '../../logger.js';
import { errorName } from '../../observability/error-name.js';
import type { StageContext } from '../deps.js';
import { extensionFor } from '../extension.js';
import type { Decision, DocumentRow } from '../types.js';

/**
 * DriveHttpClient already refreshes the access token on a 401 and replays the
 * request, so a 401 that still reaches the SDK means the refresh token is
 * dead too: only a new login helps. (Ported from the Phase 5 upload route.)
 */
function isAuthExpired(err: unknown): boolean {
  return err instanceof ServerError && (err.statusCode === 401 || err.code === 401);
}

const KEEP_GOING = { ignorePendingDiscard: true } as const;

type Drive = NonNullable<ReturnType<StageContext['liveSession']>>['driveClient'];

/**
 * Files a decided document: resolves (or creates) the folder, uploads, and
 * records the result. Crash-safe: a created folder's uid and the upload
 * target are saved before the steps that depend on them, and a re-run first
 * looks for a file it already uploaded (same SHA-1) before uploading again.
 * Once filing has started it runs to completion even if a discard arrives:
 * an upload can't be taken back.
 */
export async function fileStage(doc: DocumentRow, ctx: StageContext): Promise<void> {
  const live = ctx.liveSession();
  if (!live) {
    // A pending discard can't apply once filing_target is set (the upload may
    // have happened), and the row would stay workable in 'filing' with nothing
    // to move it on. Park it like an expired session: from awaiting_login the
    // user can discard again.
    if (!ctx.repo.transition(doc.id, 'filing', 'awaiting_login') && !ctx.repo.applyRequestedDiscard(doc.id)) {
      ctx.repo.transition(doc.id, 'filing', 'awaiting_login', { discardRequested: false }, KEEP_GOING);
    }
    return;
  }
  if (!doc.decision) {
    ctx.repo.transition(doc.id, 'filing', 'needs_review', { reviewReason: 'nothing decided to file', discardRequested: false }, KEEP_GOING);
    return;
  }
  const drive = live.driveClient;

  try {
    const { folderLinkId, folderPath } = await resolveFolder(doc.id, doc.decision, ctx, drive);

    const kind = ctx.inbox.has(doc.id, 'prepared') ? 'prepared' : 'original';
    const bytes = ctx.inbox.get(doc.id, kind);
    // The type of the blob actually sent: a recorded prepared type without its blob doesn't apply.
    const mime = kind === 'prepared' ? (doc.preparedMime ?? doc.mime) : doc.mime;
    const fileName = doc.decision.name + extensionFor(mime, doc.originalName);
    const sha1 = createHash('sha1').update(bytes).digest('hex');

    let uploaded: { nodeUid: string; name: string } | null = null;
    // Only a target for this folder counts: one left by an earlier decision
    // (discarded, restored, approved elsewhere) says nothing about this upload.
    if (doc.filingTarget?.folderLinkId === folderLinkId) {
      const found = await drive.findFileBySha1(folderLinkId, sha1);
      if (found) uploaded = { nodeUid: found.uid, name: found.name };
    }
    if (!uploaded) {
      ctx.repo.transition(doc.id, 'filing', 'filing', { filingTarget: { folderLinkId, name: fileName } }, KEEP_GOING);
      const res = await drive.uploadFile(fileName, bytes, mime, { parentFolderUid: folderLinkId });
      uploaded = { nodeUid: res.nodeUid, name: res.name };
    }

    const filed = ctx.repo.transition(
      doc.id,
      'filing',
      'filed',
      {
        filedName: uploaded.name,
        filedFolderPath: folderPath,
        driveNodeUid: uploaded.nodeUid,
        discardRequested: false,
        error: null,
      },
      KEEP_GOING,
    );
    if (!filed) {
      // Something else moved the row; keep its blob for whatever state it is in now.
      logger.warn({ documentId: doc.id }, 'document left filing before it could be marked filed');
      return;
    }
    // From here the document is filed: nothing may throw into the worker's
    // retry path, which would only upload it again.
    const filedRef = { nodeUid: uploaded.nodeUid, name: uploaded.name };
    afterFiled(doc.id, 'could not write the filing audit entry', () => {
      ctx.db
        .prepare(`INSERT INTO audit_log (event, detail) VALUES ('document_filed', ?)`)
        .run(
          JSON.stringify({
            documentId: doc.id,
            driveNodeUid: filedRef.nodeUid,
            source: doc.source,
            autoFiled: doc.autoFiled,
            userEdited: doc.userEdited,
          }),
        );
    });
    // Plaintext first: a blob left behind by a failure here is reclaimed by the purge sweep.
    afterFiled(doc.id, 'could not delete the inbox copy of a filed document', () => ctx.inbox.deleteAll(doc.id));
    // The filed name joins that folder's recent names right away (spec §5:
    // edits teach the system). Best-effort: the next tree walk catches up.
    afterFiled(doc.id, 'could not add the filed name to the folder cache', () =>
      ctx.folderCache.recordFiled(folderLinkId, { uid: filedRef.nodeUid, name: filedRef.name, modified: ctx.now() }),
    );
    logger.info({ documentId: doc.id, autoFiled: doc.autoFiled, userEdited: doc.userEdited }, 'document filed');
  } catch (err) {
    if (err instanceof FolderNameTakenError) {
      // Retrying can't help: something else owns the name. Ask the user.
      ctx.repo.transition(
        doc.id,
        'filing',
        'needs_review',
        { reviewReason: 'a file or unreadable item already uses the new folder\'s name', discardRequested: false },
        KEEP_GOING,
      );
      return;
    }
    if (!isAuthExpired(err)) throw err;
    logger.warn({ documentId: doc.id }, 'proton session expired while filing; waiting for login');
    // Clears a pending discard too: from awaiting_login the user can discard again.
    ctx.repo.transition(doc.id, 'filing', 'awaiting_login', { discardRequested: false }, KEEP_GOING);
  }
}

async function resolveFolder(
  id: string,
  decision: Decision,
  ctx: StageContext,
  drive: Drive,
): Promise<{ folderLinkId: string; folderPath: string }> {
  const f = decision.folder;
  if (f.kind === 'existing') return { folderLinkId: f.linkId, folderPath: f.path };

  const folderPath = f.parentPath === '/' ? `/${f.name}` : `${f.parentPath}/${f.name}`;
  if (f.createdLinkId) return { folderLinkId: f.createdLinkId, folderPath };

  // Reuse a folder that already exists; createFolder throws FolderNameTakenError
  // when something the lookup can't see (a file, an unreadable item) owns the
  // name — fileStage turns that into a review with a clear reason.
  const createdLinkId = (await drive.findChildFolder(f.parentLinkId, f.name)) ?? (await drive.createFolder(f.parentLinkId, f.name));
  // Saved at once: a crash before upload must not create the folder again.
  ctx.repo.transition(id, 'filing', 'filing', { decision: { ...decision, folder: { ...f, createdLinkId } } }, KEEP_GOING);
  try {
    await ctx.refreshFolderCache();
  } catch (err) {
    logger.warn({ documentId: id, err: errorName(err) }, 'folder cache refresh failed');
  }
  return { folderLinkId: createdLinkId, folderPath };
}

/** Best-effort work after a document is filed: a failure is logged (fixed text), never thrown. */
function afterFiled(documentId: string, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn({ documentId, err: errorName(err) }, what);
  }
}
