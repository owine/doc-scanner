import { describe, it, expect } from 'vitest';
import { extensionFor, intakeMime, mimeForName } from '../../src/documents/extension.js';

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

describe('mimeForName', () => {
  it('inverts the known extensions, case-insensitively, with common aliases', () => {
    expect(mimeForName('statement.PDF')).toBe('application/pdf');
    expect(mimeForName('photo.jpeg')).toBe('image/jpeg');
    expect(mimeForName('photo.jpg')).toBe('image/jpeg');
    expect(mimeForName('scan.tiff')).toBe('image/tiff');
    expect(mimeForName('notes.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('knows nothing about other names', () => {
    expect(mimeForName('archive.tar.gz')).toBeNull();
    expect(mimeForName('README')).toBeNull();
    expect(mimeForName('.pdf')).toBeNull();
    expect(mimeForName(null)).toBeNull();
  });
});

describe('intakeMime', () => {
  const text = new TextEncoder().encode('Northwind Energy');
  it('keeps a declared type, without parameters, lowercased', () => {
    expect(intakeMime('text/plain;charset=utf-8', text, 'a.pdf')).toBe('text/plain');
    expect(intakeMime(' Application/PDF ', text, null)).toBe('application/pdf');
  });

  it('works out a missing or generic type from the bytes, then the name', () => {
    expect(intakeMime('', new TextEncoder().encode('%PDF-1.7 ...'), 'scan')).toBe('application/pdf');
    expect(intakeMime('application/octet-stream', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), null)).toBe('image/png');
    expect(intakeMime('', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'x.png')).toBe('image/jpeg');
    expect(intakeMime('', text, 'statement.pdf')).toBe('application/pdf');
    expect(intakeMime('application/octet-stream', text, 'notes.unknown')).toBe('application/octet-stream');
    expect(intakeMime(';charset=x', text, null)).toBe('application/octet-stream');
  });
});
