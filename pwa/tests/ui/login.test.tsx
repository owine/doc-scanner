import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { LoginScreen } from '../../src/ui/LoginScreen.js';

beforeEach(() => { vi.restoreAllMocks(); });

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
});
