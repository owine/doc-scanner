export type CameraErrorCode = 'permission_denied' | 'no_camera' | 'busy' | 'other';

export class CameraError extends Error {
  constructor(public readonly code: CameraErrorCode, message: string) {
    super(message);
  }
}

export interface CameraHandle {
  stream: MediaStream;
  stop(): void;
}

export async function startCamera(constraints: MediaStreamConstraints = defaultConstraints()): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('other', 'getUserMedia not supported');
  }
  // iOS Safari quirk: first call sometimes rejects with NotReadableError. Retry once.
  let stream: MediaStream | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && !stream; attempt++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!stream) throw mapError(lastErr);
  return {
    stream,
    stop: () => stream!.getTracks().forEach((t) => t.stop()),
  };
}

function mapError(err: unknown): CameraError {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CameraError('permission_denied', 'Camera permission denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new CameraError('no_camera', 'No camera available');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new CameraError('busy', 'Camera is busy or unavailable');
  }
  return new CameraError('other', `Camera error: ${name || String(err)}`);
}

function defaultConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

/** Capture the current frame from a video element into a canvas. */
export function captureFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}
