import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { runTool, ToolMissingError } from './run.js';
import { ocrAddedText } from './sidecar.js';

export const OCR_TIMEOUT_MS = 5 * 60_000;
const IMG2PDF_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 30_000;
const THUMBNAIL_WIDTH = 400;

/** Every job directory starts with this, so a crashed process's can be found again. */
export const TEMP_PREFIX = 'docscanner-prepare-';
/** No job runs this long, so a directory untouched for longer belongs to a process that died. */
const STALE_TEMP_MS = 2 * OCR_TIMEOUT_MS;

export class ToolFailedError extends Error {
  override name = 'ToolFailedError';
}

/*
 * The tool is picked by the type the client declared, but Ghostscript and
 * sharp go by the bytes: a PostScript file declared as a PDF would run as a
 * program in gs, and sharp would render an SVG. So the bytes are checked first.
 */

const PDF_HEADER = [...new TextEncoder().encode('%PDF-')];

/**
 * `%PDF-` at the very first byte. Readers tolerate junk before the header,
 * but Ghostscript 10.07 then runs the file as PostScript whenever `%!` comes
 * before `%PDF-`, even after junk, a BOM or a NUL (measured in the image), and
 * ocrmypdf may hand its input to Ghostscript too. A real PDF starts with its
 * header; one that doesn't is filed as it is.
 */
function looksLikePdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, PDF_HEADER);
}

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

/**
 * img2pdf takes these types directly (BMP through Pillow, which sharp's
 * prebuilt binary lacks); WebP and GIF go through JPEG first. Each with its
 * magic bytes: JPEG FF D8 FF; PNG 89 50 4E 47 0D 0A 1A 0A; TIFF "II*\0"
 * (49 49 2A 00, little-endian) or "MM\0*" (4D 4D 00 2A, big-endian); BMP
 * "BM" (42 4D).
 */
const IMG2PDF_NATIVE: Record<string, readonly (readonly number[])[]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/tiff': [
    [0x49, 0x49, 0x2a, 0x00],
    [0x4d, 0x4d, 0x00, 0x2a],
  ],
  'image/bmp': [[0x42, 0x4d]],
};

/** The formats sharp may decode here; anything else (SVG above all) is refused. */
const SHARP_FORMATS = new Set(['jpeg', 'png', 'webp', 'tiff', 'gif', 'heif']);

