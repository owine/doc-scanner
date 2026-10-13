import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions } from '../../src/auth/live-session.js';
import { CRED, PRF_B64, SESSION, authApp, post, seedPasskey, type AuthApp } from '../helpers/auth-app.js';

const { events } = initRecordingSentry();

let ctx: AuthApp | null = null;
beforeEach(() => {
  events.length = 0;
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  vi.restoreAllMocks();
});

describe('POST /api/auth/unlock failure reporting', () => {
  it('reports a TypeError that is not a network failure, and answers 500', async () => {
    ctx = authApp();
    ctx.store.save(SESSION);
    seedPasskey(ctx.passkeys);
    ctx.auth.resume.mockRejectedValue(new TypeError('x'));
    const res = await post(ctx.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 });
    await flushEvents();
    expect(res.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({ 'auth.operation': 'unlock', 'auth.stage': 'keys' });
  });

  it('does not report a network failure, which answers 503', async () => {
    ctx = authApp();
    ctx.store.save(SESSION);
    seedPasskey(ctx.passkeys);
    ctx.auth.resume.mockRejectedValue(new TypeError('fetch failed'));
    const res = await post(ctx.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 });
    await flushEvents();
    expect(res.status).toBe(503);
    expect(events).toHaveLength(0);
  });
});
