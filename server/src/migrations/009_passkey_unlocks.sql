-- Schema version 9: passkeys that can unlock the Proton keys after a restart
-- (docs/superpowers/specs/2026-10-13-passkey-unlock-design.md).
-- wrapped: the mailbox passphrase, sealed under a key derived from the
--   passkey's PRF output (never stored), then sealed again with the
--   'passkeys' at-rest cipher. label is sealed the same way as other names.
CREATE TABLE IF NOT EXISTS passkey_unlocks (
  credential_id TEXT PRIMARY KEY,
  label         BLOB NOT NULL,
  salt          BLOB NOT NULL,
  wrapped       BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
