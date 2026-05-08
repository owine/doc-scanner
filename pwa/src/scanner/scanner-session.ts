import { startCamera, captureFrame, type CameraHandle } from './camera.js';
import { findQuad, warpToFlat, defaultQuad } from './edge-detect.js';
import { StabilityDetector, type StabilityState } from './stability.js';
import { ScansStore } from './scans-store.js';
import type { Point, Quad } from './types.js';

export const LIVE_PREVIEW_FPS = 6;
const FRAME_INTERVAL_MS = 1000 / LIVE_PREVIEW_FPS;
// After committing a page, suppress auto-capture for this long so the user has
// time to swap pages before a re-trigger on the same (still-visible) page.
const POST_CAPTURE_COOLDOWN_MS = 3000;
// EMA weight on the previous smoothed quad. Higher = more smoothing, more lag.
// 0.7 means each new frame contributes 30% — effective window ~3 frames.
// Reduces jscanify's corner jitter so the stability detector can converge.
const QUAD_SMOOTHING = 0.7;

export interface FrameDiagnostics {
  canvasW: number;
  canvasH: number;
  contourPts: number;
}

export interface SessionEvents {
  onStability?: (state: StabilityState, quad: Quad | null, diag?: FrameDiagnostics) => void;
  onPageAdded?: (ordinal: number, blob: Blob) => void;
  onError?: (err: Error) => void;
}

export class ScannerSession {
  private cam: CameraHandle | null = null;
  private video: HTMLVideoElement | null = null;
  private stability = new StabilityDetector();
  private rafId: number | null = null;
  private lastFrameAt = 0;
  private capturing = false;
  private autoCaptureEnabled = true;
  private currentQuad: Quad | null = null;
  private lastNonNullQuad: Quad | null = null;
  private smoothedQuad: Quad | null = null;
  private cooldownUntil = 0;

  constructor(
    public readonly scanId: string,
    private readonly store: ScansStore,
    private readonly events: SessionEvents = {},
  ) {}

  static async start(store: ScansStore, events: SessionEvents = {}): Promise<ScannerSession> {
    const id = await store.createInProgress();
    return new ScannerSession(id, store, events);
  }

  static async resume(scanId: string, store: ScansStore, events: SessionEvents = {}): Promise<ScannerSession> {
    return new ScannerSession(scanId, store, events);
  }

  async attachVideo(video: HTMLVideoElement): Promise<void> {
    this.cam = await startCamera();
    this.video = video;
    video.srcObject = this.cam.stream;
    await video.play();
    this.startLoop();
  }

  /**
   * Re-bind the camera stream to a (possibly new) video element. Called when
   * ScannerScreen unmounts/remounts (e.g. round-trip to EditCornersScreen)
   * so the new video element shows the live preview.
   */
  rebindVideo(video: HTMLVideoElement): void {
    this.video = video;
    if (this.cam) {
      video.srcObject = this.cam.stream;
      void video.play().catch(() => {});
    }
  }

  setAutoCapture(on: boolean): void {
    this.autoCaptureEnabled = on;
    if (!on) this.stability.reset();
  }

  /**
   * Manual shutter. Returns the current frame's canvas + the last detected quad
   * (or null). UI routes to EditCornersScreen with this canvas + a fallback quad
   * when no detection was available.
   */
  manualCapture(): { canvas: HTMLCanvasElement; quad: Quad | null } {
    if (!this.video) throw new Error('no video');
    const canvas = captureFrame(this.video);
    // Prefer the last successfully-detected quad over a momentary null. The
    // user pressed shutter because they saw a quad highlighted; honor that
    // even if the very latest frame happened to lose detection.
    return { canvas, quad: this.currentQuad ?? this.lastNonNullQuad };
  }

  /** Commit a captured frame as a page (after auto-capture or EditCornersScreen Apply). */
  async commitPage(canvas: HTMLCanvasElement, quad: Quad): Promise<void> {
    this.capturing = true;
    try {
      const blob = await warpToFlat(canvas, quad);
      const ordinal = await this.store.appendPage(this.scanId, blob, quad);
      this.events.onPageAdded?.(ordinal, blob);
      this.stability.reset();
      this.cooldownUntil = performance.now() + POST_CAPTURE_COOLDOWN_MS;
    } catch (err) {
      this.events.onError?.(err as Error);
      throw err;
    } finally {
      this.capturing = false;
    }
  }

  async finish(): Promise<void> {
    this.stop();
    await this.store.finish(this.scanId);
  }

  async discard(): Promise<void> {
    this.stop();
    await this.store.delete(this.scanId);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.cam?.stop();
    this.cam = null;
    if (this.video) this.video.srcObject = null;
  }

  private startLoop(): void {
    const loop = (t: number) => {
      this.rafId = requestAnimationFrame(loop);
      if (this.capturing) return;
      if (t - this.lastFrameAt < FRAME_INTERVAL_MS) return;
      this.lastFrameAt = t;
      this.processFrame().catch((e) => this.events.onError?.(e as Error));
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private async processFrame(): Promise<void> {
    if (!this.video) return;
    const canvas = captureFrame(this.video);
    let diag: FrameDiagnostics = { canvasW: canvas.width, canvasH: canvas.height, contourPts: 0 };
    let quad: Quad | null = null;
    try {
      const r = await findQuad(canvas);
      quad = r.quad;
      diag = { canvasW: r.canvasW, canvasH: r.canvasH, contourPts: r.contourPts };
    } catch (e) {
      this.events.onError?.(e as Error);
    }
    // Smooth raw jscanify corners so jitter doesn't reset the stability anchor
    // every frame. EMA-blend the new quad with the previous smoothed one.
    const smoothed = this.smoothQuad(quad);
    this.currentQuad = smoothed;
    if (smoothed) this.lastNonNullQuad = smoothed;
    const now = performance.now();
    const inCooldown = now < this.cooldownUntil;
    // While in post-capture cooldown, force "searching" so the UI doesn't show
    // a misleading countdown and stability won't accumulate toward auto-fire.
    const state = inCooldown ? 'searching' : this.stability.update(smoothed, now);
    if (inCooldown) this.stability.reset();
    this.events.onStability?.(state, smoothed, diag);
    if (state === 'stable' && this.autoCaptureEnabled && smoothed) {
      await this.commitPage(canvas, smoothed);
    }
  }

  private smoothQuad(quad: Quad | null): Quad | null {
    if (!quad) {
      this.smoothedQuad = null;
      return null;
    }
    if (!this.smoothedQuad) {
      this.smoothedQuad = quad;
      return quad;
    }
    const a = QUAD_SMOOTHING;
    const blend = (p: Point, q: Point): Point => ({
      x: p.x * a + q.x * (1 - a),
      y: p.y * a + q.y * (1 - a),
    });
    this.smoothedQuad = {
      tl: blend(this.smoothedQuad.tl, quad.tl),
      tr: blend(this.smoothedQuad.tr, quad.tr),
      bl: blend(this.smoothedQuad.bl, quad.bl),
      br: blend(this.smoothedQuad.br, quad.br),
    };
    return this.smoothedQuad;
  }
}

export { defaultQuad };
