import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { normaliseForClassify, UndecodableImageError } from '../../src/classify/image.js';

async function smallJpeg(): Promise<Uint8Array> {
  // 200×200 white JPEG, well under 1.5 MB.
  const buf = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(buf);
}

async function bigPng(): Promise<Uint8Array> {
  // 4000×3000 RGB PNG with random noise so it doesn't compress to nothing.
  const w = 4000, h = 3000;
  const noise = Buffer.alloc(w * h * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);
  const buf = await sharp(noise, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

describe('normaliseForClassify', () => {
  it('passes through a small JPEG unchanged', async () => {
    const input = await smallJpeg();
    const out = await normaliseForClassify(input);
    expect(out).toBe(input);
  });

  it('resizes a 4000×3000 PNG to ≤1024 long-edge JPEG ≤1.5 MB', async () => {
    const input = await bigPng();
    const out = await normaliseForClassify(input);
    expect(out.byteLength).toBeLessThanOrEqual(1.5 * 1024 * 1024);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1024);
    // 4000×3000 → fit inside 1024 → 1024×768
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(768);
  });

  it('throws UndecodableImageError on non-image bytes', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    await expect(normaliseForClassify(garbage)).rejects.toBeInstanceOf(UndecodableImageError);
  });

  it('normalises a 4000×3000 image in <500 ms (perf smoke)', async () => {
    const input = await bigPng();
    const start = performance.now();
    await normaliseForClassify(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
