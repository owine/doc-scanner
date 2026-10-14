import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/auth/mutex.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Mutex', () => {
  it('runs one call at a time, in arrival order', async () => {
    const m = new Mutex();
    const log: string[] = [];
    let release!: () => void;
    const first = m.run(async () => {
      log.push('first starts');
      await new Promise<void>((resolve) => { release = resolve; });
      log.push('first ends');
      return 'first';
    });
    const second = m.run(async () => {
      log.push('second');
      return 'second';
    });
    await tick();
    expect(log).toEqual(['first starts']);
    release();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(log).toEqual(['first starts', 'first ends', 'second']);
  });

  it('gives each call its own result, and a failure does not stop the next', async () => {
    const m = new Mutex();
    const failing = m.run(async () => {
      throw new Error('wrong password');
    });
    const next = m.run(async () => 'unlocked');
    await expect(failing).rejects.toThrow('wrong password');
    await expect(next).resolves.toBe('unlocked');
  });
});
