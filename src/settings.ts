/**
 * User-tunable settings, their defaults, and localStorage persistence.
 * No DOM access beyond the injected Storage, so it can be unit tested.
 */

export type BackgroundMode = 'none' | 'blur' | 'lounge' | 'neon';
export type PlayMode = 'solo' | 'local' | 'online';

export interface Settings {
  // detection thresholds
  blowOn: number;        // pucker/funnel score that counts as "lips pursed" (sip / blow)
  penNear: number;       // pen-to-mouth distance (in face widths) that counts as "at the lips"
  penExt: number;        // how far the pen sticks out past the index fingertip (in hand sizes)
  pinchMax: number;      // thumb–index gap / hand size below which the hand counts as gripping
  requirePinch: boolean;
  maxInhale: number;     // seconds
  maxHold: number;       // seconds before an involuntary cough
  ringFunnel: number;    // mouthFunnel for an "O" mouth (smoke rings)
  ringJaw: number;       // jawOpen for an "O" mouth
  sneerOn: number;       // noseSneer that exhales through the nose
  frenchPitch: number;   // head tilt back (degrees) for the French inhale
  waterfallPitch: number;// head tilt down (degrees) for the waterfall
  pitchOffset: number;   // neutral head pitch (radians), from calibration
  calibrated: boolean;
  // smoke look
  smokePreset: number;   // flavour index
  useCustomColor: boolean;
  customColor: string;   // #rrggbb
  density: number;
  speed: number;
  spread: number;
  noseSmoke: number;     // share of a mouth exhale that also streams from the nose (0 = none)
  // hookah
  vaseSkin: number;
  hoseColor: number;
  coalPower: number;     // 0.3…1.5 coal brightness / burn
  lightSmoke: boolean;   // coals light up the smoke
  faceLight: boolean;    // coals light up your face
  lightIntensity: number;
  // scene & play
  background: BackgroundMode;
  playMode: PlayMode;
  localPlayers: number;  // 2–4 on one device
  // misc
  muted: boolean;
  showLandmarks: boolean;
  debugOpen: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  blowOn: 0.3,
  penNear: 1.0,
  penExt: 0.6,
  pinchMax: 0.5,
  requirePinch: false,
  maxInhale: 4.0,
  maxHold: 6.0,
  ringFunnel: 0.3,
  ringJaw: 0.12,
  sneerOn: 0.3,
  frenchPitch: 12,
  waterfallPitch: 14,
  pitchOffset: 0,
  calibrated: false,
  smokePreset: 0,
  useCustomColor: false,
  customColor: '#9fd8ff',
  density: 1.0,
  speed: 1.0,
  spread: 1.0,
  noseSmoke: 0.35,
  vaseSkin: 0,
  hoseColor: 0,
  coalPower: 1.0,
  lightSmoke: true,
  faceLight: true,
  lightIntensity: 0.6,
  background: 'none' as BackgroundMode,
  playMode: 'solo' as PlayMode,
  localPlayers: 2,
  muted: false,
  showLandmarks: false,
  debugOpen: false
});

/** Numeric ranges, shared by the sliders and by validation of stored values. */
export const RANGES = {
  blowOn:         { min: 0.05, max: 0.9, step: 0.01 },
  penNear:        { min: 0.3,  max: 2.0, step: 0.05 },
  penExt:         { min: 0,    max: 1.5, step: 0.05 },
  pinchMax:       { min: 0.1,  max: 1.2, step: 0.05 },
  maxInhale:      { min: 1,    max: 8,   step: 0.5 },
  maxHold:        { min: 2,    max: 12,  step: 0.5 },
  ringFunnel:     { min: 0.05, max: 0.9, step: 0.01 },
  ringJaw:        { min: 0.02, max: 0.6, step: 0.01 },
  sneerOn:        { min: 0.05, max: 0.9, step: 0.01 },
  frenchPitch:    { min: 4,    max: 35,  step: 1 },
  waterfallPitch: { min: 4,    max: 35,  step: 1 },
  pitchOffset:    { min: -1,   max: 1,   step: 0.01 },
  density:        { min: 0.2,  max: 2.5, step: 0.05 },
  speed:          { min: 0.3,  max: 2.5, step: 0.05 },
  spread:         { min: 0.2,  max: 2.5, step: 0.05 },
  noseSmoke:      { min: 0,    max: 1,   step: 0.05 },
  coalPower:      { min: 0.3,  max: 1.5, step: 0.05 },
  lightIntensity: { min: 0,    max: 1.5, step: 0.05 },
  localPlayers:   { min: 2,    max: 4,   step: 1 }
} as const satisfies Partial<Record<keyof Settings, { min: number; max: number; step: number }>>;

const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  background: ['none', 'blur', 'lounge', 'neon'],
  playMode: ['solo', 'local', 'online']
};

export const STORAGE_KEY = 'virtual-hookah.settings.v2';

/** Merge an untrusted object onto the defaults, dropping anything of the wrong type or out of range. */
export function sanitizeSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  const src = { ...(raw as Record<string, unknown>) };
  if (src.playMode === 'duo') { src.playMode = 'local'; src.localPlayers = 2; }   // v2 → v3
  if (src.playMode === 'online') src.playMode = 'solo';                        // never resume straight into a room
  const o = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const v = src[key];
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const r = (RANGES as Record<string, { min: number; max: number }>)[key];
      o[key] = r ? Math.min(r.max, Math.max(r.min, v)) : v;
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') o[key] = v;
    } else if (typeof def === 'string') {
      if (typeof v !== 'string') continue;
      const allowed = ENUMS[key];
      if (allowed ? allowed.includes(v) : key !== 'customColor' || /^#[0-9a-f]{6}$/i.test(v)) o[key] = v;
    }
  }
  for (const k of ['smokePreset', 'vaseSkin', 'hoseColor'] as const) out[k] = Math.max(0, Math.round(out[k]));
  return out;
}

export function loadSettings(storage: Pick<Storage, 'getItem'> | null): Settings {
  try {
    const txt = storage?.getItem(STORAGE_KEY);
    return sanitizeSettings(txt ? JSON.parse(txt) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(storage: Pick<Storage, 'setItem'> | null, s: Settings): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* private mode / quota: ignore */ }
}

/** localStorage, or null when it is unavailable (blocked cookies, sandboxed iframe…). */
export function browserStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
