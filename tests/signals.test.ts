import { describe, it, expect } from 'vitest';
import { SignalProcessor, estimatePen, blowScore, headPitch, selectFace, type Landmark, type TrackingFrame } from '../src/signals';

const W = 1000, H = 1000;
const cfg = { penNear: 0.9, penExt: 0.6, pinchMax: 0.5 };

/** A face whose mouth is at normalised (0.5, 0.6) and width 0.2. */
function face(blend: Record<string, number> = {}) {
  const lm: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  lm[13] = { x: 0.5, y: 0.59 }; lm[14] = { x: 0.5, y: 0.61 };
  lm[234] = { x: 0.6, y: 0.5 }; lm[454] = { x: 0.4, y: 0.5 };
  lm[1] = { x: 0.5, y: 0.52 };
  lm[10] = { x: 0.5, y: 0.35, z: 0 }; lm[152] = { x: 0.5, y: 0.7, z: 0 };
  return { landmarks: lm, blendshapes: blend };
}

/** A hand pointing at normalised (x, y) with the given pinch gap. */
function hand(x: number, y: number, pinchGap = 0.01): Landmark[] {
  const h: Landmark[] = Array.from({ length: 21 }, () => ({ x, y: y + 0.2 }));
  h[0] = { x, y: y + 0.2 };          // wrist
  h[9] = { x, y: y + 0.1 };          // middle MCP → hand size 0.1
  h[5] = { x, y: y + 0.05 };         // index MCP
  h[8] = { x, y };                   // index tip
  h[4] = { x: x + pinchGap, y };     // thumb tip
  return h;
}

const frame = (now: number, f: ReturnType<typeof face> | null, hands: Landmark[][] = []): TrackingFrame =>
  ({ faces: f ? [f] : [], hands, width: W, height: H, now });

describe('signals', () => {
  it('blow score is max(pucker, funnel)', () => {
    expect(blowScore({ mouthPucker: 0.3, mouthFunnel: 0.5 })).toBe(0.5);
    expect(blowScore({})).toBe(0);
  });

  it('extends the pen tip along the index direction (mirrored x)', () => {
    const p = estimatePen(hand(0.5, 0.5), W, H, 0.6, null, 200);
    expect(p.handSize).toBeCloseTo(100);
    expect(p.tip.y).toBeCloseTo(500 - 60);
    expect(p.dist).toBe(Infinity);
    const q = estimatePen(hand(0.3, 0.5), W, H, 0, null, 200);
    expect(q.tip.x).toBeCloseTo(700);   // 1 - 0.3
  });

  it('smooths the blow score exponentially', () => {
    const sp = new SignalProcessor();
    let s = sp.update(frame(0, face({ mouthPucker: 1 })), cfg);
    expect(s.blow).toBeGreaterThan(0);
    expect(s.blow).toBeLessThan(1);
    for (let t = 33; t < 500; t += 33) s = sp.update(frame(t, face({ mouthPucker: 1 })), cfg);
    expect(s.blow).toBeGreaterThan(0.95);
  });

  it('detects the pen near the mouth with hysteresis and a grace period', () => {
    const sp = new SignalProcessor();
    // mouth at (500, 600) px, face width 200 px; hand tip pointing at the mouth
    let s = sp.update(frame(0, face(), [hand(0.5, 0.68)]), cfg);
    expect(s.penNear).toBe(true);
    // slightly beyond 0.9 face widths but within 1.2× hysteresis
    s = sp.update(frame(33, face(), [hand(0.5, 0.6 + 0.2 + 0.06)]), cfg);
    expect(s.pen!.dist).toBeGreaterThan(0.9);
    expect(s.pen!.dist).toBeLessThan(1.12);
    expect(s.penNear).toBe(true);
    // hand disappears: grace keeps it near for ~600 ms
    s = sp.update(frame(200, face(), []), cfg);
    expect(s.penNear).toBe(true);
    s = sp.update(frame(800, face(), []), cfg);
    expect(s.penNear).toBe(false);
  });

  it('keeps the last mouth position for ~1.5 s after the face drops', () => {
    const sp = new SignalProcessor();
    sp.update(frame(0, face()), cfg);
    expect(sp.update(frame(1000, null), cfg).mouth).not.toBeNull();
    expect(sp.update(frame(1700, null), cfg).mouth).toBeNull();
  });

  it('computes head pitch from the forehead→chin depth (+ = looking up)', () => {
    const up = face(); up.landmarks[10] = { x: 0.5, y: 0.35, z: 0.05 }; up.landmarks[152] = { x: 0.5, y: 0.7, z: -0.05 };
    expect(headPitch(up.landmarks, W, H)).toBeGreaterThan(0.2);
    expect(headPitch(face().landmarks, W, H)).toBeCloseTo(0);
  });

  it('follows the left or right face in 2-player mode', () => {
    const left = face(), right = face();
    // mirrored: a face at normalised x 0.8 appears on the LEFT of the screen
    for (const [f, x] of [[left, 0.8], [right, 0.2]] as const) { f.landmarks[234] = { x: x + 0.1, y: 0.5 }; f.landmarks[454] = { x: x - 0.1, y: 0.5 }; }
    expect(selectFace([right, left], 0, null, W)).toBe(left);
    expect(selectFace([right, left], 1, null, W)).toBe(right);
  });

  it('reports the pinch grip', () => {
    const sp = new SignalProcessor();
    expect(sp.update(frame(0, face(), [hand(0.5, 0.68, 0.01)]), cfg).pinchOk).toBe(true);
    expect(sp.update(frame(33, face(), [hand(0.5, 0.68, 0.09)]), cfg).pinchOk).toBe(false);
  });
});
