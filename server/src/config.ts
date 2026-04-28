import { z } from 'zod';

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
