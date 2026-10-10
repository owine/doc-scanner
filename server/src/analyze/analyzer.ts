import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { buildDocumentContent, UNOPENABLE, type DocumentContent } from './content.js';
import { buildFolderIndex, formatArrival, formatExamples, SYSTEM_PROMPT } from './prompt.js';
import { ModelAnswerSchema, resolveAnalysis } from './resolve.js';
import type { AnalyzeInput, AnalyzeOutcome, FolderContext, PastExample } from './types.js';

export type Effort = 'low' | 'medium' | 'high';

export interface AnalyzerConfig {
  client: Pick<Anthropic, 'messages'>;
  model: string;
  effort: Effort;
  /** Thinking counts against this, so it is sized well above the answer itself. */
  maxTokens?: number;
}

export interface Analyzer {
  analyze(input: AnalyzeInput, folders: FolderContext[], examples?: PastExample[]): Promise<AnalyzeOutcome>;
}

const DEFAULT_MAX_TOKENS = 8000;
const ANSWER_FORMAT = zodOutputFormat(ModelAnswerSchema);

/**
 * One Claude call per document: reads the file, proposes a filename and a
 * folder. API errors (network, rate limit, 5xx) propagate so the caller's
 * retry policy handles them; a response that arrives but can't be used comes
 * back as a non-ok outcome carrying the usage that was billed for it.
 */
export function createAnalyzer(cfg: AnalyzerConfig): Analyzer {
  return {
    async analyze(input, folders, examples = []) {
      const index = buildFolderIndex(folders);
      const doc = await buildDocumentContent(input.bytes, input.mimeType);
      const examplesText = formatExamples(examples);

      const request = (d: DocumentContent) =>
        cfg.client.messages.create({
          model: cfg.model,
          max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: SYSTEM_PROMPT,
          output_config: { effort: cfg.effort, format: ANSWER_FORMAT },
          messages: [
            {
              role: 'user',
              content: [
                // The folder list is the large stable part of the prompt; the
                // breakpoint lets a burst of documents reuse it.
                { type: 'text', text: index.text, cache_control: { type: 'ephemeral' } },
                ...(examplesText ? [{ type: 'text' as const, text: examplesText }] : []),
                ...d.blocks,
                { type: 'text', text: formatArrival(input, d.note) },
              ],
            },
          ],
        });

      let response: Anthropic.Message;
      try {
        response = await request(doc);
      } catch (err) {
        // A PDF that needs a password to open is rejected outright; without
        // this it would fail on every retry. File it from metadata instead.
        if (!(doc.mayBeUnopenable && err instanceof Anthropic.BadRequestError)) throw err;
        response = await request(UNOPENABLE);
      }

      const base = { model: response.model, usage: response.usage, stopReason: response.stop_reason };
      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'unspecified';
        return { ...base, status: 'refusal', detail: `declined (${category})` };
      }
      if (response.stop_reason === 'max_tokens') {
        return { ...base, status: 'truncated', detail: 'hit max_tokens before finishing the answer' };
      }

      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
      if (!text) return { ...base, status: 'invalid', detail: 'no text block in the response' };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ...base, status: 'invalid', detail: 'answer was not valid JSON' };
      }
      const parsed = ModelAnswerSchema.safeParse(json);
      if (!parsed.success) {
        return { ...base, status: 'invalid', detail: `answer did not match the schema: ${parsed.error.message}` };
      }
      return { ...base, status: 'ok', analysis: resolveAnalysis(parsed.data, index) };
    },
  };
}
