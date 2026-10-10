import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _resetLiveSessions,
  disposeAllLiveSessions,
  getAnyLiveSession,
  onLiveSessionRegistered,
  registerLiveSession,
  type LiveSession,
} from '../../src/auth/live-session.js';
import { logger } from '../../src/logger.js';

const fake = (sid: string, dispose: () => void = () => {}) =>
  ({ sid, mailboxSecret: { dispose } }) as unknown as LiveSession;

const tick = () => new Promise((r) => setImmediate(r));

const offs: Array<() => void> = [];
const listen = (fn: (s: LiveSession) => void | Promise<unknown>) => {
  const off = onLiveSessionRegistered(fn);
  offs.push(off);
  return off;
};

beforeEach(() => _resetLiveSessions());
afterEach(() => {
  while (offs.length) offs.pop()!();
});

describe('live-session hooks', () => {
  it('returns the most recently registered session', () => {
    expect(getAnyLiveSession()).toBeUndefined();
    registerLiveSession(fake('a'));
    registerLiveSession(fake('b'));
    expect(getAnyLiveSession()?.sid).toBe('b');
  });

  it('re-registering an older sid makes it the most recent again', () => {
    registerLiveSession(fake('a'));
    registerLiveSession(fake('b'));
    registerLiveSession(fake('a'));
    expect(getAnyLiveSession()?.sid).toBe('a');
  });

  it('disposes the old secret when a different session replaces the same sid', () => {
    const dispose = vi.fn();
    registerLiveSession(fake('a', dispose));
    registerLiveSession(fake('a'));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose when the same object is registered again', () => {
    const dispose = vi.fn();
    const s = fake('a', dispose);
    registerLiveSession(s);
    registerLiveSession(s);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposeAllLiveSessions disposes every secret and leaves none', () => {
    const da = vi.fn();
    const db = vi.fn();
    registerLiveSession(fake('a', da));
    registerLiveSession(fake('b', db));
    disposeAllLiveSessions();
    expect(da).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    expect(getAnyLiveSession()).toBeUndefined();
  });

  it('notifies listeners on registration, and stops after unsubscribe', async () => {
    const fn = vi.fn();
    const off = listen(fn);
    registerLiveSession(fake('a'));
    await tick();
    off();
    registerLiveSession(fake('b'));
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a listener sees the new session via getAnyLiveSession', async () => {
    let seen: string | undefined;
    listen(() => {
      seen = getAnyLiveSession()?.sid;
    });
    registerLiveSession(fake('a'));
    await tick();
    expect(seen).toBe('a');
  });

  it('a throwing listener does not break registration or other listeners', async () => {
    const ok = vi.fn();
    listen(() => {
      throw new Error('boom');
    });
    listen(ok);
    expect(() => registerLiveSession(fake('a'))).not.toThrow();
    await tick();
    expect(getAnyLiveSession()?.sid).toBe('a');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('an async listener rejection is caught (no unhandled rejection)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      listen(async () => {
        throw new Error('async boom');
      });
      registerLiveSession(fake('a'));
      await tick();
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('logs a listener failure by its type only', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      listen(() => {
        throw new RangeError('/Private/Northwind Energy');
      });
      registerLiveSession(fake('a'));
      await tick();
      expect(warn).toHaveBeenCalledWith({ errName: 'RangeError' }, 'live-session listener failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Northwind');
    } finally {
      warn.mockRestore();
    }
  });
});
