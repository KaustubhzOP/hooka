/**
 * The inhale → hold → exhale state machine, with tricks.
 *
 * Pure: no DOM, no clocks. Feed it `step(dt, input)` once per frame and listen
 * to the events it emits. All timings are in seconds.
 *
 *   IDLE ──pen at lips + sip──► INHALING ──relax / pen away──► HOLDING
 *   HOLDING ──pursed lips────────► EXHALING (blow)
 *           ──"O" mouth──────────► (ring puffed, stays HOLDING until the smoke runs out)
 *           ──scrunch nose───────► EXHALING (nose)
 *           ──mouth slightly open + head tilted back──► French inhale (trick, stays HOLDING)
 *           ──jaw wide open──────► GHOST ──sip──► HOLDING (ghost recalled)
 *                                        └─timeout─► IDLE (ghost floats away)
 *           ──held too long──────► EXHALING (cough)
 */

export type State = 'IDLE' | 'INHALING' | 'HOLDING' | 'GHOST' | 'EXHALING';
export type ExhaleKind = 'blow' | 'nose' | 'leak' | 'cough' | 'test';
export type Trick = 'french' | null;

export interface MachineConfig {
  blowOn: number;          // smoothed blow score at which the lips count as pursed
  blowOffRatio: number;    // hysteresis: released below blowOn * blowOffRatio
  requirePinch: boolean;
  maxInhale: number;
  maxHold: number;
  minInhale: number;
  onDelay: number;         // pursed this long (with pen) to start inhaling
  releaseDelay: number;    // relaxed this long to end the inhale
  awayDelay: number;       // pen away this long to end the inhale
  blowDelay: number;       // pursed this long while holding to exhale
  jawLeak: number;         // jawOpen above this (no blow, no O) releases a ghost ball
  leakDelay: number;
  ghostWindow: number;     // seconds to sip the ghost back in before it is lost
  cooldown: number;
  exhaleBase: number;      // exhale duration = exhaleBase + exhalePerCharge * charge
  exhalePerCharge: number;
  ringFunnel: number;      // mouthFunnel at/above this, with the jaw open, is an "O" mouth
  ringJaw: number;         // jawOpen at/above this (with the funnel) is an "O" mouth
  ringDelay: number;       // O held this long to puff one ring
  ringCost: number;        // seconds of inhale charge each ring uses
  sneerOn: number;         // noseSneer at/above this exhales through the nose
  sneerDelay: number;
  frenchPitch: number;     // radians of head tilt back for the French inhale
  frenchJaw: number;       // jawOpen at/above this (mouth slightly open) for the French inhale
}

export const DEFAULT_MACHINE_CONFIG: Readonly<MachineConfig> = Object.freeze({
  blowOn: 0.35,
  blowOffRatio: 0.6,
  requirePinch: false,
  maxInhale: 4.0,
  maxHold: 6.0,
  minInhale: 0.5,
  onDelay: 0.12,
  releaseDelay: 0.25,
  awayDelay: 0.35,
  blowDelay: 0.12,
  jawLeak: 0.45,
  leakDelay: 0.3,
  ghostWindow: 1.8,
  cooldown: 0.8,
  exhaleBase: 1.0,
  exhalePerCharge: 0.6,
  ringFunnel: 0.35,
  ringJaw: 0.15,
  ringDelay: 0.12,
  ringCost: 0.6,
  sneerOn: 0.35,
  sneerDelay: 0.18,
  frenchPitch: 0.21,       // ~12°
  frenchJaw: 0.06
});

export interface MachineInput {
  blow: number;      // smoothed max(mouthPucker, mouthFunnel)
  jaw: number;       // jawOpen blendshape
  penNear: boolean;  // pen (hand proxy) at the lips, already debounced
  pinchOk: boolean;  // thumb–index grip detected
  funnel?: number;   // mouthFunnel ("O" lips), for rings
  sneer?: number;    // max(noseSneerLeft, noseSneerRight), for the nose exhale
  pitch?: number;    // head pitch, radians, + = looking up
}

