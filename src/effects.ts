/**
 * The smoke director: turns the state machine + face geometry into smoke.
 * Mouth plume, nose streams, waterfall, rings, ghost ball, French inhale,
 * blowing at smoke in the air and stirring it with your hand.
 */
import type { SmokeRenderer } from './smoke';
import type { Machine } from './machine';
import type { Pt, Signals } from './signals';
import type { Settings } from './settings';

export interface FaceGeo { mouth: Pt; faceW: number; scale: number; nostrils: [Pt, Pt]; aim: Pt; tracked: boolean }

export interface DirectorOutput {
  whoosh: number;       // 0…1 for the exhale sound
  waterfall: boolean;   // the current exhale is pouring down
  stirred: number;      // particles moved by a hand this frame
  gust: number;         // particles pushed by blowing this frame
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;

/** Mouth, nostrils, face size and head direction, with fallbacks when no face is tracked (test buttons). */
export function faceGeometry(sig: Signals, W: number, H: number, running: boolean): FaceGeo {
  const tracked = !!sig.mouth;
  const mouth: Pt = sig.mouth ?? { x: W * 0.45, y: H * 0.6 };
  const faceW = tracked ? sig.faceW : Math.min(W, H) * 0.3;
  const nostrils: [Pt, Pt] = sig.nostrils ?? [
    { x: mouth.x - 0.07 * faceW, y: mouth.y - 0.17 * faceW },
    { x: mouth.x + 0.07 * faceW, y: mouth.y - 0.17 * faceW }
  ];
  const aim = running && tracked ? sig.aim : { x: 0, y: 0.15 };
  return { mouth, faceW, scale: faceW / 300, nostrils, aim, tracked };
}

export class SmokeDirector {
  private emitAcc = 0;
  private noseAcc = 0;
  private noseSide = 0;
  private ghost: { id: number; t: number; phase: 'forming' | 'out' | 'recall' } | null = null;
  private french: { groups: [number, number]; acc: number; endT: number } | null = null;
  private frenchDemo = 0;
  private waterfallDemo = 0;

  constructor(private smoke: SmokeRenderer) {}

  reset(): void {
    this.emitAcc = this.noseAcc = 0;
    if (this.ghost) this.smoke.releaseGroup(this.ghost.id);
    if (this.french) this.french.groups.forEach(g => this.smoke.releaseGroup(g));
    this.ghost = null; this.french = null;
  }

  /** Camera-free demos for the "Try it" buttons. */
  demoFrench(seconds: number): void { this.frenchDemo = seconds; }
  demoWaterfall(seconds: number): void { this.waterfallDemo = seconds; }

  ring(geo: FaceGeo, strength: number, s: Settings): void {
    this.smoke.emitRing({
      x: geo.mouth.x, y: geo.mouth.y,
      dirX: geo.aim.x * 3, dirY: -0.55,
      speed: (45 + 45 * strength) * geo.scale * s.speed,
      radius: 0.13 * geo.faceW, expand: 24 * geo.scale * s.spread,
      scale: geo.scale, strength
    });
  }

  ghostOut(geo: FaceGeo): void {
    if (this.ghost) this.smoke.releaseGroup(this.ghost.id);
    const id = this.smoke.createGroup(geo.mouth.x, geo.mouth.y + 0.05 * geo.faceW, 'hold', 10);
    this.ghost = { id, t: 0, phase: 'forming' };
  }
  ghostIn(geo: FaceGeo): void {
    if (!this.ghost) return;
    this.ghost.phase = 'recall'; this.ghost.t = 0;
    this.smoke.setGroupMode(this.ghost.id, 'recall', 16, 0.06 * geo.faceW);
  }
  ghostLost(): void {
    if (!this.ghost) return;
    this.smoke.releaseGroup(this.ghost.id);
    this.ghost = null;
  }

