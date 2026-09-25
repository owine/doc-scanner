import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/browser';
import { scrubEvent } from '../../src/observability/scrub.js';

// Mirrors server/tests/observability/scrub.test.ts: plant a secret, assert it
// appears nowhere in the serialized event.
function wire(event: ErrorEvent | null): string {
  return JSON.stringify(event);
}

function baseEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: undefined,
    exception: {
      values: [{ type: 'Error', value: 'upload failed', stacktrace: { frames: [{ filename: 'https://scan.example.test/assets/index-abc.js', function: 'request' }] } }],
    },
    ...overrides,
  };
}

describe('scrubEvent (PWA)', () => {
  it('keeps only the page path from the request, dropping headers and query', () => {
    const out = scrubEvent(baseEvent({
      request: {
        url: 'https://scan.example.test/scans?token=SECRET-QUERY',
        headers: { Referer: 'https://scan.example.test/?SECRET-REFERER', 'User-Agent': 'x', Cookie: 'docscanner_sid=SECRET-SID' },
        data: 'SECRET-BODY',
      },
    }));

    for (const s of ['SECRET-QUERY', 'SECRET-REFERER', 'SECRET-SID', 'SECRET-BODY']) expect(wire(out)).not.toContain(s);
    expect(out?.request).toEqual({ url: 'https://scan.example.test/scans' });
  });

  it('removes image data: data URLs and binary values', () => {
    const out = scrubEvent(baseEvent({
      message: 'failed to load data:image/jpeg;base64,U0VDUkVUSU1H',
      extra: { page: new Uint8Array([1, 2, 3]), blob: new Blob(['SECRET-BLOB']), thumb: 'data:image/png;base64,U0VDUkVUUE5H' },
    }));

    for (const s of ['U0VDUkVUSU1H', 'U0VDUkVUUE5H', '"0":1']) expect(wire(out)).not.toContain(s);
  });

  it('removes filenames and document names', () => {
    const out = scrubEvent(baseEvent({
      exception: { values: [{ type: 'Error', value: 'could not save "Lease Agreement.pdf"' }] },
      extra: { filename: 'Passport.jpg', name: 'Insurance card', finalName: 'Payslip' },
    }));

    for (const s of ['Lease Agreement', 'Passport', 'Insurance card', 'Payslip']) expect(wire(out)).not.toContain(s);
  });

  it('redacts email addresses embedded in messages', () => {
    const out = scrubEvent(baseEvent({ exception: { values: [{ type: 'Error', value: 'login failed for jane.doe@proton.me' }] } }));

    expect(out?.exception?.values?.[0]?.value).toBe('login failed for [email]');
  });

  it('removes credentials and tokens from extra', () => {
    const out = scrubEvent(baseEvent({ extra: { password: 'SECRET-PW', totp: 'SECRET-TOTP', email: 'SECRET@example.test' } }));

    for (const s of ['SECRET-PW', 'SECRET-TOTP', 'SECRET@example.test']) expect(wire(out)).not.toContain(s);
  });

  it('drops user data', () => {
    const out = scrubEvent(baseEvent({ user: { ip_address: '10.1.2.3', email: 'SECRET@example.test' } }));

    expect(wire(out)).not.toContain('10.1.2.3');
    expect(wire(out)).not.toContain('SECRET@example.test');
  });

  it('keeps fetch breadcrumbs as method/url/status only and drops console and ui text', () => {
    const out = scrubEvent(baseEvent({
      breadcrumbs: [
        { category: 'fetch', type: 'http', data: { method: 'POST', url: '/api/upload?x=SECRET-BC', status_code: 502, request_body_size: 123 } },
        { category: 'console', message: 'SECRET-CONSOLE' },
        { category: 'ui.input', message: 'input[name="password"]' },
        { category: 'navigation', data: { from: '/scans?SECRET-FROM', to: '/login?SECRET-TO' } },
      ],
    }));

    for (const s of ['SECRET-BC', 'SECRET-CONSOLE', 'SECRET-FROM', 'SECRET-TO']) expect(wire(out)).not.toContain(s);
    expect(out?.breadcrumbs?.[0]).toEqual({ category: 'fetch', type: 'http', data: { method: 'POST', url: '/api/upload', status_code: 502 } });
    expect(out?.breadcrumbs?.some((b) => b.category === 'ui.input')).toBe(false);
  });

  it('keeps our tags', () => {
    expect(scrubEvent(baseEvent({ tags: { 'api.operation': 'upload' } }))?.tags).toEqual({ 'api.operation': 'upload' });
  });
});

describe('scrubEvent on pathological input', () => {
  // Error messages can embed base64, PGP armor or a JSON body. beforeSend runs
  // synchronously on the main thread, so scrubbing must stay linear-ish.
  for (const [label, token] of [
    ['base64', 'QUJD'.repeat(25_000)],
    ['one long word', 'a'.repeat(100_000)],
    ['an @ with no TLD', `${'a'.repeat(50_000)}@${'a'.repeat(50_000)}`],
  ] as const) {
    it(`scrubs a 100 KB ${label} message quickly`, () => {
      const started = performance.now();
      scrubEvent({ type: undefined, message: token, exception: { values: [{ type: 'Error', value: token }] } });
      expect(performance.now() - started).toBeLessThan(100);
    });
  }

  it('stays fast at the worst case under the cap, where every pattern still runs', () => {
    const started = performance.now();
    scrubEvent({ type: undefined, message: '\u201c'.repeat(1999), extra: { note: 'a.p '.repeat(499) } });
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('redacts a quoted document name that straddles the cap, not just its tail', () => {
    const out = scrubEvent({ type: undefined, message: `${'pad '.repeat(495)}upload "Lease Agreement.pdf" failed` });

    expect(out?.message).not.toContain('Lease');
  });

  it('drops a token cut by the length cap, so no partial secret survives', () => {
    // The cap at 2000 chars falls two characters into the address ("ja").
    const out = scrubEvent({ type: undefined, message: `${'x '.repeat(999)}jane.doe@proton.me` });

    expect(out?.message).not.toContain('ja');
    expect(out?.message?.endsWith('x [truncated]')).toBe(true);
  });
});
