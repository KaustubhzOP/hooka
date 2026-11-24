/**
 * Turns raw MediaPipe landmarks + blendshapes into the signals the state
 * machine and effects need. DOM-free; all coordinates returned are *screen*
 * pixels of the mirrored view (x is flipped so it matches the selfie video).
 */

export interface Pt { x: number; y: number }
export interface Landmark { x: number; y: number; z?: number }

export interface FaceObservation {
  landmarks: Landmark[];
  blendshapes: Record<string, number>;
}

export interface TrackingFrame {
  faces: FaceObservation[];
  hands: Landmark[][];
  width: number;   // video pixels
  height: number;
  now: number;     // ms
}

export interface SignalConfig {
  penNear: number;
  penExt: number;
  pinchMax: number;
  pitchOffset?: number;   // neutral pitch (radians) to subtract
}

export interface PenEstimate {
  grip: Pt;        // midpoint of thumb tip and index tip
  tip: Pt;         // estimated pen tip, extended along the index finger
  dir: Pt;         // unit vector, index MCP → index tip
  handSize: number;
  pinch: number;   // thumb–index gap / hand size
  dist: number;    // closest of grip / tip / thumb / index / middle tips to the mouth, in face widths
}

export interface HandMotion {
  palm: Pt;        // palm centre
  vel: Pt;         // px/s, smoothed
  tips: Pt[];      // index and middle fingertips
  size: number;    // hand size px
}

export interface Signals {
  blow: number;        // smoothed max(pucker, funnel)
  rawBlow: number;
  pucker: number;
  funnel: number;      // smoothed
  jaw: number;         // smoothed
  close: number;
  cheek: number;
  sneer: number;       // smoothed max(noseSneerLeft, noseSneerRight)
  pitch: number;       // head pitch in radians relative to the calibrated neutral; + = looking up
  faceVisible: boolean;
  faceCount: number;
  mouth: Pt | null;    // last-known mouth position (kept ~1.5 s after the face drops)
  nostrils: [Pt, Pt] | null;
  faceW: number;       // face width in pixels (234 ↔ 454)
  aim: Pt;             // where the face points, roughly (for smoke direction)
  pen: PenEstimate | null;
  penNear: boolean;    // debounced, with hysteresis and grace
  pinchOk: boolean;
  hands: HandMotion[];
}

// Landmark indices
export const LM = {
  upperLipInner: 13, lowerLipInner: 14, faceLeft: 234, faceRight: 454, noseTip: 1,
  nostrilLeft: 98, nostrilRight: 327, subnasale: 2, forehead: 10, chin: 152,
  wrist: 0, thumbTip: 4, indexMcp: 5, indexTip: 8, middleMcp: 9, middleTip: 12, ringMcp: 13
} as const;

export const MOUTH_MEMORY_MS = 1500;
export const GRACE_MS = 600;
export const PEN_HYSTERESIS = 1.25;
export const SMOOTH_TAU = 0.07; // seconds, for the gesture channels

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Normalised landmark → mirrored screen pixels. */
export const toScreen = (l: Landmark, W: number, H: number): Pt => ({ x: (1 - l.x) * W, y: l.y * H });

