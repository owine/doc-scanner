import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError, type PasskeyBegin, type PasskeyEntry } from '../api.js';
import { passkeysClient, type EnrolOutcome, type PasskeysClient } from '../auth/flows.js';

export interface PasskeysSectionProps {
  email: string;
  /** Adding needs live Proton keys: the server wraps the passphrase it holds. */
  live: boolean;
  /** A passkey was added or removed: the app's status count is stale. */
  onChanged: () => void;
  client?: PasskeysClient;
}

const PRF_UNSUPPORTED = 'This passkey can’t unlock filing (no PRF support). Use an iCloud Keychain passkey on iOS 18.4 or later, or 1Password.';
const DELETE_HINT = ' The passkey was still saved in your password manager; you can delete it there.';
const REMOVED_NOTICE = 'Your passkeys were removed because your Proton password changed. Add one again.';
const ADDED = 'Passkey added.';

const day = (iso: string) => new Date(iso).toLocaleDateString();

function messageFor(outcome: Exclude<EnrolOutcome, { kind: 'added' } | { kind: 'finish_setup' }>): string {
  // A passkey the server refused, which the browser couldn't hide.
  const hint = outcome.kind === 'failed' && outcome.forgotten === false ? DELETE_HINT : '';
  switch (outcome.kind) {
    case 'cancelled':
      return 'Setup cancelled.';
    case 'already_added':
      return 'This passkey is already added.';
    case 'prf_unsupported':
      return PRF_UNSUPPORTED + (outcome.forgotten ? '' : DELETE_HINT);
    case 'expired':
      return 'Setup expired. Try again.' + (outcome.forgotten ? '' : DELETE_HINT);
    case 'failed':
      return (outcome.code === 'proton_not_live' ? 'Sign in to Proton first, then add a passkey.' : 'Could not add the passkey. Try again.') + hint;
  }
}

/** Settings → Passkeys (passkey-unlock spec §3). Rendered only when unlock is available. */
export function PasskeysSection({ email, live, onChanged, client = passkeysClient }: PasskeysSectionProps) {
  const [passkeys, setPasskeys] = useState<PasskeyEntry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState('Passkey');
  // Fetched when Add passkey is tapped, so Continue starts the prompt straight away.
  const [begin, setBegin] = useState<PasskeyBegin | 'loading' | null>(null);
  const [busy, setBusy] = useState(false);
  // A created passkey waiting for its Finish setup tap.
  const [finish, setFinish] = useState<{ run: () => Promise<EnrolOutcome>; abandon: () => Promise<boolean> } | null>(null);
  // The same abandon, for the unmount cleanup, which sees no later state.
  const pendingAbandon = useRef<(() => Promise<boolean>) | null>(null);
  const mounted = useRef(true);
  // A layout effect: Preact 11 runs useEffect cleanups after paint, too late for this guard.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving Settings mid-setup: hide the passkey that will never unlock.
      void pendingAbandon.current?.();
    };
  }, []);

  useEffect(() => {
    client
      .list()
      .then((r) => {
        if (!mounted.current) return;
        setPasskeys(r.passkeys);
        if (r.notice === 'password_changed') setNotice(REMOVED_NOTICE);
      })
      .catch(() => mounted.current && setMessage('Could not load passkeys.'));
  }, [client]);

  function fetchBegin() {
    setBegin('loading');
    client
      .begin()
      .then((b) => mounted.current && setBegin(b))
      // Continue fetches it itself then.
      .catch(() => mounted.current && setBegin(null));
  }

  function startAdding() {
    setLabel('Passkey');
    setMessage(null);
    setNaming(true);
    fetchBegin();
  }

  async function run(step: () => Promise<EnrolOutcome>) {
    setBusy(true);
    setMessage(null);
    const outcome = await step();
    if (!mounted.current) return;
    setBusy(false);
    setFinish(null);
    pendingAbandon.current = null;
    if (outcome.kind === 'added') {
      setPasskeys((list) => [...(list ?? []), outcome.passkey]);
      setNaming(false);
      setBegin(null);
      setNotice(null);
      setMessage(ADDED);
      onChanged();
    } else if (outcome.kind === 'finish_setup') {
      setFinish({ run: outcome.finish, abandon: outcome.abandon });
      pendingAbandon.current = outcome.abandon;
      setNaming(false);
      setMessage('One more step: tap Finish setup to turn on unlocking.');
    } else {
      setMessage(messageFor(outcome));
      // The server forgot that salt: the next try needs a new one.
      if (outcome.kind === 'expired') fetchBegin();
    }
  }

  async function cancelSetup() {
    if (!finish) return;
    setFinish(null);
    pendingAbandon.current = null;
    const forgotten = await finish.abandon();
    if (mounted.current) setMessage('Setup cancelled.' + (forgotten ? '' : DELETE_HINT));
  }

  async function remove(credentialId: string) {
    setMessage(null);
    try {
      await client.remove(credentialId);
    } catch (e) {
      // Already gone is what was asked for.
      if (!(e instanceof ApiError && e.status === 404)) {
        if (mounted.current) setMessage('Could not remove the passkey.');
        return;
      }
    }
    if (!mounted.current) return;
    setPasskeys((list) => (list ?? []).filter((p) => p.credentialId !== credentialId));
    onChanged();
  }

  return (
    <>
      <h2>Passkeys</h2>
      <div class="card">
        <p class="muted">A passkey unlocks filing after a server restart, without your Proton password.</p>
        {notice && <p class="warn">{notice}</p>}
        {passkeys !== null && passkeys.length === 0 && <p class="muted">No passkeys yet.</p>}
        {passkeys !== null && passkeys.length > 0 && (
          <ul class="doc-list" role="list" aria-label="Passkeys">
            {passkeys.map((p) => (
              <li key={p.credentialId} class="doc-row">
                <span class="doc-main">
                  <span class="doc-name">{p.label}</span>
                  <br />
                  <span class="muted">
                    Added {day(p.createdAt)} · {p.lastUsedAt ? `Last used ${day(p.lastUsedAt)}` : 'Never used'}
                  </span>
                </span>
                <button class="btn btn-secondary btn-small" aria-label={`Remove ${p.label}`} onClick={() => void remove(p.credentialId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {live &&
          !finish &&
          (naming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => client.enrol(label, email, begin === null || begin === 'loading' ? undefined : begin));
              }}
            >
              <label class="field">
                <span class="field-label">Name</span>
                <input value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
              </label>
              <div class="actions">
                <button class="btn" type="submit" disabled={busy || begin === 'loading'}>
                  {busy ? 'Waiting for the passkey…' : 'Continue'}
                </button>
                <button class="btn btn-secondary" type="button" disabled={busy} onClick={() => setNaming(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button class="btn btn-secondary" onClick={startAdding}>
              Add passkey
            </button>
          ))}
        {finish && (
          <div class="actions">
            <button class="btn" disabled={busy} onClick={() => void run(finish.run)}>
              Finish setup
            </button>
            <button class="btn btn-secondary" disabled={busy} onClick={() => void cancelSetup()}>
              Cancel setup
            </button>
          </div>
        )}
        <p role="status" class={message === ADDED ? 'muted' : 'error-text'}>
          {message}
        </p>
      </div>
    </>
  );
}
