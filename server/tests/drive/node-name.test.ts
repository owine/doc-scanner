import { describe, it, expect } from 'vitest';
import { nodeName } from '../../src/drive/client.js';
import type { NodeEntity } from '@protontech/drive-sdk';

function node(name: NodeEntity['name']): NodeEntity {
  // Only `name` matters for this helper; cast the rest.
  return { uid: 'u', name } as unknown as NodeEntity;
}

describe('nodeName', () => {
  it('returns the decrypted name when the Result is ok', () => {
    expect(nodeName(node({ ok: true, value: 'scan.pdf' }))).toBe('scan.pdf');
  });

  it('returns null when the name failed to decrypt', () => {
    expect(nodeName(node({ ok: false, error: new Error('bad name') }))).toBeNull();
  });
});
