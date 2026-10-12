import { spawn } from 'node:child_process';

export class ToolMissingError extends Error {
  override name = 'ToolMissingError';
}

export class ToolTimeoutError extends Error {
  override name = 'ToolTimeoutError';
}

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
  /** Added to the allowlisted inherited environment, e.g. TMPDIR pointing at the job's private directory. */
  env?: Record<string, string>;
  /** Test hook: called with each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
}

/**
 * Output kept per stream. The end is kept, not the start: a tool says what
 * went wrong last, after any warnings.
 */
export const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * The only inherited variables a tool gets. These tools parse untrusted PDFs
 * and images, so the server's secrets (SESSION_ENCRYPTION_KEY,
 * ANTHROPIC_API_KEY, ...) must never reach them.
 */
const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

function toolEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // ocrmypdf parallelises pages itself; one thread per tesseract avoids oversubscription.
  return { ...env, OMP_THREAD_LIMIT: '1', ...extra };
}

const keepEnd = (buf: string, chunk: string) => (buf + chunk).slice(-MAX_OUTPUT_CHARS);

/**
 * Runs a program with fixed arguments: no shell, so nothing in an argument is
 * interpreted. A non-zero exit resolves (the caller decides what it means);
 * a missing program or a timeout rejects. On timeout the whole process group
 * is killed, so a tool's own children (ocrmypdf runs tesseract) go too.
 *
 * The output is for the caller to classify only: never log or report it, it
 * can quote a document.
 */
export function runTool(cmd: string, args: readonly string[], o: RunOptions): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      detached: true, // its own process group, killed as one on timeout
      stdio: ['ignore', 'pipe', 'pipe'],
      env: toolEnv(o.env),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (s: string) => {
      stdout = keepEnd(stdout, s);
      o.onStdout?.(s);
    });
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      stderr = keepEnd(stderr, s);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, o.timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new ToolMissingError(`${cmd} is not installed`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new ToolTimeoutError(`${cmd} took longer than ${o.timeoutMs} ms`));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
