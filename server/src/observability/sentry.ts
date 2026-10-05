import * as Sentry from '@sentry/hono/node';
import { scrubEvent } from './scrub.js';

type SentryEnv = Partial<Record<'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'SENTRY_RELEASE' | 'GIT_SHA' | 'NODE_ENV', string>>;

/**
 * Sentry (GlitchTip) options from the environment, or null when no DSN is set
 * — in which case nothing is initialized and the app behaves exactly as it
 * did without error reporting.
 */
export function buildSentryOptions(env: SentryEnv): Sentry.NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;

  // The image exports GIT_SHA, not SENTRY_RELEASE: the SDK auto-reads
  // SENTRY_RELEASE whenever `release` is undefined, so exporting the "dev"
  // default under that name would tag every local build as one release.
  // SENTRY_RELEASE remains an explicit operator override.
  const release = [env.SENTRY_RELEASE, env.GIT_SHA].find((v) => v && v !== 'dev');

  return {
    dsn,
    release,
    environment: env.SENTRY_ENVIRONMENT || (env.NODE_ENV === 'production' ? 'production' : 'development'),
    // Errors only. GlitchTip gets no performance data from us.
    tracesSampleRate: 0,
    // v11 replaced sendDefaultPii with dataCollection, and every field in it
    // defaults to collecting. Turn each one off explicitly: beforeSend strips
    // most of this from the wire, but none of it should be held at all —
    // httpBodies would otherwise keep up to 10 KB of every incoming body (the
    // login password, later scanned PDFs) on the request scope.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    includeLocalVariables: false,
    // The module hooks exist to auto-instrument imports for tracing, which is
    // off. Registering them anyway would put a Module.registerHooks
    // resolve/load layer (v10: import-in-the-middle via registerEsmLoaderHooks)
    // between tsx and the Drive SDK's raw-.ts crypto peer for no benefit.
    enableRuntimeChannelInjection: false,
    // Tracing is off, but the SDK still stamps sentry-trace/baggage (public
    // key, release, environment) on every outgoing request unless told not
    // to. Proton and Anthropic have no business receiving them.
    tracePropagationTargets: [],
    integrations: [
      // The SDK's default ('warn') installs an unhandledRejection listener
      // that only logs, which disables Node's crash-on-unhandled-rejection.
      // Keep the crash: report, then exit, as the process did before Sentry.
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
    ],
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
