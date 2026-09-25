import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/hono/node';
import { redactExact, scrubEvent } from '../../src/observability/scrub.js';

// Every test plants a recognisable secret and asserts it appears NOWHERE in
// the serialized event, not just that one field was cleared. A leak through
// a path the scrubber did not anticipate still fails the test.
function serialized(event: ErrorEvent | null): string {
  return JSON.stringify(event);
}

function baseEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: undefined,
    event_id: 'e1',
    exception: {
      values: [
        {
          type: 'Error',
          value: 'upload failed',
          stacktrace: {
            frames: [{ filename: '/app/server/src/drive/client.ts', function: 'uploadFile', lineno: 10 }],
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('scrubEvent', () => {
  it('removes the request body', () => {
    const event = baseEvent({
      request: {
        method: 'POST',
        url: 'https://scan.example.test/api/auth/login',
        data: '{"email":"me@example.test","password":"SECRET-PASSWORD"}',
      },
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-PASSWORD');
    expect(serialized(out)).not.toContain('me@example.test');
    expect(out?.request?.data).toBeUndefined();
    // The route itself is still useful and safe to keep.
    expect(out?.request?.method).toBe('POST');
    expect(out?.request?.url).toBe('https://scan.example.test/api/auth/login');
  });

  it('removes cookies from both the cookies field and the cookie header', () => {
    const event = baseEvent({
      request: {
        url: 'https://scan.example.test/api/drive/test-upload',
        cookies: { docscanner_sid: 'SECRET-SID' },
        headers: { cookie: 'docscanner_sid=SECRET-SID', 'set-cookie': 'docscanner_sid=SECRET-SID' },
      },
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-SID');
  });

  it('removes auth headers, including the Proton uid header', () => {
    const event = baseEvent({
      request: {
        url: 'https://scan.example.test/api/drive/test-upload',
        headers: {
          authorization: 'Bearer SECRET-ACCESS-TOKEN',
          'x-pm-uid': 'SECRET-PM-UID',
          'remote-user': 'SECRET-REMOTE-USER',
        },
      },
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-ACCESS-TOKEN');
    expect(serialized(out)).not.toContain('SECRET-PM-UID');
    expect(serialized(out)).not.toContain('SECRET-REMOTE-USER');
  });

  it('strips the query string, which can carry tokens', () => {
    const event = baseEvent({
      request: {
        url: 'https://scan.example.test/api/x?token=SECRET-QUERY#frag',
        query_string: 'token=SECRET-QUERY',
      },
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-QUERY');
    expect(out?.request?.url).toBe('https://scan.example.test/api/x');
  });

  it('removes Proton session tokens from extra and custom contexts', () => {
    const event = baseEvent({
      extra: {
        session: { uid: 'SECRET-UID', accessToken: 'SECRET-AT', refreshToken: 'SECRET-RT' },
        mailboxPassword: 'SECRET-MBX',
      },
      contexts: {
        proton: { AccessToken: 'SECRET-AT2', RefreshToken: 'SECRET-RT2', UID: 'SECRET-UID2' },
      },
    });

    const out = scrubEvent(event);

    for (const secret of ['SECRET-UID', 'SECRET-AT', 'SECRET-RT', 'SECRET-MBX', 'SECRET-AT2', 'SECRET-RT2', 'SECRET-UID2']) {
      expect(serialized(out)).not.toContain(secret);
    }
  });

  it('removes bearer tokens embedded in free text', () => {
    const event = baseEvent({
      message: 'request failed with Authorization: Bearer SECRET-INLINE-TOKEN',
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-INLINE-TOKEN');
  });

  it('removes file contents: binary values and data URLs', () => {
    const event = baseEvent({
      extra: {
        pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        buffer: Buffer.from('SECRET-FILE-BYTES'),
        preview: 'data:image/jpeg;base64,U0VDUkVULUlNQUdF',
      },
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-FILE-BYTES');
    expect(serialized(out)).not.toContain('U0VDUkVULUlNQUdF');
    // Uint8Array serializes as {"0":37,...}; the raw bytes must be gone too.
    expect(serialized(out)).not.toContain('"0":37');
  });

  it('removes filenames from exception messages and extra', () => {
    const event = baseEvent({
      exception: {
        values: [
          {
            type: 'Error',
            value: 'A file named "2026 Tax Return SSN.pdf" already exists',
            stacktrace: {
              frames: [{ filename: '/app/server/src/drive/client.ts', function: 'uploadFile' }],
            },
          },
        ],
      },
      extra: { filename: 'Medical Records.jpg', name: 'Bank Statement' },
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('Tax Return');
    expect(serialized(out)).not.toContain('Medical Records');
    expect(serialized(out)).not.toContain('Bank Statement');
  });

  it('redacts email addresses embedded in exception messages', () => {
    const event = baseEvent({
      exception: { values: [{ type: 'KeyDecryptError', value: 'Failed to decrypt any address key for jane.doe@proton.me' }] },
      message: 'No address matching jane+scans@pm.me',
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('jane');
    expect(out?.exception?.values?.[0]?.value).toBe('Failed to decrypt any address key for [email]');
  });

  it('redacts a bare filename without swallowing the rest of the message', () => {
    const out = scrubEvent(baseEvent({ message: 'upload failed for payslip_march.pdf after 3 retries' }));

    expect(out?.message).toBe('upload failed for [filename] after 3 retries');
  });

  it('keeps source file paths in stack frames so grouping still works', () => {
    const out = scrubEvent(baseEvent());

    const frame = out?.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame?.filename).toBe('/app/server/src/drive/client.ts');
    expect(frame?.function).toBe('uploadFile');
  });

  it('drops local variables captured on stack frames', () => {
    const event = baseEvent({
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: {
              frames: [{ filename: '/app/x.ts', vars: { password: 'SECRET-LOCAL', bytes: 'SECRET-LOCAL-2' } }],
            },
          },
        ],
      },
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-LOCAL');
  });

  it('drops user data', () => {
    const out = scrubEvent(baseEvent({ user: { email: 'SECRET-EMAIL@example.test', ip_address: '10.9.8.7' } }));

    expect(serialized(out)).not.toContain('SECRET-EMAIL');
    expect(serialized(out)).not.toContain('10.9.8.7');
  });

  it('keeps only method, path and status on http breadcrumbs, and drops console breadcrumbs', () => {
    const event = baseEvent({
      breadcrumbs: [
        {
          category: 'http',
          type: 'http',
          data: {
            method: 'POST',
            url: 'https://drive-api.proton.me/drive/v2/blocks?Token=SECRET-BC-QUERY',
            status_code: 500,
            request_headers: { authorization: 'Bearer SECRET-BC-TOKEN' },
          },
        },
        { category: 'console', message: 'logged SECRET-CONSOLE' },
      ],
    });

    const out = scrubEvent(event);

    expect(serialized(out)).not.toContain('SECRET-BC-QUERY');
    expect(serialized(out)).not.toContain('SECRET-BC-TOKEN');
    expect(serialized(out)).not.toContain('SECRET-CONSOLE');
    expect(out?.breadcrumbs).toEqual([
      {
        category: 'http',
        type: 'http',
        data: { method: 'POST', url: 'https://drive-api.proton.me/drive/v2/blocks', status_code: 500 },
      },
    ]);
  });

  it('leaves the operation tags we set intact', () => {
    const out = scrubEvent(baseEvent({ tags: { 'drive.operation': 'upload' } }));

    expect(out?.tags).toEqual({ 'drive.operation': 'upload' });
  });
});

describe('redactExact', () => {
  function eventWith(value: string): ErrorEvent {
    return {
      type: undefined,
      tags: { 'drive.operation': 'upload' },
      message: `failed: ${value}`,
      exception: {
        values: [{ type: 'Error', value: `could not store ${value}`, stacktrace: { frames: [{ filename: '/app/server/src/upload.ts', function: 'upload' }] } }],
      },
    };
  }

  it('redacts the value from exception values and messages', () => {
    const out = redactExact(eventWith('Divorce Papers.pdf'), ['Divorce Papers.pdf']);

    expect(serialized(out)).not.toContain('Divorce');
  });

  it('also redacts the name without its extension, which the SDK may echo with a suffix', () => {
    const event = eventWith('Divorce Papers (2).pdf');

    const out = redactExact(event, ['Divorce Papers.pdf']);

    expect(serialized(out)).not.toContain('Divorce');
  });

  it('leaves tags and stack frames alone, so a common word as a name cannot break grouping', () => {
    const out = redactExact(eventWith('upload'), ['upload']);

    expect(out.tags).toEqual({ 'drive.operation': 'upload' });
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ filename: '/app/server/src/upload.ts', function: 'upload' });
    expect(out.exception?.values?.[0]?.value).toBe('could not store [filename]');
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
