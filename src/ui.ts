/**
 * All DOM work: header, tabbed side panel, debug panel, HUD (badge, gesture
 * chips, score, toasts, turn banner, hint, cards), plus the 2D overlay drawing
 * of the progress ring and landmarks.
 */
import type { Settings, BackgroundMode, PlayMode } from './settings';
import { RANGES } from './settings';
import type { Machine, State } from './machine';
import type { Signals, Landmark, Pt } from './signals';
import { toScreen } from './signals';
import { FLAVOURS, VASE_SKINS, HOSE_COLORS } from './presets';
import { ACHIEVEMENTS, type Game } from './game';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const el = (tag: string, cls?: string, html?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export type TryKind = 'smoke' | 'ring' | 'nose' | 'ghost' | 'french' | 'waterfall';

export interface UIHandlers {
  start(): void;
  calibrate(): void;
  calSkip(): void;
  calCancel(): void;
  tryIt(kind: TryKind): void;
  reset(): void;
  toggleMute(): void;
  toggleDebug(): void;
  restoreDefaults(): void;
  flipCoals(): void;
  freshCoals(): void;
  resetStats(): void;
  saveRun(): void;
  change<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

type SliderKey = keyof typeof RANGES;

const THRESHOLD_SLIDERS: [SliderKey, string][] = [
  ['blowOn', 'Sip / blow'], ['penNear', 'Pen near (faces)'], ['penExt', 'Pen length (hands)'],
  ['pinchMax', 'Pinch max'], ['maxInhale', 'Max inhale (s)'], ['maxHold', 'Max hold (s)'],
  ['ringFunnel', 'Ring: funnel'], ['ringJaw', 'Ring: jaw open'], ['sneerOn', 'Nose: scrunch'],
  ['frenchPitch', 'French: tilt up °'], ['waterfallPitch', 'Waterfall: tilt down °']
];
const SMOKE_SLIDERS: [SliderKey, string][] = [['density', 'Density'], ['speed', 'Speed'], ['spread', 'Spread'], ['noseSmoke', 'Nose smoke']];
const HOOKAH_SLIDERS: [SliderKey, string][] = [['coalPower', 'Coal power']];
const SCENE_SLIDERS: [SliderKey, string][] = [['lightIntensity', 'Light strength']];

const SIGNAL_ROWS: [string, string][] = [
  ['blow', 'Sip / blow'], ['pucker', 'mouthPucker'], ['funnel', 'mouthFunnel'], ['jaw', 'jawOpen'],
  ['sneer', 'noseSneer'], ['pitch', 'Head pitch (±45°)'], ['cheek', 'cheekPuff'], ['penDist', 'Pen dist (÷2)'], ['pinch', 'Pinch gap']
];

const CHIPS: [string, string][] = [['face', '🙂 Face'], ['pen', '🖊️ Pen'], ['sip', '😗 Sip'], ['oh', '⭕ O'], ['nose', '👃 Scrunch'], ['head', '↕ Head']];

const BACKGROUNDS: [BackgroundMode, string][] = [['none', 'Camera'], ['blur', 'Blur'], ['lounge', 'Lounge'], ['neon', 'Neon bar']];
const MODES: [PlayMode, string][] = [['solo', '🙂 Solo'], ['local', '👥 Same device'], ['online', '🌐 Online']];

export const HINTS: Record<State, string> = {
  IDLE: 'Bring the pen to your lips and sip to inhale…',
  INHALING: 'Inhaling… relax your lips (or pull the pen away) to hold it.',
  HOLDING: 'Holding: purse to blow · “O” for rings · scrunch nose · tilt head back for French',
  GHOST: 'Ghost! Sip quickly to pull it back in…',
  EXHALING: 'Exhaling…'
};

export class UI {
  private sliders = new Map<SliderKey, { input: HTMLInputElement; out: HTMLOutputElement }>();
  private sigEls = new Map<string, { fill: HTMLElement; mark: HTMLElement; val: HTMLElement }>();
  private meters = new Map<string, { fill: HTMLElement; val: HTMLElement }>();
  private chipEls = new Map<string, HTMLElement>();
  private presetBtns: HTMLButtonElement[] = [];
  private skinBtns: HTMLButtonElement[] = [];
  private hoseBtns: HTMLButtonElement[] = [];
  private bgBtns = new Map<BackgroundMode, HTMLButtonElement>();
  private modeBtns = new Map<PlayMode, HTMLButtonElement>();
  private countBtns: HTMLButtonElement[] = [];
  private logLines: string[] = [];
  private lastState = '';
  private lastHud = 0;
  private hint = '';

  constructor(private s: Settings, private h: UIHandlers) {
    $('startBtn').onclick = () => h.start();
    $('cardStart').onclick = () => h.start();
    $('calBtn').onclick = () => h.calibrate();
    $('calSkip').onclick = () => h.calSkip();
    $('calCancel').onclick = () => h.calCancel();
    $('muteBtn').onclick = () => h.toggleMute();
    $('debugBtn').onclick = () => h.toggleDebug();
    $('resetBtn').onclick = () => h.reset();
    $('defaultsBtn').onclick = () => h.restoreDefaults();
    $('flipBtn').onclick = () => h.flipCoals();
    $('freshBtn').onclick = () => h.freshCoals();
    $('resetStats').onclick = () => { if (confirm('Reset your stats and achievements?')) h.resetStats(); };
    document.querySelectorAll<HTMLButtonElement>('[data-try]').forEach(b => b.onclick = () => h.tryIt(b.dataset.try as TryKind));

    // tabs
    const tabs = document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]');
    tabs.forEach(t => t.onclick = () => {
      tabs.forEach(x => x.classList.toggle('on', x === t));
      document.querySelectorAll<HTMLElement>('.tabPage').forEach(p => p.hidden = p.dataset.page !== t.dataset.tab);
    });

    // flavours
    FLAVOURS.forEach((f, i) => {
      const b = el('button', 'preset') as HTMLButtonElement;
      b.innerHTML = `<span class="sw"></span><span class="nm"></span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}`;
      (b.querySelector('.sw') as HTMLElement).style.background = f.swatch;
      (b.querySelector('.nm') as HTMLElement).textContent = `${f.emoji} ${f.name}`;
      b.title = f.blend === 'additive' ? `${f.name} (glows)` : f.name;
      b.onclick = () => h.change('smokePreset', i);
      $('presets').appendChild(b);
      this.presetBtns.push(b);
    });
    const customChk = $<HTMLInputElement>('customChk'), customColor = $<HTMLInputElement>('customColor');
    customChk.onchange = () => h.change('useCustomColor', customChk.checked);
    customColor.oninput = () => { h.change('customColor', customColor.value); if (!customChk.checked) h.change('useCustomColor', true); };
    for (const [k, label] of SMOKE_SLIDERS) this.addSlider($('smokeSliders'), k, label);

    // hookah
    VASE_SKINS.forEach((v, i) => {
      const b = el('button', '', v.name) as HTMLButtonElement;
      b.onclick = () => h.change('vaseSkin', i);
      $('skins').appendChild(b); this.skinBtns.push(b);
    });
    HOSE_COLORS.forEach((c, i) => {
      const b = el('button') as HTMLButtonElement;
      b.style.background = `linear-gradient(135deg, ${c.base}, ${c.dark})`;
      b.title = c.name; b.setAttribute('aria-label', c.name + ' hose');
      b.onclick = () => h.change('hoseColor', i);
      $('hoses').appendChild(b); this.hoseBtns.push(b);
    });
    for (const [k, label] of HOOKAH_SLIDERS) this.addSlider($('hookahSliders'), k, label);
    const lightSmoke = $<HTMLInputElement>('lightSmokeChk');
    lightSmoke.onchange = () => h.change('lightSmoke', lightSmoke.checked);

    // scene
    for (const [mode, label] of BACKGROUNDS) {
      const b = el('button', '', label) as HTMLButtonElement;
      b.onclick = () => h.change('background', mode);
      $('backgrounds').appendChild(b); this.bgBtns.set(mode, b);
    }
    const faceLight = $<HTMLInputElement>('faceLightChk');
    faceLight.onchange = () => h.change('faceLight', faceLight.checked);
    for (const [k, label] of SCENE_SLIDERS) this.addSlider($('sceneSliders'), k, label);

    // play
    for (const [mode, label] of MODES) {
      const b = el('button', '', label) as HTMLButtonElement;
      b.onclick = () => h.change('playMode', mode);
      $('modes').appendChild(b); this.modeBtns.set(mode, b);
    }
    for (let n = 2; n <= 4; n++) {
      const b = el('button', '', `${n} players`) as HTMLButtonElement;
      b.onclick = () => h.change('localPlayers', n);
      $('localCountBtns').appendChild(b); this.countBtns.push(b);
    }

    // debug
    const pinch = $<HTMLInputElement>('pinchChk');
    pinch.onchange = () => h.change('requirePinch', pinch.checked);
    const lm = $<HTMLInputElement>('lmChk');
    lm.onchange = () => h.change('showLandmarks', lm.checked);
    for (const [k, label] of THRESHOLD_SLIDERS) this.addSlider($('thresholds'), k, label);
    for (const [k, label] of SIGNAL_ROWS) {
      const row = el('div', 'sig', `<span>${label}</span><div class="bar"><i></i><b hidden></b></div><span>0.00</span>`);
      $('signals').appendChild(row);
      this.sigEls.set(k, { fill: row.querySelector('i')!, mark: row.querySelector('b')!, val: row.lastElementChild as HTMLElement });
    }
    for (const k of ['blow', 'funnel', 'jaw', 'sneer', 'penDist', 'pinch']) this.sigEls.get(k)!.mark.hidden = false;
    for (const [k, label, color] of [['charge', 'Inhale charge', 'var(--cyan)'], ['hold', 'Hold time', 'var(--amber)'], ['exhale', 'Exhale left', 'var(--green)']]) {
      const row = el('div', 'sig', `<span>${label}</span><div class="bar"><i style="background:${color}"></i></div><span>–</span>`);
      $('meters').appendChild(row);
      this.meters.set(k, { fill: row.querySelector('i')!, val: row.lastElementChild as HTMLElement });
    }

    // HUD chips
    for (const [k, label] of CHIPS) { const c = el('span', 'chip', label); $('chips').appendChild(c); this.chipEls.set(k, c); }

    // stage taps: start the camera from the welcome screen
    this.syncSettings();
    this.setDebugOpen(s.debugOpen);
  }

  private addSlider(parent: HTMLElement, key: SliderKey, label: string) {
    const r = RANGES[key];
    const row = el('label', 'slider', `<span>${label}</span><input type="range" min="${r.min}" max="${r.max}" step="${r.step}"><output></output>`);
    const input = row.querySelector('input')!, out = row.querySelector('output')!;
    const fmt = (v: number) => (r.step >= 1 ? v.toFixed(0) : v.toFixed(2));
    input.oninput = () => { out.textContent = fmt(+input.value); this.h.change(key, +input.value); };
    parent.appendChild(row);
    this.sliders.set(key, { input, out });
  }

  /** Push the current settings into every control. */
  syncSettings(): void {
    const s = this.s;
    for (const [k, { input, out }] of this.sliders) {
      input.value = String(s[k]);
      out.textContent = RANGES[k].step >= 1 ? (+s[k]).toFixed(0) : (+s[k]).toFixed(2);
    }
    this.presetBtns.forEach((b, i) => b.classList.toggle('sel', i === s.smokePreset));
    this.skinBtns.forEach((b, i) => b.classList.toggle('sel', i === s.vaseSkin));
    this.hoseBtns.forEach((b, i) => b.classList.toggle('sel', i === s.hoseColor));
    this.bgBtns.forEach((b, m) => b.classList.toggle('sel', m === s.background));
    this.modeBtns.forEach((b, m) => b.classList.toggle('sel', m === s.playMode));
    this.countBtns.forEach((b, i) => b.classList.toggle('sel', i + 2 === s.localPlayers));
    $('localCount').hidden = s.playMode !== 'local';
    $<HTMLInputElement>('customChk').checked = s.useCustomColor;
    $<HTMLInputElement>('customColor').value = s.customColor;
    $<HTMLInputElement>('pinchChk').checked = s.requirePinch;
    $<HTMLInputElement>('lmChk').checked = s.showLandmarks;
    $<HTMLInputElement>('lightSmokeChk').checked = s.lightSmoke;
    $<HTMLInputElement>('faceLightChk').checked = s.faceLight;
    this.setMuted(s.muted);
  }

  setMuted(m: boolean): void {
    const b = $('muteBtn');
    b.querySelector('.ic')!.textContent = m ? '🔇' : '🔊';
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
    sb.querySelector('.lbl')!.textContent = running ? 'Camera on' : 'Start camera';
    sb.classList.toggle('primary', !running);
  }

  setBackgroundNote(text: string): void { $('bgNote').textContent = text; }

  setHint(text: string): void {
    if (text === this.hint) return;
    this.hint = text;
    $('hint').textContent = text;
  }

  toast(text: string, kind: 'ach' | 'pts' | 'combo' = 'ach'): void {
    const box = $('toasts');
    while (box.children.length > 3) box.firstElementChild!.remove();
    const t = el('div', 'toast' + (kind === 'ach' ? '' : ' ' + kind));
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.remove(), 2700);
  }

  turnBanner(text: string | null): void {
    const b = $('turnBanner');
    b.hidden = !text;
    if (text) b.textContent = text;
  }

  /** Centre card: null hides it. */
  showCard(card: { title: string; body: string; error?: boolean; busy?: boolean; actions?: { label: string; primary?: boolean; fn: () => void }[] } | null): void {
    const c = $('card');
    if (!card) { c.hidden = true; return; }
    c.hidden = false;
    c.classList.toggle('error', !!card.error);
    c.replaceChildren();
    const h1 = el('h1'); h1.textContent = card.title;
    const p = el('p', 'lead');
    if (card.busy) p.appendChild(el('span', 'spinner'));
    p.appendChild(document.createTextNode(card.body));
    c.append(h1, p);
    if (card.actions?.length) {
      const a = el('div', 'cardActions');
      for (const act of card.actions) {
        const b = el('button', act.primary ? 'primary big' : '') as HTMLButtonElement;
        b.textContent = act.label; b.onclick = act.fn; a.appendChild(b);
      }
      c.appendChild(a);
    }
    const fine = el('p', 'fine');
    fine.textContent = '🔒 Tracking runs entirely in your browser. No video or images leave your device.';
    c.appendChild(fine);
  }

  setCalibration(c: { step: number; total: number; text: string; progress: number; sampling: boolean } | null): void {
    $('calCard').hidden = !c;
    if (!c) return;
    $('calStep').textContent = `Calibration · step ${c.step} of ${c.total}${c.sampling ? ' · hold it…' : ' · get ready'}`;
    $('calText').textContent = c.text;
    const bar = $('calBar');
    bar.style.width = (c.progress * 100).toFixed(1) + '%';
    bar.classList.toggle('sampling', c.sampling);
  }

  log(msg: string): void {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    this.logLines.push(`${t}  ${msg}`);
    if (this.logLines.length > 150) this.logLines.shift();
    const e = $('log');
    e.textContent = this.logLines.join('\n');
    e.scrollTop = e.scrollHeight;
  }

  /** Coal meters in the Hookah tab. */
  setCoals(heat: number, fuel: number): void {
    $('heatBar').style.width = clamp01(heat) * 100 + '%';
    $('heatVal').textContent = Math.round(heat * 100) + '%';
    $('fuelBar').style.width = clamp01(fuel) * 100 + '%';
    $('fuelVal').textContent = Math.round(fuel * 100) + '%';
  }

  /** Mark the Online mode button while in a room. */
  setOnlineActive(on: boolean): void {
    this.modeBtns.forEach((b, m) => b.classList.toggle('sel', on ? m === 'online' : m === this.s.playMode));
  }

  /** Score pill on the stage + Play tab contents. */
  renderGame(g: Game, account?: { signedIn: boolean; hasProfile: boolean; saving: boolean }): void {
    const pill = $('scorePill');
    const multi = g.mode === 'local';
    if (multi) {
      pill.innerHTML = g.players.map((p, i) => `<div class="${i === g.turn ? 'act' : ''}">${i === g.turn ? '▶ ' : ''}${p.name}: ${p.score}</div>`).join('');
    } else {
      const p = g.players[0];
      pill.innerHTML = p.score || g.combo ? `${p.score} pts${g.combo ? `<small>⭕ ×${g.combo} · best ${g.stats.bestRings}</small>` : ''}` : '';
    }
    const board = $('scoreboard');
    board.innerHTML = multi
      ? g.players.map((p, i) => `<div class="player${i === g.turn ? ' active' : ''}"><span>${i === g.turn ? '▶ ' : ''}${p.name}</span><span>${p.hits} hits · best ⭕${p.bestRings} · <b>${p.score}</b></span></div>`).join('')
      : `<div class="player"><span>This run</span><span>${g.run.hits} hits · ⭕${g.run.rings} · <b>${g.players[0].score}</b></span></div>`;
    const box = $('runBox');
    box.replaceChildren();
    if (g.mode === 'solo') {
      const btn = el('button', 'primary', account?.saving ? 'Saving…' : '🏁 Finish & save run') as HTMLButtonElement;
      btn.disabled = !!account?.saving || g.run.hits === 0;
      btn.onclick = () => this.h.saveRun();
      box.append(btn, el('p', 'hintTxt', !account?.signedIn
        ? 'Sign in to save your runs to the leaderboard.'
        : !account.hasProfile ? 'Pick a username to get on the leaderboard.'
        : 'Your best run goes on the leaderboard. Runs also save automatically when you close the tab.'));
    } else if (g.mode === 'local') {
      box.append(el('p', 'hintTxt', 'Same-device games are just for fun and are not saved to the leaderboard.'));
    }
    const st = g.stats;
    $('stats').innerHTML = [
      [st.bestRings, 'Best rings / inhale'], [st.totalRings, 'Rings blown'],
      [st.bestHold.toFixed(1) + 's', 'Longest hold'], [st.bestScore, 'Best score']
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
    $('achCount').textContent = `${st.unlocked.length}/${ACHIEVEMENTS.length}`;
    $('achievements').innerHTML = ACHIEVEMENTS.map(a =>
      `<div class="ach${st.unlocked.includes(a.id) ? ' got' : ''}" title="${a.desc}"><span class="e">${a.emoji}</span><span>${a.name}<small>${a.desc}</small></span></div>`).join('');
  }

  /** Badge, gesture chips and debug numbers. Throttled to ~11 Hz except for state changes. */
  updateHud(now: number, m: Machine, sig: Signals, calibrating: boolean, fps: number, particles: number, running: boolean): void {
    const label = calibrating ? 'CALIBRATING' : m.trick === 'french' ? 'FRENCH' : m.state;
    if (label !== this.lastState) {
      this.lastState = label;
      const b = $('badge');
      b.className = 'badge st-' + (label === 'FRENCH' ? 'HOLDING' : label);
      b.querySelector('span')!.textContent = label === 'FRENCH' ? 'FRENCH INHALE' : label;
    }
    if (now - this.lastHud < 90) return;
    this.lastHud = now;
    const s = this.s;

    // what the camera currently sees
    const DEG = Math.PI / 180;
    const chip = (k: string, on: boolean, warn = false) => { const c = this.chipEls.get(k)!; c.classList.toggle('on', on); c.classList.toggle('warn', warn); };
    $('chips').hidden = !running;
    chip('face', sig.faceVisible, running && !sig.faceVisible);
    chip('pen', sig.penNear);
    chip('sip', m.pursed && !m.oShape);
    chip('oh', m.oShape);
    chip('nose', m.sneering);
    const head = this.chipEls.get('head')!;
    const up = sig.pitch >= s.frenchPitch * DEG, down = sig.pitch <= -s.waterfallPitch * DEG;
    head.textContent = up ? '⬆ Head up' : down ? '⬇ Head down' : '↕ Head';
    chip('head', up || down);

    $('fps').textContent = running ? `${fps} fps · ${particles} puffs` : '';
    if ($('debug').hidden) return;

    $('fpsLine').textContent = running ? `tracking ${fps} fps · ${particles} puffs` : `${particles} puffs`;
    const setMeter = (k: string, frac: number, txt: string) => {
      const e = this.meters.get(k)!; e.fill.style.width = clamp01(frac) * 100 + '%'; e.val.textContent = txt;
    };
    setMeter('charge', m.charge / s.maxInhale, m.charge.toFixed(1) + 's');
    setMeter('hold', m.state === 'HOLDING' || m.state === 'GHOST' ? m.hold / s.maxHold : 0, m.state === 'HOLDING' || m.state === 'GHOST' ? m.hold.toFixed(1) + 's' : '–');
    const ex = m.exhale;
    setMeter('exhale', ex ? 1 - ex.t / ex.duration : 0, ex ? (ex.duration - ex.t).toFixed(1) + 's' : '–');

    const vals: Record<string, [number, string]> = {
      blow: [sig.blow, sig.blow.toFixed(2)], pucker: [sig.pucker, sig.pucker.toFixed(2)], funnel: [sig.funnel, sig.funnel.toFixed(2)],
      jaw: [sig.jaw, sig.jaw.toFixed(2)], sneer: [sig.sneer, sig.sneer.toFixed(2)],
      pitch: [0.5 + sig.pitch / (Math.PI / 2), (sig.pitch / DEG).toFixed(0) + '°'], cheek: [sig.cheek, sig.cheek.toFixed(2)],
      penDist: sig.pen && isFinite(sig.pen.dist) ? [sig.pen.dist / 2, (sig.pen.dist / 2).toFixed(2)] : [1, '–'],
      pinch: sig.pen ? [sig.pen.pinch, sig.pen.pinch.toFixed(2)] : [1, '–']
    };
    for (const [k, [v, txt]] of Object.entries(vals)) {
      const e = this.sigEls.get(k)!;
      e.fill.style.width = clamp01(v) * 100 + '%';
      e.val.textContent = txt;
    }
    const mark = (k: string, at: number, active: boolean, color: string) => {
      const e = this.sigEls.get(k)!; e.mark.style.left = clamp01(at) * 100 + '%'; e.fill.style.background = active ? color : 'var(--accent)';
    };
    mark('blow', s.blowOn, m.pursed, 'var(--cyan)');
    mark('funnel', s.ringFunnel, m.oShape, 'var(--amber)');
    mark('jaw', s.ringJaw, m.oShape, 'var(--amber)');
    mark('sneer', s.sneerOn, m.sneering, 'var(--green)');
    mark('penDist', s.penNear / 2, sig.penNear, 'var(--green)');
    mark('pinch', s.pinchMax, sig.pinchOk, 'var(--green)');
  }
}

// ------------------------------------------------------------- overlay drawing

const RING_COLORS: Partial<Record<State, string>> = { INHALING: '#22d3ee', HOLDING: '#fbbf24', GHOST: '#c084fc', EXHALING: '#4ade80' };

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
    ctx.setLineDash([6 * sc, 10 * sc]); ctx.lineDashOffset = -t * 30 * sc;
    ctx.beginPath(); ctx.arc(mouth.x, mouth.y, R, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(mouth.x, mouth.y, R, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, Math.min(1, prog)) * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Debug overlay: lips, nostrils, hands, pen estimate and its distance to the mouth. */
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
  ctx.setLineDash([]);
  if (sig.mouth) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sig.mouth.x, sig.mouth.y, 3, 0, Math.PI * 2); ctx.fill(); }
  if (sig.nostrils) { ctx.fillStyle = '#c084fc'; for (const n of sig.nostrils) { ctx.beginPath(); ctx.arc(n.x, n.y, 3, 0, Math.PI * 2); ctx.fill(); } }
  ctx.restore();
}
