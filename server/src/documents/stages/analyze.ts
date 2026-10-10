import { toFolderContexts } from '../../drive/folder-tree.js';
import { logger } from '../../logger.js';
import type { StageContext } from '../deps.js';
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
  const started = Date.now();
  const outcome = await ctx.analyzerFor(settings).analyze(
    {
      bytes: ctx.inbox.get(doc.id, 'original'),
      mimeType: doc.mime,
      originalName: doc.originalName,
      source: doc.source,
      sourceContext: doc.sourceContext ?? undefined,
    },
    folders,
  );
  logger.info(
    {
      documentId: doc.id,
      model: outcome.model,
      status: outcome.status,
      confidence: outcome.status === 'ok' ? outcome.analysis.confidence : undefined,
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
    moved = ctx.repo.transition(doc.id, 'analyzing', 'preparing', { analysis, attempts: 0, error: null });
  } else {
    moved = ctx.repo.transition(doc.id, 'analyzing', 'needs_review', { reviewReason: `analysis ${outcome.status}: ${outcome.detail}`, attempts: 0, error: null });
  }
  if (!moved) ctx.repo.applyRequestedDiscard(doc.id);
}
