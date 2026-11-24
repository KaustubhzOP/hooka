/**
 * Soft particle smoke rendered with Three.js on its own transparent WebGL canvas.
 * Physics (curl-noise turbulence, buoyancy, drag, growth, wind, hand stirring,
 * groups that hold together or get sucked back in) runs on the CPU in
 * struct-of-arrays buffers; each puff is an instanced quad whose wispy look
 * comes from animated fbm noise in the fragment shader, lit by the coals.
 */
import * as THREE from 'three';
import { curl2 } from './noise';
import type { Flavour } from './presets';

export const MAX_PARTICLES = 1000;

export interface EmitOptions {
  x: number; y: number;        // origin (screen px)
  dirX: number; dirY: number;  // main direction (unit-ish)
  speed: number;               // px/s
  spread: number;              // radians of random angle around dir (full width)
  scale: number;               // face width / 300 — everything scales with it
  strength: number;            // 0…1, alpha multiplier
  sizeMul?: number;            // puff size multiplier (nose streams are thinner)
  turb?: number;               // turbulence multiplier at birth (ramps to 1 with age)
  growth?: number;             // growth multiplier
  drag?: number;               // drag multiplier
  buoy?: number;               // buoyancy multiplier at birth (negative sinks; ramps to 1 with age)
  group?: number;              // attach to a group (see createGroup)
  jitter?: number;             // position jitter radius in px (default 8 × scale)
}

export interface RingOptions {
  x: number; y: number;        // centre (mouth)
  dirX: number; dirY: number;  // travel direction
  speed: number;               // travel speed px/s
  radius: number;              // starting radius px
  expand: number;              // radial growth speed px/s
  scale: number;
  strength: number;
}

/**
 * A group pulls its particles towards a point that the caller moves.
 * 'hold'   – each particle springs to centre + its own offset (a cohesive ball)
 * 'recall' – particles are sucked into the centre and vanish there (inhaled)
 */
interface Group { x: number; y: number; mode: 'hold' | 'recall'; k: number; killR: number; spread: number }

export interface SmokeLight { x: number; y: number; color: [number, number, number]; radius: number; intensity: number }

const VERT = /* glsl */`
  attribute vec4 iA;     // x, y, size, rotation
  attribute vec4 iB;     // r, g, b, alpha
  attribute float iSeed;
  uniform vec2 uLightPos;
  uniform float uLightR;
  uniform float uLightI;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vSeed;
  varying float vLight;
  void main() {
    vUv = uv;
    vCol = iB;
    vSeed = iSeed;
    float d = distance(iA.xy, uLightPos);
    vLight = uLightI * (1.0 - smoothstep(0.0, uLightR, d));
    float c = cos(iA.w), s = sin(iA.w);
    vec2 p = mat2(c, s, -s, c) * position.xy * iA.z + iA.xy;
    gl_Position = projectionMatrix * vec4(p, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  uniform float uTime;
  uniform vec3 uLightC;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vSeed;
  varying float vLight;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, n = 0.0;
    for (int i = 0; i < 3; i++) { n += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return n;
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    vec2 q = p * 1.8 + vec2(vSeed * 13.1, vSeed * 7.7);
    vec2 warp = vec2(fbm(q + uTime * 0.12), fbm(q - uTime * 0.1 + 4.0));
    float n = fbm(q + warp * 1.6);
    float edge = smoothstep(1.0, 0.15, r + (n - 0.5) * 1.0);
    float a = edge * edge * vCol.a * (0.25 + 1.35 * n * n);
    if (a < 0.003) discard;
    // light from the coals: smoke scatters it, denser bits glow more
    vec3 col = vCol.rgb + uLightC * vLight * (0.4 + 0.8 * n);
    gl_FragColor = vec4(col * a, a);   // premultiplied
  }
`;

