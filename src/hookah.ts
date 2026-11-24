/**
 * The virtual hookah, drawn on the 2D overlay canvas above the smoke:
 * a glass vase (skins: classic / crystal / LED / amber) with flavour-tinted
 * water that bubbles while inhaling, a metal stem, a clay bowl with coals that
 * burn down, turn ashy and can be flipped, and a hose (cubic Bézier with sag)
 * that follows the pen.
 */
import type { Pt } from './signals';
import type { VaseSkin, HoseColor } from './presets';

export interface HookahInput {
  t: number;              // seconds
  dt: number;
  draw: number;           // 0…1: how hard smoke is being pulled through (bubbles, hose flow)
  glow: number;           // 0…1: extra coal brightness from pulling
  pen: { back: Pt; dir: Pt; length: number } | null;  // mouthpiece back end, pointing to the mouth
  skin: VaseSkin;
  hose: HoseColor;
  water: string;          // #rrggbb
  power: number;          // coal power setting (0.3…1.5)
}

interface Bubble { x: number; y: number; r: number; vx: number; vy: number; ph: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number }

// Hookah model units: ~100 tall, y up is negative, origin at the bottom centre of the vase.
const PORT = { x: -13, y: -58 };
const WATER_Y = -16;
const DOWNSTEM_BOTTOM = -5;
const BOWL = { x0: -13, x1: 13, y0: -106, y1: -86 };

const METALS: Record<VaseSkin['metal'], string[]> = {
  brass: ['#5a4520', '#b8964a', '#f4e1a0', '#a88738', '#4a3818'],
  steel: ['#3d4048', '#9aa0aa', '#eef1f5', '#8a909a', '#2f3238'],
  copper: ['#4a2412', '#a8582c', '#f2b48a', '#9a4c24', '#3a1a0c'],
  black: ['#0c0c10', '#34343e', '#8a8a9a', '#2a2a32', '#08080b']
};

function vasePath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(-9, 0);
  ctx.bezierCurveTo(-23, -2, -23, -22, -12, -28);
  ctx.bezierCurveTo(-6, -31, -4.5, -32, -4.5, -37);
  ctx.lineTo(4.5, -37);
  ctx.bezierCurveTo(4.5, -32, 6, -31, 12, -28);
  ctx.bezierCurveTo(23, -22, 23, -2, 9, 0);
  ctx.closePath();
}

function metalGrad(ctx: CanvasRenderingContext2D, x0: number, x1: number, kind: VaseSkin['metal']) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  const stops = METALS[kind];
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** Coal state: heat drops as you smoke, fuel runs out over a session, flipping restores heat. */
export class Coals {
  heat = 1;        // 0…1 current heat (smoke thickness, glow)
  fuel = 1;        // 0…1 remaining
  ash = 0;         // 0…1 ash coating (shown on the coals)
  flipT = -1;      // flip animation progress 0…1, -1 = idle

  burn(dt: number, pulling: boolean, power: number): void {
    const p = Math.max(0.3, power);
    this.heat -= dt * (pulling ? 0.035 : 0.004) * p;
    this.ash = Math.min(1, this.ash + dt * (pulling ? 0.03 : 0.004) * p);
    this.fuel = Math.max(0, this.fuel - dt * (pulling ? 0.006 : 0.0006) * p);
    this.heat = Math.max(0, Math.min(this.heat, this.fuel > 0 ? 1 : 0));
    if (this.fuel <= 0) this.heat = Math.max(0, this.heat - dt * 0.1);
    if (this.flipT >= 0) { this.flipT += dt / 0.6; if (this.flipT >= 1) this.flipT = -1; }
  }

  /** Flip the coals: shakes off the ash and brings the heat back up (limited by the fuel left). */
  flip(): boolean {
    if (this.flipT >= 0 || this.fuel <= 0) return false;
    this.flipT = 0;
    this.ash = 0;
    this.heat = Math.min(1, Math.max(this.heat, Math.min(1, this.fuel * 1.4)));
    return true;
  }

  fresh(): void { this.heat = 1; this.fuel = 1; this.ash = 0; this.flipT = 0; }

  get needsFlip(): boolean { return this.fuel > 0 && (this.heat < 0.55 || this.ash > 0.7); }
  get burntOut(): boolean { return this.fuel <= 0 && this.heat < 0.05; }
}

