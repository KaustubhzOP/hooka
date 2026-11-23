/**
 * Wiring: tracking → signals → state machine → rendering (smoke, hookah, HUD) + audio.
 */
import './style.css';
import { loadSettings, saveSettings, browserStorage, DEFAULT_SETTINGS, type Settings } from './settings';
import { Machine, DEFAULT_MACHINE_CONFIG, type MachineConfig, type MachineEvent } from './machine';
import { SignalProcessor, emptySignals, type Signals, type TrackingFrame, type Pt } from './signals';
import { Calibration } from './calibration';
import { Tracker, describeError, LIP_CONNECTIONS, HAND_CONNECTIONS } from './tracking';
import { SmokeRenderer } from './smoke';
import { SMOKE_PRESETS, resolvePreset } from './presets';
import { Hookah } from './hookah';
import { HookahAudio } from './audio';
import { UI, HINTS, drawRing, drawLandmarks } from './ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ state */
const storage = browserStorage();
const settings: Settings = loadSettings(storage);

const machineConfig = (): MachineConfig => ({
  ...DEFAULT_MACHINE_CONFIG,
  blowOn: settings.blowOn, requirePinch: settings.requirePinch,
  maxInhale: settings.maxInhale, maxHold: settings.maxHold
});

const video = $<HTMLVideoElement>('video');
const smokeCanvas = $<HTMLCanvasElement>('smokeCanvas');
const fxCanvas = $<HTMLCanvasElement>('fxCanvas');
const fx = fxCanvas.getContext('2d')!;
let W = 1280, H = 720;   // canvas = video resolution (before the camera starts: a 16:9 default)

const tracker = new Tracker(video);
const signals = new SignalProcessor();
const calibration = new Calibration();
const hookah = new Hookah();
const audio = new HookahAudio();
audio.setMuted(settings.muted);

let smoke: SmokeRenderer | null = null;
let running = false, starting = false;
let sig: Signals = emptySignals(W);
let lastFrame: TrackingFrame | null = null;
let flash = { text: '', until: 0 };
let emitAcc = 0, glow = 0;

/* --------------------------------------------------------------------- UI */
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveSettings(storage, settings), 250);
}

function applySmokePreset() {
  smoke?.setPreset(resolvePreset(settings.smokePreset, settings.useCustomColor ? settings.customColor : null));
}

const ui: UI = new UI(settings, {
  start: () => void start(),
  calibrate: () => startCalibration(),
  testSmoke: () => testSmoke(),
  reset: () => resetAll(),
  toggleMute: () => change('muted', !settings.muted),
  toggleDebug: () => change('debugOpen', !settings.debugOpen),
  restoreDefaults: () => {
    for (const k of ['blowOn', 'penNear', 'penExt', 'pinchMax', 'maxInhale', 'maxHold', 'requirePinch'] as const)
      (settings as unknown as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    machine.cfg = machineConfig();
    ui.syncSettings(); persist();
    ui.log('thresholds restored to defaults');
  },
  change: (k, v) => change(k, v)
});

function change<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  switch (key) {
    case 'blowOn': case 'requirePinch': case 'maxInhale': case 'maxHold':
      machine.cfg = machineConfig(); break;
    case 'smokePreset': case 'useCustomColor': case 'customColor':
      applySmokePreset();
      if (key === 'smokePreset') ui.log('smoke: ' + SMOKE_PRESETS[settings.smokePreset].name);
      break;
    case 'muted': audio.setMuted(settings.muted); ui.setMuted(settings.muted); break;
    case 'debugOpen': ui.setDebugOpen(settings.debugOpen); break;
  }
  ui.syncSettings();
  persist();
}

function flashHint(text: string, ms: number) { flash = { text, until: performance.now() + ms }; }

/* ---------------------------------------------------------------- machine */
function onMachineEvent(e: MachineEvent) {
  switch (e.type) {
    case 'transition':
      ui.log(`${e.from} → ${e.to}  (${e.reason})`);
      break;
    case 'inhaleRejected':
      ui.log(`inhale rejected: too short (${e.charge.toFixed(2)}s < ${DEFAULT_MACHINE_CONFIG.minInhale}s)`);
      flashHint('Too short — keep your lips pursed a little longer to inhale.', 2200);
      break;
    case 'exhale': {
      const x = e.exhale;
      ui.log(`exhale: ${x.kind}, ${x.duration.toFixed(1)}s, strength ${x.strength.toFixed(2)}`);
      if (x.kind === 'cough') { audio.cough(); flashHint('*cough cough* — you held it too long!', 2000); }
      if (x.kind === 'leak') flashHint('Oops, it leaked out — keep your mouth closed while holding.', 2200);
      break;
    }
  }
}
const machine = new Machine(machineConfig(), onMachineEvent);

/* ----------------------------------------------------------------- layout */
function fitStage() {
  const wrap = $('stageWrap'), stage = $('stage');
  const cs = getComputedStyle(wrap);
  const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const ar = W / H;
  const w = Math.max(200, Math.min(aw, ah * ar));
  stage.style.width = Math.floor(w) + 'px';
  stage.style.height = Math.floor(w / ar) + 'px';
}

