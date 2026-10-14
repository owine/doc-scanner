import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { LockedBanner } from '../../src/ui/inbox/LockedBanner.js';
import type { UnlockClient, UnlockOutcome } from '../../src/auth/flows.js';
import type { StatusResponse } from '../../src/api.js';

const LIVE: StatusResponse = { email: 'user@example.test', proton: 'live', passkeys: 1, unlockAvailable: true };
const CREDENTIALS = [{ credentialId: 'AQEBAQEBAQEBAQEBAQEBAQ', salt: 'AwMD' }];
const RETRY = 'Couldn’t unlock. Try again.';

function setup(outcome: UnlockOutcome, passkeys = 1) {
  const client: UnlockClient = {
    prepare: vi.fn().mockResolvedValue(CREDENTIALS),
    unlock: vi.fn().mockResolvedValue(outcome),
  };
  const onUnlocked = vi.fn();
  const onSignIn = vi.fn();
  const onStatusChanged = vi.fn();
  render(<LockedBanner passkeys={passkeys} onUnlocked={onUnlocked} onSignIn={onSignIn} onStatusChanged={onStatusChanged} client={client} />);
  return { client, onUnlocked, onSignIn, onStatusChanged };
}

/** Lets the salts fetched on mount arrive. */
async function prepared(client: UnlockClient) {
  await act(async () => {
    await vi.mocked(client.prepare).mock.results[0]!.value;
  });
}

describe('LockedBanner', () => {
  it('waits for a tap, then unlocks with the salts fetched before it', async () => {
    const { client, onUnlocked } = setup({ kind: 'unlocked', status: LIVE });
    expect(screen.getByText(/filing is paused until you unlock/i)).toBeInTheDocument();
    await prepared(client);
    expect(client.unlock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(LIVE));
    expect(client.unlock).toHaveBeenCalledWith(CREDENTIALS);
  });

  it('fetches the salts again after a failed unlock, so the next tap uses fresh ones', async () => {
    const fresh = [{ credentialId: 'AgICAgICAgICAgICAgICAg', salt: 'BAQE' }];
    const { client, onUnlocked } = setup({ kind: 'failed', code: 'unlock_failed' });
    await prepared(client);
    vi.mocked(client.prepare).mockResolvedValue(fresh);
    vi.mocked(client.unlock).mockResolvedValueOnce({ kind: 'failed', code: 'unlock_failed' }).mockResolvedValueOnce({ kind: 'unlocked', status: LIVE });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText(RETRY)).toBeInTheDocument();
    await waitFor(() => expect(client.prepare).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.mocked(client.prepare).mock.results[1]!.value;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(LIVE));
    expect(client.unlock).toHaveBeenLastCalledWith(fresh);
  });

  it('offers only a Proton sign-in with no passkeys', () => {
    const { client, onSignIn } = setup({ kind: 'cancelled' }, 0);
    expect(screen.getByText('Filing is paused. Sign in to Proton to resume.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Proton' }));
    expect(onSignIn).toHaveBeenCalled();
    expect(client.prepare).not.toHaveBeenCalled();
  });

  for (const [label, outcome] of [
    ['a cancelled prompt', { kind: 'cancelled' }],
    ['a wrong secret', { kind: 'failed', code: 'unlock_failed' }],
    ['a network failure', { kind: 'failed', code: 'error' }],
  ] as const) {
    it(`asks to try again after ${label}, keeping the button`, async () => {
      const { client, onStatusChanged } = setup(outcome);
      await prepared(client);
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
      expect(await screen.findByText(RETRY)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
      expect(onStatusChanged).not.toHaveBeenCalled();
    });
  }

  it('says Proton is unreachable, keeping the button', async () => {
    const { client } = setup({ kind: 'failed', code: 'proton_unavailable' });
    await prepared(client);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Proton isn’t reachable right now. Try again in a moment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  });

  for (const [code, text] of [
    ['proton_login_required', 'Filing is paused. Sign in to Proton to resume.'],
    ['no_passkeys', 'Filing is paused. Sign in to Proton to resume.'],
    ['passkeys_stale', 'Your Proton password changed. Sign in again, then add your passkey again in Settings.'],
    ['passkey_unreadable', 'That passkey can no longer unlock. Sign in to Proton, then add a passkey again in Settings.'],
  ] as const) {
    it(`sends the user to sign in after ${code}, focused, and tells the app its status changed`, async () => {
      const { client, onSignIn, onStatusChanged } = setup({ kind: 'failed', code });
      await prepared(client);
      const unlockButton = screen.getByRole('button', { name: 'Unlock' });
      unlockButton.focus();
      fireEvent.click(unlockButton);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(onStatusChanged).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
      // Unlock is gone: focus moves to what replaced it.
      expect(screen.getByRole('button', { name: 'Sign in to Proton' })).toHaveFocus();
      // Nothing left to unlock with: no salts fetched again.
      expect(client.prepare).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Proton' }));
      expect(onSignIn).toHaveBeenCalled();
    });
  }

  it('asks again after an unknown passkey, and tells the app its status changed', async () => {
    const { client, onStatusChanged } = setup({ kind: 'failed', code: 'unknown_passkey' });
    await prepared(client);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText(RETRY)).toBeInTheDocument();
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  });

  it('holds Unlock until the salts arrive, so the tap starts the prompt itself', async () => {
    const { client } = setup({ kind: 'unlocked', status: LIVE });
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    await prepared(client);
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
  });

  it('offers Unlock anyway when fetching the salts first failed, and the tap fetches them', async () => {
    const client: UnlockClient = {
      prepare: vi.fn().mockRejectedValue(new Error('offline')),
      unlock: vi.fn().mockResolvedValue({ kind: 'unlocked', status: LIVE }),
    };
    const onUnlocked = vi.fn();
    render(<LockedBanner passkeys={1} onUnlocked={onUnlocked} onSignIn={vi.fn()} client={client} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(LIVE));
    expect(client.unlock).toHaveBeenCalledWith(null);
  });

  it('does not take focus when it first shows only Sign in to Proton', () => {
    setup({ kind: 'cancelled' }, 0);
    expect(screen.getByRole('button', { name: 'Sign in to Proton' })).not.toHaveFocus();
  });

  it('ignores an outcome that arrives after it is gone', async () => {
    let finish!: (o: UnlockOutcome) => void;
    const client: UnlockClient = {
      prepare: vi.fn().mockResolvedValue(CREDENTIALS),
      unlock: vi.fn(() => new Promise<UnlockOutcome>((resolve) => { finish = resolve; })),
    };
    const onUnlocked = vi.fn();
    const { unmount } = render(<LockedBanner passkeys={1} onUnlocked={onUnlocked} onSignIn={vi.fn()} client={client} />);
    await prepared(client);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    unmount();
    await act(async () => finish({ kind: 'unlocked', status: LIVE }));
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