export class Hookah {
  readonly coals = new Coals();
  private bubbles: Bubble[] = [];
  private sparks: Spark[] = [];
  private bubbleAcc = 0;
  private sparkAcc = 0;
  private end: Pt | null = null;
  private endV: Pt = { x: 0, y: 0 };
  private dir: Pt = { x: -1, y: 0 };
  private len = 0;
  private draw01 = 0;
  private glowNow = 0;
  private ledHue = 200;

  /** Pixel size of 1 model unit for a canvas W×H (fits portrait phones too). */
  static unit(W: number, H: number) { return Math.min((H * 0.56) / 100, (W * 0.5) / 50); }

  static origin(W: number, H: number): Pt {
    const u = Hookah.unit(W, H);
    return { x: W - 30 * u, y: H - 2 * u };
  }

  static portPosition(W: number, H: number): Pt {
    const u = Hookah.unit(W, H), o = Hookah.origin(W, H);
    return { x: o.x + PORT.x * u, y: o.y + PORT.y * u };
  }

  /** Screen rectangle around the bowl and coals (for "touch the bowl to flip"). */
  static bowlRect(W: number, H: number) {
    const u = Hookah.unit(W, H), o = Hookah.origin(W, H);
    return { x0: o.x + BOWL.x0 * u, x1: o.x + BOWL.x1 * u, y0: o.y + BOWL.y0 * u, y1: o.y + BOWL.y1 * u };
  }

  /** Where the coal light comes from, and how bright/what colour it is. */
  light(W: number, H: number): { x: number; y: number; color: [number, number, number]; intensity: number; led: [number, number, number] | null; ledPos: Pt } {
    const u = Hookah.unit(W, H), o = Hookah.origin(W, H);
    const [r, g, b] = hslToRgb(this.ledHue / 360, 0.85, 0.55);
    return {
      x: o.x, y: o.y - 100 * u,
      color: [1, 0.42 + 0.15 * this.glowNow, 0.12],
      intensity: this.glowNow,
      led: this.ledOn ? [r, g, b] : null,
      ledPos: { x: o.x, y: o.y - 8 * u }
    };
  }
  private ledOn = false;

  draw(ctx: CanvasRenderingContext2D, W: number, H: number, inp: HookahInput): void {
    const u = Hookah.unit(W, H), o = Hookah.origin(W, H);
    this.draw01 += (inp.draw - this.draw01) * Math.min(1, inp.dt * 6);
    this.ledOn = inp.skin.led;
    this.ledHue = (this.ledHue + inp.dt * (20 + 120 * this.draw01)) % 360;
    this.coals.burn(inp.dt, inp.draw > 0.05, inp.power);
    const c = this.coals;
    const flicker = 0.85 + 0.15 * Math.sin(inp.t * 13) * Math.sin(inp.t * 7.3 + 1);
    this.glowNow = Math.min(1.4, c.heat * (0.35 + 0.65 * inp.glow) * flicker * (0.6 + 0.4 * inp.power));
    this.simulate(inp, W, H, u, o);

    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(u, u);
    this.drawShadow(ctx);
    this.drawVase(ctx, inp);
    this.drawStem(ctx, inp.skin.metal);
    this.drawBowl(ctx, inp);
    ctx.restore();

    this.drawHose(ctx, u, inp, W, H);
  }

  // ---------------------------------------------------------------- simulation
  private simulate(inp: HookahInput, W: number, H: number, u: number, o: Pt) {
    const dt = Math.min(0.05, inp.dt);

    this.bubbleAcc += dt * (this.draw01 > 0.05 ? 10 + 50 * this.draw01 : 0.6);
    while (this.bubbleAcc >= 1) {
      this.bubbleAcc -= 1;
      if (this.bubbles.length < 120)
        this.bubbles.push({
          x: (Math.random() - 0.5) * 3, y: DOWNSTEM_BOTTOM - 0.5, vx: (Math.random() - 0.5) * 10,
          r: 0.5 + Math.random() * (0.6 + this.draw01 * 1.2), vy: -(10 + Math.random() * 14), ph: Math.random() * 6.28
        });
    }
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.y += b.vy * dt; b.x += (b.vx + Math.sin(inp.t * 9 + b.ph) * 5) * dt; b.vx *= 1 - dt;
      b.r += dt * 0.3;
      if (b.y < WATER_Y + 1) this.bubbles.splice(i, 1);
    }

    // sparks while pulling hard, and a burst when the coals are flipped
    this.sparkAcc += dt * this.draw01 * 6 * this.coals.heat;
    if (this.coals.flipT >= 0 && this.coals.flipT < 0.1) this.sparkAcc += 3;
    while (this.sparkAcc >= 1) {
      this.sparkAcc -= 1;
      this.sparks.push({ x: (Math.random() - 0.5) * 10, y: -100, vx: (Math.random() - 0.5) * 10, vy: -(8 + Math.random() * 16), life: 0.5 + Math.random() * 0.6, age: 0 });
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 6 * dt;
      if (s.age > s.life) this.sparks.splice(i, 1);
    }

