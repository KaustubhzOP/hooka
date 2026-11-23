/**
 * Guided calibration, DOM-free. It learns *your* face for every gesture:
 *   1. neutral (also the neutral head pitch)   2. sip with the pen at the lips
 *   3. an "O" mouth (rings)                     4. scrunch the nose
 * Each threshold sits halfway between the neutral value and the gesture value,
 * and the "O" jaw threshold sits halfway between the sip and the O, so the two
 * gestures can be told apart. Gestures that barely differ from neutral are
 * reported as weak and their thresholds are left alone.
 */

export type CalStepId = 'neutral' | 'sip' | 'oh' | 'scrunch';
export type CalPhase = 'idle' | CalStepId | 'done';

export interface CalSample { blow: number; funnel: number; jaw: number; sneer: number; pitch: number }

export interface CalResult {
  neutral: CalSample;
  sip: CalSample;
  oh: CalSample;
  scrunch: CalSample;
  blowOn: number | null;       // null = weak, keep the current value
  ringFunnel: number | null;
  ringJaw: number | null;
  sneerOn: number | null;
  pitchOffset: number;
  weak: CalStepId[];
}

export const STEPS: { id: CalStepId; text: string; key: keyof CalSample }[] = [
  { id: 'neutral', text: 'Relax your face, mouth gently closed, look at the screen…', key: 'blow' },
  { id: 'sip', text: 'Pen at your lips: sip through it like a straw, and keep sipping…', key: 'blow' },
  { id: 'oh', text: 'Make a round “O” with your mouth, like blowing a smoke ring…', key: 'funnel' },
  { id: 'scrunch', text: 'Scrunch up your nose (like a bad smell)…', key: 'sneer' }
];

export const LEAD_S = 1.2;     // time to get into position before sampling
export const SAMPLE_S = 1.8;   // sampling time per step
export const MIN_DIFF = 0.12;  // blow
export const MIN_DIFF_OTHER = 0.08;

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Average of the samples, using the stronger half on `key` (people drift out of a pose). */
export function summarize(samples: CalSample[], key: keyof CalSample | null): CalSample {
  if (!samples.length) return { blow: 0, funnel: 0, jaw: 0, sneer: 0, pitch: 0 };
  const use = key ? [...samples].sort((a, b) => b[key] - a[key]).slice(0, Math.max(1, Math.ceil(samples.length / 2))) : samples;
  return {
    blow: mean(use.map(s => s.blow)), funnel: mean(use.map(s => s.funnel)), jaw: mean(use.map(s => s.jaw)),
    sneer: mean(use.map(s => s.sneer)), pitch: mean(use.map(s => s.pitch))
  };
}

export function computeCalibration(raw: Record<CalStepId, CalSample[]>): CalResult {
  const neutral = summarize(raw.neutral, null);
  const sip = summarize(raw.sip, 'blow');
  const oh = summarize(raw.oh, 'funnel');
  const scrunch = summarize(raw.scrunch, 'sneer');
  const weak: CalStepId[] = [];
  const has = (id: CalStepId) => raw[id].length > 0;

  let blowOn: number | null = null;
  if (has('sip') && sip.blow - neutral.blow >= MIN_DIFF) blowOn = round2(clamp(neutral.blow + 0.5 * (sip.blow - neutral.blow), 0.1, 0.8));
  else if (has('sip')) weak.push('sip');

  let ringFunnel: number | null = null, ringJaw: number | null = null;
  if (has('oh') && oh.funnel - neutral.funnel >= MIN_DIFF_OTHER && oh.jaw - Math.max(neutral.jaw, sip.jaw) >= 0.04) {
    ringFunnel = round2(clamp(neutral.funnel + 0.5 * (oh.funnel - neutral.funnel), 0.08, 0.8));
    const closed = has('sip') ? Math.max(neutral.jaw, sip.jaw) : neutral.jaw;
    ringJaw = round2(clamp(closed + 0.5 * (oh.jaw - closed), 0.03, 0.6));
  } else if (has('oh')) weak.push('oh');

  let sneerOn: number | null = null;
  if (has('scrunch') && scrunch.sneer - neutral.sneer >= MIN_DIFF_OTHER) sneerOn = round2(clamp(neutral.sneer + 0.5 * (scrunch.sneer - neutral.sneer), 0.08, 0.8));
  else if (has('scrunch')) weak.push('scrunch');

  return { neutral, sip, oh, scrunch, blowOn, ringFunnel, ringJaw, sneerOn, pitchOffset: neutral.pitch, weak };
}

export class Calibration {
  phase: CalPhase = 'idle';
  t = 0;
  result: CalResult | null = null;
  private stepIndex = 0;
  private samples: Record<CalStepId, CalSample[]> = { neutral: [], sip: [], oh: [], scrunch: [] };

  get active(): boolean { return this.phase !== 'idle' && this.phase !== 'done'; }

  start(): void {
    this.stepIndex = 0; this.phase = STEPS[0].id; this.t = 0; this.result = null;
    this.samples = { neutral: [], sip: [], oh: [], scrunch: [] };
  }
  cancel(): void { this.phase = 'idle'; }

  /** Skip the current step (its gesture keeps its current threshold). */
  skip(): CalResult | null {
    if (!this.active) return null;
    this.samples[this.phase as CalStepId] = [];
    return this.next();
  }

  /** Feed the current signals each frame. Returns the result once, when finished. */
  step(dt: number, s: CalSample): CalResult | null {
    if (!this.active) return null;
    this.t += dt;
    if (this.t > LEAD_S) this.samples[this.phase as CalStepId].push({ ...s });
    if (this.t >= LEAD_S + SAMPLE_S) return this.next();
    return null;
  }

  private next(): CalResult | null {
    this.stepIndex++;
    this.t = 0;
    if (this.stepIndex < STEPS.length) { this.phase = STEPS[this.stepIndex].id; return null; }
    this.phase = 'done';
    this.result = computeCalibration(this.samples);
    return this.result;
  }

  /** Step number, instruction text and 0…1 progress for the UI. */
  status(): { step: number; total: number; text: string; progress: number; sampling: boolean } {
    const i = Math.min(this.stepIndex, STEPS.length - 1);
    return { step: i + 1, total: STEPS.length, text: STEPS[i].text, progress: Math.min(1, this.t / (LEAD_S + SAMPLE_S)), sampling: this.t > LEAD_S };
  }
}