export function mouthCenter(lm: Landmark[], W: number, H: number): Pt {
  const a = toScreen(lm[LM.upperLipInner], W, H), b = toScreen(lm[LM.lowerLipInner], W, H);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The two nostril openings: the alar points pulled a little towards the base of the nose. */
export function nostrils(lm: Landmark[], W: number, H: number): [Pt, Pt] {
  const c = toScreen(lm[LM.subnasale], W, H);
  const at = (i: number) => { const p = toScreen(lm[i], W, H); return { x: p.x + (c.x - p.x) * 0.35, y: p.y + (c.y - p.y) * 0.35 }; };
  return [at(LM.nostrilLeft), at(LM.nostrilRight)];
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

/**
 * Head pitch from the forehead→chin vector in 3D. Looking up brings the chin
 * towards the camera (smaller z) and pushes the forehead away. + = looking up.
 * MediaPipe's z is in roughly the same units as x (image width).
 */
export function headPitch(lm: Landmark[], W: number, H: number): number {
  const f = lm[LM.forehead], c = lm[LM.chin];
  return Math.atan2(((f.z ?? 0) - (c.z ?? 0)) * W, (c.y - f.y) * H);
}

export function blowScore(bs: Record<string, number>): number {
  return Math.max(bs.mouthPucker ?? 0, bs.mouthFunnel ?? 0);
}

/** Pen estimate for one hand. MediaPipe has no pen detector, so the hand is the proxy. */
export function estimatePen(hand: Landmark[], W: number, H: number, penExt: number,
                            mouth: Pt | null, faceW: number): PenEstimate {
  const P = (i: number) => toScreen(hand[i], W, H);
  const wrist = P(LM.wrist), midMcp = P(LM.middleMcp), th = P(LM.thumbTip), ix = P(LM.indexTip), mcp = P(LM.indexMcp);
  const mid = P(LM.middleTip);
  const handSize = dist(wrist, midMcp) || 1;
  const pinch = dist(th, ix) / handSize;
  const grip = { x: (th.x + ix.x) / 2, y: (th.y + ix.y) / 2 };
  const dl = dist(ix, mcp) || 1;
  const dir = { x: (ix.x - mcp.x) / dl, y: (ix.y - mcp.y) / dl };
  const tip = { x: ix.x + dir.x * penExt * handSize, y: ix.y + dir.y * penExt * handSize };
  // Any of these near the lips counts: hands are often half-occluded at the mouth,
  // which makes the extrapolated tip jumpy, so the fingertips are a sturdier fallback.
  const d = mouth
    ? Math.min(dist(grip, mouth), dist(tip, mouth), dist(th, mouth) * 1.1, dist(ix, mouth) * 1.1, dist(mid, mouth) * 1.25) / (faceW || 1)
    : Infinity;
  return { grip, tip, dir, handSize, pinch, dist: d };
}

const faceSpan = (f: FaceObservation) => Math.abs(f.landmarks[LM.faceLeft].x - f.landmarks[LM.faceRight].x);
const faceCenterX = (f: FaceObservation) => 1 - (f.landmarks[LM.faceLeft].x + f.landmarks[LM.faceRight].x) / 2;

/**
 * Pick which face to follow. In 2-player mode `slot` 0 is the left face on
 * screen and 1 the right one; otherwise the face nearest the last mouth.
 */
export function selectFace(faces: FaceObservation[], slot: number | null, lastMouthX: number | null, W: number): FaceObservation | null {
  const ok = faces.filter(f => f.landmarks.length > 454);
  if (!ok.length) return null;
  if (ok.length === 1) return ok[0];
  const sorted = [...ok].sort((a, b) => faceCenterX(a) - faceCenterX(b));
  if (slot === -1) return ok.reduce((big, f) => faceSpan(f) > faceSpan(big) ? f : big);   // closest to the camera
  if (slot != null) return sorted[Math.min(slot, sorted.length - 1)];
  if (lastMouthX == null) return sorted[0];
  return sorted.reduce((best, f) => Math.abs(faceCenterX(f) * W - lastMouthX) < Math.abs(faceCenterX(best) * W - lastMouthX) ? f : best);
}

/** Stateful part: smoothing, hysteresis, grace periods and last-known positions. */
export class SignalProcessor {
  private s = { blow: 0, funnel: 0, jaw: 0, sneer: 0, pitch: 0 };
  private lastT: number | null = null;
  private lastFaceT = -Infinity;
  private lastPenNearT = -Infinity;
  private penLatched = false;
  private bs: Record<string, number> = {};
  private mouth: Pt | null = null;
  private nose: [Pt, Pt] | null = null;
  private faceW = 0;
  private aim: Pt = { x: 0, y: 0.15 };
  private rawPitch = 0;
  private prevHands: HandMotion[] = [];
  /** Same-device: which face to follow (0 = leftmost …; -1 = the face closest to the camera); null = single player. */
  slot: number | null = null;

  reset(): void {
    this.s = { blow: 0, funnel: 0, jaw: 0, sneer: 0, pitch: 0 };
    this.lastT = null; this.lastFaceT = -Infinity; this.lastPenNearT = -Infinity;
    this.penLatched = false; this.bs = {}; this.mouth = null; this.nose = null; this.faceW = 0;
    this.prevHands = [];
  }

  update(f: TrackingFrame, cfg: SignalConfig): Signals {
    const { width: W, height: H, now } = f;
    const dt = this.lastT == null ? 1 / 30 : Math.max(0, Math.min(0.25, (now - this.lastT) / 1000));
    this.lastT = now;

    const face = selectFace(f.faces, this.slot, this.mouth?.x ?? null, W);
    if (face) {
      const lm = face.landmarks;
      this.lastFaceT = now;
      this.mouth = mouthCenter(lm, W, H);
      this.nose = nostrils(lm, W, H);
      this.faceW = faceWidth(lm, W, H) || this.faceW;
      const a = faceAim(lm, W, H);
      this.aim = { x: this.aim.x + (a.x - this.aim.x) * 0.3, y: this.aim.y + (a.y - this.aim.y) * 0.3 };
      this.rawPitch = headPitch(lm, W, H);
      this.bs = { ...face.blendshapes };
    }
    const faceVisible = now - this.lastFaceT < GRACE_MS;
    const mouthValid = now - this.lastFaceT < MOUTH_MEMORY_MS && this.mouth != null;
    if (!mouthValid) { this.mouth = null; this.nose = null; }
    const bs = faceVisible ? this.bs : {};

    // Exponential smoothing of the gesture channels (blendshapes are jittery frame to frame).
    const k = 1 - Math.exp(-dt / SMOOTH_TAU);
    const rawBlow = blowScore(bs);
    const target = {
      blow: rawBlow,
      funnel: bs.mouthFunnel ?? 0,
      jaw: bs.jawOpen ?? 0,
      sneer: Math.max(bs.noseSneerLeft ?? 0, bs.noseSneerRight ?? 0),
      pitch: faceVisible ? this.rawPitch - (cfg.pitchOffset ?? 0) : this.s.pitch
    };
    for (const key of Object.keys(this.s) as (keyof typeof this.s)[]) this.s[key] += (target[key] - this.s[key]) * k;

    // Pick the hand whose pen estimate is closest to the mouth.
    let best: PenEstimate | null = null;
    const hands: HandMotion[] = [];
    for (const h of f.hands) {
      if (h.length < 21) continue;
      const p = estimatePen(h, W, H, cfg.penExt, this.mouth, this.faceW);
      if (!best || p.dist < best.dist) best = p;
      const P = (i: number) => toScreen(h[i], W, H);
      const palm = { x: (P(0).x + P(5).x + P(17).x) / 3, y: (P(0).y + P(5).y + P(17).y) / 3 };
      const prev = this.prevHands.reduce<HandMotion | null>((b, q) => (!b || dist(q.palm, palm) < dist(b.palm, palm) ? q : b), null);
      let vel = { x: 0, y: 0 };
      if (prev && dt > 0 && dist(prev.palm, palm) < p.handSize * 3) {
        const vx = (palm.x - prev.palm.x) / dt, vy = (palm.y - prev.palm.y) / dt;
        vel = { x: prev.vel.x + (vx - prev.vel.x) * 0.5, y: prev.vel.y + (vy - prev.vel.y) * 0.5 };
      }
      hands.push({ palm, vel, tips: [P(LM.indexTip), P(LM.middleTip)], size: p.handSize });
    }
    this.prevHands = hands;

    const limit = this.penLatched ? cfg.penNear * PEN_HYSTERESIS : cfg.penNear;
    const nearNow = !!best && best.dist < limit;
    this.penLatched = nearNow;
    if (nearNow) this.lastPenNearT = now;

    return {
      blow: this.s.blow,
      rawBlow,
      pucker: bs.mouthPucker ?? 0,
      funnel: this.s.funnel,
      jaw: this.s.jaw,
      close: bs.mouthClose ?? 0,
      cheek: bs.cheekPuff ?? 0,
      sneer: this.s.sneer,
      pitch: this.s.pitch,
      faceVisible,
      faceCount: f.faces.length,
      mouth: this.mouth,
      nostrils: this.nose,
      faceW: this.faceW || W * 0.2,
      aim: this.aim,
      pen: best,
      penNear: now - this.lastPenNearT < GRACE_MS,   // survives brief hand/face occlusion
      pinchOk: !!best && best.pinch < cfg.pinchMax,
      hands
    };
  }

  /** Raw (un-offset) pitch of the last seen face, for calibration. */
  get neutralPitchSample(): number { return this.rawPitch; }
}

export function emptySignals(W = 1280): Signals {
  return {
    blow: 0, rawBlow: 0, pucker: 0, funnel: 0, jaw: 0, close: 0, cheek: 0, sneer: 0, pitch: 0,
    faceVisible: false, faceCount: 0, mouth: null, nostrils: null, faceW: W * 0.2, aim: { x: 0, y: 0.15 },
    pen: null, penNear: false, pinchOk: false, hands: []
  };
}
