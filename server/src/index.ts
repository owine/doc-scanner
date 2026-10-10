import './instrument.js';
import './polyfills/typed-array-base64.js';

import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { analyzerForClient, createPipeline } from './documents/pipeline.js';
import { createApp } from './http/server.js';
import { logger } from './logger.js';

const config = loadConfig();
mkdirSync(dirname(config.DB_PATH), { recursive: true });
const db = openDb(config.DB_PATH);

const pipeline = createPipeline({
  db,
  dataDir: dirname(config.DB_PATH),
  encryptionKey: config.SESSION_ENCRYPTION_KEY,
  defaults: {
    model: config.ANALYZER_MODEL,
    effort: config.ANALYZER_EFFORT,
    autoFileThreshold: config.AUTO_FILE_THRESHOLD,
    autoFileEnabled: config.AUTO_FILE_ENABLED,
    excludePaths: [],
  },
  analyzerFor: analyzerForClient(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })),
});

const app = createApp({
  db,
  pipeline,
  encryptionKey: config.SESSION_ENCRYPTION_KEY,
  secureCookie: !config.INSECURE_COOKIES,
  pwaDistPath: config.PWA_DIST_PATH,
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'server listening');
});

pipeline.start();
