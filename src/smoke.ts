/**
 * Soft particle smoke rendered with Three.js on its own transparent WebGL canvas.
 * Physics (curl-noise turbulence, buoyancy, drag, growth) runs on the CPU in
 * struct-of-arrays buffers; each puff is an instanced quad whose wispy look
 * comes from animated fbm noise in the fragment shader.
 */
import * as THREE from 'three';
import { curl2 } from './noise';
import type { SmokePreset } from './presets';

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

const VERT = /* glsl */`
  attribute vec4 iA;     // x, y, size, rotation
  attribute vec4 iB;     // r, g, b, alpha
  attribute float iSeed;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vSeed;
  void main() {
    vUv = uv;
    vCol = iB;
    vSeed = iSeed;
    float c = cos(iA.w), s = sin(iA.w);
    vec2 p = mat2(c, s, -s, c) * position.xy * iA.z + iA.xy;
    gl_Position = projectionMatrix * vec4(p, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  uniform float uTime;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vSeed;
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
    gl_FragColor = vec4(vCol.rgb * a, a);   // premultiplied
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

  // particle state (struct of arrays)
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
  private soa = [this.px, this.py, this.vx, this.vy, this.size, this.age, this.life, this.rot, this.spin, this.seed,
                 this.sc, this.str, this.turbK, this.growK, this.dragK];

  preset!: SmokePreset;

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
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { uTime: { value: 0 } },
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

  setPreset(p: SmokePreset): void {
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

  clear(): void { this.count = 0; }

  emit(n: number, o: EmitOptions): void {
    const p = this.preset;
    const base = Math.atan2(o.dirY, o.dirX);
    for (let k = 0; k < n; k++) {
      const i = this.slot();
      const ang = base + (Math.random() - 0.5) * o.spread;
      const sp = o.speed * (0.55 + Math.random() * 0.9);
      this.px[i] = o.x + (Math.random() - 0.5) * 8 * o.scale;
      this.py[i] = o.y + (Math.random() - 0.5) * 4 * o.scale;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = Math.sin(ang) * sp;
      this.size[i] = (22 + Math.random() * 18) * o.scale * (o.sizeMul ?? 1);
      this.age[i] = 0;
      this.life[i] = p.life * (0.7 + Math.random() * 0.6);
      this.rot[i] = Math.random() * Math.PI * 2;
      this.spin[i] = (Math.random() - 0.5) * 1.2;
      this.seed[i] = Math.random() * 10;
      this.sc[i] = o.scale;
      this.str[i] = o.strength;
      this.turbK[i] = o.turb ?? 1;
      this.growK[i] = o.growth ?? 1;
      this.dragK[i] = o.drag ?? 1;
    }
  }

  /**
   * A smoke ring: small puffs on an ellipse that travel together and expand.
   * Turbulence starts near zero so the ring stays coherent, then ramps in so it wobbles and breaks up.
   */
  emitRing(o: RingOptions): void {
    const p = this.preset;
    const n = 90;
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
      this.size[i] = (11 + Math.random() * 5) * o.scale;
      this.age[i] = 0;
      this.life[i] = Math.max(2.8, p.life * 1.15) * (0.9 + Math.random() * 0.2);
      this.rot[i] = Math.random() * Math.PI * 2;
      this.spin[i] = (Math.random() - 0.5) * 0.6;
      this.seed[i] = Math.random() * 10;
      this.sc[i] = o.scale;
      this.str[i] = Math.min(1, o.strength * 1.2);
      this.turbK[i] = 0.02;
      this.growK[i] = 0.45;
      this.dragK[i] = 0.35;
    }
  }

  /** Next free particle index; when full, recycle a random slot instead of dropping new smoke. */
  private slot(): number {
    if (this.count < MAX_PARTICLES) return this.count++;
    return Math.floor(Math.random() * MAX_PARTICLES);
  }

  update(dt: number): void {
    if (!this.preset) return;
    this.time += dt;
    const p = this.preset, f = this.flow, t = this.time * 0.35;
    for (let i = this.count - 1; i >= 0; i--) {
      const age = (this.age[i] += dt);
      if (age >= this.life[i]) { this.kill(i); continue; }
      const sc = this.sc[i];
      // turbulence ramps in as the jet slows down
      const cell = 170 * sc;
      curl2(this.px[i] / cell, this.py[i] / cell, t + this.seed[i] * 0.05, f);
      const tk = this.turbK[i] < 1 ? Math.min(1, this.turbK[i] + age * age * 0.045) : 1;
      const turb = p.turbulence * 55 * sc * Math.min(1, age * 1.4) * tk;
      this.vy[i] -= 48 * p.buoyancy * sc * dt * (tk < 1 ? 0.5 : 1);   // buoyancy (screen y points down)
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
      const u = this.age[i] / this.life[i];
      const fadeIn = Math.min(1, this.age[i] / 0.15);
      const fadeOut = Math.pow(1 - u, 1.6);
      A[i * 4] = this.px[i]; A[i * 4 + 1] = this.py[i]; A[i * 4 + 2] = this.size[i] * 2; A[i * 4 + 3] = this.rot[i];
      B[i * 4] = c0[0] + (c1[0] - c0[0]) * u;
      B[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * u;
      B[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * u;
      B[i * 4 + 3] = p.opacity * this.str[i] * fadeIn * fadeOut;
      S[i] = this.seed[i];
    }
    this.attrA.needsUpdate = this.attrB.needsUpdate = this.attrSeed.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.material.uniforms.uTime.value = this.time;
    this.renderer.render(this.scene, this.camera);
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (const arr of this.soa) arr[i] = arr[last];
  }
}
