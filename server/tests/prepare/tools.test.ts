import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, lutimesSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

vi.mock('../../src/prepare/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/prepare/run.js')>()),
  runTool: vi.fn(),
}));

import { runTool } from '../../src/prepare/run.js';
import { ToolMissingError } from '../../src/prepare/run.js';
import { createPrepareTools, sweepStaleTempDirs, TEMP_PREFIX, ToolFailedError } from '../../src/prepare/tools.js';

const run = vi.mocked(runTool);
interface Call {
  cmd: string;
  args: readonly string[];
  cwd: string | undefined;
  tmp: string | undefined;
  mode: number;
}
let calls: Call[];

/** A fake tool: records how it was run, writes `files` into its working directory, exits with `code`. */
function fakeTool(files: Record<string, string | Uint8Array>, code = 0, stderr = '') {
  run.mockImplementation(async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, tmp: o.env?.TMPDIR, mode: statSync(o.cwd!).mode & 0o777 });
    for (const [name, data] of Object.entries(files)) writeFileSync(join(o.cwd!, name), data);
    return { code, stdout: '', stderr };
  });
}

beforeEach(() => {
  calls = [];
  run.mockReset();
});

const PDF = new TextEncoder().encode('%PDF-1.7 fictional');

describe('PrepareTools (fake binaries)', () => {
  it('runs a tool in a private job directory, with TMPDIR there, and removes it afterwards', async () => {
    fakeTool({ 'side.txt': 'Northwind Energy', 'out.pdf': 'OCR' });
    await createPrepareTools().ocrPdf(PDF);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.cmd).toBe('ocrmypdf');
    expect(c.cwd!.startsWith(join(tmpdir(), TEMP_PREFIX))).toBe(true);
    expect(c.tmp).toBe(c.cwd);
    expect(c.mode).toBe(0o700);
    expect(existsSync(c.cwd!)).toBe(false);
  });

  it.each([
    ['an encrypted PDF', 8, ''],
    ['a signed PDF', 2, 'DigitalSignatureError: Input PDF has a digital signature. OCR would alter the document,'],
    ['a dynamic XFA form', 2, 'InputFileError: This PDF contains dynamic XFA forms created by Adobe LiveCycle Designer'],
  ])('keeps %s as it is', async (_what, code, stderr) => {
    fakeTool({}, code, stderr);
    expect(await createPrepareTools().ocrPdf(PDF)).toEqual({ kind: 'protected' });
  });

  it('fails on any other error exit', async () => {
    fakeTool({}, 2, 'InputFileError: something else');
    await expect(createPrepareTools().ocrPdf(PDF)).rejects.toBeInstanceOf(ToolFailedError);
  });

  it('does not treat other exits that mention a signature or XFA as protected', async () => {
    fakeTool({}, 1, 'DigitalSignatureError: Input PDF has a digital signature');
    await expect(createPrepareTools().ocrPdf(PDF)).rejects.toBeInstanceOf(ToolFailedError);
    fakeTool({}, 2, 'InputFileError: the word XFA or signature in passing');
    await expect(createPrepareTools().ocrPdf(PDF)).rejects.toBeInstanceOf(ToolFailedError);
  });

  it('reports a missing dependency (exit 3, e.g. a language pack) as a missing tool', async () => {
    fakeTool({}, 3, 'MissingDependencyError: Could not find language data for eng');
    await expect(createPrepareTools().ocrPdf(PDF)).rejects.toBeInstanceOf(ToolMissingError);
  });

  it('keeps a PDF whose pages all had text', async () => {
    fakeTool({ 'side.txt': '[OCR skipped on page(s) 1-2]\n', 'out.pdf': 'rewritten' });
    expect(await createPrepareTools().ocrPdf(PDF)).toEqual({ kind: 'unchanged' });
  });

  it('returns the OCRed PDF when text was added', async () => {
    fakeTool({ 'side.txt': 'Northwind Energy', 'out.pdf': 'OCR' });
    const r = await createPrepareTools().ocrPdf(PDF);
    expect(r.kind === 'ocred' && new TextDecoder().decode(r.pdf)).toBe('OCR');
  });

  it('hands BMP to img2pdf as it is, and converts WebP to JPEG first', async () => {
    fakeTool({ 'out.pdf': '%PDF-' });
    const tools = createPrepareTools();
    await tools.imageToPdf(new TextEncoder().encode('BM fictional'), 'image/bmp');
    const webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).webp().toBuffer();
    await tools.imageToPdf(new Uint8Array(webp), 'image/webp');
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['img2pdf', '-o', 'out.pdf', 'in.bmp'],
      ['img2pdf', '-o', 'out.pdf', 'in.jpeg'],
    ]);
    expect(calls.every((c) => c.tmp === c.cwd)).toBe(true);
  });

  it('renders a PDF thumbnail with Ghostscript in SAFER mode', async () => {
    const page = await sharp({ create: { width: 1275, height: 1650, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    fakeTool({ 'page.jpg': page });
    const t = await createPrepareTools().thumbnail(PDF, 'application/pdf');
    expect(calls[0]!.cmd).toBe('gs');
    expect(calls[0]!.args[0]).toBe('-dSAFER');
    expect(calls[0]!.tmp).toBe(calls[0]!.cwd);
    expect((await sharp(t!).metadata()).width).toBe(400);
  });

  it('bounds the Ghostscript render to a fixed box, whatever size the page claims', async () => {
    const page = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    fakeTool({ 'page.jpg': page });
    const tools = createPrepareTools();
    await tools.thumbnail(PDF, 'application/pdf');
    await tools.thumbnail(PDF, 'application/pdf', { width: 1275 });
    const args = calls.map((c) => c.args);
    // Twice the thumbnail width for a sharper downscale; 3:2 tall holds Letter and A4 portrait.
    expect(args[0]).toEqual(expect.arrayContaining(['-dFIXEDMEDIA', '-dPDFFitPage', '-g800x1200']));
    expect(args[1]).toContain('-g2550x3825');
    expect(args[0]!.some((a) => a.startsWith('-r'))).toBe(false);
  });
});

describe('sweepStaleTempDirs', () => {
  it('removes job directories left by a crashed process and keeps a running job’s', () => {
    const old = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const fresh = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const anHourAgo = new Date(Date.now() - 3600_000);
    utimesSync(old, anHourAgo, anHourAgo);
    sweepStaleTempDirs();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it('keeps an old directory without the prefix', () => {
    const other = mkdtempSync(join(tmpdir(), 'someone-elses-'));
    const anHourAgo = new Date(Date.now() - 3600_000);
    utimesSync(other, anHourAgo, anHourAgo);
    sweepStaleTempDirs();
    expect(existsSync(other)).toBe(true);
    rmSync(other, { recursive: true, force: true });
  });

  it('removes an old prefixed symlink without touching its target', () => {
    const target = mkdtempSync(join(tmpdir(), 'symlink-target-'));
    writeFileSync(join(target, 'keep.txt'), 'x');
    const link = join(tmpdir(), `${TEMP_PREFIX}link-${Date.now()}`);
    symlinkSync(target, link);
    const anHourAgo = new Date(Date.now() - 3600_000);
    lutimesSync(link, anHourAgo, anHourAgo);
    sweepStaleTempDirs();
    expect(() => statSync(link)).toThrow();
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  });

  it('sweeps before every job, not just at startup', async () => {
    const tools = createPrepareTools();
    const old = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
    const anHourAgo = new Date(Date.now() - 3600_000);
    utimesSync(old, anHourAgo, anHourAgo);
    fakeTool({ 'side.txt': 'Northwind Energy', 'out.pdf': 'OCR' });
    await tools.ocrPdf(PDF);
    expect(existsSync(old)).toBe(false);
  });
});
