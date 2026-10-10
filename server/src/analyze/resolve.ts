import { z } from 'zod';
import type { Analysis, FolderChoice } from './types.js';
import type { FolderIndex } from './prompt.js';

// What the model returns, via structured outputs. Folder IDs are the short
// "F12" handles from the prompt's folder list, resolved back to Drive link
// IDs by resolveAnalysis. `rationale` comes first so the model states its
// reading of the document before committing to the answer fields.
export const ModelAnswerSchema = z.object({
  rationale: z.string().describe('One or two sentences: what the document is and why this name and folder.'),
  name: z.string().describe('Filename without extension.'),
  folderId: z.string().nullable().describe('ID (like "F12") of an existing folder, or null when proposing a new one.'),
  newFolder: z
    .object({
      parentId: z.string().describe('ID of the existing folder to create it under.'),
      name: z.string().describe('Name of the new folder.'),
    })
    .nullable()
    .describe('Set only when no existing folder fits; otherwise null.'),
  confidence: z.number().describe('0 to 1.'),
  isDocument: z.boolean(),
  textSnippet: z.string(),
});

export type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

const MAX_NAME_CHARS = 120;
const MAX_SNIPPET_CHARS = 500;
// Characters Drive, or an OS the file is later downloaded to, would reject.
const ILLEGAL_NAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
const TRAILING_EXTENSION = /\.(pdf|jpe?g|png|heic|webp|gif|tiff?|docx?|xlsx?|pptx?|txt|csv|md|json|html?|heif)$/i;

export function sanitiseName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(ILLEGAL_NAME_CHARS, ' ')
    .replace(TRAILING_EXTENSION, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots would make a hidden file on download.
    .replace(/^\.+/, '')
    .slice(0, MAX_NAME_CHARS)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function resolveFolder(answer: ModelAnswer, index: FolderIndex): FolderChoice | null {
  // An existing folder wins if the model somehow set both.
  if (answer.folderId !== null) {
    const folder = index.byId.get(answer.folderId.trim());
    if (folder) return { kind: 'existing', linkId: folder.linkId, path: folder.path };
  }
  if (answer.newFolder !== null) {
    const parent = index.byId.get(answer.newFolder.parentId.trim());
    const name = sanitiseName(answer.newFolder.name, '');
    if (parent && name.length > 0) {
      return { kind: 'new', parentLinkId: parent.linkId, parentPath: parent.path, name };
    }
  }
  // A hallucinated ID or an empty proposal: no usable folder, so the
  // document goes to review instead of being filed somewhere arbitrary.
  return null;
}

export function resolveAnalysis(answer: ModelAnswer, index: FolderIndex): Analysis {
  const confidence = Number.isFinite(answer.confidence) ? Math.min(1, Math.max(0, answer.confidence)) : 0;
  return {
    name: sanitiseName(answer.name, 'Document'),
    folder: resolveFolder(answer, index),
    confidence,
    rationale: answer.rationale.trim(),
    isDocument: answer.isDocument,
    textSnippet: answer.textSnippet.trim().slice(0, MAX_SNIPPET_CHARS),
  };
}
