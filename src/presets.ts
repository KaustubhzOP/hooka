/**
 * Smoke presets. Each one is a plain object: add a new entry to SMOKE_PRESETS
 * and it shows up in the UI (keys 1–9 select the first nine).
 */

export type RGB = [number, number, number];   // 0…1

export interface SmokePreset {
  name: string;
  colorStart: RGB;        // colour when a puff is born
  colorEnd: RGB;          // colour it fades towards as it ages
  blend: 'normal' | 'additive';
  opacity: number;        // peak alpha of a puff
  life: number;           // seconds a puff lives (±30 %)
  growth: number;         // how fast puffs expand
  turbulence: number;     // curl-noise strength
  buoyancy: number;       // upward drift
  swatch: string;         // CSS colour for the UI chip
}

export const SMOKE_PRESETS: SmokePreset[] = [
  {
    name: 'Classic white', colorStart: [0.95, 0.95, 0.97], colorEnd: [0.78, 0.8, 0.85],
    blend: 'normal', opacity: 0.42, life: 3.4, growth: 1.0, turbulence: 1.0, buoyancy: 1.0, swatch: '#eef0f6'
  },
  {
    name: 'Mint', colorStart: [0.62, 1.0, 0.85], colorEnd: [0.55, 0.85, 0.8],
    blend: 'normal', opacity: 0.42, life: 3.4, growth: 1.0, turbulence: 1.0, buoyancy: 1.0, swatch: '#7dffcb'
  },
  {
    name: 'Grape', colorStart: [0.72, 0.5, 1.0], colorEnd: [0.5, 0.35, 0.8],
    blend: 'normal', opacity: 0.48, life: 3.4, growth: 1.0, turbulence: 1.1, buoyancy: 0.9, swatch: '#a970ff'
  },
  {
    name: 'Neon pink', colorStart: [1.0, 0.25, 0.8], colorEnd: [0.55, 0.15, 1.0],
    blend: 'additive', opacity: 0.34, life: 2.9, growth: 1.1, turbulence: 1.3, buoyancy: 1.1, swatch: '#ff3ccd'
  },
  {
    name: 'Dragon fire', colorStart: [1.0, 0.85, 0.35], colorEnd: [0.85, 0.18, 0.04],
    blend: 'additive', opacity: 0.42, life: 2.1, growth: 1.3, turbulence: 1.6, buoyancy: 1.8, swatch: '#ff8c28'
  }
];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The preset with the custom colour applied (if enabled). */
export function resolvePreset(index: number, customColor: string | null): SmokePreset {
  const base = SMOKE_PRESETS[Math.min(SMOKE_PRESETS.length - 1, Math.max(0, index))];
  if (!customColor) return base;
  const c = hexToRgb(customColor);
  return { ...base, colorStart: c, colorEnd: c.map(v => v * 0.8) as RGB };
}