export class SmokeRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.InstancedBufferGeometry;
  private attrA: THREE.InstancedBufferAttribute;
  private attrB: THREE.InstancedBufferAttribute;
  private attrSeed: THREE.InstancedBufferAttribute;
  private time = 0;
  private drewLast = true;
  private flow = { x: 0, y: 0 };
  private groups = new Map<number, Group>();
  private nextGroup = 1;

  /** Soft particle cap (≤ MAX_PARTICLES); lowered automatically on slow devices. */
  cap = MAX_PARTICLES;
  count = 0;
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private size = new Float32Array(MAX_PARTICLES);
  private age = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private rot = new Float32Array(MAX_PARTICLES);
  private spin = new Float32Array(MAX_PARTICLES);
  private seed = new Float32Array(MAX_PARTICLES);
  private sc = new Float32Array(MAX_PARTICLES);
  private str = new Float32Array(MAX_PARTICLES);
  private turbK = new Float32Array(MAX_PARTICLES);
  private growK = new Float32Array(MAX_PARTICLES);
  private dragK = new Float32Array(MAX_PARTICLES);
  private buoyK = new Float32Array(MAX_PARTICLES);
  private ox = new Float32Array(MAX_PARTICLES);
  private oy = new Float32Array(MAX_PARTICLES);
  private fade = new Float32Array(MAX_PARTICLES);   // extra fade-out multiplier (recall)
  private grp = new Int32Array(MAX_PARTICLES);
  private soa: (Float32Array | Int32Array)[] = [this.px, this.py, this.vx, this.vy, this.size, this.age, this.life, this.rot,
    this.spin, this.seed, this.sc, this.str, this.turbK, this.growK, this.dragK, this.buoyK, this.ox, this.oy, this.fade, this.grp];

  preset!: Flavour;
  /** 0…1 smoke strength from the coals' heat. */
  heat = 1;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.OrthographicCamera(0, width, 0, height, -10, 10);

    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    const mk = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * n), n).setUsage(THREE.DynamicDrawUsage);
    this.attrA = mk(4); this.attrB = mk(4); this.attrSeed = mk(1);
    this.geometry.setAttribute('iA', this.attrA);
    this.geometry.setAttribute('iB', this.attrB);
    this.geometry.setAttribute('iSeed', this.attrSeed);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 }, uLightPos: { value: new THREE.Vector2(-1e4, -1e4) }, uLightR: { value: 1 },
        uLightI: { value: 0 }, uLightC: { value: new THREE.Vector3(1, 0.5, 0.2) }
      },
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.resize(width, height);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    Object.assign(this.camera, { left: 0, right: width, top: 0, bottom: height });
    this.camera.updateProjectionMatrix();
  }

  setPreset(p: Flavour): void {
    this.preset = p;
    const m = this.material;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    if (p.blend === 'additive') {
      // Add colour but leave the canvas alpha alone, so the browser composites it additively over the video.
      m.blendDst = THREE.OneFactor;
      m.blendSrcAlpha = THREE.ZeroFactor;
      m.blendDstAlpha = THREE.OneFactor;
    } else {
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor;
      m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    m.needsUpdate = true;
  }

  /** Light from the coals (null = off). */
  setLight(l: SmokeLight | null): void {
    const u = this.material.uniforms;
    if (!l) { u.uLightI.value = 0; return; }
    u.uLightPos.value.set(l.x, l.y);
    u.uLightR.value = l.radius;
    u.uLightI.value = l.intensity;
    u.uLightC.value.set(...l.color);
  }

  clear(): void { this.count = 0; this.groups.clear(); }

  // ------------------------------------------------------------------ groups
  createGroup(x: number, y: number, mode: Group['mode'] = 'hold', k = 14, killR = 10): number {
    const id = this.nextGroup++;
    this.groups.set(id, { x, y, mode, k, killR, spread: 1 });
    return id;
  }
  moveGroup(id: number, x: number, y: number, spread?: number): void {
    const g = this.groups.get(id);
    if (g) { g.x = x; g.y = y; if (spread != null) g.spread = spread; }
  }
  setGroupMode(id: number, mode: Group['mode'], k?: number, killR?: number): void {
    const g = this.groups.get(id);
    if (!g) return;
    g.mode = mode;
    if (k != null) g.k = k;
    if (killR != null) g.killR = killR;
  }
  /** Let go of a group: its particles become ordinary smoke that drifts and breaks up. */
  releaseGroup(id: number): void {
    for (let i = 0; i < this.count; i++) if (this.grp[i] === id) { this.grp[i] = 0; this.turbK[i] = 0.1; this.age[i] = Math.min(this.age[i], 0.3); }
    this.groups.delete(id);
  }
  groupCount(id: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.grp[i] === id) n++;
    return n;
  }

  // ------------------------------------------------------------------ emitters
  emit(n: number, o: EmitOptions): void {
    const p = this.preset;
    const base = Math.atan2(o.dirY, o.dirX);
    const g = o.group ? this.groups.get(o.group) : undefined;
    const jit = o.jitter ?? 8 * o.scale;
    for (let k = 0; k < n; k++) {
      const i = this.slot();
      const ang = base + (Math.random() - 0.5) * o.spread;
      const sp = o.speed * (0.55 + Math.random() * 0.9);
      this.px[i] = o.x + (Math.random() - 0.5) * jit;
      this.py[i] = o.y + (Math.random() - 0.5) * jit * 0.5;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = Math.sin(ang) * sp;
      this.size[i] = (22 + Math.random() * 18) * o.scale * (o.sizeMul ?? 1);
      this.age[i] = 0;
      this.life[i] = p.life * (0.7 + Math.random() * 0.6) * (g ? 2.5 : 1);
      this.rot[i] = Math.random() * Math.PI * 2;
      this.spin[i] = (Math.random() - 0.5) * 1.2;
      this.seed[i] = Math.random() * 10;
      this.sc[i] = o.scale;
      this.str[i] = o.strength * (0.35 + 0.65 * this.heat);
      this.turbK[i] = o.turb ?? 1;
      this.growK[i] = o.growth ?? 1;
      this.dragK[i] = o.drag ?? 1;
      this.buoyK[i] = o.buoy ?? 1;
      this.fade[i] = 1;
      this.grp[i] = g ? o.group! : 0;
      if (g) { this.ox[i] = this.px[i] - g.x; this.oy[i] = this.py[i] - g.y; }
    }
  }

  /**
   * A smoke ring: small puffs on an ellipse that travel together and expand.
   * Turbulence starts near zero so the ring stays coherent, then ramps in so it wobbles and breaks up.
   */
  emitRing(o: RingOptions): void {
    const p = this.preset;
    const n = Math.min(90, Math.max(40, Math.floor(this.cap / 11)));
    const dl = Math.hypot(o.dirX, o.dirY) || 1;
    const tx = (o.dirX / dl) * o.speed, ty = (o.dirY / dl) * o.speed;
    const squash = 0.78;                      // seen slightly from below: an ellipse
    for (let k = 0; k < n; k++) {
      const i = this.slot();
      const a = (k / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
      const cx = Math.cos(a), cy = Math.sin(a) * squash;
      const rj = o.radius * (0.92 + Math.random() * 0.16);
      this.px[i] = o.x + cx * rj;
      this.py[i] = o.y + cy * rj;
      this.vx[i] = tx + cx * o.expand;
      this.vy[i] = ty + cy * o.expand;
      this.size[i] = (11 + Math.random() * 5) * o.scale * (90 / n) ** 0.5;
      this.age[i] = 0;
      this.life[i] = Math.max(2.8, p.life * 1.15) * (0.9 + Math.random() * 0.2);
      this.rot[i] = Math.random() * Math.PI * 2;
      this.spin[i] = (Math.random() - 0.5) * 0.6;
      this.seed[i] = Math.random() * 10;
      this.sc[i] = o.scale;
      this.str[i] = Math.min(1, o.strength * 1.2) * (0.35 + 0.65 * this.heat);
      this.turbK[i] = 0.02;
      this.growK[i] = 0.45;
      this.dragK[i] = 0.35;
      this.buoyK[i] = 0.5;
      this.fade[i] = 1;
      this.grp[i] = 0;
    }
  }

  // ------------------------------------------------------------------ forces
  /** Blow air from (x, y) along dir: pushes smoke inside a cone (coneMin = cosine limit). Returns how many puffs moved. */
  wind(x: number, y: number, dirX: number, dirY: number, strength: number, reach: number, dt: number, coneMin = 0.35): number {
    const dl = Math.hypot(dirX, dirY) || 1, ux = dirX / dl, uy = dirY / dl;
    let moved = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.grp[i]) continue;
      const dx = this.px[i] - x, dy = this.py[i] - y;
      const d = Math.hypot(dx, dy);
      if (d > reach || d < 1) continue;
      const along = (dx * ux + dy * uy) / d;            // cosine to the blow direction
      if (along < coneMin) continue;
      moved++;
      const f = strength * (1 - d / reach) * (along - coneMin) / (1 - coneMin);
      this.vx[i] += (ux * 0.8 + (dx / d) * 0.2) * f * dt;
      this.vy[i] += (uy * 0.8 + (dy / d) * 0.2) * f * dt;
      this.turbK[i] = Math.max(this.turbK[i], 0.8);
    }
    return moved;
  }

  /** A moving hand drags and swirls nearby smoke. */
  stir(x: number, y: number, hvx: number, hvy: number, radius: number, dt: number): number {
    let touched = 0;
    const k = Math.min(1, 6 * dt);
    for (let i = 0; i < this.count; i++) {
      const dx = this.px[i] - x, dy = this.py[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      const fall = 1 - Math.sqrt(d2) / radius;
      this.vx[i] += (hvx * 0.9 - this.vx[i]) * k * fall;
      this.vy[i] += (hvy * 0.9 - this.vy[i]) * k * fall;
      // a little swirl around the hand
      this.vx[i] += -dy * 1.5 * fall * dt * Math.sign(hvx || 1);
      this.vy[i] += dx * 1.5 * fall * dt * Math.sign(hvx || 1);
      if (this.grp[i]) { this.grp[i] = 0; this.turbK[i] = 0.5; }   // a hand breaks a ghost apart
      touched++;
    }
    return touched;
  }

  update(dt: number): void {
    if (!this.preset) return;
    this.time += dt;
    const p = this.preset, f = this.flow, t = this.time * 0.35;
    for (let i = this.count - 1; i >= 0; i--) {
      const age = (this.age[i] += dt);
      if (age >= this.life[i] || this.fade[i] <= 0.01) { this.kill(i); continue; }
      const sc = this.sc[i];
      const gid = this.grp[i];
      const g = gid ? this.groups.get(gid) : undefined;
      if (gid && !g) { this.grp[i] = 0; this.turbK[i] = 0.1; }

      if (g) {
        // grouped: spring towards the group's target, mild turbulence for life
        let tx = g.x, ty = g.y;
        if (g.mode === 'hold') {
          tx += this.ox[i] * g.spread; ty += this.oy[i] * g.spread;
        }
        const k = g.mode === 'recall' ? g.k * 1.5 : g.k;
        const damp = 2 * Math.sqrt(k) * 0.8;
        this.vx[i] += ((tx - this.px[i]) * k - this.vx[i] * damp) * dt;
        this.vy[i] += ((ty - this.py[i]) * k - this.vy[i] * damp) * dt;
        curl2(this.px[i] / (90 * sc), this.py[i] / (90 * sc), t * 2 + this.seed[i] * 0.05, f);
        this.px[i] += (this.vx[i] + f.x * 12 * sc) * dt;
        this.py[i] += (this.vy[i] + f.y * 12 * sc) * dt;
        if (g.mode === 'recall') {
          const d = Math.hypot(this.px[i] - g.x, this.py[i] - g.y);
          if (d < g.killR * 2) { this.fade[i] -= dt * 5; this.size[i] *= 1 - dt * 3; }
          if (d < g.killR) { this.kill(i); continue; }
        } else this.size[i] += 6 * sc * dt / (1 + age);
        this.rot[i] += this.spin[i] * dt;
        continue;
      }

      // turbulence ramps in as the jet slows down
      const cell = 170 * sc;
      curl2(this.px[i] / cell, this.py[i] / cell, t + this.seed[i] * 0.05, f);
      const tk = this.turbK[i] < 1 ? Math.min(1, this.turbK[i] + age * age * 0.045) : 1;
      const turb = p.turbulence * 55 * sc * Math.min(1, age * 1.4) * tk;
      const bk = this.buoyK[i] < 1 ? this.buoyK[i] + (1 - this.buoyK[i]) * Math.min(1, age / 2.5) : 1;
      this.vy[i] -= 48 * p.buoyancy * sc * dt * bk;      // buoyancy (screen y points down)
      const drag = Math.exp(-1.7 * this.dragK[i] * dt);
      this.vx[i] *= drag; this.vy[i] *= drag;
      this.px[i] += (this.vx[i] + f.x * turb) * dt;
      this.py[i] += (this.vy[i] + f.y * turb) * dt;
      this.size[i] += (70 * p.growth * this.growK[i] * sc / (1 + age * 1.2)) * dt;
      this.rot[i] += this.spin[i] * dt;
    }
  }

  render(): void {
    if (!this.preset) return;
    const n = this.count;
    if (n === 0 && !this.drewLast) return;   // nothing changed on screen
    this.drewLast = n > 0;
    const A = this.attrA.array as Float32Array, B = this.attrB.array as Float32Array, S = this.attrSeed.array as Float32Array;
    const p = this.preset, c0 = p.colorStart, c1 = p.colorEnd;
    for (let i = 0; i < n; i++) {
      const grouped = this.grp[i] !== 0;
      const u = grouped ? Math.min(0.3, this.age[i] / this.life[i]) : this.age[i] / this.life[i];
      const fadeIn = Math.min(1, this.age[i] / 0.15);
      const fadeOut = Math.pow(1 - this.age[i] / this.life[i], grouped ? 0.5 : 1.6);
      A[i * 4] = this.px[i]; A[i * 4 + 1] = this.py[i]; A[i * 4 + 2] = this.size[i] * 2; A[i * 4 + 3] = this.rot[i];
      B[i * 4] = c0[0] + (c1[0] - c0[0]) * u;
      B[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * u;
      B[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * u;
      B[i * 4 + 3] = p.opacity * this.str[i] * fadeIn * fadeOut * Math.max(0, this.fade[i]);
      S[i] = this.seed[i];
    }
    this.attrA.needsUpdate = this.attrB.needsUpdate = this.attrSeed.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.material.uniforms.uTime.value = this.time;
    this.renderer.render(this.scene, this.camera);
  }

  /** Next free particle index; when full, recycle a random ungrouped slot instead of dropping new smoke. */
  private slot(): number {
    if (this.count < this.cap) return this.count++;
    for (let tries = 0; tries < 8; tries++) {
      const i = Math.floor(Math.random() * this.count);
      if (!this.grp[i]) return i;
    }
    return Math.floor(Math.random() * this.count);
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (const arr of this.soa) arr[i] = arr[last];
  }
}
