/**
 * The virtual hookah, drawn on the 2D overlay canvas above the smoke:
 * a glass vase with water (bubbling while inhaling), a brass stem, a clay bowl
 * with glowing coals, and a hose (cubic Bézier with sag) that follows the pen.
 */
import type { Pt } from './signals';

export interface HookahInput {
  t: number;              // seconds
  dt: number;
  draw: number;           // 0…1: how hard smoke is being pulled through (bubbles, hose flow)
  glow: number;           // 0…1: extra coal brightness
  pen: { back: Pt; dir: Pt; length: number } | null;  // mouthpiece back end, pointing to the mouth
}

interface Bubble { x: number; y: number; r: number; vx: number; vy: number; ph: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number }

// Hookah model units: ~100 tall, y up is negative, origin at the bottom centre of the vase.
const PORT = { x: -13, y: -58 };
const WATER_Y = -16;
const DOWNSTEM_BOTTOM = -5;

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

function metal(ctx: CanvasRenderingContext2D, x0: number, x1: number, hue: 'brass' | 'steel' = 'brass') {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  const stops = hue === 'brass'
    ? ['#5a4520', '#b8964a', '#f4e1a0', '#a88738', '#4a3818']
    : ['#3d4048', '#9aa0aa', '#eef1f5', '#8a909a', '#2f3238'];
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

export class Hookah {
  private bubbles: Bubble[] = [];
  private sparks: Spark[] = [];
  private bubbleAcc = 0;
  private sparkAcc = 0;
  private end: Pt | null = null;
  private endV: Pt = { x: 0, y: 0 };
  private dir: Pt = { x: -1, y: 0 };
  private len = 0;
  private draw01 = 0;

  /** Pixel size of 1 model unit for a canvas of height H. */
  static unit(H: number) { return (H * 0.56) / 100; }

  /** Screen position of the hose port, for a canvas W×H. */
  static portPosition(W: number, H: number): Pt {
    const u = Hookah.unit(H), o = Hookah.origin(W, H);
    return { x: o.x + PORT.x * u, y: o.y + PORT.y * u };
  }

  static origin(W: number, H: number): Pt {
    const u = Hookah.unit(H);
    return { x: W - 30 * u, y: H - 2 * u };
  }

  draw(ctx: CanvasRenderingContext2D, W: number, H: number, inp: HookahInput): void {
    const u = Hookah.unit(H), o = Hookah.origin(W, H);
    this.draw01 += (inp.draw - this.draw01) * Math.min(1, inp.dt * 6);
    this.simulate(inp, W, H, u, o);

    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(u, u);
    this.drawShadow(ctx);
    this.drawVase(ctx, inp.t);
    this.drawStem(ctx);
    this.drawBowl(ctx, inp);
    ctx.restore();

    this.drawHose(ctx, u, inp.t, W, H);
  }

  // ---------------------------------------------------------------- simulation
  private simulate(inp: HookahInput, W: number, H: number, u: number, o: Pt) {
    const dt = Math.min(0.05, inp.dt);

    // bubbles rise from the bottom of the downstem
    this.bubbleAcc += dt * (this.draw01 > 0.05 ? 10 + 50 * this.draw01 : 0.6);
    while (this.bubbleAcc >= 1) {
      this.bubbleAcc -= 1;
      if (this.bubbles.length < 120)
        this.bubbles.push({
          x: (Math.random() - 0.5) * 3, y: DOWNSTEM_BOTTOM - 0.5, vx: (Math.random() - 0.5) * 10, r: 0.5 + Math.random() * (0.6 + this.draw01 * 1.2),
          vy: -(10 + Math.random() * 14), ph: Math.random() * 6.28
        });
    }
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.y += b.vy * dt; b.x += (b.vx + Math.sin(inp.t * 9 + b.ph) * 5) * dt; b.vx *= 1 - dt;
      b.r += dt * 0.3;
      if (b.y < WATER_Y + 1) this.bubbles.splice(i, 1);
    }

    // sparks from the coals while pulling hard
    this.sparkAcc += dt * this.draw01 * 6;
    while (this.sparkAcc >= 1) {
      this.sparkAcc -= 1;
      this.sparks.push({ x: (Math.random() - 0.5) * 10, y: -100, vx: (Math.random() - 0.5) * 8, vy: -(8 + Math.random() * 14), life: 0.5 + Math.random() * 0.6, age: 0 });
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 6 * dt;
      if (s.age > s.life) this.sparks.splice(i, 1);
    }

    // hose end: spring towards the pen (or the resting spot on the table)
    const rest = { x: o.x - 64 * u, y: H - 7 * u };
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

  private drawVase(ctx: CanvasRenderingContext2D, t: number) {
    // back of the glass
    vasePath(ctx);
    const glass = ctx.createLinearGradient(-22, 0, 22, 0);
    glass.addColorStop(0, 'rgba(40,110,140,0.55)');
    glass.addColorStop(0.35, 'rgba(120,200,225,0.16)');
    glass.addColorStop(0.65, 'rgba(120,200,225,0.12)');
    glass.addColorStop(1, 'rgba(30,90,120,0.6)');
    ctx.fillStyle = glass; ctx.fill();

    ctx.save();
    vasePath(ctx); ctx.clip();

    // downstem, seen through the glass
    ctx.fillStyle = 'rgba(190,190,200,0.55)';
    ctx.fillRect(-1.3, -37, 2.6, 37 + DOWNSTEM_BOTTOM);

    // water with an agitated surface
    const amp = 0.35 + this.draw01 * 1.1;
    ctx.beginPath();
    ctx.moveTo(-24, 2);
    for (let x = -24; x <= 24; x += 2)
      ctx.lineTo(x, WATER_Y + Math.sin(x * 0.45 + t * (2 + this.draw01 * 9)) * amp + Math.sin(x * 1.3 - t * 5) * amp * 0.4);
    ctx.lineTo(24, 2); ctx.closePath();
    const water = ctx.createLinearGradient(0, WATER_Y, 0, 0);
    water.addColorStop(0, 'rgba(90,190,210,0.55)');
    water.addColorStop(1, 'rgba(20,80,120,0.8)');
    ctx.fillStyle = water; ctx.fill();
    ctx.strokeStyle = 'rgba(210,250,255,0.55)'; ctx.lineWidth = 0.5; ctx.stroke();

    // bubbles
    ctx.lineWidth = 0.35;
    for (const b of this.bubbles) {
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220,250,255,0.18)'; ctx.fill();
      ctx.strokeStyle = 'rgba(235,252,255,0.75)'; ctx.stroke();
    }
    // a hint of trapped smoke above the water while pulling
    if (this.draw01 > 0.02) {
      const g = ctx.createLinearGradient(0, -34, 0, WATER_Y);
      g.addColorStop(0, `rgba(235,235,240,${0.28 * this.draw01})`); g.addColorStop(1, 'rgba(235,235,240,0)');
      ctx.fillStyle = g; ctx.fillRect(-24, -37, 48, 37 + WATER_Y);
    }
    ctx.restore();

    // glass rim + highlights
    vasePath(ctx);
    ctx.strokeStyle = 'rgba(200,240,255,0.45)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-15, -24); ctx.bezierCurveTo(-18.5, -18, -18.5, -9, -15, -4); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(14, -22); ctx.bezierCurveTo(16.5, -17, 16.5, -10, 14.5, -6); ctx.stroke();

    // rubber grommet at the neck
    ctx.fillStyle = '#1b1b1f';
    ctx.beginPath(); ctx.roundRect(-5.5, -40, 11, 3.4, 1); ctx.fill();
  }

  private drawStem(ctx: CanvasRenderingContext2D) {
    // hose port pipe (behind the stem decorations)
    const pg = ctx.createLinearGradient(0, PORT.y - 1.8, 0, PORT.y + 1.8);
    pg.addColorStop(0, '#f4e1a0'); pg.addColorStop(0.5, '#a88738'); pg.addColorStop(1, '#4a3818');
    ctx.fillStyle = pg;
    ctx.fillRect(PORT.x, PORT.y - 1.6, -PORT.x, 3.2);
    ctx.fillStyle = metal(ctx, PORT.x - 1, PORT.x + 2);
    ctx.beginPath(); ctx.roundRect(PORT.x - 1, PORT.y - 2.6, 3, 5.2, 0.8); ctx.fill();

    // main shaft
    ctx.fillStyle = metal(ctx, -2.4, 2.4);
    ctx.fillRect(-2.2, -87, 4.4, 48);
    // decorations
    const deco = (y: number, rx: number, ry: number) => {
      ctx.fillStyle = metal(ctx, -rx, rx);
      ctx.beginPath(); ctx.ellipse(0, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    };
    deco(-42, 6.5, 2.2);
    deco(-50, 4.2, 4.5);
    deco(-66, 3.6, 2.6);
    deco(-75, 5, 6.5);
    deco(-83, 4, 1.6);
    // tray
    ctx.fillStyle = metal(ctx, -16, 16, 'steel');
    ctx.beginPath(); ctx.ellipse(0, -87, 16, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.ellipse(0, -87.6, 15, 2.4, 0, Math.PI, Math.PI * 2); ctx.stroke();
  }

  private drawBowl(ctx: CanvasRenderingContext2D, inp: HookahInput) {
    // clay bowl
    const g = ctx.createLinearGradient(-8, 0, 8, 0);
    g.addColorStop(0, '#5e2a16'); g.addColorStop(0.45, '#b9643a'); g.addColorStop(1, '#4a2010');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-3.5, -88); ctx.lineTo(-8.5, -97); ctx.lineTo(8.5, -97); ctx.lineTo(3.5, -88); ctx.closePath(); ctx.fill();
    // heat-management foil
    ctx.fillStyle = metal(ctx, -9, 9, 'steel');
    ctx.beginPath(); ctx.ellipse(0, -97.2, 9.2, 1.9, 0, 0, Math.PI * 2); ctx.fill();

    // coals
    const flicker = 0.85 + 0.15 * Math.sin(inp.t * 13) * Math.sin(inp.t * 7.3 + 1);
    const heat = Math.min(1, (0.35 + 0.65 * inp.glow) * flicker);
    const coals: [number, number][] = [[-5.2, -99.6], [0, -100.3], [5.2, -99.6]];
    for (const [x, y] of coals) {
      ctx.fillStyle = '#2a2420';
      ctx.beginPath(); ctx.roundRect(x - 2.4, y - 1.7, 4.8, 3.4, 0.9); ctx.fill();
      const cg = ctx.createRadialGradient(x, y, 0, x, y, 3);
      cg.addColorStop(0, `rgba(255,${180 + 60 * heat | 0},90,${0.25 + 0.75 * heat})`);
      cg.addColorStop(0.6, `rgba(255,90,20,${0.15 + 0.6 * heat})`);
      cg.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.roundRect(x - 2.4, y - 1.7, 4.8, 3.4, 0.9); ctx.fill();
    }
    // glow halo + sparks (additive)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(0, -99, 0, 0, -99, 16 + 10 * heat);
    halo.addColorStop(0, `rgba(255,120,40,${0.18 + 0.45 * heat})`);
    halo.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, -99, 26, 0, Math.PI * 2); ctx.fill();
    for (const s of this.sparks) {
      ctx.fillStyle = `rgba(255,${170 + Math.random() * 60 | 0},80,${1 - s.age / s.life})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, 0.45, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  private drawHose(ctx: CanvasRenderingContext2D, u: number, t: number, W: number, H: number) {
    if (!this.end) return;
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
    // drop shadow
    ctx.translate(w * 0.25, w * 0.5);
    path(); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = w * 1.25; ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // body
    path(); ctx.strokeStyle = '#0f241c'; ctx.lineWidth = w * 1.15; ctx.stroke();
    path(); ctx.strokeStyle = '#1f4a39'; ctx.lineWidth = w; ctx.stroke();
    // woven wrap texture
    ctx.setLineDash([w * 0.35, w * 0.45]);
    path(); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = w * 0.85; ctx.stroke();
    // smoke flowing through the hose while pulling
    if (this.draw01 > 0.02) {
      ctx.setLineDash([w * 1.2, w * 3]);
      ctx.lineDashOffset = -t * 40 * u;
      path(); ctx.strokeStyle = `rgba(210,240,230,${0.22 * this.draw01})`; ctx.lineWidth = w * 0.55; ctx.stroke();
    }
    ctx.setLineDash([]);
    // highlight
    ctx.translate(-w * 0.12, -w * 0.22);
    path(); ctx.strokeStyle = 'rgba(190,255,225,0.22)'; ctx.lineWidth = w * 0.22; ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // hose cuff at the port
    ctx.fillStyle = '#c9a85a';
    ctx.beginPath(); ctx.arc(P0.x, P0.y, w * 0.7, 0, Math.PI * 2); ctx.fill();

    // mouthpiece: a metal tube from the hose end towards the mouth
    const L = this.len;
    const tip = { x: P3.x + dir.x * L, y: P3.y + dir.y * L };
    const nx = -dir.y, ny = dir.x;
    const g = ctx.createLinearGradient(P3.x + nx * w, P3.y + ny * w, P3.x - nx * w, P3.y - ny * w);
    g.addColorStop(0, '#4a3818'); g.addColorStop(0.45, '#f4e1a0'); g.addColorStop(1, '#5a4520');
    ctx.strokeStyle = g; ctx.lineCap = 'round';
    ctx.lineWidth = w * 1.1;
    ctx.beginPath(); ctx.moveTo(P3.x, P3.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    ctx.lineWidth = w * 1.6; ctx.lineCap = 'butt';
    const r0 = 0.08 * L;
    ctx.beginPath(); ctx.moveTo(P3.x + dir.x * r0, P3.y + dir.y * r0); ctx.lineTo(P3.x + dir.x * (r0 + w * 0.6), P3.y + dir.y * (r0 + w * 0.6)); ctx.stroke();
    ctx.restore();
  }
}
