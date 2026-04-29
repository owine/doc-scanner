import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../src/db.js';
import { createTestDb, createTestDbPath } from './helpers/test-db.js';

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
    expect(v.v).toBe(2);
  });

  it('migration 002 creates drive cache tables', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('entities_cache');
    expect(names).toContain('event_cursors');

    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(2);
  });

  it('does not re-apply migrations on re-open', () => {
    const { path, cleanup } = createTestDbPath();
    cleanupFn = cleanup;

    const db1 = openDb(path);
    const firstApplied = (db1.prepare('SELECT applied_at FROM schema_version WHERE version = 1').get() as { applied_at: string }).applied_at;
    const firstCount = (db1.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c;
    db1.close();

    const db2 = openDb(path);
    const secondApplied = (db2.prepare('SELECT applied_at FROM schema_version WHERE version = 1').get() as { applied_at: string }).applied_at;
    const secondCount = (db2.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c;
    db2.close();

    expect(secondCount).toBe(2);
    expect(secondCount).toBe(firstCount);
    expect(secondApplied).toBe(firstApplied);
  });
});
