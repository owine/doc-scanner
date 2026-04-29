import { useEffect, useState, useCallback } from 'preact/hooks';

export type ThemePreference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'theme';

function readStored(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function effective(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyToDom(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = effective(pref) === 'dark' ? '#0f0f0f' : '#ffffff';
}

export function useTheme(): { pref: ThemePreference; setPref: (p: ThemePreference) => void } {
  const [pref, setPrefState] = useState<ThemePreference>(readStored);

  useEffect(() => { applyToDom(pref); }, [pref]);

  // Re-apply when system preference changes (only relevant if pref === 'system')
  useEffect(() => {
    if (pref !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyToDom('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePreference) => {
    if (p === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, p);
    setPrefState(p);
  }, []);

  return { pref, setPref };
}
