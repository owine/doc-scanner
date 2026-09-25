import * as Sentry from '@sentry/browser';
import { scrubEvent } from './scrub.js';

type SentryEnv = Partial<Record<'VITE_SENTRY_DSN' | 'VITE_SENTRY_ENVIRONMENT' | 'VITE_SENTRY_RELEASE' | 'MODE', string>>;

/**
 * Browser Sentry (GlitchTip) options from build-time Vite env, or null when
 * no DSN was baked in — then nothing initializes and the PWA is unchanged.
 */
export function buildSentryOptions(env: SentryEnv): Sentry.BrowserOptions | null {
  const dsn = env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return null;

  const release = env.VITE_SENTRY_RELEASE && env.VITE_SENTRY_RELEASE !== 'dev' ? env.VITE_SENTRY_RELEASE : undefined;

  return {
    dsn,
    release,
    environment: env.VITE_SENTRY_ENVIRONMENT || env.MODE || 'production',
    // Errors only: no tracing integration and no replay are added, and this
    // keeps tracing off even if one ever were.
    tracesSampleRate: 0,
    // Never stamp sentry-trace/baggage on outgoing requests.
    tracePropagationTargets: [],
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
  };
}

/** Initializes Sentry when a DSN was set at build time. Returns whether it did. */
export function initSentry(env: SentryEnv = import.meta.env): boolean {
  const options = buildSentryOptions(env);
  if (!options) return false;
  Sentry.init(options);
  return true;
}

/**
 * Reports a failed API request the user opted in to (see api.ts `reportAs`).
 * Only the endpoint path, the failure kind and the status are attached; the
 * request body (a scanned PDF, once uploads exist) never is.
 */
export function captureRequestFailure(
  error: unknown,
  details: { operation: string; path: string; failure: 'network' | 'http'; status?: number },
): void {
  Sentry.withScope((scope) => {
    scope.setTags({
      'api.operation': details.operation,
      'api.path': details.path,
      'api.failure': details.failure,
      // Offline failures are real (the scan did not upload) but are a
      // different problem from a server outage; make them filterable.
      'network.online': String(navigator.onLine),
    });
    if (details.status !== undefined) scope.setTag('api.status', String(details.status));
    Sentry.captureException(error);
  });
}
