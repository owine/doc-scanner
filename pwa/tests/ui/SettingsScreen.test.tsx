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
  render(<SettingsScreen email="user@example.test" documents={api} onBack={onBack} onLoggedOut={onLoggedOut} />);
  return { api, onBack, onLoggedOut };
}

describe('SettingsScreen', () => {
  it('loads the settings into the form', async () => {
    setup();
    expect(await screen.findByRole('checkbox', { name: /file automatically/i })).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: /threshold/i })).toHaveValue(0.8);
    expect(screen.getByText('/Archive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves only the changed settings, so the rest keep following their env defaults', async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: /file automatically/i }));
    fireEvent.input(screen.getByRole('spinbutton', { name: /threshold/i }), { target: { value: '0.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ autoFileEnabled: true, autoFileThreshold: 0.9 }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('lets a decimal be typed one character at a time', async () => {
    const { api } = setup();
    const field = await screen.findByRole('spinbutton', { name: /threshold/i });
    fireEvent.input(field, { target: { value: '0.' } });
    expect(field).toHaveValue(0);
    expect((field as HTMLInputElement).value).toBe('0.');
    fireEvent.input(field, { target: { value: '0.9' } });
    expect(field).toHaveValue(0.9);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ autoFileThreshold: 0.9 }));
    await screen.findByText('Saved.');
  });

  it('explains a rejected value', async () => {
    setup({ saveSettings: vi.fn().mockRejectedValue(new ApiError('invalid_input', 400, 'invalid_input')) });
    fireEvent.input(await screen.findByRole('spinbutton', { name: /threshold/i }), { target: { value: '0.3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/between 0.5 and 1/i)).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
