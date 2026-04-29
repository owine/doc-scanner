import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useTheme } from '../../src/theme/use-theme.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  // ensure a meta tag exists to assert against (use DOM API, not innerHTML)
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', '');
  document.head.appendChild(meta);
  // mock matchMedia: default to light
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('dark') ? false : true,
    media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

describe('useTheme', () => {
  it('defaults to system when no localStorage value', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.pref).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reads stored preference on mount', () => {
    localStorage.setItem('theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.pref).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('writes to localStorage and updates DOM when setPref(light)', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPref('light'));
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('clears localStorage and removes data-theme when setPref(system)', () => {
    localStorage.setItem('theme', 'dark');
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPref('system'));
    expect(localStorage.getItem('theme')).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('updates meta theme-color content on change', () => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPref('dark'));
    expect(meta.content).toBe('#0f0f0f');
    act(() => result.current.setPref('light'));
    expect(meta.content).toBe('#ffffff');
  });
});
