import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Not import.meta.url: under happy-dom it isn't a file: URL. InboxScreen.test.tsx uses __dirname too.
const css = readFileSync(resolve(__dirname, '../../src/theme/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first block matching `re` (group 1 is the body), as name → value. */
function declarations(re: RegExp): Map<string, string> {
  const body = css.match(re)?.[1];
  if (body === undefined) throw new Error(`no block matches ${re}`);
  const out = new Map<string, string>();
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    out.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim().replace(/\s+/g, ' '));
  }
  return out;
}

const light = declarations(/(?:^|\n)\s*:root\s*\{([^}]*)\}/);
const systemDark = declarations(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/);
const chosenDark = declarations(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);

/** Tokens that are deliberately the same in both themes: camera surfaces, type, spacing, radii, motion. */
const SAME_IN_BOTH = /^--(ink-(bg|fg|line|success|warning|danger)|font-|fs-|sp-|r-|ease-|dur-)/;

describe('tokens.css', () => {
  it('defines the owine light palette on bare :root', () => {
    expect(light.get('--paper')).toBe('#f6f4ef');
    expect(light.get('--ink')).toBe('#0e1620');
    expect(light.get('--accent')).toBe('#2b5fd9');
    expect(light.get('color-scheme')).toBe('light');
  });

  it('keeps the system-dark and chosen-dark blocks identical', () => {
    expect([...systemDark.entries()].sort()).toEqual([...chosenDark.entries()].sort());
    expect(systemDark.get('color-scheme')).toBe('dark');
  });

  it('only overrides tokens that bare :root declares', () => {
    for (const name of systemDark.keys()) expect(light.has(name), name).toBe(true);
  });

  it('uses a dark control border that clears 3:1', () => {
    expect(systemDark.get('--line-strong')).toBe('#626e80');
  });

  it('overrides every theme-dependent token in dark', () => {
    for (const name of light.keys()) if (!SAME_IN_BOTH.test(name)) expect(systemDark.has(name), name).toBe(true);
  });

  it('declares only well-formed names and values', () => {
    for (const block of [light, systemDark, chosenDark]) {
      for (const [name, value] of block) {
        expect(name).toMatch(/^(--[a-z0-9-]+|color-scheme)$/);
        expect(value, name).not.toMatch(/--|:/);
      }
    }
  });

  it('has exactly one dark media query', () => {
    expect(css.match(/prefers-color-scheme:\s*dark/g)).toHaveLength(1);
  });
});
