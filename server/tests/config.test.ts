import { describe, it, expect } from 'vitest';
import { loadConfig, autoFileThresholdSchema } from '../src/config.js';

describe('loadConfig', () => {
  it('rejects missing SESSION_ENCRYPTION_KEY', () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: 'x' })).toThrow(/SESSION_ENCRYPTION_KEY/);
  });

  it('rejects non-32-byte SESSION_ENCRYPTION_KEY', () => {
    expect(() =>
      loadConfig({ SESSION_ENCRYPTION_KEY: Buffer.from('short').toString('base64'), ANTHROPIC_API_KEY: 'x' }),
    ).toThrow(/32 bytes/);
  });

  it('accepts valid config', () => {
    const cfg = loadConfig({
      SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      ANTHROPIC_API_KEY: 'x',
    });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.TRUST_PROXY).toBe(true);
  });

  const base = { SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), ANTHROPIC_API_KEY: 'x' };

  it('defaults the analyzer to Haiku 5.5 at medium effort with auto-filing off', () => {
    const cfg = loadConfig(base);
    expect(cfg.ANALYZER_MODEL).toBe('claude-haiku-5-5');
    expect(cfg.ANALYZER_EFFORT).toBe('medium');
    expect(cfg.AUTO_FILE_THRESHOLD).toBe(0.8);
    expect(cfg.AUTO_FILE_ENABLED).toBe(false);
  });

  it('rejects a threshold outside 0.5..1', () => {
    expect(() => loadConfig({ ...base, AUTO_FILE_THRESHOLD: '1.5' })).toThrow(/AUTO_FILE_THRESHOLD/);
    // Below 0.5 the model is guessing more often than not: never file on that.
    expect(() => loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.4' })).toThrow(/AUTO_FILE_THRESHOLD/);
    expect(() => loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0' })).toThrow(/AUTO_FILE_THRESHOLD/);
  });

  it('treats a blank threshold as unset', () => {
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '' }).AUTO_FILE_THRESHOLD).toBe(0.8);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '  ' }).AUTO_FILE_THRESHOLD).toBe(0.8);
  });

  it('accepts the threshold bounds and float-awkward two-decimal values', () => {
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.5' }).AUTO_FILE_THRESHOLD).toBe(0.5);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '1' }).AUTO_FILE_THRESHOLD).toBe(1);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.57' }).AUTO_FILE_THRESHOLD).toBe(0.57);
  });

  it('parses AUTO_FILE_ENABLED true and 1 as true', () => {
    expect(loadConfig({ ...base, AUTO_FILE_ENABLED: 'true' }).AUTO_FILE_ENABLED).toBe(true);
    expect(loadConfig({ ...base, AUTO_FILE_ENABLED: '1' }).AUTO_FILE_ENABLED).toBe(true);
  });

  it('rejects a blank ANALYZER_MODEL', () => {
    expect(() => loadConfig({ ...base, ANALYZER_MODEL: '  ' })).toThrow(/ANALYZER_MODEL/);
  });

  it('keeps the shared threshold schema strict (no coercion)', () => {
    for (const bad of [null, '', false, '0.8']) {
      expect(autoFileThresholdSchema.safeParse(bad).success).toBe(false);
    }
    expect(autoFileThresholdSchema.safeParse(0.8).success).toBe(true);
  });

  it('treats blank proxy settings as unset (Compose passes unset variables as empty)', () => {
    const cfg = loadConfig({ ...base, AUTH_PROXY_USER: '', AUTH_PROXY_SECRET: '  ' });
    expect(cfg.AUTH_PROXY_USER).toBeUndefined();
    expect(cfg.AUTH_PROXY_SECRET).toBeUndefined();
  });

  it('reads the proxy user and a long enough secret', () => {
    const cfg = loadConfig({ ...base, AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: 's'.repeat(32) });
    expect(cfg.AUTH_PROXY_USER).toBe('owine');
    expect(cfg.AUTH_PROXY_SECRET).toBe('s'.repeat(32));
  });

  it('rejects a proxy secret shorter than 32 characters', () => {
    expect(() => loadConfig({ ...base, AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: 'short' })).toThrow(
      /AUTH_PROXY_SECRET: must be at least 32 characters/,
    );
  });

  it('rejects a proxy secret without a proxy user, which would do nothing', () => {
    expect(() => loadConfig({ ...base, AUTH_PROXY_SECRET: 's'.repeat(32) })).toThrow(/AUTH_PROXY_SECRET: needs AUTH_PROXY_USER/);
  });

  it('rejects surrounding whitespace in the proxy settings with a clear error', () => {
    expect(() => loadConfig({ ...base, AUTH_PROXY_USER: 'owine\n' })).toThrow(/AUTH_PROXY_USER: must not have leading or trailing whitespace/);
    expect(() => loadConfig({ ...base, AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: ' ' + 's'.repeat(32) })).toThrow(
      /AUTH_PROXY_SECRET: must not have leading or trailing whitespace/,
    );
  });

  it('rejects a threshold with more than two decimals', () => {
    expect(() => loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.875' })).toThrow(/AUTO_FILE_THRESHOLD/);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.85' }).AUTO_FILE_THRESHOLD).toBe(0.85);
  });
});
