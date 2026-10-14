import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { StatusResponse, UnlockCredential } from '../../api.js';
import { unlockClient, type UnlockClient } from '../../auth/flows.js';

export interface LockedBannerProps {
  /** Passkeys that can unlock; with none, the banner only offers a Proton sign-in. */
  passkeys: number;
  onUnlocked: (status: StatusResponse) => void;
  /** Opens the sign-in-to-Proton screen. */
  onSignIn: () => void;
  /** The server changed the Proton state or the passkeys (a refusal that cleared something), with its code. */
  onStatusChanged?: (code: string) => void;
  client?: UnlockClient;
}

type Problem = 'retry' | 'unavailable' | 'no_prf' | 'login_required' | 'stale' | 'unreadable';

function problemOf(code: string): Problem {
  switch (code) {
    case 'proton_login_required':
    case 'no_passkeys':
      return 'login_required';
    case 'passkeys_stale':
      return 'stale';
    case 'passkey_unreadable':
      return 'unreadable';
    case 'proton_unavailable':
      return 'unavailable';
    case 'no_prf':
      return 'no_prf';
    default:
      return 'retry';
  }
}

/** Refusals after which the server's state differs: the app reads its status again. */
const STATUS_CHANGING = new Set(['proton_login_required', 'no_passkeys', 'passkeys_stale', 'passkey_unreadable', 'unknown_passkey']);

/** Problems that leave only Sign in to Proton: no passkey can unlock now. */
const SIGN_IN_ONLY = new Set<Problem>(['login_required', 'stale', 'unreadable']);

const SIGN_IN_TEXT = {
  login_required: 'Filing is paused. Sign in to Proton to resume.',
  stale: 'Your Proton password changed. Sign in again, then add your passkey again in Settings.',
  unreadable: 'That passkey can no longer unlock. Sign in to Proton, then add a passkey again in Settings.',
} as const;

/**
 * Shown while Proton is locked: tokens stored, keys gone with a restart
 * (passkey-unlock spec §3). Unlock waits for a tap, since iOS needs a user
 * gesture for the passkey prompt; the salts are fetched before it.
 */
export function LockedBanner({ passkeys, onUnlocked, onSignIn, onStatusChanged = () => {}, client = unlockClient }: LockedBannerProps) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  // The first salts are on their way: a tap now would have to fetch them
  // before the prompt, and iOS may refuse a prompt that no longer follows the tap.
  const [preparing, setPreparing] = useState(passkeys > 0);
  // Unlock was replaced by Sign in to Proton: focus follows it.
  const [focusSignIn, setFocusSignIn] = useState(false);
  const signInRef = useRef<HTMLButtonElement>(null);
  const prepared = useRef<UnlockCredential[] | null>(null);
  // Only the latest fetch may fill `prepared`.
  const generation = useRef(0);
  const mounted = useRef(true);
  // A layout effect: Preact 11 runs useEffect cleanups after paint, too late for this guard.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!focusSignIn) return;
    signInRef.current?.focus();
    setFocusSignIn(false);
  }, [focusSignIn]);

  function prefetch(first = false) {
    const mine = ++generation.current;
    prepared.current = null;
    if (first) setPreparing(true);
    client
      .prepare()
      .then((credentials) => {
        if (generation.current === mine) prepared.current = credentials;
      })
      // The tap fetches them itself then.
      .catch(() => {})
      .finally(() => {
        if (mounted.current && generation.current === mine) setPreparing(false);
      });
  }

  useEffect(() => {
    if (passkeys === 0) return;
    prefetch(true);
  }, [client, passkeys]);

  async function tap() {
    setBusy(true);
    setProblem(null);
    const outcome = await client.unlock(prepared.current);
    if (!mounted.current) return;
    setBusy(false);
    if (outcome.kind === 'unlocked') {
      onUnlocked(outcome.status);
      return;
    }
    const next = outcome.kind === 'cancelled' ? 'retry' : problemOf(outcome.code);
    if (SIGN_IN_ONLY.has(next)) setFocusSignIn(true);
    // A passkey may have been removed, or another added elsewhere: the next tap
    // gets fresh salts. Not when only Sign in to Proton is left.
    else prefetch();
    setProblem(next);
    if (outcome.kind === 'failed' && STATUS_CHANGING.has(outcome.code)) onStatusChanged(outcome.code);
  }

  const signInOnly = problem && SIGN_IN_ONLY.has(problem) ? (problem as keyof typeof SIGN_IN_TEXT) : passkeys === 0 ? 'login_required' : null;
  if (signInOnly) {
    return (
      <div class="warn">
        {SIGN_IN_TEXT[signInOnly]}{' '}
        <button ref={signInRef} class="btn btn-secondary btn-small" onClick={onSignIn}>
          Sign in to Proton
        </button>
      </div>
    );
  }
  return (
    <div class="warn">
      Filing is paused until you unlock.{' '}
      <button class="btn btn-small" disabled={busy || preparing} onClick={() => void tap()}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      {/* A lost device, a passkey without PRF, a server error: a way out that keeps the passkeys. */}{' '}
      <button class="btn btn-secondary btn-small" onClick={onSignIn}>
        Sign in with password instead
      </button>
      {problem === 'retry' && <p class="error-text">Couldn’t unlock. Try again.</p>}
      {problem === 'unavailable' && <p class="error-text">Proton isn’t reachable right now. Try again in a moment.</p>}
      {problem === 'no_prf' && <p class="error-text">That passkey can’t unlock here. Try another, or sign in with your password.</p>}
    </div>
  );
}
