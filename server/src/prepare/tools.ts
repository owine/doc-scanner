import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { runTool } from './run.js';
import { ocrAddedText } from './sidecar.js';

export const OCR_TIMEOUT_MS = 5 * 60_000;
const IMG2PDF_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 30_000;
const THUMBNAIL_WIDTH = 400;

/** Every job directory starts with this, so a crashed process's can be found again. */
export const TEMP_PREFIX = 'docscanner-prepare-';
/** No job runs this long, so a directory untouched for longer belongs to a process that died. */
const STALE_TEMP_MS = 2 * OCR_TIMEOUT_MS;

/** img2pdf takes these directly (BMP through Pillow, which sharp's prebuilt binary lacks); WebP and GIF go through JPEG first. */
const IMG2PDF_NATIVE = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/bmp']);

export class ToolFailedError extends Error {
  override name = 'ToolFailedError';
}

export type OcrResult =
  | { kind: 'ocred'; pdf: Uint8Array }
  /** Every page already had text: file the original. */
  | { kind: 'unchanged' }
  /** Encrypted, digitally signed or a dynamic XFA form: OCR would break it or can't read it, so file the original. */
  | { kind: 'protected' };

export interface PrepareTools {
  ocrPdf(pdf: Uint8Array): Promise<OcrResult>;
  imageToPdf(image: Uint8Array, mime: string): Promise<Uint8Array>;
  /** A JPEG of the first page or the image, or null when the type can't be rendered. */
  thumbnail(bytes: Uint8Array, mime: string, o?: { width?: number }): Promise<Uint8Array | null>;
}

/**
 * Removes job directories a crashed process left behind (inTempDir's finally
 * never ran): they hold a document's plaintext. Only old ones, so a job
 * running in another process is left alone.
 */
export function sweepStaleTempDirs(now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      const st = lstatSync(dir); // never follow a link
      if (now - st.mtimeMs <= STALE_TEMP_MS) continue;
      if (st.isSymbolicLink()) unlinkSync(dir); // the link only, not its target
      else if (st.isDirectory()) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * A private directory (mode 0700) for one job's plaintext, always removed
 * afterwards. Tools run with it as their working directory and their TMPDIR,
 * so their own temporary files (ocrmypdf's page images and text) go with it,
 * even when a timeout kills them.
 */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  // Also before every job: a crash and a quick restart would otherwise leave
  // plaintext in the temp directory until some later start.
  sweepStaleTempDirs();
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createPrepareTools(): PrepareTools {
  sweepStaleTempDirs();
  return {
    async ocrPdf(pdf) {
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), pdf);
        const r = await runTool(
          'ocrmypdf',
          ['--skip-text', '--output-type', 'pdf', '--jobs', '2', '-l', 'eng', '--sidecar', 'side.txt', 'in.pdf', 'out.pdf'],
          { timeoutMs: OCR_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } },
        );
        // 8: encrypted with a password. A digitally signed PDF is refused (unless
        // told to invalidate the signature, which we never do), and so is a
        // dynamic XFA form; both are filed as they are.
        if (r.code === 8 || (r.code !== 0 && /digital signature|XFA/i.test(r.stderr))) return { kind: 'protected' };
        if (r.code !== 0) throw new ToolFailedError(`ocrmypdf exited ${r.code}`);
        const sidecar = await readFile(join(dir, 'side.txt'), 'utf8');
        if (!ocrAddedText(sidecar)) return { kind: 'unchanged' };
        return { kind: 'ocred', pdf: new Uint8Array(await readFile(join(dir, 'out.pdf'))) };
      });
    },

    async imageToPdf(image, mime) {
      return inTempDir(async (dir) => {
        const native = IMG2PDF_NATIVE.has(mime);
        const input = native ? image : new Uint8Array(await sharp(image).rotate().jpeg({ quality: 90 }).toBuffer());
        const name = native ? `in.${mime.split('/')[1]}` : 'in.jpeg';
        await writeFile(join(dir, name), input);
        const r = await runTool('img2pdf', ['-o', 'out.pdf', name], { timeoutMs: IMG2PDF_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } });
        if (r.code !== 0) throw new ToolFailedError(`img2pdf exited ${r.code}`);
        return new Uint8Array(await readFile(join(dir, 'out.pdf')));
      });
    },

    async thumbnail(bytes, mime, o = {}) {
      const width = o.width ?? THUMBNAIL_WIDTH;
      const fromImage = async (img: Uint8Array) =>
        new Uint8Array(await sharp(img).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer());
      if (mime.startsWith('image/')) {
        try {
          return await fromImage(bytes);
        } catch {
          return null; // HEIC, BMP and anything else sharp can't decode
        }
      }
      if (mime !== 'application/pdf') return null;
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), bytes);
        // 150 dpi renders a Letter page 1275 px wide: plenty for a 400 px card.
        // -dSAFER keeps the PDF from touching files.
        const r = await runTool(
          'gs',
          ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=jpeg', '-dJPEGQ=85', '-r150', '-dFirstPage=1', '-dLastPage=1', '-sOutputFile=page.jpg', 'in.pdf'],
          { timeoutMs: THUMBNAIL_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } },
        );
        if (r.code !== 0) return null; // encrypted, corrupt
        try {
          return await fromImage(new Uint8Array(await readFile(join(dir, 'page.jpg'))));
        } catch {
          return null;
        }
      });
    },
  };
}
