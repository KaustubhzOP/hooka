/**
 * The inhale → hold → exhale state machine.
 *
 * Pure: no DOM, no clocks. Feed it `step(dt, input)` once per frame and listen
 * to the events it emits. All timings are in seconds.
 */

export type State = 'IDLE' | 'INHALING' | 'HOLDING' | 'EXHALING';
export type ExhaleKind = 'blow' | 'leak' | 'cough' | 'test';

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
  jawLeak: number;         // jawOpen above this (without a blow) leaks the smoke
  leakDelay: number;
  cooldown: number;
  exhaleBase: number;      // exhale duration = exhaleBase + exhalePerCharge * charge
  exhalePerCharge: number;
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
  leakDelay: 0.35,
  cooldown: 0.8,
  exhaleBase: 1.0,
  exhalePerCharge: 0.6
});

export interface MachineInput {
  blow: number;      // smoothed max(mouthPucker, mouthFunnel)
  jaw: number;       // jawOpen blendshape
  penNear: boolean;  // pen (hand proxy) at the lips, already debounced
  pinchOk: boolean;  // thumb–index grip detected
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
  | { type: 'exhale'; exhale: Exhale };

export class Machine {
  state: State = 'IDLE';
  /** Seconds spent in the current state. */
  stateTime = 0;
  /** Inhale charge in seconds (0 … maxInhale). */
  charge = 0;
  /** Seconds spent holding. */
  hold = 0;
  /** Remaining cooldown after an exhale. */
  cooldown = 0;
  exhale: Exhale | null = null;
  /** Hysteresis latch for "lips pursed". */
  pursed = false;

  private armed = false;   // lips relaxed at least once since entering HOLDING
  private onT = 0;
  private offT = 0;
  private awayT = 0;
  private openT = 0;

  constructor(public cfg: MachineConfig, private onEvent: (e: MachineEvent) => void = () => {}) {}

  reset(): void {
    this.state = 'IDLE'; this.stateTime = 0; this.charge = 0; this.hold = 0; this.cooldown = 0;
    this.exhale = null; this.pursed = false; this.armed = false;
    this.onT = this.offT = this.awayT = this.openT = 0;
  }

  /** Start an exhale from any state (used by the "Test smoke" button). */
  forceExhale(kind: ExhaleKind = 'test', strength = 0.9, charge = 3): void {
    this.charge = charge;
    this.startExhale(kind, strength, `forced (${kind})`);
  }

  /** 0…1 progress for the HUD ring in the current state. */
  progress(): number {
    switch (this.state) {
      case 'INHALING': return this.charge / this.cfg.maxInhale;
      case 'HOLDING': return Math.max(0, 1 - this.hold / this.cfg.maxHold);
      case 'EXHALING': return this.exhale ? Math.max(0, 1 - this.exhale.t / this.exhale.duration) : 0;
      default: return 0;
    }
  }

  step(dt: number, input: MachineInput): void {
    const c = this.cfg;
    this.stateTime += dt;

    // Hysteresis on the blow score: pursed above blowOn, relaxed below blowOn * ratio.
    if (input.blow >= c.blowOn) this.pursed = true;
    else if (input.blow < c.blowOn * c.blowOffRatio) this.pursed = false;
    const pursed = this.pursed;
    const penOk = input.penNear && (!c.requirePinch || input.pinchOk);

    switch (this.state) {
      case 'IDLE': {
        if (this.cooldown > 0) { this.cooldown = Math.max(0, this.cooldown - dt); this.onT = 0; break; }
        if (penOk && pursed) {
          this.onT += dt;
          if (this.onT >= c.onDelay) {
            this.charge = 0; this.offT = 0; this.awayT = 0; this.onT = 0;
            this.go('INHALING', 'pen at lips + lips pursed');
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
            this.hold = 0; this.armed = false; this.onT = 0; this.openT = 0;
            this.go('HOLDING', `${why} after ${this.charge.toFixed(1)}s inhale`);
          } else {
            const charge = this.charge;
            this.charge = 0;
            this.onEvent({ type: 'inhaleRejected', charge });
            this.go('IDLE', `inhale too short (${charge.toFixed(2)}s)`);
          }
        }
        break;
      }

      case 'HOLDING': {
        this.hold += dt;
        if (!pursed) this.armed = true;            // a lingering pucker must relax before a blow counts
        if (this.armed && pursed) {
          this.onT += dt;
          if (this.onT >= c.blowDelay) {
            this.startExhale('blow', input.blow * 1.4, 'blow');
            break;
          }
        } else this.onT = 0;

        this.openT = input.jaw > c.jawLeak && !pursed ? this.openT + dt : 0;
        if (this.openT >= c.leakDelay) { this.startExhale('leak', 0.4, 'jaw opened → smoke leaked'); break; }
        if (this.hold >= c.maxHold) this.startExhale('cough', 0.75, `held ${c.maxHold.toFixed(1)}s → cough`);
        break;
      }

      case 'EXHALING': {
        const e = this.exhale!;
        e.t += dt;
        if (e.t >= e.duration) {
          this.charge = 0;
          this.cooldown = c.cooldown;
          this.exhale = null;
          this.go('IDLE', 'exhale finished');
        }
        break;
      }
    }
  }

  private startExhale(kind: ExhaleKind, strength: number, reason: string): void {
    const c = this.cfg;
    const full = c.exhaleBase + c.exhalePerCharge * this.charge;
    const duration = kind === 'leak' ? 0.7 : kind === 'cough' ? Math.max(1.2, full * 0.8) : full;
    this.exhale = {
      kind, t: 0, duration,
      strength: Math.max(0.3, Math.min(1, strength)),
      charge: this.charge
    };
    this.onT = 0; this.openT = 0;
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
