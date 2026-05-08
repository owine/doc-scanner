import sharp from 'sharp';

export class UndecodableImageError extends Error {}

/**
 * Image normaliser for Anthropic vision input. Output invariants:
 *   - format: JPEG or PNG (whatever the input was, if pass-through;
 *     otherwise re-encoded as JPEG q=85)
 *   - long edge: ≤ 1024 px
 *   - byte size: ≤ 1.5 MB
 *
 * Pass-through (returns the same Uint8Array reference) only when the input
 * already meets all three invariants. Re-encoded otherwise. Throws
 * `UndecodableImageError` if sharp can't decode the bytes — caller should
 * map to HTTP 422.
 *
 * Slice 2's `pdf/build.ts` adapter assumes word coordinates are normalised
 * 0–1, which Haiku produces; this normaliser only touches pixels, not text.
 */
const MAX_LONG_EDGE = 1024;
const MAX_BYTES = 1.5 * 1024 * 1024;

export async function normaliseForClassify(input: Uint8Array): Promise<Uint8Array> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new UndecodableImageError('sharp could not decode input bytes');
  }
  if (!meta.format) throw new UndecodableImageError('unrecognised image format');

  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const formatOk = meta.format === 'jpeg' || meta.format === 'png';
  if (formatOk && longEdge <= MAX_LONG_EDGE && input.byteLength <= MAX_BYTES) {
    return input;
  }
  // Re-encode as JPEG q=85. Document scans encode well as JPEG without
  // visible artifacts at this resolution; payload is meaningfully smaller
  // than PNG for photos and equivalent-or-better for scans.
  const buf = await sharp(input)
    .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return new Uint8Array(buf);
}
