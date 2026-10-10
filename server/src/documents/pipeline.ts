import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '../db.js';
import { createAnalyzer, type Analyzer } from '../analyze/analyzer.js';
import { getAnyLiveSession, onLiveSessionRegistered, type LiveSession } from '../auth/live-session.js';
import { AtRestCipher } from '../crypto/at-rest.js';
import { FolderCacheStore } from '../drive/folder-cache-store.js';
import { captureDocumentFailure } from '../observability/report.js';
import { SettingsStore, type EffectiveSettings } from '../settings/settings-store.js';
import { logger } from '../logger.js';
import { errorName } from '../observability/error-name.js';
import { InboxStore } from './inbox-store.js';
import { DocumentRepo } from './repo.js';
import { DocumentWorker } from './worker.js';

export interface PipelineOptions {
  db: DB;
  /** Directory beside the database; the inbox lives in `<dataDir>/inbox`. */
  dataDir: string;
  encryptionKey: string;
  defaults: EffectiveSettings;
  analyzerFor: (settings: EffectiveSettings) => Analyzer;
  liveSession?: () => LiveSession | undefined;
  now?: () => Date;
}

export interface Pipeline {
  repo: DocumentRepo;
  inbox: InboxStore;
  settings: SettingsStore;
  folderCache: FolderCacheStore;
  worker: DocumentWorker;
  /** Starts the worker's timers and subscribes it to logins. */
  start(): void;
  stop(): void;
}

/** An analyzer per settings snapshot, so a model or effort change applies to the next document. */
export function analyzerForClient(client: Pick<Anthropic, 'messages'>): (s: EffectiveSettings) => Analyzer {
  return (s) => createAnalyzer({ client, model: s.model, effort: s.effort, autoFileThreshold: s.autoFileThreshold });
}

export function createPipeline(o: PipelineOptions): Pipeline {
  const now = o.now ?? (() => new Date());
  const repo = new DocumentRepo(o.db, now);
  const inbox = new InboxStore(join(o.dataDir, 'inbox'), new AtRestCipher(o.encryptionKey, 'inbox'));
  const settings = new SettingsStore(o.db, o.defaults);
  const folderCache = new FolderCacheStore(o.db, new AtRestCipher(o.encryptionKey, 'folder-cache'));
  const worker = new DocumentWorker({
    db: o.db,
    repo,
    inbox,
    settings,
    folderCache,
    analyzerFor: o.analyzerFor,
    liveSession: o.liveSession ?? getAnyLiveSession,
    now,
    report: captureDocumentFailure,
  });
  let unsubscribe: (() => void) | null = null;
  return {
    repo,
    inbox,
    settings,
    folderCache,
    worker,
    start() {
      worker.start();
      unsubscribe = onLiveSessionRegistered(() => {
        worker.onLogin().catch((err: unknown) => logger.error({ errName: errorName(err) }, 'document worker failed after login'));
      });
    },
    stop() {
      worker.stop();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
