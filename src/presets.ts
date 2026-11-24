/**
 * Flavours and hookah skins. Each one is a plain object: add an entry to the
 * array and it appears in the UI (keys 1–9 pick the first nine flavours).
 */

export type RGB = [number, number, number];   // 0…1

export interface Flavour {
  name: string;
  emoji: string;
  colorStart: RGB;        // smoke colour when a puff is born
  colorEnd: RGB;          // colour it fades towards as it ages
  blend: 'normal' | 'additive';
  opacity: number;        // peak alpha of a puff
  life: number;           // seconds a puff lives (±30 %)
  growth: number;         // how fast puffs expand
  turbulence: number;     // curl-noise strength
  buoyancy: number;       // upward drift
  water: string;          // CSS colour of the water in the vase
  swatch: string;         // CSS colour for the UI chip
}

/** Kept as the old name too: a "smoke preset" is a flavour. */
export type SmokePreset = Flavour;

const base = { blend: 'normal' as const, opacity: 0.42, life: 3.4, growth: 1.0, turbulence: 1.0, buoyancy: 1.0 };

export const FLAVOURS: Flavour[] = [
  { ...base, name: 'Classic white', emoji: '☁️', colorStart: [0.95, 0.95, 0.97], colorEnd: [0.78, 0.8, 0.85], water: '#3c9fb8', swatch: '#eef0f6' },
  { ...base, name: 'Mint', emoji: '🌿', colorStart: [0.62, 1.0, 0.85], colorEnd: [0.55, 0.85, 0.8], water: '#2fb89a', swatch: '#7dffcb' },
  { ...base, name: 'Grape', emoji: '🍇', colorStart: [0.72, 0.5, 1.0], colorEnd: [0.5, 0.35, 0.8], opacity: 0.48, turbulence: 1.1, buoyancy: 0.9, water: '#7a4cc4', swatch: '#a970ff' },
  { ...base, name: 'Watermelon', emoji: '🍉', colorStart: [1.0, 0.55, 0.62], colorEnd: [0.85, 0.4, 0.5], water: '#d4566a', swatch: '#ff7a8f' },
  { ...base, name: 'Blueberry', emoji: '🫐', colorStart: [0.55, 0.65, 1.0], colorEnd: [0.4, 0.45, 0.85], water: '#3d5fc9', swatch: '#7d97ff' },
  { ...base, name: 'Peach', emoji: '🍑', colorStart: [1.0, 0.78, 0.6], colorEnd: [0.95, 0.65, 0.55], water: '#e39565', swatch: '#ffc49a' },
  { ...base, name: 'Double apple', emoji: '🍎', colorStart: [0.92, 0.95, 0.75], colorEnd: [0.75, 0.82, 0.6], water: '#8bbf4a', swatch: '#d6ee9a' },
  { ...base, name: 'Neon pink', emoji: '💗', colorStart: [1.0, 0.25, 0.8], colorEnd: [0.55, 0.15, 1.0], blend: 'additive', opacity: 0.34, life: 2.9, growth: 1.1, turbulence: 1.3, buoyancy: 1.1, water: '#e02cb0', swatch: '#ff3ccd' },
  { ...base, name: 'Dragon fire', emoji: '🐉', colorStart: [1.0, 0.85, 0.35], colorEnd: [0.85, 0.18, 0.04], blend: 'additive', opacity: 0.42, life: 2.1, growth: 1.3, turbulence: 1.6, buoyancy: 1.8, water: '#d8641c', swatch: '#ff8c28' }
];

/** Back-compat alias. */
export const SMOKE_PRESETS = FLAVOURS;

export interface VaseSkin {
  id: string;
  name: string;
  glassEdge: string;      // rgba at the glass edge
  glassMid: string;       // rgba in the middle of the glass
  metal: 'brass' | 'steel' | 'copper' | 'black';
  facets: boolean;        // draw cut-crystal facets
  led: boolean;           // colour-cycling LED light in the base
}

export const VASE_SKINS: VaseSkin[] = [
  { id: 'classic', name: 'Classic', glassEdge: 'rgba(40,110,140,0.55)', glassMid: 'rgba(120,200,225,0.14)', metal: 'brass', facets: false, led: false },
  { id: 'crystal', name: 'Crystal', glassEdge: 'rgba(200,220,235,0.45)', glassMid: 'rgba(240,248,255,0.08)', metal: 'steel', facets: true, led: false },
  { id: 'led', name: 'LED', glassEdge: 'rgba(25,25,40,0.75)', glassMid: 'rgba(60,60,90,0.25)', metal: 'black', facets: false, led: true },
  { id: 'amber', name: 'Amber', glassEdge: 'rgba(150,80,20,0.6)', glassMid: 'rgba(230,160,80,0.18)', metal: 'copper', facets: false, led: false }
];

export interface HoseColor { id: string; name: string; base: string; dark: string; highlight: string }

export const HOSE_COLORS: HoseColor[] = [
  { id: 'green', name: 'Emerald', base: '#1f4a39', dark: '#0f241c', highlight: 'rgba(190,255,225,0.22)' },
  { id: 'black', name: 'Black', base: '#222228', dark: '#0b0b0e', highlight: 'rgba(255,255,255,0.18)' },
  { id: 'red', name: 'Crimson', base: '#6b1622', dark: '#330a10', highlight: 'rgba(255,190,200,0.22)' },
  { id: 'blue', name: 'Royal blue', base: '#1d3170', dark: '#0d1633', highlight: 'rgba(190,210,255,0.22)' },
  { id: 'gold', name: 'Gold', base: '#8a6a22', dark: '#4a380f', highlight: 'rgba(255,240,190,0.3)' }
];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The flavour with the custom colour applied (if enabled). */
export function resolvePreset(index: number, customColor: string | null): Flavour {
  const f = FLAVOURS[Math.min(FLAVOURS.length - 1, Math.max(0, index))];
  if (!customColor) return f;
  const c = hexToRgb(customColor);
  return { ...f, colorStart: c, colorEnd: c.map(v => v * 0.8) as RGB, water: customColor };
}
