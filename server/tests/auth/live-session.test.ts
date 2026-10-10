import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _resetLiveSessions,
  getAnyLiveSession,
  onLiveSessionRegistered,
  registerLiveSession,
  type LiveSession,
} from '../../src/auth/live-session.js';

const fake = (sid: string) =>
  ({ sid, mailboxSecret: { dispose: () => {} } }) as unknown as LiveSession;

beforeEach(() => _resetLiveSessions());

describe('live-session hooks', () => {
  it('returns the most recently registered session', () => {
    expect(getAnyLiveSession()).toBeUndefined();
    registerLiveSession(fake('a'));
    registerLiveSession(fake('b'));
    expect(getAnyLiveSession()?.sid).toBe('b');
  });

  it('notifies listeners on registration, and stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = onLiveSessionRegistered(fn);
    registerLiveSession(fake('a'));
    off();
    registerLiveSession(fake('b'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not break registration', () => {
    onLiveSessionRegistered(() => {
      throw new Error('boom');
    });
    expect(() => registerLiveSession(fake('a'))).not.toThrow();
    expect(getAnyLiveSession()?.sid).toBe('a');
  });
});
