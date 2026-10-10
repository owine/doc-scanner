const BY_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tif',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

const GENERIC = 'application/octet-stream';

/** `type/subtype` without parameters, lowercased; '' when there is none. */
function bareMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/** A name's extension, lowercased with its dot, or null. A leading dot alone is not one. */
function extensionOf(name: string | null): string | null {
  const m = name?.match(/(?<=[^.])\.([\p{L}\p{N}]{1,10})$/u);
  return m ? `.${m[1]!.toLowerCase()}` : null;
}

/** The extension a filed document gets: from its (prepared) type, else its original name, else none. */
export function extensionFor(mime: string, originalName: string | null): string {
  return BY_TYPE[bareMime(mime)] ?? extensionOf(originalName) ?? '';
}

const BY_EXTENSION: Record<string, string> = {
  ...Object.fromEntries(Object.entries(BY_TYPE).map(([type, ext]) => [ext, type])),
  '.jpeg': 'image/jpeg',
  '.tiff': 'image/tiff',
  '.htm': 'text/html',
};

/** The MIME type a file name's extension implies, if it is one we know. */
export function mimeForName(name: string | null): string | null {
  const ext = extensionOf(name);
  return (ext && BY_EXTENSION[ext]) ?? null;
}

/** The few formats worth recognising by their first bytes. */
function sniffMime(bytes: Uint8Array): string | null {
  const starts = (sig: readonly number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

/**
 * The type an incoming file is stored with: the declared one, bare and
 * lowercased; if that says nothing (empty, or the generic octet-stream),
 * what the bytes show, else what the name implies.
 */
export function intakeMime(declared: string, bytes: Uint8Array, name: string | null): string {
  const bare = bareMime(declared);
  if (bare && bare !== GENERIC) return bare;
  return sniffMime(bytes) ?? mimeForName(name) ?? GENERIC;
}
