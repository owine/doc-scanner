import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const config = loadConfig();
const app = new Hono();
app.get('/api/health', (c) => c.json({ ok: true }));
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'server listening');
});
