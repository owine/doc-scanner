import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { SETTING, deleteSetting, readSetting, takeSetting, writeSetting } from '../../src/auth/app-settings.js';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe('app settings', () => {
  it('reads, overwrites, takes once and deletes a value', () => {
    const t = createTestDb();
    cleanup = t.cleanup;
    expect(readSetting(t.db, SETTING.protonUserId)).toBeNull();
    writeSetting(t.db, SETTING.protonUserId, 'user-1');
    writeSetting(t.db, SETTING.protonUserId, 'user-2');
    expect(readSetting(t.db, SETTING.protonUserId)).toBe('user-2');
    writeSetting(t.db, SETTING.removedNotice, 'password_changed');
    expect(takeSetting(t.db, SETTING.removedNotice)).toBe('password_changed');
    expect(takeSetting(t.db, SETTING.removedNotice)).toBeNull();
    deleteSetting(t.db, SETTING.protonUserId);
    expect(readSetting(t.db, SETTING.protonUserId)).toBeNull();
  });
});