function setResolution(w: number, h: number) {
  W = w; H = h;
  fxCanvas.width = w; fxCanvas.height = h;
  smoke?.resize(w, h);
  fitStage();
}

new ResizeObserver(fitStage).observe($('stageWrap'));
window.addEventListener('resize', fitStage);

/* ------------------------------------------------------------------ start */
async function start() {
  audio.ensure();
  if (running || starting) return;
  starting = true;
  ui.showCard({ title: 'Starting…', body: 'Loading the tracking models and asking for camera access.', busy: true });
  try {
    const [dims, delegate] = await Promise.all([tracker.startCamera(), tracker.loadModels()]);
    setResolution(dims.width, dims.height);
    signals.reset();
    running = true;
    ui.setRunning(true);
    ui.showCard(null);
    ui.log(`camera ${dims.width}×${dims.height}, models on ${delegate}`);
    flashHint('Tip: press C to calibrate your lips first. Then bring the pen to your lips and purse them.', 6000);
  } catch (err) {
    console.error(err);
    const d = describeError(err);
    ui.log('ERROR: ' + d.title + ' — ' + ((err as Error)?.message ?? err));
    ui.showCard({
      title: d.title, body: d.body, error: true,
      actions: [
        { label: 'Retry', primary: true, fn: () => void start() },
        { label: 'Test smoke without camera', fn: () => { ui.showCard(null); testSmoke(); } }
      ]
    });
  } finally {
    starting = false;
  }
}

tracker.onEnded = () => {
  running = false;
  ui.setRunning(false);
  machine.reset(); calibration.cancel(); ui.setCalibration(null);
  ui.log('camera stopped');
  ui.showCard({ title: 'Camera disconnected', body: 'The camera stopped sending video. Reconnect it and press Retry.', error: true,
    actions: [{ label: 'Retry', primary: true, fn: () => void start() }] });
};

/* ------------------------------------------------------------ calibration */
function startCalibration() {
  if (!running) { flashHint('Start the camera first.', 2000); return; }
  audio.ensure();
  machine.reset();
  calibration.start();
  ui.log('calibration started');
}

function stepCalibration(dt: number) {
  const result = calibration.step(dt, sig.blow);
  ui.setCalibration(calibration.active ? calibration.status() : null);
  if (!result) return;
  const r = result;
  if (r.weak) {
    ui.log(`calibration weak (neutral ${r.neutral.toFixed(2)}, pucker ${r.pucker.toFixed(2)}) — threshold kept at ${settings.blowOn.toFixed(2)}`);
    flashHint('Your pucker barely registered. Try more exaggerated lips (or adjust the blow threshold in Debug).', 5000);
  } else {
    change('blowOn', r.threshold);
    ui.log(`calibrated: neutral ${r.neutral.toFixed(2)}, pucker ${r.pucker.toFixed(2)} → threshold ${r.threshold.toFixed(2)}`);
    flashHint(`Calibrated ✓  Bring the pen to your lips, purse to inhale, relax to hold, purse again to blow.`, 4500);
  }
}

/* ------------------------------------------------------------------ misc */
function testSmoke() {
  audio.ensure();
  if (calibration.active) return;
  machine.forceExhale('test', 0.9, 3);
}

function resetAll() {
  machine.reset(); calibration.cancel(); ui.setCalibration(null); smoke?.clear(); emitAcc = 0;
  ui.log('reset');
}

/** Cough: three sharp puffs matching the audio, then a weaker tail. */
function coughPulse(t: number) {
  let p = 0.25;
  for (const c of [0.02, 0.32, 0.57]) p += 1.6 * Math.exp(-(((t - c) / 0.07) ** 2));
  return p;
}

/* ------------------------------------------------------------------- loop */
let last = performance.now(), frames = 0, fps = 0, fpsT = last;

