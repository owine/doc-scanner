import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ApiError, type PasskeyBegin, type PasskeyEntry } from '../api.js';
import { passkeysClient, type EnrolOutcome, type PasskeysClient } from '../auth/flows.js';

export type PasskeyChange = 'added' | 'removed';

export interface PasskeysSectionProps {
  email: string;
  /** Adding needs live Proton keys: the server wraps the passphrase it holds. */
  live: boolean;
  /** A passkey was added or removed: the app's status count is stale. */
  onChanged: (change: PasskeyChange) => void;
  /** Opened to add a passkey: scroll here and focus Add passkey (the heading without it). */
  focusAdd?: boolean;
  client?: PasskeysClient;
}

const PRF_UNSUPPORTED = 'This passkey can’t unlock filing (no PRF support). Use an iCloud Keychain passkey on iOS 18.4 or later, or 1Password.';
const DELETE_HINT = ' The passkey was still saved in your password manager; you can delete it there.';
const REMOVED_NOTICE = 'Your passkeys were removed because your Proton password changed. Add one again.';
const ADDED = 'Passkey added.';
const ONE_MORE_STEP = 'One more step: tap Finish setup to turn on unlocking.';

const day = (iso: string) => new Date(iso).toLocaleDateString();
const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A status line: `error` picks the error colour; a step or a cancelled setup is not one. */
interface Message {
  text: string;
  error: boolean;
}

/**
 * What each Remove button is called. A label alone, unless labels repeat:
 * then with its added date ("Passkey (added 13 Oct)"), and a number if even
 * that repeats, so every button has a name of its own.
 */
function removeNames(passkeys: PasskeyEntry[]): string[] {
  const count = (names: string[], n: string) => names.filter((x) => x === n).length;
  const labels = passkeys.map((p) => p.label);
  const dated = passkeys.map((p) => (count(labels, p.label) > 1 ? `${p.label} (added ${shortDay(p.createdAt)})` : p.label));
  return dated.map((n, i) => (count(dated, n) > 1 ? `${n} #${dated.slice(0, i + 1).filter((x) => x === n).length}` : n));
}

/** Where focus goes when the focused control is replaced. */
type FocusTarget = 'finish' | 'add';

function messageFor(outcome: Exclude<EnrolOutcome, { kind: 'added' } | { kind: 'finish_setup' }>): Message {
  // A passkey the server refused, which the browser couldn't hide.
  const hint = outcome.kind === 'failed' && outcome.forgotten === false ? DELETE_HINT : '';
  switch (outcome.kind) {
    case 'cancelled':
      return { text: 'Setup cancelled.', error: false };
    case 'already_added':
      return { text: 'This passkey is already added.', error: true };
    case 'prf_unsupported':
      return { text: PRF_UNSUPPORTED + (outcome.forgotten ? '' : DELETE_HINT), error: true };
    case 'expired':
      return { text: 'Setup expired. Try again.' + (outcome.forgotten ? '' : DELETE_HINT), error: true };
    case 'failed':
      return {
        text: (outcome.code === 'proton_not_live' ? 'Sign in to Proton first, then add a passkey.' : 'Could not add the passkey. Try again.') + hint,
        error: true,
      };
  }
}

