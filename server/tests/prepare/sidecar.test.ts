import { describe, it, expect } from 'vitest';
import { ocrAddedText } from '../../src/prepare/sidecar.js';

describe('ocrAddedText', () => {
  it('is false when every page was skipped', () => {
    expect(ocrAddedText('[OCR skipped on page(s) 1]')).toBe(false);
    expect(ocrAddedText('[OCR skipped on page(s) 1-3]\n')).toBe(false);
    expect(ocrAddedText('[OCR skipped on page(s) 1]\f[OCR skipped on page(s) 2]\f')).toBe(false);
  });
  it('is false for nothing recognised', () => {
    expect(ocrAddedText('')).toBe(false);
    expect(ocrAddedText(' \n\f \n')).toBe(false);
  });
  it('is true when any page gained text', () => {
    expect(ocrAddedText('[OCR skipped on page(s) 1]\fNorthwind Energy\nAmount due')).toBe(true);
    expect(ocrAddedText('Northwind Energy')).toBe(true);
  });
});
