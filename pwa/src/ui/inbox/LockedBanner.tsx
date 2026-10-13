import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { StatusResponse, UnlockCredential } from '../../api.js';
import { unlockClient, type UnlockClient } from '../../auth/flows.js';

export interface LockedBannerProps {
  /** Passkeys that can unlock; with none, the banner only offers a Proton sign-in. */
  passkeys: number;
  onUnlocked: (status: StatusResponse) => void;
  /** Opens the sign-in-to-Proton screen. */
  onSignIn: () => void;
  /** The server changed the Proton state or the passkeys (a refusal that cleared something). */
  onStatusChanged?: () => void;
  client?: UnlockClient;
}

type Problem = 'retry' | 'unavailable' | 'login_required' | 'stale' | 'unreadable';

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
    default:
      return 'retry';
  }
}

/** Refusals after which the server's state differs: the app reads its status again. */
const STATUS_CHANGING = new Set(['proton_login_required', 'passkeys_stale', 'passkey_unreadable']);

const SIGN_IN_TEXT = {
  login_required: 'Filing is paused. Sign in to Proton to resume.',
  stale: 'Your Proton password changed. Sign in again, then add your passkey again in Settings.',
  unreadable: 'That passkey can no longer unlock. Sign in to Proton, then remove it and add it again in Settings.',
} as const;

/**
 * Shown while Proton is locked: tokens stored, keys gone with a restart
 * (passkey-unlock spec §3). Unlock waits for a tap, since iOS needs a user
 * gesture for the passkey prompt; the salts are fetched before it.
 */
export function LockedBanner({ passkeys, onUnlocked, onSignIn, onStatusChanged = () => {}, client = unlockClient }: LockedBannerProps) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
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

  function prefetch() {
    const mine = ++generation.current;
    prepared.current = null;
    client
      .prepare()
      .then((credentials) => {
        if (generation.current === mine) prepared.current = credentials;
      })
      // The tap fetches them itself then.
      .catch(() => {});
  }

  useEffect(() => {
    if (passkeys === 0) return;
    prefetch();
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
    // A passkey may have been removed, or another added elsewhere: the next tap gets fresh salts.
    prefetch();
    setProblem(outcome.kind === 'cancelled' ? 'retry' : problemOf(outcome.code));
    if (outcome.kind === 'failed' && STATUS_CHANGING.has(outcome.code)) onStatusChanged();
  }

  const signInOnly =
    problem === 'login_required' || problem === 'stale' || problem === 'unreadable' ? problem : passkeys === 0 ? 'login_required' : null;
  if (signInOnly) {
    return (
      <div class="warn">
        {SIGN_IN_TEXT[signInOnly]}{' '}
        <button class="btn btn-secondary btn-small" onClick={onSignIn}>
          Sign in to Proton
        </button>
      </div>
    );
  }
  return (
    <div class="warn">
      Filing is paused until you unlock.{' '}
      <button class="btn btn-small" disabled={busy} onClick={() => void tap()}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      {problem === 'retry' && <p class="error-text">Couldn’t unlock. Try again.</p>}
      {problem === 'unavailable' && <p class="error-text">Proton isn’t reachable right now. Try again in a moment.</p>}
    </div>
  );
}
