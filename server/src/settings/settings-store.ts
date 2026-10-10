import { z } from 'zod';
import { autoFileThresholdSchema } from '../config.js';
import type { DB } from '../db.js';

export interface EffectiveSettings {
  model: string;
  effort: 'low' | 'medium' | 'high';
  autoFileThreshold: number;
  autoFileEnabled: boolean;
  /** "Never file here": absolute Drive paths; they and their subtrees are hidden from the analyzer. */
  excludePaths: string[];
}

const PatchSchema = z
  .object({
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high']),
    // Same rule as the env var: 0..1, at most two decimals (the prompt prints it with toFixed(2)).
    autoFileThreshold: autoFileThresholdSchema,
    autoFileEnabled: z.boolean(),
    excludePaths: z.array(z.string().regex(/^\/.+/, 'must be an absolute folder path')),
  })
  .partial()
  .strict();

type Key = keyof EffectiveSettings;

/** Keys in migration 003's app_settings, which other modules share (drive_client_uid). */
const PREFIX = 'filing.';

/**
 * Env vars supply the defaults; values saved here (from the PWA's settings
 * screen) override them. Stored as JSON, one row per setting, in
 * `app_settings` under `filing.<name>`.
 */
export class SettingsStore {
  constructor(
    private readonly db: DB,
    private readonly defaults: EffectiveSettings,
  ) {}

  get(): EffectiveSettings {
    const rows = this.db
      .prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'filing.%'`)
      .all() as { key: string; value: string }[];
    const saved: Record<string, unknown> = {};
    for (const r of rows) {
      const name = r.key.slice(PREFIX.length);
      if (name in this.defaults) saved[name] = JSON.parse(r.value);
    }
    return { ...this.defaults, ...(saved as Partial<EffectiveSettings>) };
  }

  update(patch: Partial<EffectiveSettings>): EffectiveSettings {
    const valid = PatchSchema.parse(patch);
    const upsert = this.db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.db.exec('BEGIN');
    try {
      for (const [key, value] of Object.entries(valid)) upsert.run(PREFIX + key, JSON.stringify(value));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get();
  }

  clear(key: Key): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(PREFIX + key);
  }
}