export interface Exhale {
  kind: ExhaleKind;
  t: number;         // elapsed
  duration: number;
  strength: number;  // 0.3 … 1
  charge: number;    // inhale charge that is being exhaled
}

export type MachineEvent =
  | { type: 'transition'; from: State; to: State; reason: string }
  | { type: 'inhaleRejected'; charge: number }
  | { type: 'exhale'; exhale: Exhale }
  | { type: 'ring'; index: number; strength: number; remaining: number }
  | { type: 'ghost'; phase: 'out' | 'in' | 'lost'; charge: number }
  | { type: 'trick'; trick: 'french'; active: boolean }
  /** A complete hit is over (smoke fully out, lost, or rejected): used for turns in 2-player mode. */
  | { type: 'hitEnd'; outcome: 'exhaled' | 'rings' | 'ghostLost' | 'rejected'; rings: number; held: number };

export class Machine {
  state: State = 'IDLE';
  stateTime = 0;
  /** Inhale charge in seconds (0 … maxInhale). */
  charge = 0;
  /** Seconds spent holding (including ghost time). */
  hold = 0;
  cooldown = 0;
  exhale: Exhale | null = null;
  /** Hysteresis latches. */
  pursed = false;
  oShape = false;
  sneering = false;
  /** Active trick while holding (French inhale). */
  trick: Trick = null;
  /** Rings puffed during the current hold. */
  rings = 0;

  private armed = false;      // lips relaxed at least once since entering HOLDING
  private ringArmed = false;  // mouth left the O shape since the last ring
  private onT = 0;
  private offT = 0;
  private awayT = 0;
  private openT = 0;
  private ringT = 0;
  private sneerT = 0;
  private frenchT = 0;

  constructor(public cfg: MachineConfig, private onEvent: (e: MachineEvent) => void = () => {}) {}

  reset(): void {
    this.state = 'IDLE'; this.stateTime = 0; this.charge = 0; this.hold = 0; this.cooldown = 0;
    this.exhale = null; this.pursed = this.oShape = this.sneering = false; this.trick = null;
    this.armed = this.ringArmed = false; this.rings = 0;
    this.onT = this.offT = this.awayT = this.openT = this.ringT = this.sneerT = this.frenchT = 0;
  }

  /** Is the mouth in the ring-blowing "O" shape? (no hysteresis; see `oShape` for the latched value) */
  isOShape(input: MachineInput): boolean {
    return (input.funnel ?? 0) >= this.cfg.ringFunnel && input.jaw >= this.cfg.ringJaw;
  }

  /** Start an exhale from any state (used by the "Test" buttons). */
  forceExhale(kind: ExhaleKind = 'test', strength = 0.9, charge = 3): void {
    this.charge = charge;
    this.startExhale(kind, strength, `forced (${kind})`);
  }

  /** 0…1 progress for the HUD ring in the current state. */
  progress(): number {
    switch (this.state) {
      case 'INHALING': return this.charge / this.cfg.maxInhale;
      case 'HOLDING': return Math.max(0, 1 - this.hold / this.cfg.maxHold);
      case 'GHOST': return Math.max(0, 1 - this.stateTime / this.cfg.ghostWindow);
      case 'EXHALING': return this.exhale ? Math.max(0, 1 - this.exhale.t / this.exhale.duration) : 0;
      default: return 0;
    }
  }

