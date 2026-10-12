import { describe, it, expect } from 'vitest';
import { MAX_OUTPUT_CHARS, runTool, ToolMissingError, ToolTimeoutError } from '../../src/prepare/run.js';

const node = process.execPath;

describe('runTool', () => {
  it('returns the exit code and output without throwing on a non-zero exit', async () => {
    const r = await runTool(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { timeoutMs: 10_000 });
    expect(r).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('passes arguments verbatim, with no shell', async () => {
    const r = await runTool(node, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi); rm -rf /'], { timeoutMs: 10_000 });
    expect(r.stdout).toBe('$(echo hi); rm -rf /');
  });

  it('adds the given environment variables to the inherited ones', async () => {
    const r = await runTool(node, ['-e', 'process.stdout.write(process.env.TMPDIR + " " + process.env.OMP_THREAD_LIMIT)'], {
      timeoutMs: 10_000,
      env: { TMPDIR: '/job/dir' },
    });
    expect(r.stdout).toBe('/job/dir 1');
  });

  it('keeps only the end of a long output, where a tool says what went wrong', async () => {
    const r = await runTool(node, ['-e', 'process.stderr.write("x".repeat(200000) + "END")'], { timeoutMs: 10_000 });
    expect(r.stderr).toHaveLength(MAX_OUTPUT_CHARS);
    expect(r.stderr.endsWith('END')).toBe(true);
  });

  it('rejects with ToolMissingError when the program does not exist', async () => {
    await expect(runTool('/nonexistent/doc-scanner-tool', [], { timeoutMs: 1000 })).rejects.toBeInstanceOf(ToolMissingError);
  });

  it('kills a tool that runs too long, children included', async () => {
    // The child spawns a grandchild that would outlive a plain kill.
    // On Linux a killed grandchild stays a zombie until PID 1 reaps it, so in
    // Docker run this with an init process (`docker run --init`).
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(g.pid));
      setInterval(() => {}, 1000);`;
    let grandchild = 0;
    const started = Date.now();
    await expect(
      runTool(node, ['-e', script], { timeoutMs: 300, onStdout: (s) => { grandchild = Number(s); } }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(grandchild, 0)).toThrow(); // gone
  });
});
