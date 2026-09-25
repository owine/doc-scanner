import * as Sentry from '@sentry/hono/node';
import type { Event } from '@sentry/hono/node';
import { buildSentryOptions } from '../../src/observability/sentry.js';

/**
 * Initializes Sentry with the app's real options (scrubber included) but a
 * transport that records events instead of sending them. Sentry state is
 * process-global, so call this once per test file; vitest isolates files.
 */
export function initRecordingSentry(): { events: Event[] } {
  const events: Event[] = [];
  const options = buildSentryOptions({ SENTRY_DSN: 'https://public@glitchtip.example.test/1' });
  if (!options) throw new Error('expected options for a non-empty DSN');

  Sentry.init({
    ...options,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === 'event') events.push(payload as Event);
        }
        return {};
      },
      flush: async () => true,
    }),
  });

  return { events };
}

/** Waits for queued events to reach the recording transport. */
export async function flushEvents(): Promise<void> {
  await Sentry.flush(1000);
}
