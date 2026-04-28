import { openDb, type DB } from '../../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createTestDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'docscanner-test-'));
  const db = openDb(join(dir, 'test.db'));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createTestDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'docscanner-test-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
