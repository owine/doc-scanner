import { describe, it, expect } from 'vitest';
import { folderLabel, safeDriveUrl } from '../../src/ui/inbox/labels.js';

describe('folderLabel', () => {
  it('shows an existing folder by path', () => {
    expect(folderLabel({ kind: 'existing', linkId: 'L-bills', path: '/Bills' })).toBe('/Bills');
  });

  it('puts a new folder directly under the root', () => {
    expect(folderLabel({ kind: 'new', parentLinkId: 'L-root', parentPath: '/', name: 'Gas' })).toBe('/Gas');
  });

  it('puts a new folder under a nested parent', () => {
    expect(folderLabel({ kind: 'new', parentLinkId: 'L-bills', parentPath: '/Bills', name: 'Gas' })).toBe('/Bills/Gas');
  });
});

describe('safeDriveUrl', () => {
  it('accepts https links to Proton Drive and Docs', () => {
    expect(safeDriveUrl('https://drive.proton.me/s/file/n')).toBe('https://drive.proton.me/s/file/n');
    expect(safeDriveUrl('https://docs.proton.me/doc?mode=open')).toBe('https://docs.proton.me/doc?mode=open');
  });

  it('rejects other schemes, hosts and empty values', () => {
    expect(safeDriveUrl('http://drive.proton.me/x')).toBeNull();
    expect(safeDriveUrl('https://example.test/x')).toBeNull();
    expect(safeDriveUrl('javascript:alert(1)')).toBeNull();
    expect(safeDriveUrl(null)).toBeNull();
    expect(safeDriveUrl('')).toBeNull();
  });
});