  update(dt: number, m: Machine, sig: Signals, geo: FaceGeo, s: Settings, running: boolean): DirectorOutput {
    const out: DirectorOutput = { whoosh: 0, waterfall: false, stirred: 0, gust: 0 };
    const smoke = this.smoke, { mouth, faceW, scale } = geo;
    this.frenchDemo = Math.max(0, this.frenchDemo - dt);
    this.waterfallDemo = Math.max(0, this.waterfallDemo - dt);

    // ---- exhale: mouth plume, nose streams, waterfall
    const ex = m.exhale;
    if (m.state === 'EXHALING' && ex) {
      const u = ex.t / ex.duration;
      const env = 1 - u * u;
      const pulse = ex.kind === 'cough' ? coughPulse(ex.t) : 1;
      const live = running && ex.kind === 'blow' && sig.faceVisible
        ? 0.55 + 0.45 * clamp(sig.blow / Math.max(0.05, s.blowOn * 1.5), 0, 1) : 1;
      const strength = ex.strength * env * pulse;
      const puffStrength = clamp(0.35 + 0.65 * ex.strength * env, 0, 1);
      const waterfall = (ex.kind === 'blow' || ex.kind === 'test')
        && (this.waterfallDemo > 0 || (running && geo.tracked && sig.pitch <= -s.waterfallPitch * DEG));
      out.waterfall = waterfall;

      if (ex.kind !== 'nose') {
        this.emitAcc += dt * 90 * s.density * strength * live;
        const n = Math.floor(this.emitAcc); this.emitAcc -= n;
        if (n > 0) {
          if (waterfall) {
            // heavy smoke pours down off the lip, then slowly lifts
            smoke.emit(n, {
              x: mouth.x, y: mouth.y + 6 * scale,
              dirX: geo.aim.x * 1.2, dirY: 1,
              speed: (60 + 80 * ex.strength) * scale * s.speed,
              spread: 0.7 * s.spread, scale, strength: puffStrength,
              buoy: -1.6, turb: 0.35, drag: 0.7, sizeMul: 0.8
            });
          } else {
            const jet = clamp(Math.abs(geo.aim.x) * 4, 0, 1);
            const kindSpread = ex.kind === 'leak' ? 1.6 : ex.kind === 'cough' ? 1.3 : 1;
            smoke.emit(n, {
              x: mouth.x, y: mouth.y + 4 * scale,
              dirX: geo.aim.x * 4, dirY: 0.55 + geo.aim.y,
              speed: (70 + 170 * ex.strength) * scale * s.speed * (0.7 + 0.6 * jet) * (ex.kind === 'leak' ? 0.5 : 1),
              spread: Math.min(Math.PI * 1.9, s.spread * (2.2 - 1.1 * jet) * kindSpread),
              scale, strength: puffStrength
            });
          }
        }
      }

      const noseShare = ex.kind === 'nose' ? 1 : (ex.kind === 'blow' || ex.kind === 'test') ? s.noseSmoke : 0;
      if (noseShare > 0) {
        this.noseAcc += dt * (ex.kind === 'nose' ? 60 : 30) * noseShare * s.density * strength;
        const n = Math.floor(this.noseAcc); this.noseAcc -= n;
        const cx = (geo.nostrils[0].x + geo.nostrils[1].x) / 2;
        for (let k = 0; k < n; k++) {
          const side = this.noseSide++ & 1;                 // alternate nostrils across frames
          const nos = geo.nostrils[side];
          const outward = Math.sign(nos.x - cx) || (side ? 1 : -1);
          smoke.emit(1, {
            x: nos.x, y: nos.y,
            dirX: outward * 0.35 + geo.aim.x * 2, dirY: 1,  // nose smoke streams down and slightly outwards
            speed: (130 + 130 * ex.strength) * scale * s.speed,
            spread: 0.35 * s.spread,
            scale, strength: puffStrength * (ex.kind === 'nose' ? 0.9 : 0.7),
            sizeMul: 0.32, turb: 0.3, growth: 0.6, drag: 0.8, jitter: 3 * scale
          });
        }
      }
      out.whoosh = clamp(strength * live * (ex.kind === 'cough' ? 0.6 : ex.kind === 'nose' ? 0.55 : 1), 0, 1);
    } else { this.emitAcc = 0; this.noseAcc = 0; }

    // ---- ghost ball
    if (this.ghost) {
      const g = this.ghost;
      g.t += dt;
      if (g.phase === 'forming' || g.phase === 'out') {
        const ease = 1 - Math.exp(-g.t * 1.6);
        const cx = mouth.x + geo.aim.x * 0.3 * faceW;
        const cy = mouth.y + (0.1 + 0.16 * ease) * faceW + Math.sin(g.t * 3) * 0.015 * faceW;
        smoke.moveGroup(g.id, cx, cy, 1 + 0.5 * ease);
        if (g.phase === 'forming') {
          const n = Math.round(dt * 220 * s.density);
          smoke.emit(n, {
            x: cx, y: cy, dirX: 0, dirY: 1, speed: 15 * scale, spread: Math.PI * 2, scale,
            strength: 0.9, sizeMul: 0.8, growth: 0, turb: 0.1, group: g.id, jitter: 0.32 * faceW
          });
          if (g.t > 0.45) g.phase = 'out';
        }
      } else {
        smoke.moveGroup(g.id, mouth.x, mouth.y);
        if (g.t > 1.2 || smoke.groupCount(g.id) === 0) { smoke.releaseGroup(g.id); this.ghost = null; }
      }
    }

    // ---- French inhale: a curtain of smoke flows from the lower lip up into the nose
    if ((m.trick === 'french' && m.state === 'HOLDING') || this.frenchDemo > 0) {
      if (!this.french) {
        const k = 1.3, killR = 0.04 * faceW;
        this.french = {
          groups: [smoke.createGroup(geo.nostrils[0].x, geo.nostrils[0].y, 'recall', k, killR),
                   smoke.createGroup(geo.nostrils[1].x, geo.nostrils[1].y, 'recall', k, killR)],
          acc: 0, endT: -1
        };
      }
      this.french.endT = -1;
    } else if (this.french && this.french.endT < 0) this.french.endT = 0;
    if (this.french) {
      const f = this.french;
      f.groups.forEach((id, i) => smoke.moveGroup(id, geo.nostrils[i].x, geo.nostrils[i].y));
      if (f.endT < 0) {
        f.acc += dt * 85 * s.density;
        const n = Math.floor(f.acc); f.acc -= n;
        for (let k = 0; k < n; k++) {
          const side = this.noseSide++ & 1;
          smoke.emit(1, {
            x: mouth.x + (side ? 1 : -1) * 0.06 * faceW, y: mouth.y + 0.04 * faceW,
            dirX: (side ? 1 : -1) * 0.45, dirY: 1, speed: 110 * scale, spread: 0.9, scale,
            strength: 0.95, sizeMul: 0.7, growth: 0.4, turb: 0.2, group: f.groups[side], jitter: 0.08 * faceW
          });
        }
      } else {
        f.endT += dt;
        if (f.endT > 1.5) { f.groups.forEach(g => smoke.releaseGroup(g)); this.french = null; }
      }
    }

    // ---- blowing at smoke in the air (not while using the hookah)
    if (running && geo.tracked && smoke.count > 0 && m.pursed && !sig.penNear && (m.state === 'IDLE')) {
      const dir = { x: geo.aim.x * 3, y: 0.15 + geo.aim.y };
      out.gust = smoke.wind(mouth.x, mouth.y, dir.x, dir.y, 1100 * scale * clamp(sig.blow, 0.3, 1), faceW * 3.5, dt, -0.2);
    }

    // ---- stirring the smoke with a moving hand
    if (running && smoke.count > 0) {
      for (const h of sig.hands) {
        const speed = Math.hypot(h.vel.x, h.vel.y);
        if (speed > 250 * scale) out.stirred += smoke.stir(h.palm.x, h.palm.y, h.vel.x, h.vel.y, h.size * 1.8, dt);
      }
    }
    return out;
  }
}

/** Cough: three sharp puffs matching the audio, then a weaker tail. */
export function coughPulse(t: number): number {
  let p = 0.25;
  for (const c of [0.02, 0.32, 0.57]) p += 1.6 * Math.exp(-(((t - c) / 0.07) ** 2));
  return p;
}
