import type { DB } from '../db.js';

/**
 * Install-scoped values in migration 003's `app_settings`, stored as plain
 * strings (SettingsStore owns the `filing.` keys, client-uid.ts the Drive
 * client uid). None of them is secret.
 */
export const SETTING = {
  /** The Proton `User.ID` of the last login: a different one means a different account. */
  protonUserId: 'proton.user_id',
  /** SHA-256 of the primary user key's KeySalt, written when a passkey is enrolled. */
  keySaltFingerprint: 'passkeys.key_salt_fingerprint',
  /** The WebAuthn user handle: made once, so every passkey belongs to one user. */
  userHandle: 'passkeys.user_handle',
  /** Set when a login removed the passkeys because the password changed; Settings says so once. */
  removedNotice: 'passkeys.removed_notice',
} as const;

export type SettingKey = (typeof SETTING)[keyof typeof SETTING];

export function readSetting(db: DB, key: SettingKey): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeSetting(db: DB, key: SettingKey, value: string): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function deleteSetting(db: DB, key: SettingKey): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

/** Reads a value and deletes it: for something shown once. */
export function takeSetting(db: DB, key: SettingKey): string | null {
  const value = readSetting(db, key);
  if (value !== null) deleteSetting(db, key);
  return value;
}
