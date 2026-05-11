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
    expect(v.v).toBe(4);
  });

  it('migration 002 creates drive cache tables', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('entities_cache');
    expect(names).toContain('event_cursors');

    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(4);
  });

  it('migration 003 keys event cursors by scope and adds app_settings', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('app_settings');

    const columns = db.prepare('PRAGMA table_info(event_cursors)').all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain('scope_id');
    expect(columnNames).not.toContain('id');
  });

  it('migration 004 adds classification history with an FTS5 index kept in sync', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    db.prepare(
      'INSERT INTO classification_history (ocr_snippet, final_name, folder_link_id, folder_path, drive_node_uid) VALUES (?, ?, ?, ?, ?)',
    ).run('Form W-2 wage and tax statement', 'W2 2026', 'f-tax', '/Tax', 'node-1');

    // The insert trigger populates the external-content index; porter stemming
    // lets "wages" match "wage".
    const hits = db.prepare(
      "SELECT rowid FROM classification_history_fts WHERE classification_history_fts MATCH 'wages'",
    ).all() as { rowid: number }[];
    expect(hits).toHaveLength(1);
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

    expect(secondCount).toBe(4);
    expect(secondCount).toBe(firstCount);
    expect(secondApplied).toBe(firstApplied);
  });
});
