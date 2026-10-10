import { describe, it, expect } from 'vitest';
import { extensionFor } from '../../src/documents/extension.js';

describe('extensionFor', () => {
  it('maps known MIME types', () => {
    expect(extensionFor('application/pdf', null)).toBe('.pdf');
    expect(extensionFor('image/jpeg', null)).toBe('.jpg');
    expect(extensionFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document', null)).toBe('.docx');
  });

  it('falls back to the original filename, then to nothing', () => {
    expect(extensionFor('application/octet-stream', 'archive.tar.gz')).toBe('.gz');
    expect(extensionFor('application/octet-stream', 'README')).toBe('');
    expect(extensionFor('application/octet-stream', null)).toBe('');
  });
});
