/**
 * An error's class name only, for logs: messages can quote document, file or
 * folder names. Safe on anything thrown, including null and non-Errors.
 */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
