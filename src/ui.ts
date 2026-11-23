/**
 * All DOM work: header buttons, smoke panel, debug panel, HUD (badge, hint,
 * cards), and the 2D overlay drawing of the progress ring and landmarks.
 */
import type { Settings } from './settings';
import { RANGES } from './settings';
import type { Machine, State } from './machine';
import type { Signals, Landmark, Pt } from './signals';
import { toScreen } from './signals';
import { SMOKE_PRESETS } from './presets';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface UIHandlers {
  start(): void;
  calibrate(): void;
  testSmoke(): void;
  reset(): void;
  toggleMute(): void;
  toggleDebug(): void;
  restoreDefaults(): void;
  change<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

type SliderKey = keyof typeof RANGES;

const THRESHOLD_SLIDERS: [SliderKey, string][] = [
  ['blowOn', 'Blow threshold'], ['penNear', 'Pen near (faces)'], ['penExt', 'Pen length (hands)'],
  ['pinchMax', 'Pinch max'], ['maxInhale', 'Max inhale (s)'], ['maxHold', 'Max hold (s)'],
  ['ringFunnel', 'Ring: funnel'], ['ringJaw', 'Ring: jaw open'], ['sneerOn', 'Nose: sneer']
];
const SMOKE_SLIDERS: [SliderKey, string][] = [['density', 'Density'], ['speed', 'Speed'], ['spread', 'Spread'], ['noseSmoke', 'Nose smoke']];

const SIGNAL_ROWS: [string, string][] = [
  ['blow', 'Blow score'], ['pucker', 'mouthPucker'], ['funnel', 'mouthFunnel'], ['jaw', 'jawOpen'],
  ['close', 'mouthClose'], ['cheek', 'cheekPuff'], ['sneer', 'noseSneer'], ['penDist', 'Pen dist (÷2)'], ['pinch', 'Pinch gap']
];

export const HINTS: Record<State, string> = {
  IDLE: 'Bring the pen to your lips and purse them to inhale…',
  INHALING: 'Inhaling… relax your lips or pull the pen away to hold it in.',
  HOLDING: 'Holding… purse your lips to blow · make an “O” to puff rings · scrunch your nose to exhale through it',
  EXHALING: 'Exhaling…'
};

export class UI {
  private sliders = new Map<SliderKey, { input: HTMLInputElement; out: HTMLOutputElement }>();
  private sigEls = new Map<string, { fill: HTMLElement; mark: HTMLElement; val: HTMLElement }>();
  private meters = new Map<string, { fill: HTMLElement; val: HTMLElement }>();
  private presetBtns: HTMLButtonElement[] = [];
  private logLines: string[] = [];
  private lastState = '';
  private lastHud = 0;

  constructor(private s: Settings, private h: UIHandlers) {
    $('startBtn').onclick = () => h.start();
    $('cardStart').onclick = () => h.start();
    $('calBtn').onclick = () => h.calibrate();
    $('testBtn').onclick = () => h.testSmoke();
    $('muteBtn').onclick = () => h.toggleMute();
    $('debugBtn').onclick = () => h.toggleDebug();
    $('resetBtn').onclick = () => h.reset();
    $('defaultsBtn').onclick = () => h.restoreDefaults();

    // smoke presets
    SMOKE_PRESETS.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'preset';
      b.innerHTML = `<span class="sw"></span><span class="nm"></span>${p.blend === 'additive' ? '<span class="tag">glow</span>' : ''}<kbd>${i + 1}</kbd>`;
      (b.querySelector('.sw') as HTMLElement).style.background = p.swatch;
      (b.querySelector('.nm') as HTMLElement).textContent = p.name;
      b.onclick = () => h.change('smokePreset', i);
      $('presets').appendChild(b);
      this.presetBtns.push(b);
    });
    const customChk = $<HTMLInputElement>('customChk'), customColor = $<HTMLInputElement>('customColor');
    customChk.onchange = () => h.change('useCustomColor', customChk.checked);
    customColor.oninput = () => { h.change('customColor', customColor.value); if (!customChk.checked) h.change('useCustomColor', true); };
    for (const [k, label] of SMOKE_SLIDERS) this.addSlider($('smokeSliders'), k, label);

    const pinch = $<HTMLInputElement>('pinchChk');
    pinch.onchange = () => h.change('requirePinch', pinch.checked);
    const lm = $<HTMLInputElement>('lmChk');
    lm.onchange = () => h.change('showLandmarks', lm.checked);

    // debug panel
    for (const [k, label] of THRESHOLD_SLIDERS) this.addSlider($('thresholds'), k, label);
    for (const [k, label] of SIGNAL_ROWS) {
      const row = document.createElement('div'); row.className = 'sig';
      row.innerHTML = `<span>${label}</span><div class="bar"><i></i><b hidden></b></div><span>0.00</span>`;
      $('signals').appendChild(row);
      this.sigEls.set(k, { fill: row.querySelector('i')!, mark: row.querySelector('b')!, val: row.lastElementChild as HTMLElement });
    }
    this.sigEls.get('blow')!.mark.hidden = false;
    this.sigEls.get('penDist')!.mark.hidden = false;
    this.sigEls.get('pinch')!.mark.hidden = false;
    this.sigEls.get('funnel')!.mark.hidden = false;
    this.sigEls.get('sneer')!.mark.hidden = false;
    for (const [k, label, color] of [['charge', 'Inhale charge', 'var(--cyan)'], ['hold', 'Hold time', 'var(--amber)'], ['exhale', 'Exhale left', 'var(--green)']]) {
      const row = document.createElement('div'); row.className = 'sig';
      row.innerHTML = `<span>${label}</span><div class="bar"><i style="background:${color}"></i></div><span>–</span>`;
      $('meters').appendChild(row);
      this.meters.set(k, { fill: row.querySelector('i')!, val: row.lastElementChild as HTMLElement });
    }
    this.syncSettings();
    this.setDebugOpen(s.debugOpen);
  }

  private addSlider(parent: HTMLElement, key: SliderKey, label: string) {
    const r = RANGES[key];
    const row = document.createElement('label'); row.className = 'slider';
    row.innerHTML = `<span>${label}</span><input type="range" min="${r.min}" max="${r.max}" step="${r.step}"><output></output>`;
    const input = row.querySelector('input')!, out = row.querySelector('output')!;
    input.oninput = () => { out.textContent = (+input.value).toFixed(2); this.h.change(key, +input.value); };
    parent.appendChild(row);
    this.sliders.set(key, { input, out });
  }

  /** Push the current settings into every control. */
  syncSettings(): void {
    const s = this.s;
    for (const [k, { input, out }] of this.sliders) { input.value = String(s[k]); out.textContent = (+s[k]).toFixed(2); }
    this.presetBtns.forEach((b, i) => b.classList.toggle('sel', i === s.smokePreset));
    $<HTMLInputElement>('customChk').checked = s.useCustomColor;
    $<HTMLInputElement>('customColor').value = s.customColor;
    $<HTMLInputElement>('pinchChk').checked = s.requirePinch;
    $<HTMLInputElement>('lmChk').checked = s.showLandmarks;
    this.setMuted(s.muted);
  }

  setMuted(m: boolean): void {
    const b = $('muteBtn');
    b.innerHTML = `${m ? '🔇' : '🔊'} <kbd>M</kbd>`;
    b.classList.toggle('on', m);
  }

  setDebugOpen(open: boolean): void {
    $('debug').hidden = !open;
    $('debugBtn').classList.toggle('on', open);
    $('fps').hidden = !open;
    window.dispatchEvent(new Event('resize'));
  }

  setRunning(running: boolean): void {
    $<HTMLButtonElement>('calBtn').disabled = !running;
    const sb = $<HTMLButtonElement>('startBtn');
    sb.disabled = running;
    sb.textContent = running ? 'Camera on' : 'Start camera';
    sb.classList.toggle('primary', !running);
  }

  private hint = '';
  setHint(text: string): void {
    if (text === this.hint) return;
    this.hint = text;
    $('hint').textContent = text;
  }

  /** Centre card: null hides it. */
  showCard(card: { title: string; body: string; error?: boolean; busy?: boolean; actions?: { label: string; primary?: boolean; fn: () => void }[] } | null): void {
    const el = $('card');
    if (!card) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('error', !!card.error);
    el.replaceChildren();
    const h1 = document.createElement('h1'); h1.textContent = card.title;
    const p = document.createElement('p'); p.className = 'lead';
    if (card.busy) { const sp = document.createElement('span'); sp.className = 'spinner'; p.appendChild(sp); }
    p.appendChild(document.createTextNode(card.body));
    el.append(h1, p);
    if (card.actions?.length) {
      const a = document.createElement('div'); a.className = 'cardActions';
      for (const act of card.actions) {
        const b = document.createElement('button'); b.textContent = act.label;
        if (act.primary) b.className = 'primary big';
        b.onclick = act.fn; a.appendChild(b);
      }
      el.appendChild(a);
    }
    const fine = document.createElement('p'); fine.className = 'fine';
    fine.textContent = '🔒 Tracking runs entirely in your browser. No video or images leave your device.';
    el.appendChild(fine);
  }

  setCalibration(c: { step: number; text: string; progress: number } | null): void {
    $('calCard').hidden = !c;
    if (!c) return;
    $('calStep').textContent = `Calibration · step ${c.step} of 2`;
    $('calText').textContent = c.text;
    $('calBar').style.width = (c.progress * 100).toFixed(1) + '%';
  }

  log(msg: string): void {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    this.logLines.push(`${t}  ${msg}`);
    if (this.logLines.length > 120) this.logLines.shift();
    const el = $('log');
    el.textContent = this.logLines.join('\n');
    el.scrollTop = el.scrollHeight;
  }

  /** Badge + hint + debug numbers. Throttled to ~11 Hz except for state changes. */
  updateHud(now: number, m: Machine, sig: Signals, calibrating: boolean, fps: number, particles: number, running: boolean, oShape = false): void {
    const label = calibrating ? 'CALIBRATING' : m.state;
    if (label !== this.lastState) {
      this.lastState = label;
      const b = $('badge');
      b.className = 'badge st-' + label;
      b.querySelector('span')!.textContent = label;
    }
    if (now - this.lastHud < 90) return;
    this.lastHud = now;
    $('fps').textContent = running ? `${fps} fps` : '';
    if ($('debug').hidden) return;

    const s = this.s;
    $('fpsLine').textContent = running ? `tracking ${fps} fps · ${particles} puffs` : `${particles} puffs`;
    const setMeter = (k: string, frac: number, txt: string) => {
      const e = this.meters.get(k)!; e.fill.style.width = clamp01(frac) * 100 + '%'; e.val.textContent = txt;
    };
    setMeter('charge', m.charge / s.maxInhale, m.charge.toFixed(1) + 's');
    setMeter('hold', m.state === 'HOLDING' ? m.hold / s.maxHold : 0, m.state === 'HOLDING' ? m.hold.toFixed(1) + 's' : '–');
    const ex = m.exhale;
    setMeter('exhale', ex ? 1 - ex.t / ex.duration : 0, ex ? (ex.duration - ex.t).toFixed(1) + 's' : '–');

    const vals: Record<string, number> = {
      blow: sig.blow, pucker: sig.pucker, funnel: sig.funnel, jaw: sig.jaw, close: sig.close, cheek: sig.cheek, sneer: sig.sneer,
      penDist: sig.pen && isFinite(sig.pen.dist) ? sig.pen.dist / 2 : 1, pinch: sig.pen ? sig.pen.pinch : 1
    };
    for (const [k, v] of Object.entries(vals)) {
      const e = this.sigEls.get(k)!;
      e.fill.style.width = clamp01(v) * 100 + '%';
      e.val.textContent = v.toFixed(2);
    }
    const blow = this.sigEls.get('blow')!;
    blow.mark.style.left = clamp01(s.blowOn) * 100 + '%';
    blow.fill.style.background = m.pursed ? 'var(--cyan)' : 'var(--accent)';
    const pen = this.sigEls.get('penDist')!;
    pen.mark.style.left = clamp01(s.penNear / 2) * 100 + '%';
    pen.fill.style.background = sig.penNear ? 'var(--green)' : 'var(--accent)';
    const funnel = this.sigEls.get('funnel')!;
    funnel.mark.style.left = clamp01(s.ringFunnel) * 100 + '%';
    funnel.fill.style.background = oShape ? 'var(--amber)' : 'var(--accent)';
    const sneer = this.sigEls.get('sneer')!;
    sneer.mark.style.left = clamp01(s.sneerOn) * 100 + '%';
    sneer.fill.style.background = sig.sneer >= s.sneerOn ? 'var(--green)' : 'var(--accent)';
    const pinch = this.sigEls.get('pinch')!;
    pinch.mark.style.left = clamp01(s.pinchMax) * 100 + '%';
    pinch.fill.style.background = sig.pinchOk ? 'var(--green)' : 'var(--accent)';
  }
}

