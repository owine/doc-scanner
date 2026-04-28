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
});
