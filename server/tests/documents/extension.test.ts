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

  it('lets the MIME type beat a conflicting name, and normalises it', () => {
    expect(extensionFor('application/pdf', 'scan.jpg')).toBe('.pdf');
    expect(extensionFor('Application/PDF', null)).toBe('.pdf');
    expect(extensionFor('text/plain; charset=utf-8', null)).toBe('.txt');
    expect(extensionFor('image/heif', null)).toBe('.heif');
    expect(extensionFor('text/html', null)).toBe('.html');
  });

  it('only takes a short, safe extension from the name', () => {
    const o = 'application/octet-stream';
    expect(extensionFor(o, '.bashrc')).toBe('');
    expect(extensionFor(o, 'report.')).toBe('');
    expect(extensionFor(o, 'x.pdf/../y')).toBe('');
    expect(extensionFor(o, 'a.' + 'z'.repeat(300))).toBe('');
    expect(extensionFor(o, 'a.b\u0000c')).toBe('');
    expect(extensionFor(o, 'NOTES.TXT')).toBe('.txt');
  });
});
