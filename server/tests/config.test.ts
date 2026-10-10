import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

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

  it('rejects a threshold outside 0..1', () => {
    expect(() => loadConfig({ ...base, AUTO_FILE_THRESHOLD: '1.5' })).toThrow(/AUTO_FILE_THRESHOLD/);
  });

  it('treats a blank threshold as unset', () => {
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '' }).AUTO_FILE_THRESHOLD).toBe(0.8);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '  ' }).AUTO_FILE_THRESHOLD).toBe(0.8);
  });

  it('accepts the threshold bounds and float-awkward two-decimal values', () => {
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0' }).AUTO_FILE_THRESHOLD).toBe(0);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '1' }).AUTO_FILE_THRESHOLD).toBe(1);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.29' }).AUTO_FILE_THRESHOLD).toBe(0.29);
  });

  it('parses AUTO_FILE_ENABLED true and 1 as true', () => {
    expect(loadConfig({ ...base, AUTO_FILE_ENABLED: 'true' }).AUTO_FILE_ENABLED).toBe(true);
    expect(loadConfig({ ...base, AUTO_FILE_ENABLED: '1' }).AUTO_FILE_ENABLED).toBe(true);
  });

  it('rejects a blank ANALYZER_MODEL', () => {
    expect(() => loadConfig({ ...base, ANALYZER_MODEL: '  ' })).toThrow(/ANALYZER_MODEL/);
  });

  it('rejects a threshold with more than two decimals', () => {
    expect(() => loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.875' })).toThrow(/AUTO_FILE_THRESHOLD/);
    expect(loadConfig({ ...base, AUTO_FILE_THRESHOLD: '0.85' }).AUTO_FILE_THRESHOLD).toBe(0.85);
  });
});
