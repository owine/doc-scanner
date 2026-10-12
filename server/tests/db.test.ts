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
    expect(v.v).toBe(7);
  });

  it('migration 002 creates drive cache tables', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('entities_cache');
    expect(names).toContain('event_cursors');

    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(7);
  });

  it('migration 006 adds documents.drive_url', () => {
    const { db, cleanup } = createTestDb();
    cleanupFn = cleanup;
    const cols = db.prepare("SELECT name FROM pragma_table_info('documents')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('drive_url');
  });

  it('migration 007 adds documents.prepare_note and has_thumbnail', () => {
    const { db, cleanup } = createTestDb();
    try {
      const cols = (db.prepare("SELECT name FROM pragma_table_info('documents')").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['prepare_note', 'has_thumbnail']));
      db.prepare(
        `INSERT INTO documents (id, seq, created_at, updated_at, source, mime, size, sha256, state, next_attempt_at)
         VALUES ('d1', 1, 't', 't', 'picker', 'application/pdf', 10, 'abc', 'received', 't')`,
      ).run();
      expect(() => db.prepare('UPDATE documents SET has_thumbnail = 2 WHERE id = ?').run('d1')).toThrow();
      expect(() => db.prepare('UPDATE documents SET has_thumbnail = 1 WHERE id = ?').run('d1')).not.toThrow();
    } finally {
      cleanup();
    }
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

    expect(secondCount).toBe(7);
    expect(secondCount).toBe(firstCount);
    expect(secondApplied).toBe(firstApplied);
  });

  it('creates the document pipeline tables', () => {
    const { db, cleanup } = createTestDb();
    try {
      const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table')`).all() as { name: string }[]).map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['documents', 'document_seq', 'folder_cache', 'classification_history']));
    } finally {
      cleanup();
    }
  });

  const insertDoc = (db: ReturnType<typeof createTestDb>['db'], state: string, discardedAt: string | null) =>
    db.prepare(
      `INSERT INTO documents (id, seq, created_at, updated_at, source, mime, size, sha256, state, next_attempt_at, discarded_at)
       VALUES ('d1', 1, 't', 't', 'picker', 'application/pdf', 10, 'abc', ?, 't', ?)`,
    ).run(state, discardedAt);

  it('seeds document_seq at 0', () => {
    const { db, cleanup } = createTestDb();
    try {
      expect(db.prepare('SELECT value FROM document_seq WHERE id = 1').get()).toEqual({ value: 0 });
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown document state', () => {
    const { db, cleanup } = createTestDb();
    try {
      expect(() => insertDoc(db, 'bogus', null)).toThrow();
      expect(() => insertDoc(db, 'received', null)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('rejects a discarded row without discarded_at', () => {
    const { db, cleanup } = createTestDb();
    try {
      expect(() => insertDoc(db, 'discarded', null)).toThrow();
      expect(() => insertDoc(db, 'discarded', 't')).not.toThrow();
    } finally {
      cleanup();
    }
  });
});