/** Settings → Passkeys (passkey-unlock spec §3). Rendered only when unlock is available. */
export function PasskeysSection({ email, live, onChanged, focusAdd = false, client = passkeysClient }: PasskeysSectionProps) {
  const [passkeys, setPasskeys] = useState<PasskeyEntry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState('Passkey');
  // Fetched when Add passkey is tapped, so Continue starts the prompt straight away.
  const [begin, setBegin] = useState<PasskeyBegin | 'loading' | null>(null);
  const [busy, setBusy] = useState(false);
  // A created passkey waiting for its Finish setup tap.
  const [finish, setFinish] = useState<{ run: () => Promise<EnrolOutcome>; abandon: () => Promise<boolean> } | null>(null);
  // The same abandon, for the unmount cleanup, which sees no later state.
  const pendingAbandon = useRef<(() => Promise<boolean>) | null>(null);
  // A removal in flight: a second tap must not send another.
  const removing = useRef(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // A new object per request, so the same target can be asked for twice.
  const [focusRequest, setFocusRequest] = useState<{ target: FocusTarget } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const finishRef = useRef<HTMLButtonElement>(null);
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

  // The focused control was replaced: focus what replaced it, before paint.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.target === 'finish') finishRef.current?.focus();
    // No Add passkey without live keys: the list's heading then.
    else (addRef.current ?? headingRef.current)?.focus();
  }, [focusRequest]);
  const focusOn = (target: FocusTarget) => setFocusRequest({ target });

  // On arrival only: the section's top in view, then its first control.
  useLayoutEffect(() => {
    if (!focusAdd) return;
    headingRef.current?.scrollIntoView?.({ block: 'start' });
    (addRef.current ?? headingRef.current)?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    client
      .list()
      .then((r) => {
        if (!mounted.current) return;
        setPasskeys(r.passkeys);
        if (r.notice === 'password_changed') setNotice(REMOVED_NOTICE);
      })
      .catch(() => mounted.current && setMessage({ text: 'Could not load passkeys.', error: true }));
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
    // Before the await: Finish setup's step may store the passkey, so leaving
    // Settings while it runs must not hide it. A step that comes back unfinished
    // is abandoned below instead.
    pendingAbandon.current = null;
    const outcome = await step();
    if (!mounted.current) {
      // Settings closed while the prompt was up: nobody is left to tap Finish setup.
      if (outcome.kind === 'finish_setup') void outcome.abandon();
      return;
    }
    setBusy(false);
    setFinish(null);
    if (outcome.kind === 'added') {
      setPasskeys((list) => [...(list ?? []), outcome.passkey]);
      setNaming(false);
      setBegin(null);
      setNotice(null);
      setMessage({ text: ADDED, error: false });
      focusOn('add');
      onChanged('added');
    } else if (outcome.kind === 'finish_setup') {
      setFinish({ run: outcome.finish, abandon: outcome.abandon });
      pendingAbandon.current = outcome.abandon;
      setNaming(false);
      setMessage({ text: ONE_MORE_STEP, error: false });
      focusOn('finish');
    } else {
      setMessage(messageFor(outcome));
      // Finish setup is gone (the name form stays for a first try).
      if (!naming) focusOn('add');
      // The server forgot that salt: the next try needs a new one.
      if (outcome.kind === 'expired') fetchBegin();
    }
  }

  async function cancelSetup() {
    if (!finish) return;
    setFinish(null);
    pendingAbandon.current = null;
    focusOn('add');
    const forgotten = await finish.abandon();
    if (mounted.current) setMessage({ text: 'Setup cancelled.' + (forgotten ? '' : DELETE_HINT), error: false });
  }

  function cancelNaming() {
    setNaming(false);
    focusOn('add');
  }

  async function remove(credentialId: string) {
    if (removing.current) return;
    removing.current = true;
    setRemovingId(credentialId);
    setMessage(null);
    try {
      await client.remove(credentialId);
    } catch (e) {
      // Already gone is what was asked for.
      if (!(e instanceof ApiError && e.status === 404)) {
        if (mounted.current) setMessage({ text: 'Could not remove the passkey.', error: true });
        return;
      }
    } finally {
      removing.current = false;
      if (mounted.current) setRemovingId(null);
    }
    if (!mounted.current) return;
    setPasskeys((list) => (list ?? []).filter((p) => p.credentialId !== credentialId));
    // Its Remove button is gone.
    focusOn('add');
    onChanged('removed');
  }

  const names = passkeys ? removeNames(passkeys) : [];

  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        Passkeys
      </h2>
      <div class="card">
        <p class="muted">A passkey unlocks filing after a server restart, without your Proton password.</p>
        {notice && <p class="warn">{notice}</p>}
        {passkeys !== null && passkeys.length === 0 && <p class="muted">No passkeys yet.</p>}
        {passkeys !== null && passkeys.length > 0 && (
          <ul class="doc-list" role="list" aria-label="Passkeys">
            {passkeys.map((p, i) => (
              <li key={p.credentialId} class="doc-row">
                <span class="doc-main">
                  <span class="doc-name">{p.label}</span>
                  <br />
                  <span class="muted">
                    Added {day(p.createdAt)} · {p.lastUsedAt ? `Last used ${day(p.lastUsedAt)}` : 'Never used'}
                  </span>
                </span>
                <button
                  class="btn btn-secondary btn-small"
                  aria-label={`Remove ${names[i]}`}
                  disabled={removingId !== null}
                  onClick={() => void remove(p.credentialId)}
                >
                  {removingId === p.credentialId ? 'Removing…' : 'Remove'}
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
                <button class="btn btn-secondary" type="button" disabled={busy} onClick={cancelNaming}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button ref={addRef} class="btn btn-secondary" onClick={startAdding}>
              Add passkey
            </button>
          ))}
        {finish && (
          <div class="actions">
            <button ref={finishRef} class="btn" disabled={busy} onClick={() => void run(finish.run)}>
              Finish setup
            </button>
            <button class="btn btn-secondary" disabled={busy} onClick={() => void cancelSetup()}>
              Cancel setup
            </button>
          </div>
        )}
        <p role="status" class={message?.error ? 'error-text' : 'muted'}>
          {message?.text}
        </p>
      </div>
    </>
  );
}
