import type { DB } from '../db.js';
import type { Analyzer } from '../analyze/analyzer.js';
import type { LiveSession } from '../auth/live-session.js';
import type { FolderCacheStore } from '../drive/folder-cache-store.js';
import type { DocumentStage } from '../observability/report.js';
import type { EffectiveSettings, SettingsStore } from '../settings/settings-store.js';
import type { InboxStore } from './inbox-store.js';
import type { DocumentRepo } from './repo.js';

/** Everything the stages and the worker need, injected so tests can fake it. */
export interface PipelineDeps {
  db: DB;
  repo: DocumentRepo;
  inbox: InboxStore;
  settings: SettingsStore;
  folderCache: FolderCacheStore;
  analyzerFor: (settings: EffectiveSettings) => Analyzer;
  liveSession: () => LiveSession | undefined;
  now: () => Date;
  report: (error: unknown, stage: DocumentStage, sensitive: readonly string[]) => void;
}

/** What a stage sees: the deps plus the worker's folder-cache refresh. */
export interface StageContext extends PipelineDeps {
  refreshFolderCache: () => Promise<void>;
}
