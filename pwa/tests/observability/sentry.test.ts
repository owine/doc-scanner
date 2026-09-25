import { describe, it, expect } from 'vitest';
import * as Sentry from '@sentry/browser';
import { buildSentryOptions, initSentry } from '../../src/observability/sentry.js';

const DSN = 'https://public@glitchtip.example.test/2';

describe('buildSentryOptions (PWA)', () => {
  it('returns null when VITE_SENTRY_DSN is unset, empty or whitespace', () => {
    expect(buildSentryOptions({})).toBeNull();
    expect(buildSentryOptions({ VITE_SENTRY_DSN: '' })).toBeNull();
    expect(buildSentryOptions({ VITE_SENTRY_DSN: '  ' })).toBeNull();
  });

  it('takes release and environment from build-time env', () => {
    expect(buildSentryOptions({ VITE_SENTRY_DSN: DSN, VITE_SENTRY_RELEASE: 'abc123', VITE_SENTRY_ENVIRONMENT: 'staging' }))
      .toMatchObject({ dsn: DSN, release: 'abc123', environment: 'staging' });
  });

  it('falls back to the Vite mode for environment and drops the "dev" release placeholder', () => {
    const options = buildSentryOptions({ VITE_SENTRY_DSN: DSN, VITE_SENTRY_RELEASE: 'dev', MODE: 'production' });

    expect(options?.environment).toBe('production');
    expect(options?.release).toBeUndefined();
  });

  it('disables tracing and default PII', () => {
    expect(buildSentryOptions({ VITE_SENTRY_DSN: DSN })).toMatchObject({ tracesSampleRate: 0, sendDefaultPii: false });
  });

  it('wires the scrubber in as beforeSend', () => {
    const beforeSend = buildSentryOptions({ VITE_SENTRY_DSN: DSN })?.beforeSend;

    const out = beforeSend?.({ type: undefined, request: { url: 'https://x.test/?SECRET' } }, {}) as Sentry.ErrorEvent;

    expect(JSON.stringify(out)).not.toContain('SECRET');
  });
});

describe('initSentry without a DSN (PWA)', () => {
  it('does not initialize a client', () => {
    expect(initSentry({ VITE_SENTRY_DSN: '' })).toBe(false);
    expect(Sentry.isInitialized()).toBe(false);
  });
});
