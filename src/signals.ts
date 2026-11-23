/**
 * Turns raw MediaPipe landmarks + blendshapes into the handful of signals the
 * state machine needs. DOM-free; all coordinates returned are *screen* pixels
 * of the mirrored view (x is flipped so it matches the selfie-style video).
 */

export interface Pt { x: number; y: number }
export interface Landmark { x: number; y: number; z?: number }

export interface FaceObservation {
  landmarks: Landmark[];
  blendshapes: Record<string, number>;
}

export interface TrackingFrame {
  face: FaceObservation | null;
  hands: Landmark[][];
  width: number;   // video pixels
  height: number;
  now: number;     // ms
}

export interface SignalConfig {
  penNear: number;
  penExt: number;
  pinchMax: number;
}

export interface PenEstimate {
  grip: Pt;        // midpoint of thumb tip and index tip
  tip: Pt;         // estimated pen tip, extended along the index finger
  dir: Pt;         // unit vector, index MCP → index tip
  handSize: number;
  pinch: number;   // thumb–index gap / hand size
  dist: number;    // min(grip, tip) distance to the mouth / face width (Infinity without a mouth)
}

export interface Signals {
  blow: number;        // smoothed max(pucker, funnel)
  rawBlow: number;
  pucker: number;
  funnel: number;
  jaw: number;
  close: number;
  cheek: number;
  faceVisible: boolean;
  mouth: Pt | null;    // last-known mouth position (kept ~1.5 s after the face drops)
  faceW: number;       // face width in pixels (234 ↔ 454)
  aim: Pt;             // where the face points, roughly (unit-ish, for smoke direction)
  pen: PenEstimate | null;
  penNear: boolean;    // debounced, with hysteresis and grace
  pinchOk: boolean;
}

// Landmark indices
export const LM = {
  upperLipInner: 13, lowerLipInner: 14, faceLeft: 234, faceRight: 454, noseTip: 1,
  wrist: 0, thumbTip: 4, indexMcp: 5, indexTip: 8, middleMcp: 9
} as const;

export const MOUTH_MEMORY_MS = 1500;
export const GRACE_MS = 400;
export const PEN_HYSTERESIS = 1.2;
export const BLOW_SMOOTH_TAU = 0.06; // seconds

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Normalised landmark → mirrored screen pixels. */
export const toScreen = (l: Landmark, W: number, H: number): Pt => ({ x: (1 - l.x) * W, y: l.y * H });

