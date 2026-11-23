/**
 * Guided two-step calibration of the blow threshold. DOM-free.
 *  1. relax the face (neutral)      2. purse the lips (pucker)
 * threshold = neutral + 0.5 × (pucker − neutral), clamped to [0.1, 0.8].
 */

export type CalPhase = 'idle' | 'neutral' | 'pucker' | 'done';

export interface CalResult {
  neutral: number;
  pucker: number;
  threshold: number;
  weak: boolean;      // difference < MIN_DIFF: threshold should not be trusted
}

export const LEAD_S = 1.2;     // time to get into position before sampling
export const SAMPLE_S = 2.0;   // sampling time per step
export const MIN_DIFF = 0.12;

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

export function computeCalibration(neutralSamples: number[], puckerSamples: number[]): CalResult {
  const neutral = mean(neutralSamples);
  // Use the stronger half of the pucker samples: people drift out of the pose.
  const sorted = [...puckerSamples].sort((a, b) => b - a);
  const pucker = mean(sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2))));
  const diff = pucker - neutral;
  const threshold = Math.min(0.8, Math.max(0.1, Math.round((neutral + 0.5 * diff) * 100) / 100));
  return { neutral, pucker, threshold, weak: diff < MIN_DIFF };
}

export class Calibration {
  phase: CalPhase = 'idle';
  t = 0;
  result: CalResult | null = null;
  private neutral: number[] = [];
  private pucker: number[] = [];

  get active(): boolean { return this.phase === 'neutral' || this.phase === 'pucker'; }

  start(): void { this.phase = 'neutral'; this.t = 0; this.neutral = []; this.pucker = []; this.result = null; }
  cancel(): void { this.phase = 'idle'; }

  /** Feed the smoothed blow score each frame. Returns the result once, when finished. */
  step(dt: number, blow: number): CalResult | null {
    if (!this.active) return null;
    this.t += dt;
    if (this.t > LEAD_S) (this.phase === 'neutral' ? this.neutral : this.pucker).push(blow);
    if (this.t >= LEAD_S + SAMPLE_S) {
      if (this.phase === 'neutral') { this.phase = 'pucker'; this.t = 0; return null; }
      this.phase = 'done';
      this.result = computeCalibration(this.neutral, this.pucker);
      return this.result;
    }
    return null;
  }

  /** Step number (1/2), instruction text and 0…1 progress for the UI. */
  status(): { step: number; text: string; progress: number; sampling: boolean } {
    const step = this.phase === 'pucker' ? 2 : 1;
    const text = step === 1
      ? 'Relax your face, mouth gently closed…'
      : 'Purse your lips like sipping through the pen, and hold it…';
    return { step, text, progress: Math.min(1, this.t / (LEAD_S + SAMPLE_S)), sampling: this.t > LEAD_S };
  }
}
