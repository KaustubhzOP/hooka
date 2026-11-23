import { describe, it, expect } from 'vitest';
import { Calibration, computeCalibration, LEAD_S, SAMPLE_S } from '../src/calibration';
import { loadSettings, saveSettings, sanitizeSettings, DEFAULT_SETTINGS, STORAGE_KEY } from '../src/settings';

describe('calibration', () => {
  it('sets the threshold halfway between neutral and pucker', () => {
    const r = computeCalibration([0.1, 0.1], [0.7, 0.7]);
    expect(r.threshold).toBeCloseTo(0.4);
    expect(r.weak).toBe(false);
  });

  it('clamps the threshold and flags a weak pucker', () => {
    expect(computeCalibration([0, 0], [0.05, 0.05]).threshold).toBe(0.1);
    expect(computeCalibration([0, 0], [0.05, 0.05]).weak).toBe(true);
    expect(computeCalibration([0.9], [1]).threshold).toBe(0.8);
  });

  it('runs both guided steps and produces a result', () => {
    const c = new Calibration();
    c.start();
    const dt = 1 / 30;
    let result = null;
    for (let t = 0; t < 2 * (LEAD_S + SAMPLE_S) + 0.5 && !result; t += dt)
      result = c.step(dt, c.phase === 'neutral' ? 0.05 : 0.65);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBeCloseTo(0.35, 2);
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