    // hose end: spring towards the pen (or the resting spot on the table)
    const rest = { x: Math.max(8 * u, o.x - 64 * u), y: H - 7 * u };
    const target = inp.pen ? inp.pen.back : rest;
    const tdir = inp.pen ? inp.pen.dir : { x: -1, y: 0.04 };
    const tlen = inp.pen ? inp.pen.length : 14 * u;
    if (!this.end) { this.end = { ...target }; this.len = tlen; }
    const k = inp.pen ? 260 : 40, c = 2 * Math.sqrt(k) * 0.85;
    this.endV.x += ((target.x - this.end.x) * k - this.endV.x * c) * dt;
    this.endV.y += ((target.y - this.end.y) * k - this.endV.y * c) * dt;
    this.end.x += this.endV.x * dt; this.end.y += this.endV.y * dt;
    this.end.x = Math.max(-W * 0.1, Math.min(W * 1.1, this.end.x));
    this.end.y = Math.max(-H * 0.1, Math.min(H * 1.1, this.end.y));
    const a = Math.min(1, dt * (inp.pen ? 14 : 4));
    this.dir.x += (tdir.x - this.dir.x) * a; this.dir.y += (tdir.y - this.dir.y) * a;
    const dl = Math.hypot(this.dir.x, this.dir.y) || 1; this.dir.x /= dl; this.dir.y /= dl;
    this.len += (tlen - this.len) * a;
  }

  // ------------------------------------------------------------------ drawing
  private drawShadow(ctx: CanvasRenderingContext2D) {
    const g = ctx.createRadialGradient(0, 1, 0, 0, 1, 30);
    g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 1, 30, 4, 0, 0, Math.PI * 2); ctx.fill();
  }

  private drawVase(ctx: CanvasRenderingContext2D, inp: HookahInput) {
    const skin = inp.skin, t = inp.t;
    vasePath(ctx);
    const glass = ctx.createLinearGradient(-22, 0, 22, 0);
    glass.addColorStop(0, skin.glassEdge);
    glass.addColorStop(0.35, skin.glassMid);
    glass.addColorStop(0.65, skin.glassMid);
    glass.addColorStop(1, skin.glassEdge);
    ctx.fillStyle = glass; ctx.fill();

    ctx.save();
    vasePath(ctx); ctx.clip();

    // downstem, seen through the glass
    ctx.fillStyle = 'rgba(190,190,200,0.55)';
    ctx.fillRect(-1.3, -37, 2.6, 37 + DOWNSTEM_BOTTOM);

    // water (flavour-tinted) with an agitated surface
    const amp = 0.35 + this.draw01 * 1.1;
    ctx.beginPath();
    ctx.moveTo(-24, 2);
    for (let x = -24; x <= 24; x += 2)
      ctx.lineTo(x, WATER_Y + Math.sin(x * 0.45 + t * (2 + this.draw01 * 9)) * amp + Math.sin(x * 1.3 - t * 5) * amp * 0.4);
    ctx.lineTo(24, 2); ctx.closePath();
    const water = ctx.createLinearGradient(0, WATER_Y, 0, 0);
    water.addColorStop(0, hexA(inp.water, 0.5));
    water.addColorStop(1, hexA(inp.water, 0.85));
    ctx.fillStyle = water; ctx.fill();
    ctx.strokeStyle = 'rgba(230,250,255,0.55)'; ctx.lineWidth = 0.5; ctx.stroke();

    // LED base light, colour cycling, brighter while pulling
    if (skin.led) {
      const l = this.light(1, 1).led!;
      const col = `rgba(${l.map(v => (v * 255) | 0).join(',')},`;
      const g = ctx.createRadialGradient(0, -2, 0, 0, -2, 26);
      g.addColorStop(0, col + (0.75 + 0.25 * this.draw01) + ')');
      g.addColorStop(1, col + '0)');
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g; ctx.fillRect(-24, -40, 48, 42);
      ctx.restore();
    }

    // bubbles
    ctx.lineWidth = 0.35;
    for (const b of this.bubbles) {
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220,250,255,0.18)'; ctx.fill();
      ctx.strokeStyle = 'rgba(235,252,255,0.75)'; ctx.stroke();
    }
    // smoke collecting above the water while pulling
    if (this.draw01 > 0.02) {
      const g = ctx.createLinearGradient(0, -34, 0, WATER_Y);
      g.addColorStop(0, `rgba(235,235,240,${0.28 * this.draw01})`); g.addColorStop(1, 'rgba(235,235,240,0)');
      ctx.fillStyle = g; ctx.fillRect(-24, -37, 48, 37 + WATER_Y);
    }
    // cut-crystal facets
    if (skin.facets) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.35;
      for (let x = -24; x <= 24; x += 4) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 8, -36); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 8, -36); ctx.stroke();
      }
    }
    ctx.restore();

    // glass rim + highlights
    vasePath(ctx);
    ctx.strokeStyle = skin.facets ? 'rgba(255,255,255,0.6)' : 'rgba(200,240,255,0.45)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-15, -24); ctx.bezierCurveTo(-18.5, -18, -18.5, -9, -15, -4); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(14, -22); ctx.bezierCurveTo(16.5, -17, 16.5, -10, 14.5, -6); ctx.stroke();

    // rubber grommet at the neck
    ctx.fillStyle = '#1b1b1f';
    ctx.beginPath(); ctx.roundRect(-5.5, -40, 11, 3.4, 1); ctx.fill();
  }

  private drawStem(ctx: CanvasRenderingContext2D, metal: VaseSkin['metal']) {
    const m = METALS[metal];
    const pg = ctx.createLinearGradient(0, PORT.y - 1.8, 0, PORT.y + 1.8);
    pg.addColorStop(0, m[2]); pg.addColorStop(0.5, m[3]); pg.addColorStop(1, m[4]);
    ctx.fillStyle = pg;
    ctx.fillRect(PORT.x, PORT.y - 1.6, -PORT.x, 3.2);
    ctx.fillStyle = metalGrad(ctx, PORT.x - 1, PORT.x + 2, metal);
    ctx.beginPath(); ctx.roundRect(PORT.x - 1, PORT.y - 2.6, 3, 5.2, 0.8); ctx.fill();

    ctx.fillStyle = metalGrad(ctx, -2.4, 2.4, metal);
    ctx.fillRect(-2.2, -87, 4.4, 48);
    const deco = (y: number, rx: number, ry: number) => {
      ctx.fillStyle = metalGrad(ctx, -rx, rx, metal);
      ctx.beginPath(); ctx.ellipse(0, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    };
    deco(-42, 6.5, 2.2);
    deco(-50, 4.2, 4.5);
    deco(-66, 3.6, 2.6);
    deco(-75, 5, 6.5);
    deco(-83, 4, 1.6);
    // tray
    ctx.fillStyle = metalGrad(ctx, -16, 16, metal === 'black' ? 'black' : 'steel');
    ctx.beginPath(); ctx.ellipse(0, -87, 16, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.ellipse(0, -87.6, 15, 2.4, 0, Math.PI, Math.PI * 2); ctx.stroke();
  }

  private drawBowl(ctx: CanvasRenderingContext2D, _inp: HookahInput) {
    const g = ctx.createLinearGradient(-8, 0, 8, 0);
    g.addColorStop(0, '#5e2a16'); g.addColorStop(0.45, '#b9643a'); g.addColorStop(1, '#4a2010');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-3.5, -88); ctx.lineTo(-8.5, -97); ctx.lineTo(8.5, -97); ctx.lineTo(3.5, -88); ctx.closePath(); ctx.fill();
    ctx.fillStyle = metalGrad(ctx, -9, 9, 'steel');
    ctx.beginPath(); ctx.ellipse(0, -97.2, 9.2, 1.9, 0, 0, Math.PI * 2); ctx.fill();

    // coals: glowing, ash-coated, and flipping when asked
    const c = this.coals;
    const heat = Math.min(1, this.glowNow);
    const size = 0.75 + 0.25 * c.fuel;                       // they shrink as they burn
    const flip = c.flipT >= 0 ? c.flipT : -1;
    const coals: [number, number][] = [[-5.2, -99.6], [0, -100.3], [5.2, -99.6]];
    coals.forEach(([x, y], i) => {
      const ph = flip >= 0 ? Math.min(1, Math.max(0, flip * 1.4 - i * 0.2)) : -1;
      const hop = ph >= 0 ? Math.sin(ph * Math.PI) * 4 : 0;
      const sy = ph >= 0 ? Math.abs(Math.cos(ph * Math.PI)) * 0.8 + 0.2 : 1;
      const w = 4.8 * size, h = 3.4 * size * sy;
      const cy = y - hop;
      ctx.fillStyle = '#2a2420';
      ctx.beginPath(); ctx.roundRect(x - w / 2, cy - h / 2, w, h, 0.9); ctx.fill();
      const cg = ctx.createRadialGradient(x, cy, 0, x, cy, 3);
      cg.addColorStop(0, `rgba(255,${180 + 60 * heat | 0},90,${0.2 + 0.8 * heat})`);
      cg.addColorStop(0.6, `rgba(255,90,20,${0.1 + 0.65 * heat})`);
      cg.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.roundRect(x - w / 2, cy - h / 2, w, h, 0.9); ctx.fill();
      if (c.ash > 0.05) {                                    // grey ash on top
        ctx.fillStyle = `rgba(180,175,170,${0.75 * c.ash})`;
        ctx.beginPath(); ctx.roundRect(x - w / 2, cy - h / 2, w, h * 0.45, 0.9); ctx.fill();
      }
    });

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(0, -99, 0, 0, -99, 16 + 10 * heat);
    halo.addColorStop(0, `rgba(255,120,40,${0.08 + 0.5 * heat})`);
    halo.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, -99, 26, 0, Math.PI * 2); ctx.fill();
    for (const s of this.sparks) {
      ctx.fillStyle = `rgba(255,${170 + Math.random() * 60 | 0},80,${1 - s.age / s.life})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, 0.45, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  private drawHose(ctx: CanvasRenderingContext2D, u: number, inp: HookahInput, W: number, H: number) {
    if (!this.end) return;
    const hc = inp.hose, t = inp.t;
    const P0 = Hookah.portPosition(W, H);
    const P3 = this.end, dir = this.dir;
    const d = Math.hypot(P3.x - P0.x, P3.y - P0.y);
    const sag = 0.28 * d + 6 * u;
    const C1 = { x: P0.x - (10 * u + 0.25 * d), y: P0.y + 0.12 * d };
    const C2 = { x: P3.x - dir.x * (0.22 * d + 6 * u), y: P3.y - dir.y * (0.22 * d + 6 * u) + sag };
    const w = 3.2 * u;
    const path = () => { ctx.beginPath(); ctx.moveTo(P0.x, P0.y); ctx.bezierCurveTo(C1.x, C1.y, C2.x, C2.y, P3.x, P3.y); };

    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.translate(w * 0.25, w * 0.5);
    path(); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = w * 1.25; ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    path(); ctx.strokeStyle = hc.dark; ctx.lineWidth = w * 1.15; ctx.stroke();
    path(); ctx.strokeStyle = hc.base; ctx.lineWidth = w; ctx.stroke();
    ctx.setLineDash([w * 0.35, w * 0.45]);
    path(); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = w * 0.85; ctx.stroke();
    if (this.draw01 > 0.02) {
      ctx.setLineDash([w * 1.2, w * 3]);
      ctx.lineDashOffset = -t * 40 * u;
      path(); ctx.strokeStyle = `rgba(210,240,230,${0.22 * this.draw01})`; ctx.lineWidth = w * 0.55; ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.translate(-w * 0.12, -w * 0.22);
    path(); ctx.strokeStyle = hc.highlight; ctx.lineWidth = w * 0.22; ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.fillStyle = METALS[inp.skin.metal][3];
    ctx.beginPath(); ctx.arc(P0.x, P0.y, w * 0.7, 0, Math.PI * 2); ctx.fill();

    // mouthpiece: a metal tube from the hose end towards the mouth
    const L = this.len;
    const tip = { x: P3.x + dir.x * L, y: P3.y + dir.y * L };
    const nx = -dir.y, ny = dir.x;
    const m = METALS[inp.skin.metal];
    const g = ctx.createLinearGradient(P3.x + nx * w, P3.y + ny * w, P3.x - nx * w, P3.y - ny * w);
    g.addColorStop(0, m[4]); g.addColorStop(0.45, m[2]); g.addColorStop(1, m[0]);
    ctx.strokeStyle = g; ctx.lineCap = 'round';
    ctx.lineWidth = w * 1.1;
    ctx.beginPath(); ctx.moveTo(P3.x, P3.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    ctx.lineWidth = w * 1.6; ctx.lineCap = 'butt';
    const r0 = 0.08 * L;
    ctx.beginPath(); ctx.moveTo(P3.x + dir.x * r0, P3.y + dir.y * r0); ctx.lineTo(P3.x + dir.x * (r0 + w * 0.6), P3.y + dir.y * (r0 + w * 0.6)); ctx.stroke();
    ctx.restore();
  }
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
