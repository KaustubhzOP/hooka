# Virtual Hookah 🫧

A camera-based AR toy: hold a **real pen** like a hookah mouthpiece, and your lips and hand drive a
virtual **inhale → hold → exhale** with smoke, a bubbling hookah and a hose that follows your hand.

> **Just for fun, no smoking involved.** No tobacco, no real smoke, just pixels.

- Face and hand tracking run **in your browser** (MediaPipe, WebAssembly). **No video leaves your device**: nothing is uploaded, there is no server-side code.
- Desktop Chrome / Edge. Works offline once installed: the WASM runtime and models are served from `public/`.

## Run it

Requires Node 18+ (20+ recommended).

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:5173> and click **Start camera**. Browsers only allow the camera on `localhost`
or `https`.

`npm install` runs `scripts/setup-assets.mjs` (postinstall), which:

1. copies the MediaPipe WASM runtime from `node_modules/@mediapipe/tasks-vision/wasm` into `public/mediapipe/wasm/`
2. downloads the official float16 `face_landmarker.task` and `hand_landmarker.task` models into `public/models/`

If the download failed (offline, proxy), run it again later with `npm run setup-assets`, or download the two files by hand
into `public/models/` (the script prints the URLs).

Other scripts:

| command | what it does |
|---|---|
| `npm test` | Vitest unit tests (state machine, signals, calibration, settings) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` / `npm run preview` | production build in `dist/` and a local preview of it |

## How to play

1. **Bring the pen to your lips** and purse them (like sipping through it). After ~0.1 s you start **inhaling**: a cyan ring fills around your mouth, the water bubbles and the coals glow.
2. **Relax your lips** (or pull the pen away) to **hold** the smoke. The ring turns amber and counts down.
3. **Purse your lips again** to **blow** it out. Longer inhales give longer, bigger exhales; the live pucker strength modulates the plume, and turning your head aims it.

Things that go wrong, on purpose:

- **Too short** (< 0.5 s inhale): nothing is stored.
- **Held too long** (default 6 s): you cough it out.
- **Mouth wide open** while holding: it leaks out in a small weak puff.
- A pucker that is still lingering when you pull the pen away does **not** count as a blow: relax first, then blow.

### Keys

| key | action |
|---|---|
| `1`–`5` | smoke preset (Classic white, Mint, Grape, Neon pink, Dragon fire) |
| `C` | calibrate (`Esc` cancels) |
| `T` | test smoke (works without a camera) |
| `R` | reset the state machine and clear smoke |
| `D` | debug panel |
| `L` | landmark overlay |
| `M` | mute |

## Calibrate (recommended)

Press **C** (or the Calibrate button) with the camera on:

1. **Relax your face**, mouth gently closed, for 2 s.
2. **Purse your lips** like sipping through the pen, and hold for 2 s.

Each step has a 1.2 s lead-in before sampling. The blow threshold becomes
`neutral + 0.5 × (pucker − neutral)`, clamped to `[0.1, 0.8]`. If your pucker barely differs from neutral
(< 0.12) the app warns you and keeps the old threshold: exaggerate the pucker, improve the lighting, or set
the threshold by hand. All settings (thresholds, smoke look, mute…) persist in `localStorage`.

## Tuning thresholds (debug panel, `D`)

The debug panel shows live bars for the blow score, `mouthPucker`, `mouthFunnel`, `jawOpen`, `mouthClose`,
`cheekPuff`, pen distance and pinch gap; red marks show the current thresholds. It also has the state meters,
an event log of every transition with its reason, and the tracking FPS. Turn on **Draw landmarks overlay** (`L`) to see the
lips, hands, the estimated pen (grip → tip, green when "near") and its distance line to the mouth.

| slider | default | raise it if… | lower it if… |
|---|---|---|---|
| **Blow threshold** (`blowOn`) | 0.35 | inhale/blow triggers while your lips are relaxed | pursing doesn't register (watch the blow bar cross the red mark) |
| **Pen near** (`penNear`, face widths) | 0.9 | the pen isn't recognised at your lips | it triggers with the hand far from the mouth |
| **Pen length** (`penExt`, hand sizes) | 0.6 | you hold the pen far back from its tip | you hold it close to the tip |
| **Pinch max** (`pinchMax`) | 0.5 | "require pinch" rejects your grip | it accepts an open hand |
| **Max inhale** (s) | 4 | | |
| **Max hold** (s) | 6 | you cough too soon | |

Fixed timings (in `src/machine.ts`, `DEFAULT_MACHINE_CONFIG`): 120 ms pucker to start / to blow, 250 ms relaxed to
end the inhale, 350 ms pen-away to end it, min inhale 0.5 s, jaw leak at `jawOpen > 0.45` for 0.35 s, exhale
1.0 s + 0.6 s × charge, cooldown 0.8 s. Blow-score hysteresis: on at the threshold, off at 0.6× it.

**Require pinch grip** (side panel) additionally demands the thumb and index tips be close together, which
cuts false triggers from just touching your face.

## How it works

```
camera ─► tracking.ts ─► signals.ts ─► machine.ts ─► smoke.ts / hookah.ts / ui.ts / audio.ts
          MediaPipe       blow score,    IDLE/INHALING/   rendering + sound
          face + hands    pen-near…      HOLDING/EXHALING