function loop(now: number) {
  requestAnimationFrame(loop);

// Dev-only handle for poking at the app from the console / browser tests.
if (import.meta.env.DEV) Object.assign(window, { __hookah: { machine, audio, settings, calibration, get smoke() { return smoke; } } });
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  const t = now / 1000;

  // 1. tracking → signals
  if (running) {
    const f = tracker.detect(now);
    if (f) { lastFrame = f; sig = signals.update(f, settings); frames++; }
  } else sig = emptySignals(W);
  if (now - fpsT >= 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }

  // 2. signals → state machine (or calibration)
  if (calibration.active) stepCalibration(dt);
  else machine.step(dt, sig);

  // 3. smoke emission
  const mouth: Pt = sig.mouth ?? { x: W * 0.5, y: H * 0.6 };
  const faceW = sig.mouth ? sig.faceW : W * 0.2;
  const scale = faceW / 300;
  let whoosh = 0;
  const ex = machine.exhale;
  if (machine.state === 'EXHALING' && ex && smoke) {
    const u = ex.t / ex.duration;
    const env = 1 - u * u;                               // fades toward the end
    const pulse = ex.kind === 'cough' ? coughPulse(ex.t) : 1;
    const live = running && ex.kind === 'blow' && sig.faceVisible
      ? 0.55 + 0.45 * clamp(sig.blow / Math.max(0.05, settings.blowOn * 1.5), 0, 1) : 1;
    const strength = ex.strength * env * pulse;
    emitAcc += dt * 90 * settings.density * strength * live;
    const n = Math.floor(emitAcc); emitAcc -= n;
    // Head turned → a narrower jet towards that side; facing the camera → a wide puff.
    const aim = running && sig.mouth ? sig.aim : { x: 0, y: 0.15 };
    const jet = clamp(Math.abs(aim.x) * 4, 0, 1);
    const kindSpread = ex.kind === 'leak' ? 1.6 : ex.kind === 'cough' ? 1.3 : 1;
    if (n > 0) smoke.emit(n, {
      x: mouth.x, y: mouth.y + 4 * scale,
      dirX: aim.x * 4, dirY: 0.55 + aim.y,
      speed: (70 + 170 * ex.strength) * scale * settings.speed * (0.7 + 0.6 * jet) * (ex.kind === 'leak' ? 0.5 : 1),
      spread: Math.min(Math.PI * 1.9, settings.spread * (2.2 - 1.1 * jet) * kindSpread),
      scale, strength: clamp(0.35 + 0.65 * ex.strength * env, 0, 1)
    });
    whoosh = clamp(strength * live * (ex.kind === 'cough' ? 0.6 : 1), 0, 1);
  } else emitAcc = 0;

  smoke?.update(dt);
  smoke?.render();

  // 4. hookah, hose, ring, debug overlay
  const inhaling = machine.state === 'INHALING';
  const chargeFrac = machine.charge / settings.maxInhale;
  const drawAmt = inhaling ? 0.45 + 0.55 * chargeFrac : 0;
  const glowTarget = inhaling ? 0.55 + 0.45 * chargeFrac : machine.state === 'HOLDING' ? 0.3 : 0;
  glow += (glowTarget - glow) * Math.min(1, dt * (glowTarget > glow ? 6 : 1.5));
  const p = sig.pen;
  fx.clearRect(0, 0, W, H);
  hookah.draw(fx, W, H, {
    t, dt, draw: drawAmt, glow,
    pen: p ? { back: { x: p.grip.x - p.dir.x * p.handSize * 0.9, y: p.grip.y - p.dir.y * p.handSize * 0.9 }, dir: p.dir, length: p.handSize * 0.55 } : null
  });
  drawRing(fx, machine, running ? sig.mouth : (machine.state === 'EXHALING' ? mouth : null), faceW, sig.penNear, t);
  if (settings.showLandmarks && running && lastFrame)
    drawLandmarks(fx, lastFrame.face?.landmarks ?? null, lastFrame.hands, LIP_CONNECTIONS, HAND_CONNECTIONS, sig, W, H);

  // 5. audio + HUD
  audio.update(dt, inhaling ? 0.5 + 0.5 * chargeFrac : 0, chargeFrac, whoosh);
  ui.updateHud(now, machine, sig, calibration.active, fps, smoke?.count ?? 0, running);
  ui.setHint(currentHint(now));
}

function currentHint(now: number): string {
  if (now < flash.until) return flash.text;
  if (!running || calibration.active) return '';
  if (!sig.faceVisible) return 'I can’t see your face — face the camera, with light in front of you.';
  if (machine.state === 'IDLE' && !sig.pen) return 'Hold the pen like a mouthpiece and keep your hand in view…';
  return HINTS[machine.state];
}

/* ------------------------------------------------------------------- keys */
addEventListener('keydown', e => {
  const el = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (el instanceof HTMLInputElement && !['range', 'checkbox'].includes(el.type)) return;
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return;
  const k = e.key.toLowerCase();
  const n = parseInt(k, 10);
  if (n >= 1 && n <= Math.min(9, SMOKE_PRESETS.length)) { change('smokePreset', n - 1); audio.ensure(); }
  else if (k === 'c') startCalibration();
  else if (k === 't') testSmoke();
  else if (k === 'r') resetAll();
  else if (k === 'd') change('debugOpen', !settings.debugOpen);
  else if (k === 'l') change('showLandmarks', !settings.showLandmarks);
  else if (k === 'm') { audio.ensure(); change('muted', !settings.muted); }
  else if (k === 'escape' && calibration.active) { calibration.cancel(); ui.setCalibration(null); ui.log('calibration cancelled'); }
  else return;
  e.preventDefault();
});

/* ------------------------------------------------------------------- boot */
try {
  smoke = new SmokeRenderer(smokeCanvas, W, H);
  applySmokePreset();
} catch (e) {
  console.error(e);
  ui.log('WebGL unavailable — smoke disabled');
  flashHint('WebGL is unavailable in this browser, so the smoke cannot be drawn.', 8000);
}
setResolution(W, H);
ui.log('ready — press “Start camera”');
requestAnimationFrame(loop);
