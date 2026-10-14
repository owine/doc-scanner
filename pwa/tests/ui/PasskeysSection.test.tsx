import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { PasskeysSection, type PasskeysSectionProps } from '../../src/ui/PasskeysSection.js';
import type { EnrolOutcome, PasskeysClient } from '../../src/auth/flows.js';
import { ApiError, type PasskeyBegin, type PasskeyEntry } from '../../src/api.js';

const BEGIN: PasskeyBegin = { salt: 'c2FsdA', userHandle: 'dXNlcg', excludeCredentials: [] };
const PHONE: PasskeyEntry = { credentialId: 'AQEBAQEBAQEBAQEBAQEBAQ', label: 'Phone', createdAt: '2026-10-01T10:00:00.000Z', lastUsedAt: null };
const LAPTOP: PasskeyEntry = { credentialId: 'AgICAgICAgICAgICAgICAg', label: 'Laptop', createdAt: '2026-10-13T10:00:00.000Z', lastUsedAt: null };
const PRF_TEXT = 'This passkey can’t unlock filing (no PRF support). Use an iCloud Keychain passkey on iOS 18.4 or later, or 1Password.';

function setup(over: Partial<PasskeysClient> = {}, props: Partial<PasskeysSectionProps> = {}) {
  const client: PasskeysClient = {
    list: vi.fn().mockResolvedValue({ passkeys: [PHONE], notice: null }),
    remove: vi.fn().mockResolvedValue({}),
    begin: vi.fn().mockResolvedValue(BEGIN),
    enrol: vi.fn().mockResolvedValue({ kind: 'added', passkey: LAPTOP }),
    forget: vi.fn().mockResolvedValue(true),
    ...over,
  };
  const onChanged = vi.fn();
  const { unmount } = render(<PasskeysSection email="user@example.test" live onChanged={onChanged} client={client} {...props} />);
  return { client, onChanged, unmount };
}

