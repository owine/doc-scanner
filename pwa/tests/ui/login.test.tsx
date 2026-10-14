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

  it('offers Cancel only over a signed-in app', () => {
    const { unmount } = render(<LoginScreen onLoggedIn={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    unmount();
    const onCancel = vi.fn();
    render(<LoginScreen onLoggedIn={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('says why when Proton ended the session', () => {
    const { unmount } = render(<LoginScreen onLoggedIn={() => {}} />);
    expect(screen.queryByText('Proton ended the session. Sign in again to resume filing.')).toBeNull();
    unmount();
    render(<LoginScreen onLoggedIn={() => {}} reason="proton_ended" />);
    expect(screen.getByText('Proton ended the session. Sign in again to resume filing.')).toBeInTheDocument();
  });

  async function failWith(response: () => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const { container } = render(<LoginScreen onLoggedIn={() => {}} />);
    fireEvent.input(container.querySelector('input[type="email"]') as HTMLInputElement, { target: { value: 'a@b.co' } });
    fireEvent.input(container.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'pw' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
    return container.querySelector('.error-text')?.textContent ?? '';
  }

  for (const [label, response, text] of [
    ['a refused login', () => new Response('{"error":"auth_failed","reauth_required":true}', { status: 401 }), 'Proton didn’t accept that email, password or code.'],
    ['a refused input', () => new Response('{"error":"invalid_input"}', { status: 400 }), 'Check your email and password.'],
    ['a proxy that lost the sign-in', () => new Response('{"error":"not_authenticated"}', { status: 401 }), 'This browser isn’t signed in to the server. Reload the page and try again.'],
    ['a code the screen does not know', () => new Response('{"error":"something_new"}', { status: 409 }), 'Couldn’t sign in. Try again.'],
    ['a proxy error page', () => new Response('<html>Bad Gateway</html>', { status: 502 }), 'Couldn’t sign in. Try again.'],
    ['a server failure', () => new Response('{"error":"auth_failed","reauth_required":true}', { status: 500 }), 'Couldn’t sign in. Try again.'],
    ['no answer', () => Promise.reject(new TypeError('Failed to fetch')), "Can't reach the server."],
  ] as const) {
    it(`says what went wrong in words after ${label}, never the raw code`, async () => {
      const shown = await failWith(response);
      expect(shown).toBe(text);
    });
  }

  for (const [label, response] of [
    ['the server', () => new Response('{"error":"not_authenticated"}', { status: 401 })],
    ['a proxy, with no code of the app', () => new Response('<html>401 Unauthorized</html>', { status: 401 })],
  ] as const) {
    it(`offers Reload when ${label} says this browser isn’t signed in`, async () => {
      const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
      expect(await failWith(response)).toBe('This browser isn’t signed in to the server. Reload the page and try again.');
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
    });
  }

  it('offers no Reload for other failures', async () => {
    await failWith(() => new Response('{"error":"invalid_input"}', { status: 400 }));
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
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
