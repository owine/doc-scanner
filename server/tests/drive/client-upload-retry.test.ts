import { describe, it, expect, vi } from 'vitest';
import {
  uploadWithCollisionRetry,
  UploadCollisionExhausted,
  isCollisionError,
} from '../../src/drive/client.js';

describe('uploadWithCollisionRetry', () => {
  it('returns the first successful attempt with the original name', async () => {
    const attempt = vi.fn().mockResolvedValue({ nodeUid: 'n1', driveUrl: 'u1' });
    const out = await uploadWithCollisionRetry('Receipt', attempt);
    expect(attempt).toHaveBeenCalledOnce();
    expect(attempt).toHaveBeenCalledWith('Receipt');
    expect(out.finalName).toBe('Receipt');
    expect(out.result).toEqual({ nodeUid: 'n1', driveUrl: 'u1' });
  });

  it('retries with " (2)" suffix on first collision and returns the suffixed name', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('node already exists in folder'))
      .mockResolvedValueOnce({ nodeUid: 'n2', driveUrl: 'u2' });
    const out = await uploadWithCollisionRetry('Receipt', attempt);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, 'Receipt');
    expect(attempt).toHaveBeenNthCalledWith(2, 'Receipt (2)');
    expect(out.finalName).toBe('Receipt (2)');
  });

  it('throws UploadCollisionExhausted after 4 consecutive collisions', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('409 conflict'));
    await expect(uploadWithCollisionRetry('Receipt', attempt))
      .rejects.toBeInstanceOf(UploadCollisionExhausted);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(attempt.mock.calls.map((c) => c[0])).toEqual([
      'Receipt', 'Receipt (2)', 'Receipt (3)', 'Receipt (4)',
    ]);
  });

  it('propagates non-collision errors immediately (no retry)', async () => {
    const networkErr = new Error('network unreachable');
    const attempt = vi.fn().mockRejectedValue(networkErr);
    await expect(uploadWithCollisionRetry('Receipt', attempt)).rejects.toBe(networkErr);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('preserves the last collision error as `cause` on UploadCollisionExhausted', async () => {
    const lastErr = new Error('duplicate name');
    const attempt = vi.fn().mockRejectedValue(lastErr);
    try {
      await uploadWithCollisionRetry('Receipt', attempt);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UploadCollisionExhausted);
      expect((err as Error & { cause?: unknown }).cause).toBe(lastErr);
    }
  });
});

describe('isCollisionError', () => {
  it.each([
    'node already exists',
    'name conflict in folder',
    'duplicate filename',
    '409 Conflict',
    '422 Unprocessable',
  ])('classifies "%s" as a collision', (msg) => {
    expect(isCollisionError(new Error(msg))).toBe(true);
  });

  it.each([
    'network unreachable',
    'authentication failed',
    'quota exceeded',
    'unknown',
  ])('classifies "%s" as NOT a collision', (msg) => {
    expect(isCollisionError(new Error(msg))).toBe(false);
  });

  it('returns false for non-Error throwables', () => {
    expect(isCollisionError('exists')).toBe(false);
    expect(isCollisionError(null)).toBe(false);
    expect(isCollisionError({ message: 'exists' })).toBe(false);
  });
});
