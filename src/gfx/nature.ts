// Organic meshes for scenery: lumpy leaf clusters, boulders, cones for conifers and grass tufts.
// All are unit-sized (about 1 m across, centred like the sphere mesh) and built from a fixed seed,
// so every client draws identical scenery.
import type { MeshData } from './renderer';

/** Small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 3D value noise in [0, 1]. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647) ^ Math.imul(seed, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (t: number) => t * t * (3 - 2 * t);
  const fx = f(x - xi), fy = f(y - yi), fz = f(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), fx), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), fx), fy),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), fx), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), fx), fy),
    fz);
}

/**
 * A sphere whose surface is pushed in and out by noise. `amount` is the bump height as a fraction
 * of the radius, `freq` how many bumps fit around it, `flat` squashes the underside (for rocks).
 */
export function lumpMesh(seed: number, amount: number, freq: number, flat = 0, rings = 12, segs = 18): MeshData {
  const pos: number[][] = [];
  const radius = (x: number, y: number, z: number) => 0.5 * (1 - amount * 0.5 + amount * (noise3(x * freq + 7, y * freq + 3, z * freq + 5, seed) * 0.65 + noise3(x * freq * 2.3, y * freq * 2.3, z * freq * 2.3, seed + 9) * 0.35));
  const point = (theta: number, phi: number): number[] => {
    const d = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
    const r = radius(d[0], d[1], d[2]);
    const y = d[1] * r;
    return [d[0] * r, y < 0 ? y * (1 - flat) : y, d[2] * r];
  };
  const v: number[] = [], idx: number[] = [];
  const e = 0.02;
  for (let i = 0; i <= rings; i++) {
    const theta = (i / rings) * Math.PI;
    for (let j = 0; j <= segs; j++) {
      const phi = (j / segs) * Math.PI * 2;
      const p = point(theta, phi);
      // Normal from two nearby points on the bumpy surface.
      const t0 = Math.min(Math.max(theta, e), Math.PI - e);
      const a = point(t0 + e, phi), b = point(t0, phi + e), c = point(t0, phi);
      const u = [a[0] - c[0], a[1] - c[1], a[2] - c[2]], w = [b[0] - c[0], b[1] - c[1], b[2] - c[2]];
      let n = [u[2] * w[1] - u[1] * w[2], u[0] * w[2] - u[2] * w[0], u[1] * w[0] - u[0] * w[1]];
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / len, n[1] / len, n[2] / len];
      // Keep it pointing outward at the poles, where the tangents collapse.
      if (n[0] * c[0] + n[1] * c[1] + n[2] * c[2] < 0) n = [-n[0], -n[1], -n[2]];
      pos.push(p);
      v.push(p[0], p[1], p[2], n[0], n[1], n[2], j / segs, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Cone with its base at y = -0.5 and tip at y = 0.5, base radius 0.5 (a tier of a conifer). */
export function coneMesh(segs = 14): MeshData {
  const v: number[] = [], idx: number[] = [];
  const slope = Math.atan2(0.5, 1);
  for (let j = 0; j <= segs; j++) {
    const t = (j / segs) * Math.PI * 2, x = Math.cos(t), z = Math.sin(t);
    const n = [x * Math.cos(slope), Math.sin(slope), z * Math.cos(slope)];
    v.push(x * 0.5, -0.5, z * 0.5, n[0], n[1], n[2], j / segs, 1, 0, 0.5, 0, n[0], n[1], n[2], j / segs, 0);
  }
  for (let j = 0; j < segs; j++) { const a = j * 2; idx.push(a, a + 1, a + 2); }
  // Underside.
  const c = v.length / 8;
  v.push(0, -0.5, 0, 0, -1, 0, 0.5, 0.5);
  for (let j = 0; j <= segs; j++) { const t = (j / segs) * Math.PI * 2; v.push(Math.cos(t) * 0.5, -0.5, Math.sin(t) * 0.5, 0, -1, 0, 0.5, 0.5); }
  for (let j = 0; j < segs; j++) idx.push(c, c + 1 + j, c + 2 + j);
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/**
 * A tuft of grass: blades that taper to a point and bend outward, standing on y = 0 inside a
 * circle of radius 0.5, up to 1 tall. Both sides of every blade are drawn.
 */
export function tuftMesh(seed: number, blades = 14): MeshData {
  const r = rng(seed);
  const v: number[] = [], idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.34;
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    const out = a + (r() - 0.5) * 1.6;
    const lean = 0.1 + r() * 0.3, height = 0.45 + r() * 0.55, width = 0.035 + r() * 0.03;
    // Blade faces sideways to its lean direction.
    const sx = -Math.sin(out), sz = Math.cos(out);
    const segs = 3;
    const base = v.length / 8;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const cx = bx + Math.cos(out) * lean * t * t, cz = bz + Math.sin(out) * lean * t * t, cy = height * t;
      const w = width * (1 - t * 0.92);
      // Normals point mostly up so a tuft is lit softly from the sky.
      const n = [Math.cos(out) * 0.35, 0.9, Math.sin(out) * 0.35];
      v.push(cx - sx * w, cy, cz - sz * w, n[0], n[1], n[2], 0, 1 - t, cx + sx * w, cy, cz + sz * w, n[0], n[1], n[2], 1, 1 - t);
    }
    for (let k = 0; k < segs; k++) {
      const p = base + k * 2;
      idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2, p, p + 2, p + 1, p + 1, p + 2, p + 3);
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}
