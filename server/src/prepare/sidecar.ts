/** ocrmypdf writes this placeholder to the sidecar for a page that already had text. */
const SKIPPED = /\[OCR skipped on page\(s\) [^\]]*\]/g;

/** Whether ocrmypdf recognised any text: its sidecar holds more than skip placeholders and blank space. */
export function ocrAddedText(sidecar: string): boolean {
  return /\S/.test(sidecar.replace(SKIPPED, ''));
}
