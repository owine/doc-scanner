import { z } from 'zod';
import { autoFileThresholdSchema } from '../config.js';
import type { DB } from '../db.js';
import { logger } from '../logger.js';

export interface EffectiveSettings {
  model: string;
  effort: 'low' | 'medium' | 'high';
  autoFileThreshold: number;
  autoFileEnabled: boolean;
  /** "Never file here": absolute Drive paths; they and their subtrees are hidden from the analyzer. */
  excludePaths: string[];
}

// One entry of "never file here": absolute, no empty segments or control characters,
// no trailing slash. The root is rejected because excluding it would exclude everything.
const excludePathSchema = z
  .string()
  .trim()
  .regex(/^\/.*$/, 'must be an absolute folder path')
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), 'must not contain control characters')
  .transform((p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p))
  .refine((p) => p !== '/', 'must not be the root')
  .refine((p) => !p.slice(1).split('/').some((seg) => seg === ''), 'must not have empty segments');

const FieldsSchema = z.object({
  model: z.string().trim().min(1),
  effort: z.enum(['low', 'medium', 'high']),
  // Same rule as the env var: 0..1, at most two decimals (the prompt prints it with toFixed(2)).
  autoFileThreshold: autoFileThresholdSchema,
  autoFileEnabled: z.boolean(),
  excludePaths: z.array(excludePathSchema).transform((a) => [...new Set(a)]),
});
const FIELDS = FieldsSchema.shape;
const PatchSchema = FieldsSchema.partial().strict();

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
      .prepare(`SELECT key, value FROM app_settings WHERE substr(key, 1, 7) = 'filing.'`)
      .all() as { key: string; value: string }[];
    const saved: Record<string, unknown> = {};
    for (const r of rows) {
      const name = r.key.slice(PREFIX.length);
      if (!Object.hasOwn(FIELDS, name)) continue;
      try {
        const parsed = FIELDS[name as Key].safeParse(JSON.parse(r.value));
        if (!parsed.success) throw new Error('invalid');
        saved[name] = parsed.data;
      } catch {
        logger.warn({ key: r.key }, 'ignoring unreadable saved setting; using default');
      }
    }
    return { ...this.defaults, ...(saved as Partial<EffectiveSettings>) };
  }

  update(patch: unknown): EffectiveSettings {
    const valid = PatchSchema.parse(patch);
    const upsert = this.db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.db.exec('BEGIN');
    try {
      for (const [key, value] of Object.entries(valid)) upsert.run(PREFIX + key, JSON.stringify(value));
      this.db.exec('COMMIT');
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get();
  }

  clear(key: Key): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(PREFIX + key);
  }
}