// ------------------------------------------------------------- overlay drawing

const RING_COLORS: Partial<Record<State, string>> = { INHALING: '#22d3ee', HOLDING: '#fbbf24', EXHALING: '#4ade80' };

/** Progress ring around the mouth. */
export function drawRing(ctx: CanvasRenderingContext2D, m: Machine, mouth: Pt | null, faceW: number, penNear: boolean, t: number): void {
  if (!mouth) return;
  const sc = faceW / 300, R = 52 * sc;
  let col = RING_COLORS[m.state];
  let prog = m.progress();
  if (!col) {
    if (!penNear) return;
    col = 'rgba(255,255,255,0.55)'; prog = 0;
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 7 * sc;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.arc(mouth.x, mouth.y, R, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 5 * sc;
  ctx.strokeStyle = col;
  ctx.shadowColor = col; ctx.shadowBlur = 12 * sc;
  if (prog <= 0) {
    // idle with pen at lips: a slowly rotating dashed ring as "ready" feedback
    ctx.setLineDash([6 * sc, 10 * sc]); ctx.lineDashOffset = -t * 30 * sc;
    ctx.beginPath(); ctx.arc(mouth.x, mouth.y, R, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(mouth.x, mouth.y, R, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, Math.min(1, prog)) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Debug overlay: lips, hands, pen estimate and its distance to the mouth. */
export function drawLandmarks(ctx: CanvasRenderingContext2D, face: Landmark[] | null, hands: Landmark[][],
                              lips: { start: number; end: number }[], handConn: { start: number; end: number }[],
                              sig: Signals, W: number, H: number): void {
  ctx.save();
  ctx.lineWidth = 2;
  const seg = (lm: Landmark[], conns: { start: number; end: number }[]) => {
    ctx.beginPath();
    for (const { start, end } of conns) {
      const a = toScreen(lm[start], W, H), b = toScreen(lm[end], W, H);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  };
  if (face) { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; seg(face, lips); }
  ctx.strokeStyle = 'rgba(143,179,255,0.85)';
  for (const h of hands) seg(h, handConn);
  const p = sig.pen;
  if (p) {
    const near = sig.penNear, col = near ? '#4ade80' : '#f87171';
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(p.grip.x, p.grip.y); ctx.lineTo(p.tip.x, p.tip.y); ctx.stroke();
    for (const q of [p.grip, p.tip]) { ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill(); }
    if (sig.mouth) {
      ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.tip.x, p.tip.y); ctx.lineTo(sig.mouth.x, sig.mouth.y); ctx.stroke();
    }
  }
  if (sig.mouth) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sig.mouth.x, sig.mouth.y, 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