  step(dt: number, input: MachineInput): void {
    const c = this.cfg;
    this.stateTime += dt;
    this.updateLatches(input);
    const pursed = this.pursed;
    const penOk = input.penNear && (!c.requirePinch || input.pinchOk);

    switch (this.state) {
      case 'IDLE': {
        if (this.cooldown > 0) { this.cooldown = Math.max(0, this.cooldown - dt); this.onT = 0; break; }
        if (penOk && pursed) {
          this.onT += dt;
          if (this.onT >= c.onDelay) {
            this.charge = 0; this.offT = 0; this.awayT = 0; this.onT = 0;
            this.go('INHALING', 'pen at lips + sipping');
          }
        } else this.onT = 0;
        break;
      }

      case 'INHALING': {
        this.charge = Math.min(c.maxInhale, this.charge + dt);
        this.offT = pursed ? 0 : this.offT + dt;
        this.awayT = penOk ? 0 : this.awayT + dt;
        if (this.offT >= c.releaseDelay || this.awayT >= c.awayDelay) {
          const why = this.offT >= c.releaseDelay ? 'lips relaxed' : 'pen pulled away';
          if (this.charge >= c.minInhale) {
            this.enterHolding();
            this.go('HOLDING', `${why} after ${this.charge.toFixed(1)}s inhale`);
          } else {
            const charge = this.charge;
            this.charge = 0;
            this.onEvent({ type: 'inhaleRejected', charge });
            this.go('IDLE', `inhale too short (${charge.toFixed(2)}s)`);
            this.onEvent({ type: 'hitEnd', outcome: 'rejected', rings: 0, held: 0 });
          }
        }
        break;
      }

      case 'HOLDING': {
        this.hold += dt;
        const oShape = this.oShape;
        if (!pursed) this.armed = true;            // a lingering pucker must relax before a blow counts
        if (!oShape) this.ringArmed = true;        // one ring per "O"

        // Smoke rings: an O-shaped mouth puffs one ring and uses some charge.
        if (this.armed && this.ringArmed && oShape) {
          this.ringT += dt;
          if (this.ringT >= c.ringDelay) {
            this.ringT = 0; this.ringArmed = false; this.onT = 0;
            this.setTrick(null);
            this.charge = Math.max(0, this.charge - c.ringCost);
            this.rings++;
            this.onEvent({ type: 'ring', index: this.rings, strength: Math.max(0.45, Math.min(1, (input.funnel ?? 0) * 1.6)), remaining: this.charge });
            if (this.charge < c.ringCost * 0.5) {
              const rings = this.rings, held = this.hold;
              this.charge = 0; this.cooldown = c.cooldown;
              this.go('IDLE', `all smoke used for ${rings} ring${rings > 1 ? 's' : ''}`);
              this.onEvent({ type: 'hitEnd', outcome: 'rings', rings, held });
            }
            break;
          }
        } else this.ringT = 0;

        // Blow: pursed lips with the mouth (nearly) closed. An O is a ring, not a blow.
        if (this.armed && pursed && !oShape) {
          this.onT += dt;
          if (this.onT >= c.blowDelay) { this.startExhale('blow', input.blow * 1.4, 'blow'); break; }
        } else this.onT = 0;

        // Nose: scrunch the nose (lips not pursed) to exhale through it.
        this.sneerT = this.sneering && !pursed ? this.sneerT + dt : 0;
        if (this.sneerT >= c.sneerDelay) {
          this.startExhale('nose', 0.55 + 0.45 * Math.min(1, input.sneer ?? 0), 'nose scrunched → exhale through the nose');
          break;
        }

        // French inhale: mouth slightly open (not an O, not wide), head tilted back.
        const frenchPose = !pursed && !oShape && input.jaw >= c.frenchJaw && input.jaw < c.jawLeak
          && (input.pitch ?? 0) >= c.frenchPitch;
        this.frenchT = frenchPose ? this.frenchT + dt : Math.max(0, this.frenchT - dt * 2);
        if (this.trick !== 'french' && this.frenchT >= 0.2) this.setTrick('french');
        else if (this.trick === 'french' && this.frenchT <= 0) this.setTrick(null);

        // Ghost: open the jaw wide without blowing → a ball of smoke rolls out.
        this.openT = input.jaw > c.jawLeak && !pursed && !oShape ? this.openT + dt : 0;
        if (this.openT >= c.leakDelay) {
          this.setTrick(null);
          this.onEvent({ type: 'ghost', phase: 'out', charge: this.charge });
          this.onT = 0;
          this.go('GHOST', 'jaw opened wide → ghost ball out');
          break;
        }
        if (this.hold >= c.maxHold) { this.setTrick(null); this.startExhale('cough', 0.75, `held ${c.maxHold.toFixed(1)}s → cough`); }
        break;
      }

      case 'GHOST': {
        this.hold += dt;
        // A quick sip pulls the ball back in.
        if (pursed) {
          this.onT += dt;
          if (this.onT >= c.onDelay) {
            this.onEvent({ type: 'ghost', phase: 'in', charge: this.charge });
            this.enterHolding(true);
            this.go('HOLDING', 'sipped the ghost back in');
            break;
          }
        } else this.onT = 0;
        if (this.stateTime >= c.ghostWindow) {
          const held = this.hold, rings = this.rings;
          this.onEvent({ type: 'ghost', phase: 'lost', charge: this.charge });
          this.charge = 0; this.cooldown = c.cooldown;
          this.go('IDLE', 'ghost floated away');
          this.onEvent({ type: 'hitEnd', outcome: 'ghostLost', rings, held });
        }
        break;
      }

      case 'EXHALING': {
        const e = this.exhale!;
        e.t += dt;
        if (e.t >= e.duration) {
          const held = this.hold, rings = this.rings;
          this.charge = 0;
          this.cooldown = c.cooldown;
          this.exhale = null;
          this.go('IDLE', 'exhale finished');
          this.onEvent({ type: 'hitEnd', outcome: 'exhaled', rings, held });
        }
        break;
      }
    }
  }

