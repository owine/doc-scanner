import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { SettingsScreen } from '../../src/ui/SettingsScreen.js';
import { ApiError } from '../../src/api.js';
import type { DocumentsApi } from '../../src/documents/api.js';
import type { Settings } from '../../src/documents/types.js';
import { FOLDERS } from '../documents/fixtures.js';

afterEach(() => { vi.unstubAllGlobals(); });

const SETTINGS: Settings = { model: 'claude-haiku-5-5', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: ['/Archive'] };

function setup(over: Partial<DocumentsApi> = {}) {
  const api = {
    settings: vi.fn().mockResolvedValue(SETTINGS),
    saveSettings: vi.fn(async (p: Partial<Settings>) => ({ ...SETTINGS, ...p })),
    folders: vi.fn().mockResolvedValue({ walkedAt: '2026-10-10T12:00:00.000Z', folders: FOLDERS }),
    refreshFolders: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  } as unknown as DocumentsApi;
  const onBack = vi.fn();
  const onLoggedOut = vi.fn();
  const { unmount } = render(<SettingsScreen email="user@example.test" documents={api} onBack={onBack} onLoggedOut={onLoggedOut} />);
  return { api, onBack, onLoggedOut, unmount };
}

describe('SettingsScreen', () => {
  it('loads the settings into the form', async () => {
    setup();
    expect(await screen.findByRole('checkbox', { name: /file automatically/i })).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: /threshold/i })).toHaveValue('0.8');
    expect(screen.getByText('/Archive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves only the changed settings, so the rest keep following their env defaults', async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: /file automatically/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /threshold/i }), { target: { value: '0.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ autoFileEnabled: true, autoFileThreshold: 0.9 }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('lets a decimal be typed one character at a time', async () => {
    const { api } = setup();
    const field = await screen.findByRole('textbox', { name: /threshold/i });
    fireEvent.input(field, { target: { value: '0.' } });
    expect(field).toHaveValue('0.');
    fireEvent.input(field, { target: { value: '0.9' } });
    expect(field).toHaveValue('0.9');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ autoFileThreshold: 0.9 }));
    await screen.findByText('Saved.');
  });

  it('explains a rejected value', async () => {
    const { api } = setup({ saveSettings: vi.fn().mockRejectedValue(new ApiError('invalid_input', 400, 'invalid_input')) });
    fireEvent.input(await screen.findByRole('textbox', { name: /threshold/i }), { target: { value: '0.85' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'A value was rejected. Check the model name, a threshold between 0.5 and 1 with at most two decimals, and the excluded folders.',
      ),
    ).toBeInTheDocument();
    expect(api.saveSettings).toHaveBeenCalledWith({ autoFileThreshold: 0.85 });
  });

  it('accepts a decimal comma, as some keyboards type it', async () => {
    const { api } = setup();
    const field = await screen.findByRole('textbox', { name: /threshold/i });
    expect(field).toHaveAttribute('inputmode', 'decimal');
    fireEvent.input(field, { target: { value: '0,85' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ autoFileThreshold: 0.85 }));
    await screen.findByText('Saved.');
  });

  it('blocks a threshold with more than two decimals and says why', async () => {
    const { api } = setup();
    fireEvent.input(await screen.findByRole('textbox', { name: /threshold/i }), { target: { value: '0.855' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /threshold/i })).toHaveAccessibleDescription('Use at most two decimals, such as 0.85.');
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('clears "Saved." once the form changes again', async () => {
    setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: /file automatically/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    fireEvent.input(screen.getByRole('textbox', { name: /threshold/i }), { target: { value: '0.' } });
    await waitFor(() => expect(screen.queryByText('Saved.')).toBeNull());
  });

  it('blocks a threshold below 0.5 before sending it', async () => {
    const { api } = setup();
    fireEvent.input(await screen.findByRole('textbox', { name: /threshold/i }), { target: { value: '0.3' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('Enter a number between 0.5 and 1.')).toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('describes an invalid threshold instead of naming the field with the error', async () => {
    setup();
    const field = await screen.findByRole('textbox', { name: 'Auto-file threshold (0.5 to 1)' });
    expect(field).not.toHaveAttribute('aria-invalid', 'true');
    fireEvent.input(field, { target: { value: '0.3' } });
    const invalid = screen.getByRole('textbox', { name: 'Auto-file threshold (0.5 to 1)' });
    expect(invalid).toHaveAttribute('aria-invalid', 'true');
    expect(invalid).toHaveAccessibleDescription(/between 0.5 and 1/);
  });

  it('blocks a blank threshold', async () => {
    setup();
    fireEvent.input(await screen.findByRole('textbox', { name: /threshold/i }), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('disables Save again after a successful save', async () => {
    setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: /file automatically/i }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByText('Saved.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says when the settings could not be loaded', async () => {
    setup({ settings: vi.fn().mockRejectedValue(new Error('down')) });
    expect(await screen.findByText('Could not load settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows why the folder list could not be refreshed', async () => {
    setup({ refreshFolders: vi.fn().mockRejectedValue(new ApiError('not_logged_in', 401, 'not_logged_in')) });
    fireEvent.click(await screen.findByRole('button', { name: /refresh folder list/i }));
    expect(await screen.findByText('Sign in again to read your Drive folders.')).toBeInTheDocument();
  });

  it('keeps the controls below the form when the settings load', async () => {
    setup();
    // Found before the settings arrive, as a quick tap would.
    const dark = screen.getByRole('radio', { name: /dark/i });
    await screen.findByRole('checkbox', { name: /file automatically/i });
    expect(dark.isConnected).toBe(true);
    expect(screen.getByRole('radio', { name: /dark/i })).toBe(dark);
  });

  it('switches the theme', async () => {
    setup();
    const dark = await screen.findByRole('radio', { name: /dark/i });
    expect(dark).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(dark);
    await waitFor(() => expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: /system/i })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('radio', { name: /system/i }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /system/i })).toHaveAttribute('aria-checked', 'true'));
  });

  it('adds and removes never-file-here folders', async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove /Archive' }));
    fireEvent.click(screen.getByRole('button', { name: /add folder/i }));
    fireEvent.click(await screen.findByRole('button', { name: '/Taxes/2026' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ excludePaths: ['/Taxes/2026'] }));
    await screen.findByText('Saved.');
  });

  it('keeps list semantics on the excluded folders', async () => {
    setup();
    expect(await screen.findByText('/Archive')).toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveClass('doc-list');
    expect(document.querySelectorAll('ul:not([role="list"])')).toHaveLength(0);
  });

  it('does not offer the root folder as never-file-here', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /add folder/i }));
    expect(await screen.findByRole('button', { name: '/Bills' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '/' })).toBeNull();
  });

  it('reloads the folder list after the excluded folders change', async () => {
    const { api } = setup();
    await screen.findByRole('checkbox', { name: /file automatically/i });
    expect(api.folders).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove /Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    await waitFor(() => expect(api.folders).toHaveBeenCalledTimes(2));
  });

  it('does not reload the folder list when only other settings change', async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: /file automatically/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(api.folders).toHaveBeenCalledTimes(1);
  });

  it('blocks an empty model before sending it', async () => {
    const { api } = setup();
    fireEvent.input(await screen.findByRole('textbox', { name: /model/i }), { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/enter a model name/i)).toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('locks the form while saving', async () => {
    let finish: (s: Settings) => void = () => {};
    const { api } = setup({
      saveSettings: vi.fn(() => new Promise<Settings>((resolve) => { finish = resolve; })),
    });
    const box = await screen.findByRole('checkbox', { name: /file automatically/i });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(box).toBeDisabled();
    finish({ ...SETTINGS, autoFileEnabled: true });
    await screen.findByText('Saved.');
    expect(box).toBeEnabled();
  });

  it('ignores a save that finishes after the screen is gone', async () => {
    let finish: (s: Settings) => void = () => {};
    const { api, unmount } = setup({
      saveSettings: vi.fn(() => new Promise<Settings>((resolve) => { finish = resolve; })),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove /Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    unmount();
    finish({ ...SETTINGS, excludePaths: [] });
    await new Promise((r) => setTimeout(r, 0));
    // A reload after unmount would be a sign the guard is missing.
    expect(api.folders).toHaveBeenCalledTimes(1);
  });

  it('refreshes the folder list', async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /refresh folder list/i }));
    await waitFor(() => expect(api.refreshFolders).toHaveBeenCalled());
    expect(await screen.findByText(/6 folders/i)).toBeInTheDocument();
  });

  it('signs out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
    const { onLoggedOut } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
  });

  it('stays signed in and says so when sign-out fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const { onLoggedOut } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    expect(await screen.findByText('Could not sign out. Check your connection and try again.')).toBeInTheDocument();
    expect(onLoggedOut).not.toHaveBeenCalled();
  });

  it('goes back', async () => {
    const { onBack } = setup();
    await screen.findByRole('checkbox', { name: /file automatically/i });
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
