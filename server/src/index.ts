import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { logger } from './logger.js';

const config = loadConfig();
mkdirSync(dirname(config.DB_PATH), { recursive: true });
const db = openDb(config.DB_PATH);
logger.info({ path: config.DB_PATH }, 'database opened');

const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'server listening');
});

void db;
