import type { FolderChoice } from '../../analyze/types.js';
import { toFolderContexts } from '../../drive/folder-tree.js';
import { logger } from '../../logger.js';
import type { StageContext } from '../deps.js';
import { currentAnchorFolder } from '../anchor.js';
import { folderPath } from '../folders.js';
import type { DocumentRow } from '../types.js';

/** How long to wait before looking again when no folder tree has been walked yet. */
const NO_TREE_RETRY_MS = 10 * 60_000;

/**
 * Asks Claude to read the document and propose a name and folder. Needs no
 * Proton keys, only the cached folder tree; with none yet (nobody has logged
 * in since the database was created), it waits — logging in walks the tree
 * and makes these due again.
 */
export async function analyzeStage(doc: DocumentRow, ctx: StageContext): Promise<void> {
  let cache = ctx.folderCache.load();
  if (!cache && ctx.liveSession()) {
    try {
      await ctx.refreshFolderCache();
    } catch {
      // Fixed text only: the error could quote folder names.
      logger.warn({ documentId: doc.id }, 'folder cache refresh failed');
    }
    cache = ctx.folderCache.load();
  }
  if (!cache) {
    // Back to 'received' so a row left in 'analyzing' by a crash does not sit there.
    ctx.repo.transition(doc.id, doc.state, 'received', { nextAttemptAt: new Date(ctx.now().getTime() + NO_TREE_RETRY_MS) });
    return;
  }
  if (doc.state === 'received' && !ctx.repo.transition(doc.id, 'received', 'analyzing')) {
    ctx.repo.applyRequestedDiscard(doc.id);
    return;
  }

  const settings = ctx.settings.get();
  const folders = toFolderContexts(cache.tree, { excludePaths: settings.excludePaths });
  // "File with" (spec §3): the folder is the anchor's as the tree has it now,
  // null if it has gone or become never-file-here since.
  const anchor = doc.anchor;
  const anchorFolder = anchor ? currentAnchorFolder(anchor, cache.tree, settings.excludePaths) : null;
  const started = Date.now();
  const outcome = await ctx.analyzerFor(settings).analyze(
    {
      bytes: ctx.inbox.get(doc.id, 'original'),
      mimeType: doc.mime,
      originalName: doc.originalName,
      source: doc.source,
      sourceContext: doc.sourceContext ?? undefined,
      // The snapshot's path when the folder is gone: the pairing name still helps.
      ...(anchor ? { anchor: { name: anchor.name, folderPath: folderPath(anchorFolder ?? anchor.folder) } } : {}),
    },
    folders,
  );
  logger.info(
    {
      documentId: doc.id,
      model: outcome.model,
      status: outcome.status,
      confidence: outcome.status === 'ok' ? outcome.analysis.confidence : undefined,
      anchored: anchor !== null,
      inputTokens: outcome.usage.input_tokens,
      cacheReadTokens: outcome.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: outcome.usage.cache_creation_input_tokens ?? 0,
      outputTokens: outcome.usage.output_tokens,
      durationMs: Date.now() - started,
    },
    'document analysed',
  );

  let moved: boolean;
  if (outcome.status === 'ok') {
    const { textSnippet: _unused, ...analysis } = outcome.analysis;
    // Pinned in code: the model only names a document filed with another.
    if (anchor) analysis.folder = anchorFolder;
    moved = ctx.repo.transition(doc.id, 'analyzing', 'preparing', {
      analysis,
      reviewReason: reanalysisReason(doc, anchorFolder),
      attempts: 0,
      error: null,
    });
  } else {
    // Still prepared, so the review card gets a thumbnail and the file its
    // text layer; decideStage then sends it to review with this reason.
    moved = ctx.repo.transition(doc.id, 'analyzing', 'preparing', {
      analysis: null,
      reviewReason: `analysis ${outcome.status}: ${outcome.detail}`,
      attempts: 0,
      error: null,
    });
  }
  if (!moved) ctx.repo.applyRequestedDiscard(doc.id);
}

/**
 * Why a re-analysed document goes to review whatever its confidence (the
 * user asked for it from review), or null for an ordinary one. Fixed text:
 * decideStage logs the reason as it is, and reasons never carry names.
 */
function reanalysisReason(doc: DocumentRow, anchorFolder: FolderChoice | null): string | null {
  if (doc.anchor) return anchorFolder ? 'filed with another document' : "the related document's folder is no longer available";
  return doc.reanalyzed ? 're-analyzed' : null;
}
