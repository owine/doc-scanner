import './polyfills/typed-array-base64.js';

import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './http/server.js';
import { logger } from './logger.js';

const config = loadConfig();
mkdirSync(dirname(config.DB_PATH), { recursive: true });
const db = openDb(config.DB_PATH);

const app = createApp({
  db,
  encryptionKey: config.SESSION_ENCRYPTION_KEY,
  secureCookie: !config.INSECURE_COOKIES,
  pwaDistPath: config.PWA_DIST_PATH,
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'server listening');
});