  private updateLatches(input: MachineInput) {
    const c = this.cfg;
    // Hysteresis: on at the threshold, off well below it, so noisy blendshapes don't flicker.
    if (input.blow >= c.blowOn) this.pursed = true;
    else if (input.blow < c.blowOn * c.blowOffRatio) this.pursed = false;

    const funnel = input.funnel ?? 0;
    if (funnel >= c.ringFunnel && input.jaw >= c.ringJaw) this.oShape = true;
    else if (funnel < c.ringFunnel * 0.75 || input.jaw < c.ringJaw * 0.6) this.oShape = false;

    const sneer = input.sneer ?? 0;
    if (sneer >= c.sneerOn) this.sneering = true;
    else if (sneer < c.sneerOn * 0.7) this.sneering = false;
  }

  private enterHolding(keepHold = false) {
    if (!keepHold) { this.hold = 0; this.rings = 0; }
    this.armed = false; this.ringArmed = false;
    this.onT = this.openT = this.ringT = this.sneerT = this.frenchT = 0;
    this.trick = null;
  }

  private setTrick(t: Trick) {
    if (t === this.trick) return;
    const prev = this.trick;
    this.trick = t;
    if (t) this.onEvent({ type: 'trick', trick: t, active: true });
    else if (prev) this.onEvent({ type: 'trick', trick: prev, active: false });
    if (!t) this.frenchT = 0;
  }

  private startExhale(kind: ExhaleKind, strength: number, reason: string): void {
    const c = this.cfg;
    const full = c.exhaleBase + c.exhalePerCharge * this.charge;
    const duration = kind === 'leak' ? 0.7 : kind === 'cough' ? Math.max(1.2, full * 0.8) : kind === 'nose' ? full * 0.9 : full;
    this.exhale = { kind, t: 0, duration, strength: Math.max(0.3, Math.min(1, strength)), charge: this.charge };
    this.onT = 0; this.openT = 0;
    this.setTrick(null);
    this.onEvent({ type: 'exhale', exhale: { ...this.exhale } });
    this.go('EXHALING', reason);
  }

  private go(to: State, reason: string): void {
    const from = this.state;
    this.state = to;
    this.stateTime = 0;
    this.onEvent({ type: 'transition', from, to, reason });
  }
}
