/**
 * Light from the hookah spilling onto the scene and your face. Drawn on its own
 * canvas that the page composites with `mix-blend-mode: screen`, so it only
 * ever brightens what is underneath (video or backdrop), below the smoke.
 */
import type { Pt } from './signals';

export interface LightInput {
  coal: { x: number; y: number; intensity: number };
  led: [number, number, number] | null;
  ledPos: Pt;
  face: Pt | null;       // mouth / face centre
  faceW: number;
  strength: number;      // user slider
  faceLight: boolean;
}

export function drawLighting(ctx: CanvasRenderingContext2D, W: number, H: number, l: LightInput): void {
  ctx.clearRect(0, 0, W, H);
  if (l.strength <= 0) return;
  const k = l.strength;

  // warm ambient spill from the coals
  const ci = Math.min(1.2, l.coal.intensity) * k;
  if (ci > 0.01) {
    const r = Math.max(W, H) * 0.7;
    const g = ctx.createRadialGradient(l.coal.x, l.coal.y, 0, l.coal.x, l.coal.y, r);
    g.addColorStop(0, `rgba(255,120,45,${0.3 * ci})`);
    g.addColorStop(0.4, `rgba(255,90,30,${0.1 * ci})`);
    g.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // LED base glow
  if (l.led) {
    const [r, gg, b] = l.led.map(v => (v * 255) | 0);
    const rad = Math.min(W, H) * 0.55;
    const g = ctx.createRadialGradient(l.ledPos.x, l.ledPos.y, 0, l.ledPos.x, l.ledPos.y, rad);
    g.addColorStop(0, `rgba(${r},${gg},${b},${0.35 * k})`);
    g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // your face, lit from the hookah's side (brighter when you pull and the coals flare)
  if (l.faceLight && l.face && ci > 0.01) {
    const dx = l.coal.x - l.face.x, dy = l.coal.y - l.face.y;
    const dl = Math.hypot(dx, dy) || 1;
    const fx = l.face.x + (dx / dl) * l.faceW * 0.35, fy = l.face.y - l.faceW * 0.25 + (dy / dl) * l.faceW * 0.2;
    const r = l.faceW * 1.1;
    const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, r);
    g.addColorStop(0, `rgba(255,140,70,${0.32 * ci})`);
    g.addColorStop(1, 'rgba(255,120,50,0)');
    ctx.fillStyle = g; ctx.fillRect(fx - r, fy - r, r * 2, r * 2);
  }
}
