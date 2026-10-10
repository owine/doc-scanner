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
    expect(() => s.update({ autoFileThreshold: 0.3 })).toThrow();
    expect(() => s.update({ excludePaths: ['relative/path'] })).toThrow();
    expect(s.get()).toEqual(defaults);
  });

  it('rejects a null threshold instead of coercing it to 0', () => {
    const s = store();
    expect(() => s.update({ autoFileThreshold: null })).toThrow();
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

  it('persists across a new store on the same db', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    new SettingsStore(t.db, defaults).update({ effort: 'high' });
    expect(new SettingsStore(t.db, defaults).get().effort).toBe('high');
  });

  it('saves nothing when any field of a mixed patch is invalid', () => {
    const s = store();
    expect(() => s.update({ effort: 'low', autoFileThreshold: 2 })).toThrow();
    expect(s.get()).toEqual(defaults);
  });

  it('rejects unknown keys, __proto__ and wrongly typed values', () => {
    const s = store();
    expect(() => s.update({ foo: 1 })).toThrow();
    expect(() => s.update(JSON.parse('{"__proto__":{"x":1}}'))).toThrow();
    expect(() => s.update({ autoFileEnabled: 'true' })).toThrow();
    expect(s.get()).toEqual(defaults);
  });

  it('normalises never-file-here paths', () => {
    const s = store();
    s.update({ excludePaths: ['/Archive/', ' /Archive ', '/Tax/2024'] });
    expect(s.get().excludePaths).toEqual(['/Archive', '/Tax/2024']);
    for (const bad of ['/', '//x', 'relative', '/a//b', '/a\nb', '']) {
      expect(() => s.update({ excludePaths: [bad] })).toThrow();
    }
    expect(s.get().excludePaths).toEqual(['/Archive', '/Tax/2024']);
  });

  it('falls back to defaults for corrupt or unknown saved rows', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    const ins = t.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
    ins.run('filing.effort', '{bad');
    ins.run('filing.autoFileEnabled', '"yes"');
    ins.run('filing.constructor', '1');
    ins.run('FILING.model', '"x"');
    expect(new SettingsStore(t.db, defaults).get()).toEqual(defaults);
  });
});
