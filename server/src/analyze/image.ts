import sharp from 'sharp';

export class UndecodableImageError extends Error {}

export interface NormalisedImage {
  bytes: Uint8Array;
  mediaType: 'image/jpeg' | 'image/png';
}

// 1568 px is the long edge Claude's vision input is sized for; larger images
// are downscaled server-side anyway, and smaller ones lose the small print
// (dates, account numbers) that naming depends on.
const MAX_LONG_EDGE = 1568;
const MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * Prepares an image for Claude vision input. A JPEG or PNG already within the
 * size limits passes through untouched; anything else is resized to fit
 * 1568 px and re-encoded as JPEG q=85. Throws `UndecodableImageError` when
 * sharp cannot decode the bytes (including formats its prebuilt binary lacks,
 * such as HEIC).
 */
export async function normaliseImage(input: Uint8Array): Promise<NormalisedImage> {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new UndecodableImageError('sharp could not decode input bytes');
  }
  if (!meta.format) throw new UndecodableImageError('unrecognised image format');

  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (
    (meta.format === 'jpeg' || meta.format === 'png') &&
    longEdge <= MAX_LONG_EDGE &&
    input.byteLength <= MAX_BYTES
  ) {
    return { bytes: input, mediaType: meta.format === 'png' ? 'image/png' : 'image/jpeg' };
  }
  let buf: Buffer;
  try {
    buf = await sharp(input)
      // Honour EXIF orientation so a sideways phone photo reaches the model upright.
      .rotate()
      .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new UndecodableImageError('sharp could not re-encode input bytes');
  }
  return { bytes: new Uint8Array(buf), mediaType: 'image/jpeg' };
}
