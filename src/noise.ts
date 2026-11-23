/** 3D simplex noise (after Stefan Gustavson) and a 2D curl field built on it. */

const GRAD = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);
const PERM = new Uint8Array(512);
const MOD12 = new Uint8Array(512);
{
  const p = new Uint8Array(256).map((_, i) => i);
  let s = 1337;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) { PERM[i] = p[i & 255]; MOD12[i] = PERM[i] % 12; }
}
const F3 = 1 / 3, G3 = 1 / 6;

export function noise3(x: number, y: number, z: number): number {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
  const ii = i & 255, jj = j & 255, kk = k & 255;
  let n = 0;
  const corner = (gi: number, cx: number, cy: number, cz: number) => {
    let tt = 0.6 - cx * cx - cy * cy - cz * cz;
    if (tt < 0) return 0;
    tt *= tt;
    const g = gi * 3;
    return tt * tt * (GRAD[g] * cx + GRAD[g + 1] * cy + GRAD[g + 2] * cz);
  };
  n += corner(MOD12[ii + PERM[jj + PERM[kk]]], x0, y0, z0);
  n += corner(MOD12[ii + i1 + PERM[jj + j1 + PERM[kk + k1]]], x1, y1, z1);
  n += corner(MOD12[ii + i2 + PERM[jj + j2 + PERM[kk + k2]]], x2, y2, z2);
  n += corner(MOD12[ii + 1 + PERM[jj + 1 + PERM[kk + 1]]], x3, y3, z3);
  return 32 * n;
}

/**
 * Divergence-free 2D flow: curl of a scalar potential ψ(x, y, t), i.e. (∂ψ/∂y, −∂ψ/∂x).
 * Two octaves for a mix of large swirls and small eddies. Writes into `out`.
 */
export function curl2(x: number, y: number, t: number, out: { x: number; y: number }): void {
  const e = 0.05;
  const psi = (px: number, py: number) => noise3(px, py, t) + 0.45 * noise3(px * 2.3 + 17.1, py * 2.3 - 5.2, t * 1.7);
  out.x = (psi(x, y + e) - psi(x, y - e)) / (2 * e);
  out.y = -(psi(x + e, y) - psi(x - e, y)) / (2 * e);
}
