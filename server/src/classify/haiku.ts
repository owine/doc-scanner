import Anthropic from '@anthropic-ai/sdk';
import type { ClassifyInput, ClassifyResult, PastExample } from './types.js';
import { logger } from '../logger.js';

export class ImageTooLargeError extends Error {}

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;

const FILING_TOOL = {
  name: 'extract_and_suggest',
  description: 'Extract OCR text from each page and propose a filename and destination folder.',
  input_schema: {
    type: 'object' as const,
    required: ['suggestedName', 'suggestedFolderLinkId', 'confidence', 'rationale', 'pageOcr'],
    properties: {
      suggestedName: { type: 'string' as const, description: 'Filename without extension. ASCII, no slashes, ≤80 chars.' },
      suggestedFolderLinkId: { type: 'string' as const, description: 'Must be one of the linkIds from the provided folders list.' },
      confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
      rationale: { type: 'string' as const, maxLength: 200 },
      pageOcr: {
        type: 'array' as const,
        description: 'Per-page OCR results, in input page order.',
        items: {
          type: 'object' as const,
          required: ['text', 'words'],
          properties: {
            text: { type: 'string' as const },
            words: {
              type: 'array' as const,
              items: {
                type: 'object' as const,
                required: ['text', 'x', 'y', 'w', 'h'],
                properties: {
                  text: { type: 'string' as const },
                  x: { type: 'number' as const, minimum: 0, maximum: 1 },
                  y: { type: 'number' as const, minimum: 0, maximum: 1 },
                  w: { type: 'number' as const, minimum: 0, maximum: 1 },
                  h: { type: 'number' as const, minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
};

// Lazily-initialised SDK client. NB: do not cache a *rejected* promise here
// (lesson from the retired WorkerClient.init in PR-8); we instantiate the
// SDK eagerly on first call and let any constructor error surface naturally.
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      timeout: TIMEOUT_MS,
    });
  }
  return client;
}

function sanitiseName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9 .,'_-]/g, '').slice(0, 80).trim();
  return cleaned.length > 0 ? cleaned : 'Document';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function formatExamples(examples: PastExample[] | undefined): string {
  if (!examples?.length) return '';
  return [
    '<examples>',
    ...examples.map((e) => `OCR: ${e.ocrSnippet}  →  filed as "${e.finalName}" in ${e.folderPath}`),
    '</examples>',
  ].join('\n');
}

export async function classify(input: ClassifyInput): Promise<ClassifyResult | null> {
  // Defence in depth: image.ts should keep us under this, but if a future
  // caller bypasses the route's normalise step, fail fast before the API call.
  for (const page of input.pages) {
    if (page.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageTooLargeError(`page ${page.byteLength} > ${MAX_IMAGE_BYTES}`);
    }
  }

  const folderLines = input.folders.map((f) => `${f.linkId}: ${f.path}`).join('\n');
  const examplesBlock = formatExamples(input.examples);
  const imageBlocks = input.pages.map((page) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: 'image/jpeg' as const,
      data: Buffer.from(page).toString('base64'),
    },
  }));

  const start = performance.now();
  let response;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4000,
      tool_choice: { type: 'tool', name: FILING_TOOL.name },
      tools: [FILING_TOOL],
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'For each page image below, extract OCR text (full reading order) and word bounding boxes (normalised 0-1). Then suggest a filename and destination folder for the entire document.\n\n' +
              `Available folders:\n${folderLines}`,
            cache_control: { type: 'ephemeral' },
          },
          ...imageBlocks,
          ...(examplesBlock ? [{ type: 'text' as const, text: examplesBlock }] : []),
        ],
      }],
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'classify: anthropic call failed');
    return null;
  }

  const block = (response.content as Array<{ type: string }>).find((b) => b.type === 'tool_use') as
    | { type: 'tool_use'; input: Record<string, unknown> }
    | undefined;
  if (!block) {
    logger.warn('classify: no tool_use block in response');
    return null;
  }

  const raw = block.input as Partial<ClassifyResult>;
  if (
    typeof raw.suggestedName !== 'string'
    || typeof raw.suggestedFolderLinkId !== 'string'
    || typeof raw.confidence !== 'number'
    || typeof raw.rationale !== 'string'
    || !Array.isArray(raw.pageOcr)
    || raw.pageOcr.length !== input.pages.length
  ) {
    logger.warn({ expectedPages: input.pages.length, got: raw }, 'classify: tool_use input malformed');
    return null;
  }

  const sanitisedName = NAME_REGEX.test(raw.suggestedName) ? raw.suggestedName : sanitiseName(raw.suggestedName);
  const folderOk = input.folders.some((f) => f.linkId === raw.suggestedFolderLinkId);
  const finalLinkId = folderOk ? raw.suggestedFolderLinkId : '';

  const pageOcr = raw.pageOcr.map((p) => ({
    text: typeof p.text === 'string' ? p.text : '',
    words: Array.isArray(p.words)
      ? p.words.map((w) => ({
          text: String(w.text ?? ''),
          x: clamp01(Number(w.x)),
          y: clamp01(Number(w.y)),
          w: clamp01(Number(w.w)),
          h: clamp01(Number(w.h)),
        }))
      : [],
  }));

  const elapsed = Math.round(performance.now() - start);
  logger.info(
    {
      elapsed,
      pages: input.pages.length,
      model: MODEL,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    },
    'classify: ok',
  );
  return {
    suggestedName: sanitisedName,
    suggestedFolderLinkId: finalLinkId,
    confidence: raw.confidence,
    rationale: raw.rationale,
    pageOcr,
  };
}
