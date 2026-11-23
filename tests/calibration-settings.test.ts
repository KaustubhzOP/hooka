import { describe, it, expect } from 'vitest';
import { Calibration, computeCalibration, LEAD_S, SAMPLE_S, type CalSample } from '../src/calibration';
import { loadSettings, saveSettings, sanitizeSettings, DEFAULT_SETTINGS, STORAGE_KEY } from '../src/settings';

const sample = (o: Partial<CalSample> = {}): CalSample => ({ blow: 0.05, funnel: 0.05, jaw: 0.03, sneer: 0.05, pitch: 0.1, ...o });
const many = (o: Partial<CalSample>) => Array.from({ length: 20 }, () => sample(o));

describe('calibration', () => {
  it('derives every gesture threshold from your own face', () => {
    const r = computeCalibration({
      neutral: many({}), sip: many({ blow: 0.65, jaw: 0.05 }),
      oh: many({ blow: 0.6, funnel: 0.55, jaw: 0.35 }), scrunch: many({ sneer: 0.55 })
    });
    expect(r.blowOn).toBeCloseTo(0.35);
    expect(r.ringFunnel).toBeCloseTo(0.3);
    expect(r.ringJaw).toBeCloseTo(0.2);                     // halfway between the sip jaw and the O jaw
    expect(r.sneerOn).toBeCloseTo(0.3);
    expect(r.pitchOffset).toBeCloseTo(0.1);
    expect(r.weak).toEqual([]);
  });

  it('flags weak gestures and leaves their thresholds alone', () => {
    const r = computeCalibration({ neutral: many({}), sip: many({ blow: 0.1 }), oh: many({ funnel: 0.08 }), scrunch: many({ sneer: 0.07 }) });
    expect(r.blowOn).toBeNull(); expect(r.ringFunnel).toBeNull(); expect(r.sneerOn).toBeNull();
    expect(r.weak).toEqual(['sip', 'oh', 'scrunch']);
  });

  it('clamps the blow threshold', () => {
    expect(computeCalibration({ neutral: many({ blow: 0.9 }), sip: many({ blow: 1 }), oh: [], scrunch: [] }).blowOn).toBeNull();
    expect(computeCalibration({ neutral: many({ blow: 0.7 }), sip: many({ blow: 1 }), oh: [], scrunch: [] }).blowOn).toBe(0.8);
  });

  it('runs all four guided steps, and skipped steps are not weak', () => {
    const c = new Calibration();
    c.start();
    const dt = 1 / 30;
    let result = null;
    for (let t = 0; t < 4 * (LEAD_S + SAMPLE_S) + 1 && !result; t += dt) {
      if (c.phase === 'scrunch') { result = c.skip(); break; }
      result = c.step(dt, c.phase === 'sip' ? sample({ blow: 0.65 }) : sample());
    }
    expect(result).not.toBeNull();
    expect(result!.blowOn).toBeCloseTo(0.35, 2);
    expect(result!.sneerOn).toBeNull();
    expect(result!.weak).toEqual(['oh']);
    expect(c.active).toBe(false);
  });
});

describe('settings', () => {
  it('round-trips through storage', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveSettings(storage, { ...DEFAULT_SETTINGS, blowOn: 0.42, smokePreset: 3 });
    const s = loadSettings(storage);
    expect(s.blowOn).toBe(0.42);
    expect(s.smokePreset).toBe(3);
    expect(mem.has(STORAGE_KEY)).toBe(true);
  });

  it('ignores garbage and clamps out-of-range values', () => {
    const s = sanitizeSettings({ blowOn: 99, penNear: 'x', muted: 'yes', customColor: 'red', extra: 1 });
    expect(s.blowOn).toBe(0.9);
    expect(s.penNear).toBe(DEFAULT_SETTINGS.penNear);
    expect(s.muted).toBe(false);
    expect(s.customColor).toBe(DEFAULT_SETTINGS.customColor);
    expect(loadSettings({ getItem: () => '{not json' })).toEqual(DEFAULT_SETTINGS);
  });
});
