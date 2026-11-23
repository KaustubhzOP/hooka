/**
 * Camera + MediaPipe Face/Hand Landmarker, all served locally from /public.
 * Produces a TrackingFrame per new video frame.
 */
import { FilesetResolver, FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import type { TrackingFrame } from './signals';

const BASE = import.meta.env.BASE_URL;
const abs = (p: string) => new URL(BASE + p, location.href).href;
export const WASM_PATH = abs('mediapipe/wasm');
export const FACE_MODEL = abs('models/face_landmarker.task');
export const HAND_MODEL = abs('models/hand_landmarker.task');
export const SEGMENT_MODEL = abs('models/selfie_segmenter.tflite');

/** Phones and tablets: smaller camera frames and lighter settings. */
export const IS_MOBILE = typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));

export type TrackingErrorKind = 'permission' | 'nocamera' | 'inuse' | 'insecure' | 'models' | 'unknown';

export class TrackingError extends Error {
  constructor(public kind: TrackingErrorKind, message: string) { super(message); }
}

/** Human-readable title + explanation for the on-screen error card. */
export function describeError(err: unknown): { title: string; body: string } {
  const e = err instanceof TrackingError ? err : toTrackingError(err);
  switch (e.kind) {
    case 'permission': return {
      title: 'Camera permission denied',
      body: 'Allow camera access for this page (click the camera icon in the address bar), then press Retry. Video never leaves your device.'
    };
    case 'nocamera': return {
      title: 'No camera found',
      body: 'Connect a webcam (or enable the built-in one) and press Retry. You can still try the smoke with “Test smoke” (T).'
    };
    case 'inuse': return {
      title: 'Camera is busy',
      body: 'Another app or browser tab is using the camera. Close it and press Retry.'
    };
    case 'insecure': return {
      title: 'Camera not available on this page',
      body: 'Open the app in desktop Chrome or Edge on http://localhost (npm run dev) or over https. Browsers block cameras on plain http.'
    };
    case 'models': return {
      title: 'Tracking models failed to load',
      body: e.message + ' — run “npm run setup-assets” to (re)download them into public/models, then reload.'
    };
    default: return { title: 'Something went wrong', body: e.message || String(err) };
  }
}

function toTrackingError(err: unknown): TrackingError {
  if (err instanceof TrackingError) return err;
  const name = (err as { name?: string })?.name ?? '';
  const msg = (err as { message?: string })?.message ?? String(err);
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return new TrackingError('permission', msg);
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return new TrackingError('nocamera', msg);
  if (name === 'NotSupportedError' || name === 'TypeError')
    return new TrackingError('insecure', msg);
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
    return new TrackingError('inuse', msg);
  return new TrackingError('unknown', msg);
}

/** Vite's dev server answers unknown paths with index.html; catch that before MediaPipe does. */
export async function assertAsset(url: string, label: string): Promise<void> {
  let res: Response;
  try { res = await fetch(url, { method: 'HEAD' }); }
  catch { throw new TrackingError('models', `Could not reach ${label}`); }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || type.includes('text/html')) throw new TrackingError('models', `${label} is missing (${url})`);
}

export class Tracker {
  face: FaceLandmarker | null = null;
  hands: HandLandmarker | null = null;
  delegate: 'GPU' | 'CPU' = 'GPU';
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private numFaces = 1;
  stream: MediaStream | null = null;
  private lastVideoTime = -1;
  private lastTs = 0;

  constructor(public video: HTMLVideoElement) {}

  get ready(): boolean { return !!this.face && !!this.hands && !!this.stream; }

  private loading: Promise<'GPU' | 'CPU'> | null = null;

  /** Loads both models once; concurrent / repeated calls share the same promise. */
  loadModels(): Promise<'GPU' | 'CPU'> {
    this.loading ??= this.load().catch(e => { this.loading = null; throw e; });
    return this.loading;
  }

  private async load(): Promise<'GPU' | 'CPU'> {
    await Promise.all([
      assertAsset(FACE_MODEL, 'face_landmarker.task'),
      assertAsset(HAND_MODEL, 'hand_landmarker.task'),
      assertAsset(WASM_PATH + '/vision_wasm_internal.wasm', 'MediaPipe WASM runtime')
    ]);
    let fileset;
    try { fileset = this.fileset = await FilesetResolver.forVisionTasks(WASM_PATH); }
    catch (e) { throw new TrackingError('models', 'MediaPipe runtime failed to start: ' + (e as Error).message); }

    const make = async (delegate: 'GPU' | 'CPU') => {
      const face = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'VIDEO', numFaces: this.numFaces, outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5
      });
      const hands = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate },
        runningMode: 'VIDEO', numHands: 2,
        // Lower than the defaults: a hand holding a pen at the mouth is partly hidden by the face.
        minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35
      });
      return { face, hands };
    };
    try {
      Object.assign(this, await make('GPU'));
      this.delegate = 'GPU';
    } catch (gpuErr) {
      console.warn('GPU delegate failed, falling back to CPU', gpuErr);
      try {
        Object.assign(this, await make('CPU'));
        this.delegate = 'CPU';
      } catch (e) {
        throw new TrackingError('models', 'Could not create the landmark models: ' + (e as Error).message);
      }
    }
    return this.delegate;
  }

  async startCamera(): Promise<{ width: number; height: number }> {
    if (this.stream?.active) return { width: this.video.videoWidth, height: this.video.videoHeight };
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new TrackingError('insecure', 'getUserMedia is not available on this page');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: IS_MOBILE
          ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 30 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user', frameRate: { ideal: 30 } },
        audio: false
      });
    } catch (e) {
      throw toTrackingError(e);
    }
    const v = this.video;
    v.srcObject = this.stream;
    v.muted = true;
    await v.play();
    if (!v.videoWidth) await new Promise<void>(r => v.addEventListener('loadedmetadata', () => r(), { once: true }));
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => this.onEnded?.());
    return { width: v.videoWidth, height: v.videoHeight };
  }

  /** Track one face, or two for 2-player mode. */
  async setNumFaces(n: 1 | 2): Promise<void> {
    this.numFaces = n;
    if (this.face) await this.face.setOptions({ numFaces: n });
  }

  /** Last timestamp handed to MediaPipe (other tasks on the same video reuse it). */
  get timestamp(): number { return this.lastTs; }

  /** Called if the camera is unplugged / stopped by the OS. */
  onEnded: (() => void) | null = null;

  /** Runs both landmarkers when the video has a new frame; otherwise returns null. */
  detect(now: number): TrackingFrame | null {
    const v = this.video;
    if (!this.face || !this.hands || v.readyState < 2 || v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    const ts = Math.max(now, this.lastTs + 1);   // timestamps must strictly increase
    this.lastTs = ts;

    const fr = this.face.detectForVideo(v, ts);
    const hr = this.hands.detectForVideo(v, ts);

    const faces: TrackingFrame['faces'] = (fr.faceLandmarks ?? []).map((landmarks, i) => {
      const blendshapes: Record<string, number> = {};
      for (const c of fr.faceBlendshapes?.[i]?.categories ?? []) blendshapes[c.categoryName] = c.score;
      return { landmarks, blendshapes };
    });
    return { faces, hands: hr.landmarks ?? [], width: v.videoWidth, height: v.videoHeight, now };
  }

  stop(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }
}

/** Lip outline connections, for the debug overlay. */
export const LIP_CONNECTIONS = FaceLandmarker.FACE_LANDMARKS_LIPS;
export const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;
