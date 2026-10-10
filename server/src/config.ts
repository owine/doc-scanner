import { z } from 'zod';

// Shared with saved-settings validation. At most two decimals: the analyzer prompt
// prints the threshold with toFixed(2), so a finer value would show the model a
// different number than the gate uses. z.coerce accepts env strings and JSON numbers.
export const autoFileThresholdSchema = z.coerce
  .number()
  .min(0)
  .max(1)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'must have at most two decimal places (e.g. 0.85)');

// Compose forwards unset optional vars as '', and .default() only fires on undefined.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const ConfigSchema = z.object({
  SESSION_ENCRYPTION_KEY: z
    .string({ message: 'SESSION_ENCRYPTION_KEY is required' })
    .min(1, 'SESSION_ENCRYPTION_KEY is required')
    .refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'SESSION_ENCRYPTION_KEY must be base64-encoded 32 bytes' },
    ),
  ANTHROPIC_API_KEY: z
    .string({ message: 'ANTHROPIC_API_KEY is required' })
    .min(1, 'ANTHROPIC_API_KEY is required'),
  DB_PATH: z.string().default('./data/app.db'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TRUST_PROXY: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  INSECURE_COOKIES: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  PWA_DIST_PATH: z.string().optional(),
  ANALYZER_MODEL: z.string().trim().min(1).default('claude-haiku-5-5'),
  ANALYZER_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AUTO_FILE_THRESHOLD: z.preprocess(blankToUndefined, autoFileThresholdSchema.default(0.8)),
  // Off until the analyzer's auto-file precision has been measured on real use; saved settings can override.
  AUTO_FILE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `  - ${path}: ${issue.message}`;
    });
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