/** Opens the name form and waits until the begin fetched for it has arrived. */
async function startAdding(name = 'Laptop') {
  fireEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
  const field = screen.getByRole('textbox', { name: 'Name' });
  expect(field).toHaveValue('Passkey');
  fireEvent.input(field, { target: { value: name } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
}

describe('PasskeysSection', () => {
  it('lists each passkey with when it was added and last used', async () => {
    setup({ list: vi.fn().mockResolvedValue({ passkeys: [PHONE, { ...LAPTOP, lastUsedAt: '2026-10-13T11:00:00.000Z' }], notice: null }) });
    const list = await screen.findByRole('list', { name: 'Passkeys' });
    expect(within(list).getByText('Phone')).toBeInTheDocument();
    expect(within(list).getByText(/never used/i)).toBeInTheDocument();
    expect(within(list).getByText(/last used/i)).toBeInTheDocument();
  });

  it('says once that a password change removed the passkeys', async () => {
    setup({ list: vi.fn().mockResolvedValue({ passkeys: [], notice: 'password_changed' }) });
    expect(await screen.findByText('Your passkeys were removed because your Proton password changed. Add one again.')).toBeInTheDocument();
    expect(screen.getByText('No passkeys yet.')).toBeInTheDocument();
  });

  it('adds a named passkey with the begin fetched on Add passkey', async () => {
    const { client, onChanged } = setup();
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(client.enrol).toHaveBeenCalledWith('Laptop', 'user@example.test', BEGIN);
    expect(screen.getByText('Passkey added.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  for (const [label, outcome, text] of [
    ['no PRF support', { kind: 'prf_unsupported', forgotten: true }, PRF_TEXT],
    ['an already added passkey', { kind: 'already_added' }, 'This passkey is already added.'],
    ['an expired setup', { kind: 'expired', forgotten: true }, 'Setup expired. Try again.'],
  ] as const) {
    it(`explains ${label}`, async () => {
      const { onChanged } = setup({ enrol: vi.fn().mockResolvedValue(outcome) });
      await startAdding();
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(onChanged).not.toHaveBeenCalled();
    });
  }

  it('says where to delete a passkey the browser could not hide', async () => {
    setup({ enrol: vi.fn().mockResolvedValue({ kind: 'prf_unsupported', forgotten: false }) });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/you can delete it there/i)).toBeInTheDocument();
  });

  /** An enrolment that needs a second tap; `finish` and `abandon` are its two ways out. */
  function unfinished(finished: EnrolOutcome = { kind: 'added', passkey: LAPTOP }) {
    const finish = vi.fn<() => Promise<EnrolOutcome>>().mockResolvedValue(finished);
    const abandon = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const outcome: EnrolOutcome = { kind: 'finish_setup', finish, abandon };
    return { finish, abandon, enrol: vi.fn().mockResolvedValue(outcome) };
  }

  it('finishes setup from its own button when the follow-up prompt needed a tap', async () => {
    const { finish, abandon, enrol } = unfinished();
    setup({ enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(finish).toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
  });

  it('offers nothing but Finish setup or Cancel setup while a setup waits for its tap', async () => {
    setup({ enrol: unfinished().enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Finish setup' });
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add passkey' })).toBeNull();
  });

  it('hides the half-made passkey when the setup is cancelled', async () => {
    const { abandon, enrol } = unfinished();
    setup({ enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel setup' }));
    expect(await screen.findByText('Setup cancelled.')).toBeInTheDocument();
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add passkey' })).toBeInTheDocument();
  });

  it('hides the half-made passkey when Settings closes before the setup finished', async () => {
    const { abandon, enrol } = unfinished();
    const { unmount } = setup({ enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Finish setup' });
    unmount();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it('says where to delete a passkey the server refused when the browser could not hide it', async () => {
    setup({ enrol: vi.fn().mockResolvedValue({ kind: 'failed', code: 'internal', forgotten: false }) });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/could not add the passkey\. try again\. the passkey was still saved/i)).toBeInTheDocument();
  });

  it('removes a passkey, and treats one already gone as removed', async () => {
    const { client, onChanged } = setup({
      list: vi.fn().mockResolvedValue({ passkeys: [PHONE, LAPTOP], notice: null }),
      remove: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError('not_found', 404, 'not_found')),
    });
    await screen.findByRole('button', { name: 'Remove Phone' });
    screen.getAllByRole('button', { name: /^Remove / }).forEach((b) => expect(b).toHaveClass('btn-danger'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Phone' }));
    await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
    expect(client.remove).toHaveBeenCalledWith(PHONE.credentialId);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Laptop' }));
    await waitFor(() => expect(screen.queryByText('Laptop')).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('asks the password manager to forget a removed passkey, and ignores its failure', async () => {
    const { client, onChanged } = setup({
      list: vi.fn().mockResolvedValue({ passkeys: [PHONE, LAPTOP], notice: null }),
      forget: vi.fn().mockRejectedValue(new Error('unsupported')),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Phone' }));
    await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
    expect(client.forget).toHaveBeenCalledWith(PHONE.credentialId);
    expect(onChanged).toHaveBeenCalledWith('removed');
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('forgets nothing when the removal failed', async () => {
    const { client } = setup({ remove: vi.fn().mockRejectedValue(new ApiError('internal', 500, 'internal')) });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Phone' }));
    expect(await screen.findByText('Could not remove the passkey.')).toBeInTheDocument();
    expect(client.forget).not.toHaveBeenCalled();
  });

  it('keeps a passkey that Finish setup may still store when Settings closes mid-step', async () => {
    let settle!: (o: EnrolOutcome) => void;
    const finish = vi.fn(() => new Promise<EnrolOutcome>((resolve) => { settle = resolve; }));
    const abandon = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const { unmount } = setup({ enrol: vi.fn().mockResolvedValue({ kind: 'finish_setup', finish, abandon }) });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));
    expect(finish).toHaveBeenCalled();
    unmount();
    await act(async () => settle({ kind: 'added', passkey: LAPTOP }));
    expect(abandon).not.toHaveBeenCalled();
  });

  it('hides a half-made passkey whose setup comes back after Settings closed', async () => {
    let settle!: (o: EnrolOutcome) => void;
    const abandon = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const enrol = vi.fn(() => new Promise<EnrolOutcome>((resolve) => { settle = resolve; }));
    const { unmount } = setup({ enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    unmount();
    await act(async () => settle({ kind: 'finish_setup', finish: vi.fn(), abandon }));
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it('moves focus to Finish setup when the name form gives way to it', async () => {
    setup({ enrol: unfinished().enrol });
    await startAdding();
    const cont = screen.getByRole('button', { name: 'Continue' });
    cont.focus();
    fireEvent.click(cont);
    expect(await screen.findByRole('button', { name: 'Finish setup' })).toHaveFocus();
  });

  it('moves focus back to Add passkey after Cancel setup, and after the form is cancelled', async () => {
    setup({ enrol: unfinished().enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel setup' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add passkey' })).toHaveFocus());
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add passkey' })).toHaveFocus();
  });

  it('moves focus to Add passkey after a removal, or to the heading when Add is not offered', async () => {
    const { unmount } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Phone' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add passkey' })).toHaveFocus());
    unmount();
    setup({}, { live: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Phone' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Passkeys' })).toHaveFocus());
  });

  it('does not show a step or a cancelled setup as an error', async () => {
    setup({ enrol: unfinished().enrol });
    await startAdding();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/one more step/i)).not.toHaveClass('error-text');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }));
    expect(await screen.findByText('Setup cancelled.')).not.toHaveClass('error-text');
  });

  it('removes once on a double tap', async () => {
    let done!: (v: unknown) => void;
    const { client } = setup({ remove: vi.fn(() => new Promise((resolve) => { done = resolve; })) });
    const button = await screen.findByRole('button', { name: 'Remove Phone' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(client.remove).toHaveBeenCalledTimes(1);
    await act(async () => done({}));
    await waitFor(() => expect(screen.queryByText('Phone')).toBeNull());
  });

  it('names each Remove button apart when labels repeat', async () => {
    const short = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    setup({ list: vi.fn().mockResolvedValue({ passkeys: [{ ...PHONE, label: 'Passkey' }, { ...LAPTOP, label: 'Passkey' }], notice: null }) });
    expect(await screen.findByRole('button', { name: `Remove Passkey (added ${short(PHONE.createdAt)})` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Remove Passkey (added ${short(LAPTOP.createdAt)})` })).toBeInTheDocument();
  });

  it('offers no Add passkey without live Proton keys', async () => {
    setup({}, { live: false });
    expect(await screen.findByText('Phone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add passkey' })).toBeNull();
  });
});
