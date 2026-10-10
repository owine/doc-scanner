import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from '@cantoo/pdf-lib';
import { createAnalyzer } from '../../src/analyze/analyzer.js';
import type { AnalyzeInput, FolderContext } from '../../src/analyze/types.js';

const folders: FolderContext[] = [
  { linkId: 'link-root', path: '/', recentNames: [] },
  { linkId: 'link-bills', path: '/Bills', recentNames: ['Northwind Energy Aug 2026'] },
];

const input: AnalyzeInput = {
  bytes: new TextEncoder().encode('Northwind Energy statement, September 2026'),
  mimeType: 'text/plain',
  originalName: null,
  source: 'picker',
};

const usage = { input_tokens: 1200, output_tokens: 90 } as Anthropic.Usage;

function fakeClient(response: Partial<Anthropic.Message>) {
  const create = vi.fn().mockResolvedValue({
    model: 'claude-haiku-5-5',
    usage,
    stop_reason: 'end_turn',
    stop_details: null,
    content: [],
    ...response,
  });
  return { client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>, create };
}

function textReply(obj: unknown): Partial<Anthropic.Message> {
  return { content: [{ type: 'text', text: JSON.stringify(obj), citations: null } as Anthropic.TextBlock] };
}

const goodAnswer = {
  rationale: 'Monthly Northwind Energy bill.',
  name: 'Northwind Energy Sep 2026',
  folderId: 'F2',
  newFolder: null,
  confidence: 0.93,
  isDocument: true,
  textSnippet: 'Northwind Energy statement, September 2026',
};

describe('createAnalyzer', () => {
  it('returns a resolved analysis with the served model and usage', async () => {
    const { client } = fakeClient(textReply(goodAnswer));
    const out = await createAnalyzer({ client, model: 'claude-haiku-5-5', effort: 'low' }).analyze(input, folders);
    expect(out).toMatchObject({
      status: 'ok',
      model: 'claude-haiku-5-5',
      usage,
      analysis: { name: 'Northwind Energy Sep 2026', folder: { kind: 'existing', linkId: 'link-bills' }, confidence: 0.93 },
    });
  });

  it('sends effort and the structured-output format, with the folder list cached first', async () => {
    const { client, create } = fakeClient(textReply(goodAnswer));
    await createAnalyzer({ client, model: 'claude-sonnet-5-5', effort: 'medium' }).analyze(input, folders);
    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format.type).toBe('json_schema');
    const content = params.messages[0].content;
    expect(content[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(content[0].text).toContain('F2 /Bills');
    expect(content.at(-1).text).toContain('<arrival>');
  });

  it('includes history examples when given', async () => {
    const { client, create } = fakeClient(textReply(goodAnswer));
    await createAnalyzer({ client, model: 'm', effort: 'low' }).analyze(input, folders, [
      { snippet: 'Northwind Energy', finalName: 'Northwind Energy Jul 2026', folderPath: '/Bills' },
    ]);
    expect(create.mock.calls[0][0].messages[0].content[1].text).toContain('Northwind Energy Jul 2026');
  });

  it('maps a refusal, keeping the billed usage', async () => {
    const { client } = fakeClient({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null } as Anthropic.Message['stop_details'],
    });
    const out = await createAnalyzer({ client, model: 'm', effort: 'low' }).analyze(input, folders);
    expect(out).toMatchObject({ status: 'refusal', detail: 'declined (cyber)', usage });
  });

  it('maps max_tokens to truncated', async () => {
    const { client } = fakeClient({ stop_reason: 'max_tokens', content: [] });
    const out = await createAnalyzer({ client, model: 'm', effort: 'low' }).analyze(input, folders);
    expect(out.status).toBe('truncated');
  });

  it('reports malformed or off-schema answers as invalid', async () => {
    const broken = fakeClient({ content: [{ type: 'text', text: '{nope', citations: null } as Anthropic.TextBlock] });
    expect((await createAnalyzer({ client: broken.client, model: 'm', effort: 'low' }).analyze(input, folders)).status).toBe(
      'invalid',
    );
    const offSchema = fakeClient(textReply({ name: 'x' }));
    expect(
      (await createAnalyzer({ client: offSchema.client, model: 'm', effort: 'low' }).analyze(input, folders)).status,
    ).toBe('invalid');
  });

  it('refiles an encrypted PDF the API cannot open from metadata alone', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.encrypt({ ownerPassword: 'owner', userPassword: 'secret' });
    const pdf: AnalyzeInput = { ...input, bytes: await doc.save(), mimeType: 'application/pdf' };
    const ok = fakeClient(textReply(goodAnswer));
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Anthropic.BadRequestError(400, undefined, 'could not process PDF', new Headers()))
      .mockImplementation(ok.create);
    const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;
    const out = await createAnalyzer({ client, model: 'm', effort: 'low' }).analyze(pdf, folders);
    expect(out.status).toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1][0].messages[0].content;
    expect(retry.some((b: { type: string }) => b.type === 'document')).toBe(false);
    expect(retry.at(-1).text).toContain('password-protected');
  });

  it('does not swallow a bad request for an ordinary document', async () => {
    const create = vi.fn().mockRejectedValue(new Anthropic.BadRequestError(400, undefined, 'bad', new Headers()));
    const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;
    await expect(createAnalyzer({ client, model: 'm', effort: 'low' }).analyze(input, folders)).rejects.toThrow('bad');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('lets API errors propagate for the caller to retry', async () => {
    const create = vi.fn().mockRejectedValue(new Error('overloaded'));
    const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;
    await expect(createAnalyzer({ client, model: 'm', effort: 'low' }).analyze(input, folders)).rejects.toThrow('overloaded');
  });
});
