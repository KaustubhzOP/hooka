/**
 * Background swap: MediaPipe selfie segmentation cuts you out of the camera
 * frame and puts you in front of a blurred room, a hookah lounge or a neon bar.
 * The backdrops are drawn procedurally — no image files.
 */
import { ImageSegmenter } from '@mediapipe/tasks-vision';
import type { BackgroundMode } from './settings';
import { SEGMENT_MODEL, assertAsset, type Tracker } from './tracking';

export class Backdrop {
  private segmenter: ImageSegmenter | null = null;
  private loading: Promise<void> | null = null;
  private maskCanvas = document.createElement('canvas');
  private maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: false })!;
  private maskData: ImageData | null = null;
  private person = document.createElement('canvas');
  private personCtx = this.person.getContext('2d')!;
  private scene = document.createElement('canvas');
  private sceneKey = '';
  private frame = 0;
  private hasMask = false;
  error: string | null = null;

  constructor(private canvas: HTMLCanvasElement, private tracker: Tracker) {}

  /** Load the segmenter the first time a background is chosen. */
  ensure(): Promise<void> {
    this.loading ??= (async () => {
      try {
        await assertAsset(SEGMENT_MODEL, 'selfie_segmenter.tflite');
        await this.tracker.loadModels();
        const make = (delegate: 'GPU' | 'CPU') => ImageSegmenter.createFromOptions(this.tracker.fileset!, {
          baseOptions: { modelAssetPath: SEGMENT_MODEL, delegate },
          runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false
        });
        try { this.segmenter = await make('GPU'); } catch { this.segmenter = await make('CPU'); }
      } catch (e) {
        this.error = (e as Error).message;
        this.loading = null;
        throw e;
      }
    })();
    return this.loading;
  }

  get ready() { return !!this.segmenter; }

  /** Update the person mask (every other frame to save time) and draw the composite. */
  render(mode: BackgroundMode, video: HTMLVideoElement, W: number, H: number, t: number, segment: boolean): void {
    const ctx = this.canvas.getContext('2d')!;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    if (mode === 'none' || !this.segmenter || video.readyState < 2) return;

    if (segment && (this.frame++ & 1) === 0) this.segment(video);

    // 1. backdrop
    ctx.save();
    if (mode === 'blur') {
      ctx.filter = 'blur(16px) brightness(0.8)';
      ctx.translate(W, 0); ctx.scale(-1, 1);
      ctx.drawImage(video, -20, -20, W + 40, H + 40);
    } else {
      this.ensureScene(mode, W, H);
      ctx.drawImage(this.scene, 0, 0);
      this.animate(ctx, mode, W, H, t);
    }
    ctx.restore();

    // 2. you, cut out with the (slightly softened) mask
    if (!this.hasMask) return;
    const p = this.personCtx;
    if (this.person.width !== W || this.person.height !== H) { this.person.width = W; this.person.height = H; }
    p.globalCompositeOperation = 'source-over';
    p.clearRect(0, 0, W, H);
    p.save(); p.translate(W, 0); p.scale(-1, 1);
    p.drawImage(video, 0, 0, W, H);
    p.globalCompositeOperation = 'destination-in';
    p.filter = 'blur(2px)';
    p.imageSmoothingEnabled = true;
    p.drawImage(this.maskCanvas, 0, 0, W, H);
    p.restore();
    ctx.drawImage(this.person, 0, 0);
  }

  private segment(video: HTMLVideoElement) {
    try {
      const res = this.segmenter!.segmentForVideo(video, this.tracker.timestamp + 0.5);
      const m = res.confidenceMasks?.[0];
      if (m) {
        const w = m.width, h = m.height, conf = m.getAsFloat32Array();
        if (this.maskCanvas.width !== w || this.maskCanvas.height !== h || !this.maskData) {
          this.maskCanvas.width = w; this.maskCanvas.height = h;
          this.maskData = this.maskCtx.createImageData(w, h);
        }
        const d = this.maskData.data;
        for (let i = 0; i < conf.length; i++) {
          // sharpen the edge a little: 0.35…0.65 → 0…1
          const a = Math.min(1, Math.max(0, (conf[i] - 0.35) / 0.3));
          d[i * 4 + 3] = a * 255;
        }
        this.maskCtx.putImageData(this.maskData, 0, 0);
        this.hasMask = true;
      }
      res.close();
    } catch (e) {
      console.warn('segmentation failed', e);
    }
  }

  // ---------------------------------------------------------------- backdrops
  private ensureScene(mode: BackgroundMode, W: number, H: number) {
    const key = `${mode}:${W}x${H}`;
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    this.scene.width = W; this.scene.height = H;
    const g = this.scene.getContext('2d')!;
    if (mode === 'lounge') drawLounge(g, W, H);
    else drawNeonBar(g, W, H);
  }

  /** Cheap animated bits on top of the static backdrop. */
  private animate(ctx: CanvasRenderingContext2D, mode: BackgroundMode, W: number, H: number, t: number) {
    const u = Math.min(W, H) / 100;
    ctx.globalCompositeOperation = 'lighter';
    if (mode === 'lounge') {
      // drifting bokeh of the lanterns
      for (let i = 0; i < 14; i++) {
        const x = ((i * 137.5) % 100) / 100 * W + Math.sin(t * 0.2 + i) * 3 * u;
        const y = (0.12 + ((i * 61.8) % 40) / 100) * H + Math.cos(t * 0.17 + i * 2) * 2 * u;
        const r = (2 + (i % 4)) * u;
        const a = 0.05 + 0.04 * Math.sin(t * 0.8 + i);
        const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, `rgba(255,190,110,${a})`); gr.addColorStop(1, 'rgba(255,170,90,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      // neon flicker: re-light the sign with a slightly varying glow
      const flick = Math.random() < 0.02 ? 0.2 : 0.85 + 0.15 * Math.sin(t * 9);
      neonText(ctx, 'HOOKAH', W * 0.5, H * 0.2, 13 * u, '#ff3ccd', 0.35 * flick);
      neonText(ctx, 'lounge', W * 0.5, H * 0.32, 7 * u, '#22d3ee', 0.3 * (0.9 + 0.1 * Math.sin(t * 5 + 1)));
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawLounge(g: CanvasRenderingContext2D, W: number, H: number) {
  const u = Math.min(W, H) / 100;
  // warm wall
  const wall = g.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, '#2b140c'); wall.addColorStop(0.65, '#3a1d10'); wall.addColorStop(1, '#170905');
  g.fillStyle = wall; g.fillRect(0, 0, W, H);
  // moroccan arches
  g.strokeStyle = 'rgba(255,200,140,0.08)'; g.lineWidth = 1.2 * u;
  for (let x = W * 0.08; x < W; x += W * 0.22) {
    g.beginPath();
    g.moveTo(x - 7 * u, H * 0.62); g.lineTo(x - 7 * u, H * 0.3);
    g.quadraticCurveTo(x - 7 * u, H * 0.18, x, H * 0.14);
    g.quadraticCurveTo(x + 7 * u, H * 0.18, x + 7 * u, H * 0.3);
    g.lineTo(x + 7 * u, H * 0.62); g.stroke();
  }
  // hanging lanterns with warm light
  for (const fx of [0.18, 0.5, 0.82]) {
    const x = W * fx, y = H * 0.16;
    const glow = g.createRadialGradient(x, y, 0, x, y, 30 * u);
    glow.addColorStop(0, 'rgba(255,170,80,0.45)'); glow.addColorStop(1, 'rgba(255,140,60,0)');
    g.fillStyle = glow; g.fillRect(x - 30 * u, y - 30 * u, 60 * u, 60 * u);
    g.strokeStyle = 'rgba(40,20,10,0.9)'; g.lineWidth = 0.4 * u;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, y - 5 * u); g.stroke();
    g.fillStyle = '#e8a050';
    g.beginPath(); g.moveTo(x, y - 5 * u); g.lineTo(x + 3 * u, y); g.lineTo(x, y + 5 * u); g.lineTo(x - 3 * u, y); g.closePath(); g.fill();
  }
  // couch
  g.fillStyle = '#4a1416';
  g.beginPath(); g.roundRect(-5 * u, H * 0.66, W + 10 * u, H * 0.2, 4 * u); g.fill();
  g.fillStyle = '#5e1c1e';
  for (let x = 0; x < W; x += 18 * u) { g.beginPath(); g.roundRect(x + u, H * 0.6, 16 * u, H * 0.12, 3 * u); g.fill(); }
  // floor rug
  const floor = g.createLinearGradient(0, H * 0.84, 0, H);
  floor.addColorStop(0, '#2a1208'); floor.addColorStop(1, '#100604');
  g.fillStyle = floor; g.fillRect(0, H * 0.84, W, H * 0.16);
  // vignette
  const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
}

function drawNeonBar(g: CanvasRenderingContext2D, W: number, H: number) {
  const u = Math.min(W, H) / 100;
  g.fillStyle = '#120d16'; g.fillRect(0, 0, W, H);
  // brick wall
  const bw = 9 * u, bh = 4 * u;
  for (let row = 0, y = 0; y < H * 0.75; row++, y += bh) {
    for (let x = (row % 2) * -bw / 2; x < W; x += bw) {
      const shade = 20 + ((x * 7 + y * 13) % 11);
      g.fillStyle = `rgb(${shade + 14},${shade},${shade + 8})`;
      g.fillRect(x + 0.3 * u, y + 0.3 * u, bw - 0.6 * u, bh - 0.6 * u);
    }
  }
  // back-lit shelf with bottles
  const sy = H * 0.52;
  const glow = g.createLinearGradient(0, sy - 12 * u, 0, sy);
  glow.addColorStop(0, 'rgba(120,60,255,0)'); glow.addColorStop(1, 'rgba(120,60,255,0.35)');
  g.fillStyle = glow; g.fillRect(0, sy - 12 * u, W, 12 * u);
  g.fillStyle = '#05040a';
  for (let x = 2 * u; x < W; x += 6 * u) {
    const h = (5 + ((x / u) * 3.7) % 5) * u;
    g.beginPath(); g.roundRect(x, sy - h, 3 * u, h, [1.2 * u, 1.2 * u, 0, 0]); g.fill();
    g.fillRect(x + 1 * u, sy - h - 2 * u, u, 2 * u);
  }
  g.fillStyle = '#2a1c33'; g.fillRect(0, sy, W, 1.2 * u);
  // bar counter
  const bar = g.createLinearGradient(0, H * 0.75, 0, H);
  bar.addColorStop(0, '#1d1220'); bar.addColorStop(1, '#09060b');
  g.fillStyle = bar; g.fillRect(0, H * 0.75, W, H * 0.25);
  g.fillStyle = 'rgba(34,211,238,0.5)'; g.fillRect(0, H * 0.75, W, 0.4 * u);
  // static sign (the animated glow is added on top every frame)
  neonText(g, 'HOOKAH', W * 0.5, H * 0.2, 13 * u, '#ff3ccd', 1);
  neonText(g, 'lounge', W * 0.5, H * 0.32, 7 * u, '#22d3ee', 1);
  // neon ring
  g.save(); g.shadowColor = '#fbbf24'; g.shadowBlur = 3 * u; g.strokeStyle = '#ffd27a'; g.lineWidth = 0.7 * u;
  g.beginPath(); g.ellipse(W * 0.14, H * 0.26, 7 * u, 5 * u, 0, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.ellipse(W * 0.86, H * 0.3, 5 * u, 3.6 * u, 0, 0, Math.PI * 2); g.stroke();
  g.restore();
  const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
}

function neonText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, alpha: number) {
  g.save();
  g.globalAlpha = alpha;
  g.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = color; g.shadowBlur = size * 0.6;
  g.strokeStyle = color; g.lineWidth = size * 0.08;
  g.strokeText(text, x, y);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.shadowBlur = size * 0.25;
  g.fillText(text, x, y);
  g.restore();
}
