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

/** The extension a filed document gets: from its (prepared) type, else its original name, else none. */
export function extensionFor(mime: string, originalName: string | null): string {
  const known = BY_TYPE[mime.split(';')[0]!.trim().toLowerCase()];
  if (known) return known;
  const m = originalName?.match(/(?<=[^.])\.([\p{L}\p{N}]{1,10})$/u);
  return m ? `.${m[1]!.toLowerCase()}` : '';
}