/** Whether sharp sees a raster format it may decode (it reads the header only). */
async function sharpMayDecode(bytes: Uint8Array): Promise<boolean> {
  try {
    const { format } = await sharp(bytes).metadata();
    return format !== undefined && SHARP_FORMATS.has(format);
  } catch {
    return false;
  }
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
 * running in another process is left alone; with `all`, every one (at server
 * startup, when no job of ours can be running yet, so a crash and a quick
 * restart leave nothing behind).
 */
export function sweepStaleTempDirs(o: { all?: boolean; now?: number } = {}): void {
  const now = o.now ?? Date.now();
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
      if (!o.all && now - st.mtimeMs <= STALE_TEMP_MS) continue;
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

/**
 * `atStartup`: the server process owns the temp directory and no job runs
 * before it starts, so every job directory there is a dead one. Only the
 * server's own start says so; anything else (tests, scripts) may share the
 * directory with a running job.
 */
export function createPrepareTools(o: { atStartup?: boolean } = {}): PrepareTools {
  sweepStaleTempDirs({ all: o.atStartup === true });
  return {
    async ocrPdf(pdf) {
      if (!looksLikePdf(pdf)) throw new ToolFailedError('not a PDF');
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), pdf);
        const r = await runTool(
          'ocrmypdf',
          ['--skip-text', '--output-type', 'pdf', '--jobs', '2', '-l', 'eng', '--sidecar', 'side.txt', 'in.pdf', 'out.pdf'],
          { timeoutMs: OCR_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } },
        );
        // 8: encrypted with a password. A digitally signed PDF is refused (unless
        // told to invalidate the signature, which we never do), and so is a
        // dynamic XFA form (both exit 2); both are filed as they are.
        if (r.code === 8 || (r.code === 2 && /DigitalSignatureError|dynamic XFA forms/.test(r.stderr))) return { kind: 'protected' };
        // 3: a missing dependency, e.g. Tesseract or the language pack.
        if (r.code === 3) throw new ToolMissingError('ocrmypdf is missing a dependency');
        if (r.code !== 0) throw new ToolFailedError(`ocrmypdf exited ${r.code}`);
        const sidecar = await readFile(join(dir, 'side.txt'), 'utf8');
        if (!ocrAddedText(sidecar)) return { kind: 'unchanged' };
        return { kind: 'ocred', pdf: new Uint8Array(await readFile(join(dir, 'out.pdf'))) };
      });
    },

    async imageToPdf(image, mime) {
      const img2pdf = (input: Uint8Array, name: string) =>
        inTempDir(async (dir) => {
          await writeFile(join(dir, name), input);
          const r = await runTool('img2pdf', ['-o', 'out.pdf', name], { timeoutMs: IMG2PDF_TIMEOUT_MS, cwd: dir, env: { TMPDIR: dir } });
          if (r.code !== 0) throw new ToolFailedError(`img2pdf exited ${r.code}`);
          return new Uint8Array(await readFile(join(dir, 'out.pdf')));
        });
      const signatures = Object.hasOwn(IMG2PDF_NATIVE, mime) ? IMG2PDF_NATIVE[mime] : undefined;
      if (signatures) {
        if (!signatures.some((sig) => startsWith(image, sig))) throw new ToolFailedError('not the image type it was declared as');
        try {
          return await img2pdf(image, `in.${mime.split('/')[1]}`);
        } catch (err) {
          // img2pdf refuses some images it takes directly (a 16-bit PNG, for
          // one): retry once as a JPEG, if sharp can read it (not BMP). A
          // missing or timed-out img2pdf won't do better the second time.
          if (!(err instanceof ToolFailedError) || !(await sharpMayDecode(image))) throw err;
        }
      } else if (!(await sharpMayDecode(image))) {
        throw new ToolFailedError('not the image type it was declared as');
      }
      return img2pdf(new Uint8Array(await sharp(image).rotate().jpeg({ quality: 90 }).toBuffer()), 'in.jpeg');
    },

    async thumbnail(bytes, mime, o = {}) {
      const width = o.width ?? THUMBNAIL_WIDTH;
      const fromImage = async (img: Uint8Array) =>
        new Uint8Array(await sharp(img).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer());
      if (mime.startsWith('image/')) {
        if (!(await sharpMayDecode(bytes))) return null; // an SVG, or BMP, which sharp's prebuilt binary lacks
        try {
          return await fromImage(bytes);
        } catch {
          return null; // HEIC, BMP and anything else sharp can't decode
        }
      }
      if (mime !== 'application/pdf' || !looksLikePdf(bytes)) return null;
      return inTempDir(async (dir) => {
        await writeFile(join(dir, 'in.pdf'), bytes);
        // Render into a fixed box, so a page that claims a huge size can't make
        // a huge bitmap: twice the wanted width (a sharper downscale), 3:2 tall
        // (holds Letter and A4 portrait, which fit by width and leave white at
        // the bottom; a landscape page fits by width and leaves more).
        // -dSAFER keeps the PDF from touching files.
        const boxW = width * 2;
        const boxH = Math.round(boxW * 1.5);
        const r = await runTool(
          'gs',
          ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=jpeg', '-dJPEGQ=85', '-dFIXEDMEDIA', '-dPDFFitPage', `-g${boxW}x${boxH}`, '-dFirstPage=1', '-dLastPage=1', '-sOutputFile=page.jpg', 'in.pdf'],
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
