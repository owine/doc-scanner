import * as Sentry from '@sentry/hono/node';
import { scrubEvent } from './scrub.js';

type SentryEnv = Partial<Record<'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'SENTRY_RELEASE' | 'NODE_ENV', string>>;

/**
 * Sentry (GlitchTip) options from the environment, or null when no DSN is set
 * — in which case nothing is initialized and the app behaves exactly as it
 * did without error reporting.
 */
export function buildSentryOptions(env: SentryEnv): Sentry.NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;

  // The Dockerfile's GIT_SHA build arg defaults to "dev" for local builds;
  // tagging every local build as one release would merge unrelated code.
  const release = env.SENTRY_RELEASE && env.SENTRY_RELEASE !== 'dev' ? env.SENTRY_RELEASE : undefined;

  return {
    dsn,
    release,
    environment: env.SENTRY_ENVIRONMENT || (env.NODE_ENV === 'production' ? 'production' : 'development'),
    // Errors only. GlitchTip gets no performance data from us.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    includeLocalVariables: false,
    // The loader hooks exist to auto-instrument imports for tracing, which is
    // off. Registering them anyway would put import-in-the-middle between tsx
    // and the Drive SDK's raw-.ts crypto peer for no benefit.
    registerEsmLoaderHooks: false,
    beforeSend: (event) => scrubEvent(event),
  };
}

/** Initializes Sentry when a DSN is configured. Returns whether it did. */
export function initSentry(env: SentryEnv = process.env): boolean {
  const options = buildSentryOptions(env);
  if (!options) return false;
  Sentry.init(options);
  return true;
}