```

| file | role |
|---|---|
| `src/tracking.ts` | camera, Face Landmarker (with blendshapes) + Hand Landmarker in VIDEO mode, GPU delegate with CPU fallback, typed errors |
| `src/signals.ts` | blow score (max of pucker/funnel, exponentially smoothed), mouth = midpoint of landmarks 13/14, face width = 234↔454, pen estimate (see below), 400 ms grace, 1.2× hysteresis, mouth kept 1.5 s after the face drops. All coordinates are mirrored screen pixels. |
| `src/machine.ts` | the pure state machine (no DOM), emits transition/exhale events |
| `src/calibration.ts` | the two-step calibration, pure |
| `src/settings.ts` | defaults, validation, `localStorage` persistence |
| `src/smoke.ts`, `src/noise.ts` | Three.js smoke: instanced quads, CPU physics with curl noise (simplex, divergence-free), buoyancy, drag, growth; fbm-warped soft puffs in the fragment shader; ≤ 1000 particles; normal or true additive blending over the video |
| `src/presets.ts` | smoke presets: plain objects, add one to the array and it appears in the UI |
| `src/hookah.ts` | 2D canvas hookah: glass vase with water and bubbles, brass stem, clay bowl with glowing coals and sparks, Bézier hose with sag following the pen on a spring |
| `src/audio.ts` | Web Audio: bubbling (sine blips + gurgle bed), exhale whoosh (band-passed noise), cough; all procedural |
| `src/ui.ts` | DOM panels, HUD badge/hints/cards, progress ring and landmark overlay drawing |
| `src/main.ts` | wiring and the frame loop |

**The pen is estimated, not detected.** MediaPipe has no pen detector, so the hand is the proxy: the grip point is
the midpoint of thumb tip (4) and index tip (8), and the pen tip is extended along the index finger (5 → 8) by
`penExt` × hand size (wrist 0 → middle MCP 9). The pen counts as "at the lips" when the closer of the two points is
within `penNear` face widths of the mouth.

**Layers:** video (CSS-mirrored) → smoke (WebGL canvas) → hookah + hose, ring, debug overlay (2D canvas) → HTML UI.

## Known limitations

- **The pen itself is never seen.** Any hand near the mouth (scratching your chin, a finger on the lips) can count as the pen. Enable *Require pinch grip* to reduce this.
- **Blendshapes vary by face, lighting and camera.** Calibrate; beards, moustaches, strong backlight or low light make pucker detection noisy.
- **Occlusion:** a hand or arm covering a large part of the face (e.g. the forehead) can make the face tracker drop out. The 400 ms grace and 1.5 s mouth memory only bridge short gaps.
- **2D only:** the smoke is a screen-space effect; it doesn't know about depth and won't go behind your head or hand.
- Talking, whistling or kissing faces also produce pucker/funnel scores and can trigger an inhale when the pen is at the lips.
- The hose attaches at the back of the hand (where a mouthpiece's hose would be) rather than at the pen tip, so it doesn't run into your mouth.
- Desktop Chrome/Edge only; no mobile layout or touch handling. Safari/Firefox are untested.
- Performance depends on the GPU: tracking two models per frame is the main cost. If FPS is low, close other camera/GPU-heavy tabs; the app falls back to CPU if the GPU delegate fails, which is slower.
