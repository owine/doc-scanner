import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db.js';

let cleanupFn: (() => void) | null = null;
afterEach(() => { cleanupFn?.(); cleanupFn = null; });

describe('openDb', () => {
  it('runs initial migration creating expected tables', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('sessions');
    expect(names).toContain('audit_log');
    expect(names).toContain('schema_version');
  });

  it('records applied schema version', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(1);
  });
});
