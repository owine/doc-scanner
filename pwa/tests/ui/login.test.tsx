import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { LoginScreen } from '../../src/ui/LoginScreen.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('LoginScreen', () => {
  it('shows the credential warning prominently', () => {
    render(<LoginScreen onLoggedIn={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/unofficial/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/never stored/i);
  });

  it('renders email and password inputs', () => {
    const { container } = render(<LoginScreen onLoggedIn={() => {}} />);
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('moves focus to the 2FA code field when it appears', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"totp_required"}', { status: 422 })));
    const { container } = render(<LoginScreen onLoggedIn={() => {}} />);
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(email, { target: { value: 'a@b.co' } });
    fireEvent.input(password, { target: { value: 'pw' } });
    password.focus();
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    const totp = await screen.findByLabelText('TOTP');
    await waitFor(() => expect(totp).toHaveFocus());
    expect(totp).toHaveAttribute('autocomplete', 'one-time-code');
  });
});
