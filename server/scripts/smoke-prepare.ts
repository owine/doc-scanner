/**
 * Exercises the real preparation tools inside the built Docker image (CI runs
 * it on every build). Run it with an init process (`docker run --init`).
 * Prints one line per check, never document text; exits non-zero on a failure.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { runTool, ToolTimeoutError } from '../src/prepare/run.js';
import { createPrepareTools } from '../src/prepare/tools.js';

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}`);
  if (!ok) failures++;
}

/** Adds an (unsigned) signature to a PDF's form, as ocrmypdf checks for one. pikepdf comes with ocrmypdf. */
const SIGN = `
import sys, pikepdf
from pikepdf import Array, Dictionary, Name, String
pdf = pikepdf.open(sys.argv[1])
sig = pdf.make_indirect(Dictionary(Type=Name.Sig, Filter=Name('/Adobe.PPKLite'), SubFilter=Name('/adbe.pkcs7.detached'), ByteRange=Array([0, 0, 0, 0]), Contents=String(bytes(64))))
field = pdf.make_indirect(Dictionary(FT=Name.Sig, T=String('Signature1'), V=sig, Type=Name.Annot, Subtype=Name.Widget, Rect=Array([0, 0, 0, 0]), P=pdf.pages[0].obj))
pdf.pages[0].obj.Annots = Array([field])
pdf.Root.AcroForm = Dictionary(Fields=Array([field]), SigFlags=3)
pdf.save(sys.argv[2])
`;

const doc = await PDFDocument.create({ updateMetadata: false });
const font = await doc.embedFont(StandardFonts.Helvetica);
const first = doc.addPage([612, 792]);
first.drawText('Northwind Energy', { x: 56, y: 720, size: 28, font });
first.drawText('Electricity Bill - September 2026', { x: 56, y: 680, size: 18, font });
const born = await doc.save();

const tools = createPrepareTools();
const page = await tools.thumbnail(born, 'application/pdf', { width: 1275 });
check('Ghostscript renders a PDF page', page !== null);
const imageOnly = await tools.imageToPdf(page!, 'image/jpeg');
check('img2pdf makes a PDF from a JPEG', Buffer.from(imageOnly.subarray(0, 5)).toString() === '%PDF-');
check('a born-digital PDF is left unchanged', (await tools.ocrPdf(born)).kind === 'unchanged');
check('an image-only PDF gains a text layer', (await tools.ocrPdf(imageOnly)).kind === 'ocred');
check('thumbnails a PDF', (await tools.thumbnail(born, 'application/pdf')) !== null);
check('thumbnails a JPEG', (await tools.thumbnail(page!, 'image/jpeg')) !== null);
const png16 = await sharp(page!).resize({ width: 300 }).png().toColourspace('rgb16').toBuffer();
check('a 16-bit PNG becomes a PDF', Buffer.from((await tools.imageToPdf(new Uint8Array(png16), 'image/png')).subarray(0, 5)).toString() === '%PDF-');

const dir = await mkdtemp(join(tmpdir(), 'smoke-'));
try {
  // A PostScript program with a PDF header later on. Run directly, this
  // Ghostscript executes it: it prints the marker and renders a page. Through
  // the tools, the content check must stop it before Ghostscript starts, so
  // there is no thumbnail (the page it would render) and no OCR.
  const MARKER = 'SMOKE-PS-RAN';
  const polyglot = new TextEncoder().encode(`%!PS-Adobe-3.0\n(${MARKER}\\n) print flush\nshowpage\n%PDF-1.4\n`);
  await writeFile(join(dir, 'poly.pdf'), polyglot);
  const direct = await runTool('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=jpeg', '-sOutputFile=poly.jpg', 'poly.pdf'], {
    timeoutMs: 30_000,
    cwd: dir,
  });
  const rendered = (await readdir(dir)).includes('poly.jpg');
  check('Ghostscript runs the PostScript polyglot when handed it directly', direct.stdout.includes(MARKER) && rendered);
  check('the polyglot gets no thumbnail: Ghostscript never sees it', (await tools.thumbnail(polyglot, 'application/pdf')) === null);
  check('the polyglot is not OCRed', await tools.ocrPdf(polyglot).then(() => false, (err: unknown) => err instanceof Error && err.message === 'not a PDF'));

  await writeFile(join(dir, 'in.pdf'), born);
  const enc = await runTool('qpdf', ['--encrypt', 'u', 'o', '256', '--', 'in.pdf', 'enc.pdf'], { timeoutMs: 30_000, cwd: dir });
  check('qpdf encrypts a copy', enc.code === 0);
  check('an encrypted PDF is kept as it is', (await tools.ocrPdf(new Uint8Array(await readFile(join(dir, 'enc.pdf'))))).kind === 'protected');

  const sign = await runTool('python3', ['-I', '-c', SIGN, 'in.pdf', 'signed.pdf'], { timeoutMs: 30_000, cwd: dir });
  check('pikepdf adds a signature field', sign.code === 0);
  check('a signed PDF is kept as it is', (await tools.ocrPdf(new Uint8Array(await readFile(join(dir, 'signed.pdf'))))).kind === 'protected');

  // ocrmypdf must keep its work files (page images, recognised text) under
  // TMPDIR, so a killed job leaves nothing in the shared temporary directory.
  const many = await PDFDocument.create();
  const image = await many.embedJpg(page!);
  for (let i = 0; i < 40; i++) many.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  await writeFile(join(dir, 'many.pdf'), await many.save());
  const before = new Set(await readdir(tmpdir()));
  let killed = false;
  try {
    await runTool('ocrmypdf', ['--skip-text', '--output-type', 'pdf', '--jobs', '2', '-l', 'eng', 'many.pdf', 'out.pdf'], {
      timeoutMs: 2000,
      cwd: dir,
      env: { TMPDIR: dir },
    });
  } catch (err) {
    killed = err instanceof ToolTimeoutError;
  }
  const outside = (await readdir(tmpdir())).filter((f) => f.startsWith('ocrmypdf') && !before.has(f));
  const inside = (await readdir(dir)).filter((f) => f.startsWith('ocrmypdf'));
  check('a killed OCR leaves its work files only in its job directory', killed && outside.length === 0 && inside.length > 0);
} finally {
  await rm(dir, { recursive: true, force: true });
}

process.exit(failures > 0 ? 1 : 0);
