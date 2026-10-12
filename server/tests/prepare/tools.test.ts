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
import { ToolMissingError, ToolTimeoutError } from '../../src/prepare/run.js';
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

  it('removes the job directory after a non-zero exit and after a timeout', async () => {
    fakeTool({}, 2, 'InputFileError: something else');
    await expect(createPrepareTools().ocrPdf(PDF)).rejects.toBeInstanceOf(ToolFailedError);
    expect(existsSync(calls[0]!.cwd!)).toBe(false);
    run.mockImplementation(async (cmd, args, o) => {
      calls.push({ cmd, args, cwd: o.cwd, tmp: o.env?.TMPDIR, mode: 0 });
      throw new ToolTimeoutError('too slow');
    });
    await expect(createPrepareTools().ocrPdf(PDF)).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(existsSync(calls[1]!.cwd!)).toBe(false);
  });

  it('fails imageToPdf on a non-zero exit, and gives no thumbnail when Ghostscript fails', async () => {
    fakeTool({}, 1);
    const tools = createPrepareTools();
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await expect(tools.imageToPdf(new Uint8Array(png), 'image/png')).rejects.toBeInstanceOf(ToolFailedError);
    expect(calls.map((c) => c.cmd)).toEqual(['img2pdf']);
    expect(await tools.thumbnail(PDF, 'application/pdf')).toBeNull();
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

describe('checking the bytes before a tool or sharp parses them', () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const POSTSCRIPT = enc('%!PS-Adobe-3.0\n%%Title: fictional\n/Helvetica findfont 12 scalefont setfont\nshowpage\n');
  const SVG = enc('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const solid = () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } });

  it('refuses a PostScript file declared as a PDF, without running a tool', async () => {
    fakeTool({ 'side.txt': 'x', 'out.pdf': 'x', 'page.jpg': 'x' });
    const tools = createPrepareTools();
    await expect(tools.ocrPdf(POSTSCRIPT)).rejects.toThrow(new ToolFailedError('not a PDF'));
    expect(await tools.thumbnail(POSTSCRIPT, 'application/pdf')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('needs the PDF header at the very first byte', async () => {
    fakeTool({ 'side.txt': '[OCR skipped on page(s) 1]' });
    const tools = createPrepareTools();
    expect(await tools.ocrPdf(PDF)).toEqual({ kind: 'unchanged' });
    // Ghostscript 10.07 runs a file as PostScript when `%!` comes before
    // `%PDF-`, whatever precedes it (measured: junk, a BOM or a NUL first all
    // ran), so nothing may come before the header, not even whitespace.
    const polyglots = {
      'PostScript, then a PDF header': enc('%!PS-Adobe-3.0\n(PS-RAN\n) print flush\nshowpage\n%PDF-1.4\n'),
      'DOS EPS magic': new Uint8Array([0xc5, 0xd0, 0xd3, 0xc6, 0x1e, 0, 0, 0, ...enc('%!PS-Adobe-3.0 EPSF-3.0\n%PDF-1.4\n')]),
      'junk before %!': enc('xx\n%!PS\n(PS-RAN\n) print flush\n%PDF-1.4\n'),
      'a BOM before %!': new Uint8Array([0xef, 0xbb, 0xbf, ...enc('%!PS\n%PDF-1.4\n')]),
      'a NUL before %!': new Uint8Array([0, ...enc('%!PS\n%PDF-1.4\n')]),
      'whitespace before the header': enc(' \n%PDF-1.4\n'),
      'junk before the header': enc('(PS-RAN\n) print flush\n%PDF-1.4\n'),
    };
    for (const [what, bytes] of Object.entries(polyglots)) {
      await expect(tools.ocrPdf(bytes), what).rejects.toThrow(new ToolFailedError('not a PDF'));
      expect([what, await tools.thumbnail(bytes, 'application/pdf')]).toEqual([what, null]);
    }
    expect(calls).toHaveLength(1);
  });

  it('refuses an SVG declared as an image, without running a tool or rendering it', async () => {
    fakeTool({ 'out.pdf': '%PDF-' });
    const tools = createPrepareTools();
    for (const mime of ['image/png', 'image/webp', 'image/gif', 'image/jpeg']) {
      await expect(tools.imageToPdf(SVG, mime)).rejects.toBeInstanceOf(ToolFailedError);
      expect([mime, await tools.thumbnail(SVG, mime)]).toEqual([mime, null]);
    }
    expect(calls).toEqual([]);
  });

  it('refuses an image whose bytes are not the type it was declared as', async () => {
    fakeTool({ 'out.pdf': '%PDF-' });
    const tools = createPrepareTools();
    const jpeg = new Uint8Array(await solid().jpeg().toBuffer());
    const png = new Uint8Array(await solid().png().toBuffer());
    const tiff = new Uint8Array(await solid().tiff().toBuffer());
    for (const [bytes, mime] of [
      [jpeg, 'image/png'],
      [png, 'image/jpeg'],
      [png, 'image/tiff'],
      [tiff, 'image/bmp'],
      [enc('BM fictional'), 'image/png'],
      [POSTSCRIPT, 'image/tiff'],
    ] as const) {
      await expect(tools.imageToPdf(bytes, mime)).rejects.toBeInstanceOf(ToolFailedError);
    }
    expect(calls).toEqual([]);
    // Each matching its declared type goes through.
    for (const [bytes, mime] of [
      [jpeg, 'image/jpeg'],
      [png, 'image/png'],
      [tiff, 'image/tiff'],
      [enc('BM fictional'), 'image/bmp'],
    ] as const) {
      await tools.imageToPdf(bytes, mime);
    }
    expect(calls.map((c) => c.args.at(-1))).toEqual(['in.jpeg', 'in.png', 'in.tiff', 'in.bmp']);
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
