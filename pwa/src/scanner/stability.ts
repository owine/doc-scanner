import type { Quad } from './types.js';

export type StabilityState = 'searching' | 'counting' | 'stable';
export const STABILITY_WINDOW_MS = 1500;
// Tuned empirically on iPhone with 1080-wide camera frames combined with
// EMA quad smoothing in scanner-session: jscanify's corner extremes are
// inherently noisy on textured backgrounds (the "largest contour" alternates
// between the page outline and other blobs), so a generous threshold here is
// what makes auto-capture viable at all. Real-world testing settled at 100.
export const STABILITY_DRIFT_PX = 100;

interface Sample { quad: Quad; t: number; }

function maxCornerDrift(a: Quad, b: Quad): number {
  const corners: (keyof Quad)[] = ['tl', 'tr', 'bl', 'br'];
  let max = 0;
  for (const c of corners) {
    const dx = a[c].x - b[c].x;
    const dy = a[c].y - b[c].y;
    const d = Math.hypot(dx, dy);
    if (d > max) max = d;
  }
  return max;
}

export class StabilityDetector {
  private anchor: Sample | null = null;

  update(quad: Quad | null, now: number): StabilityState {
    if (!quad) {
      this.anchor = null;
      return 'searching';
    }
    if (!this.anchor) {
      this.anchor = { quad, t: now };
      return 'counting';
    }
    if (maxCornerDrift(quad, this.anchor.quad) > STABILITY_DRIFT_PX) {
      this.anchor = { quad, t: now };
      return 'counting';
    }
    return now - this.anchor.t >= STABILITY_WINDOW_MS ? 'stable' : 'counting';
  }

  reset(): void { this.anchor = null; }
}
