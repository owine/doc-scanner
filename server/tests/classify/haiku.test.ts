import { describe, it, expect, vi, beforeEach } from 'vitest';

// Anthropic SDK is mocked at the module boundary. The mock's `create`
// implementation is reassigned per-test to control the response. The mock
// is a class (not vi.fn()) because vitest 4.x flags `new vi.fn()` patterns
// without a function/class implementation.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { classify, ImageTooLargeError } from '../../src/classify/haiku.js';

const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('classify (haiku vision)', () => {
  it('returns parsed ClassifyResult on single-page tool-use happy path', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use',
        name: 'extract_and_suggest',
        input: {
          suggestedName: 'Tax Receipt 2026',
          suggestedFolderLinkId: 'folder-tax',
          confidence: 0.9,
          rationale: 'Page contains IRS Form 1040 header',
          pageOcr: [{
            text: 'IRS Form 1040 — Tax year 2026',
            words: [
              { text: 'IRS', x: 0.1, y: 0.05, w: 0.08, h: 0.04 },
              { text: 'Form', x: 0.2, y: 0.05, w: 0.1, h: 0.04 },
              { text: '1040', x: 0.32, y: 0.05, w: 0.1, h: 0.04 },
            ],
          }],
        },
      }],
      usage: { input_tokens: 1500, output_tokens: 200 },
    });

    const result = await classify({
      pages: [TINY_JPEG],
      folders: [{ linkId: 'folder-tax', path: '/Tax' }],
    });

    expect(result).toEqual({
      suggestedName: 'Tax Receipt 2026',
      suggestedFolderLinkId: 'folder-tax',
      confidence: 0.9,
      rationale: 'Page contains IRS Form 1040 header',
      pageOcr: [{
        text: 'IRS Form 1040 — Tax year 2026',
        words: [
          { text: 'IRS', x: 0.1, y: 0.05, w: 0.08, h: 0.04 },
          { text: 'Form', x: 0.2, y: 0.05, w: 0.1, h: 0.04 },
          { text: '1040', x: 0.32, y: 0.05, w: 0.1, h: 0.04 },
        ],
      }],
    });
  });

  it('returns one OCR entry per input page on multi-page input', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use',
        name: 'extract_and_suggest',
        input: {
          suggestedName: 'Multi-page invoice',
          suggestedFolderLinkId: 'folder-tax',
          confidence: 0.85,
          rationale: 'Three-page invoice',
          pageOcr: [
            { text: 'page 1 text', words: [] },
            { text: 'page 2 text', words: [] },
            { text: 'page 3 text', words: [] },
          ],
        },
      }],
      usage: { input_tokens: 4000, output_tokens: 300 },
    });

    const result = await classify({
      pages: [TINY_JPEG, TINY_JPEG, TINY_JPEG],
      folders: [{ linkId: 'folder-tax', path: '/Tax' }],
    });
    expect(result?.pageOcr.length).toBe(3);
    expect(result?.pageOcr.map((p) => p.text)).toEqual(['page 1 text', 'page 2 text', 'page 3 text']);
  });

  it('drops a hallucinated folder linkId (returns empty string)', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use',
        input: {
          suggestedName: 'Recipe',
          suggestedFolderLinkId: 'folder-not-in-cache',
          confidence: 0.7,
          rationale: 'Looks like a recipe',
          pageOcr: [{ text: 'pasta', words: [] }],
        },
      }],
      usage: {},
    });

    const result = await classify({
      pages: [TINY_JPEG],
      folders: [{ linkId: 'folder-recipes', path: '/Recipes' }],
    });
    expect(result?.suggestedFolderLinkId).toBe('');
    expect(result?.suggestedName).toBe('Recipe');
  });

  it('returns null when pageOcr length does not match input pages', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use',
        input: {
          suggestedName: 'X', suggestedFolderLinkId: 'f', confidence: 0.5, rationale: 'r',
          pageOcr: [{ text: 'only one page returned', words: [] }],
        },
      }],
      usage: {},
    });
    const result = await classify({
      pages: [TINY_JPEG, TINY_JPEG, TINY_JPEG],
      folders: [{ linkId: 'f', path: '/' }],
    });
    expect(result).toBeNull();
  });

  it('returns null on Anthropic SDK error', async () => {
    mockCreate.mockRejectedValue(new Error('connection refused'));
    const result = await classify({
      pages: [TINY_JPEG],
      folders: [{ linkId: 'f', path: '/' }],
    });
    expect(result).toBeNull();
  });

  it('throws ImageTooLargeError before any API call when an input page is >3 MB', async () => {
    const oversized = new Uint8Array(3 * 1024 * 1024 + 1);
    await expect(
      classify({ pages: [oversized], folders: [{ linkId: 'f', path: '/' }] }),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('sanitises a hallucinated name with illegal chars', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'tool_use',
        input: {
          suggestedName: 'Tax/Receipt 2026 ✨',
          suggestedFolderLinkId: 'folder-tax',
          confidence: 0.9,
          rationale: 'r',
          pageOcr: [{ text: 't', words: [] }],
        },
      }],
      usage: {},
    });
    const result = await classify({
      pages: [TINY_JPEG],
      folders: [{ linkId: 'folder-tax', path: '/Tax' }],
    });
    // '/' and '✨' stripped → 'TaxReceipt 2026'
    expect(result?.suggestedName).toBe('TaxReceipt 2026');
  });
});