export function mouthCenter(lm: Landmark[], W: number, H: number): Pt {
  const a = toScreen(lm[LM.upperLipInner], W, H), b = toScreen(lm[LM.lowerLipInner], W, H);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function faceWidth(lm: Landmark[], W: number, H: number): number {
  return dist(toScreen(lm[LM.faceLeft], W, H), toScreen(lm[LM.faceRight], W, H));
}

/** Rough head direction: nose tip offset from the face centre, in face widths. */
export function faceAim(lm: Landmark[], W: number, H: number): Pt {
  const l = toScreen(lm[LM.faceLeft], W, H), r = toScreen(lm[LM.faceRight], W, H);
  const n = toScreen(lm[LM.noseTip], W, H);
  const fw = dist(l, r) || 1;
  return { x: (n.x - (l.x + r.x) / 2) / fw, y: (n.y - (l.y + r.y) / 2) / fw };
}

export function blowScore(bs: Record<string, number>): number {
  return Math.max(bs.mouthPucker ?? 0, bs.mouthFunnel ?? 0);
}

/** Pen estimate for one hand. MediaPipe has no pen detector, so the hand is the proxy. */
export function estimatePen(hand: Landmark[], W: number, H: number, penExt: number,
                            mouth: Pt | null, faceW: number): PenEstimate {
  const P = (i: number) => toScreen(hand[i], W, H);
  const wrist = P(LM.wrist), midMcp = P(LM.middleMcp), th = P(LM.thumbTip), ix = P(LM.indexTip), mcp = P(LM.indexMcp);
  const handSize = dist(wrist, midMcp) || 1;
  const pinch = dist(th, ix) / handSize;
  const grip = { x: (th.x + ix.x) / 2, y: (th.y + ix.y) / 2 };
  const dl = dist(ix, mcp) || 1;
  const dir = { x: (ix.x - mcp.x) / dl, y: (ix.y - mcp.y) / dl };
  const tip = { x: ix.x + dir.x * penExt * handSize, y: ix.y + dir.y * penExt * handSize };
  const d = mouth ? Math.min(dist(grip, mouth), dist(tip, mouth)) / (faceW || 1) : Infinity;
  return { grip, tip, dir, handSize, pinch, dist: d };
}

/** Stateful part: smoothing, hysteresis, grace periods and last-known positions. */
export class SignalProcessor {
  private smoothBlow = 0;
  private lastT: number | null = null;
  private lastFaceT = -Infinity;
  private lastPenNearT = -Infinity;
  private penLatched = false;
  private bs: Record<string, number> = {};
  private mouth: Pt | null = null;
  private faceW = 0;
  private aim: Pt = { x: 0, y: 0.15 };

  reset(): void {
    this.smoothBlow = 0; this.lastT = null; this.lastFaceT = -Infinity; this.lastPenNearT = -Infinity;
    this.penLatched = false; this.bs = {}; this.mouth = null; this.faceW = 0;
  }

  update(f: TrackingFrame, cfg: SignalConfig): Signals {
    const { width: W, height: H, now } = f;
    const dt = this.lastT == null ? 1 / 30 : Math.max(0, Math.min(0.25, (now - this.lastT) / 1000));
    this.lastT = now;

    if (f.face && f.face.landmarks.length > 454) {
      const lm = f.face.landmarks;
      this.lastFaceT = now;
      this.mouth = mouthCenter(lm, W, H);
      this.faceW = faceWidth(lm, W, H) || this.faceW;
      const a = faceAim(lm, W, H);
      this.aim = { x: this.aim.x + (a.x - this.aim.x) * 0.3, y: this.aim.y + (a.y - this.aim.y) * 0.3 };
      this.bs = { ...f.face.blendshapes };
    }
    const faceVisible = now - this.lastFaceT < GRACE_MS;
    const mouthValid = now - this.lastFaceT < MOUTH_MEMORY_MS && this.mouth != null;
    if (!mouthValid) this.mouth = null;
    const bs = faceVisible ? this.bs : {};

    const rawBlow = blowScore(bs);
    const k = 1 - Math.exp(-dt / BLOW_SMOOTH_TAU);
    this.smoothBlow += (rawBlow - this.smoothBlow) * k;

    // Pick the hand whose pen estimate is closest to the mouth.
    let best: PenEstimate | null = null;
    for (const h of f.hands) {
      if (h.length < 21) continue;
      const p = estimatePen(h, W, H, cfg.penExt, this.mouth, this.faceW);
      if (!best || p.dist < best.dist) best = p;
    }

    const limit = this.penLatched ? cfg.penNear * PEN_HYSTERESIS : cfg.penNear;
    const nearNow = !!best && best.dist < limit;
    this.penLatched = nearNow;
    if (nearNow) this.lastPenNearT = now;

    return {
      blow: this.smoothBlow,
      rawBlow,
      pucker: bs.mouthPucker ?? 0,
      funnel: bs.mouthFunnel ?? 0,
      jaw: bs.jawOpen ?? 0,
      close: bs.mouthClose ?? 0,
      cheek: bs.cheekPuff ?? 0,
      faceVisible,
      mouth: this.mouth,
      faceW: this.faceW || W * 0.2,
      aim: this.aim,
      pen: best,
      penNear: now - this.lastPenNearT < GRACE_MS,   // survives brief hand/face occlusion
      pinchOk: !!best && best.pinch < cfg.pinchMax
    };
  }
}

export function emptySignals(W = 1280): Signals {
  return {
    blow: 0, rawBlow: 0, pucker: 0, funnel: 0, jaw: 0, close: 0, cheek: 0, faceVisible: false,
    mouth: null, faceW: W * 0.2, aim: { x: 0, y: 0.15 }, pen: null, penNear: false, pinchOk: false
  };
}
