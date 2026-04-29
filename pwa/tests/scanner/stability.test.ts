import { describe, it, expect } from 'vitest';
import { StabilityDetector } from '../../src/scanner/stability.js';
import type { Quad } from '../../src/scanner/types.js';

function quad(x: number, y: number): Quad {
  return {
    tl: { x, y },
    tr: { x: x + 100, y },
    bl: { x, y: y + 100 },
    br: { x: x + 100, y: y + 100 },
  };
}

describe('StabilityDetector', () => {
  it('returns "searching" with no prior frames', () => {
    const s = new StabilityDetector();
    expect(s.update(null, 0)).toBe('searching');
  });

  it('returns "counting" once a quad is seen', () => {
    const s = new StabilityDetector();
    expect(s.update(quad(10, 10), 0)).toBe('counting');
  });

  it('returns "stable" after 1.5s of stable quads', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    expect(s.update(quad(10, 10), 1500)).toBe('stable');
  });

  it('does not return stable when corners drift > 20px', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    expect(s.update(quad(50, 50), 1500)).toBe('counting');
  });

  it('resets counting when quad disappears', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    expect(s.update(null, 500)).toBe('searching');
    expect(s.update(quad(10, 10), 600)).toBe('counting');
    expect(s.update(quad(10, 10), 1000)).toBe('counting');
  });

  it('reset() clears state', () => {
    const s = new StabilityDetector();
    s.update(quad(10, 10), 0);
    s.update(quad(10, 10), 1500);
    s.reset();
    expect(s.update(quad(10, 10), 2000)).toBe('counting');
  });
});
