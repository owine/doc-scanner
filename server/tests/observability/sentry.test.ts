import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Sentry from '@sentry/hono/node';
import { buildSentryOptions, initSentry } from '../../src/observability/sentry.js';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';

const DSN = 'https://public@glitchtip.example.test/1';

describe('buildSentryOptions', () => {
  it('returns null when SENTRY_DSN is unset', () => {
    expect(buildSentryOptions({})).toBeNull();
  });

  it('returns null when SENTRY_DSN is empty or whitespace', () => {
    expect(buildSentryOptions({ SENTRY_DSN: '' })).toBeNull();
    expect(buildSentryOptions({ SENTRY_DSN: '   ' })).toBeNull();
  });

  it('takes release and environment from the environment', () => {
    const options = buildSentryOptions({
      SENTRY_DSN: DSN,
      SENTRY_RELEASE: '0123abcd',
      SENTRY_ENVIRONMENT: 'staging',
    });

    expect(options).toMatchObject({ dsn: DSN, release: '0123abcd', environment: 'staging' });
  });

  it('uses GIT_SHA (what the image exports) when SENTRY_RELEASE is not set', () => {
    expect(buildSentryOptions({ SENTRY_DSN: DSN, GIT_SHA: 'feedface' })?.release).toBe('feedface');
    expect(buildSentryOptions({ SENTRY_DSN: DSN, GIT_SHA: 'dev' })?.release).toBeUndefined();
    expect(buildSentryOptions({ SENTRY_DSN: DSN, GIT_SHA: 'feedface', SENTRY_RELEASE: 'override' })?.release).toBe('override');
  });

  it('falls back to NODE_ENV for the environment', () => {
    expect(buildSentryOptions({ SENTRY_DSN: DSN, NODE_ENV: 'production' })?.environment).toBe('production');
    expect(buildSentryOptions({ SENTRY_DSN: DSN })?.environment).toBe('development');
  });

  it('leaves release unset when SENTRY_RELEASE is absent or the Docker default', () => {
    expect(buildSentryOptions({ SENTRY_DSN: DSN })?.release).toBeUndefined();
    expect(buildSentryOptions({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'dev' })?.release).toBeUndefined();
  });

  it('disables tracing, default PII and local-variable capture', () => {
    const options = buildSentryOptions({ SENTRY_DSN: DSN });

    expect(options).toMatchObject({
      tracesSampleRate: 0,
      sendDefaultPii: false,
      includeLocalVariables: false,
    });
  });

  it('does not register the ESM loader hooks (nothing to trace; tsx owns loading)', () => {
    expect(buildSentryOptions({ SENTRY_DSN: DSN })?.registerEsmLoaderHooks).toBe(false);
  });

  it('wires the scrubber in as beforeSend', () => {
    const beforeSend = buildSentryOptions({ SENTRY_DSN: DSN })?.beforeSend;

    const out = beforeSend?.(
      { type: undefined, request: { url: 'https://x.test/a?t=1', data: 'SECRET' } },
      {},
    ) as Sentry.ErrorEvent;

    expect(JSON.stringify(out)).not.toContain('SECRET');
  });
});

describe('initSentry without a DSN', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('does not initialize a client', () => {
    expect(initSentry({ SENTRY_DSN: '' })).toBe(false);
    expect(Sentry.isInitialized()).toBe(false);
  });

  it('leaves createApp exactly as before: no Sentry middleware, no warnings', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { db, cleanup } = createTestDb();
    try {
      initSentry({});
      const app = createApp({ db, encryptionKey: Buffer.alloc(32, 1).toString('base64') });

      const res = await app.request('/api/health');

      expect(res.status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
