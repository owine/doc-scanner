import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { SettingsStore, type EffectiveSettings } from '../../src/settings/settings-store.js';

const defaults: EffectiveSettings = {
  model: 'claude-haiku-5-5',
  effort: 'medium',
  autoFileThreshold: 0.8,
  autoFileEnabled: false,
  excludePaths: [],
};

let cleanup: () => void = () => {};
afterEach(() => cleanup());

function store() {
  const t = createTestDb();
  cleanup = t.cleanup;
  return new SettingsStore(t.db, defaults);
}

describe('SettingsStore', () => {
  it('returns the env defaults when nothing is saved', () => {
    expect(store().get()).toEqual(defaults);
  });

  it('saved values override defaults and persist', () => {
    const s = store();
    s.update({ autoFileEnabled: true, excludePaths: ['/Archive'] });
    expect(s.get()).toEqual({ ...defaults, autoFileEnabled: true, excludePaths: ['/Archive'] });
  });

  it('rejects invalid values without saving anything', () => {
    const s = store();
    expect(() => s.update({ autoFileThreshold: 2 })).toThrow();
    expect(() => s.update({ autoFileThreshold: 0.875 })).toThrow();
    expect(() => s.update({ excludePaths: ['relative/path'] })).toThrow();
    expect(s.get()).toEqual(defaults);
  });

  it('rejects a null threshold instead of coercing it to 0', () => {
    const s = store();
    expect(() => s.update({ autoFileThreshold: null as unknown as number })).toThrow();
    expect(s.get()).toEqual(defaults);
  });

  it("leaves other modules' app_settings rows alone", () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    t.db.prepare(`INSERT INTO app_settings (key, value) VALUES ('drive_client_uid', 'not-json')`).run();
    const s = new SettingsStore(t.db, defaults);
    expect(s.get()).toEqual(defaults);
    s.update({ effort: 'low' });
    expect((t.db.prepare(`SELECT value FROM app_settings WHERE key = 'drive_client_uid'`).get() as { value: string }).value).toBe('not-json');
  });

  it('clearing an override falls back to the default', () => {
    const s = store();
    s.update({ effort: 'low' });
    s.clear('effort');
    expect(s.get().effort).toBe('medium');
  });
});
