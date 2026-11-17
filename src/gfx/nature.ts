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

/** Pushes a two-sided quad strip (a blade, frond or leaf card) given its rows of left/right points. */
function strip(v: number[], idx: number[], rows: { l: number[]; r: number[]; n: number[]; t: number }[]): void {
  const base = v.length / 8;
  for (const row of rows) v.push(...row.l, ...row.n, 0, 1 - row.t, ...row.r, ...row.n, 1, 1 - row.t);
  for (let k = 0; k < rows.length - 1; k++) {
    const p = base + k * 2;
    idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2, p, p + 2, p + 1, p + 1, p + 2, p + 3);
  }
}

/**
 * A dense clump of grass: curved blades of very different heights, a few seed stalks with heads,
 * standing on y = 0 within a radius of 0.5 and up to 1 tall. UV v runs 1 at the root to 0 at the
 * tip (the shader shades by it).
 */
export function grassClumpMesh(seed: number, blades = 30): MeshData {
  const r = rng(seed);
  const v: number[] = [], idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = r() * Math.PI * 2, d = Math.pow(r(), 0.7) * 0.42;
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    const out = a + (r() - 0.5) * 1.2;
    const tall = r() < 0.15;
    const height = tall ? 0.85 + r() * 0.15 : 0.25 + r() * 0.55, lean = (0.12 + r() * 0.35) * height;
    const width = (0.02 + r() * 0.025) * (tall ? 0.6 : 1);
    const sx = -Math.sin(out), sz = Math.cos(out);
    const rows = [];
    const segs = 4;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const cx = bx + Math.cos(out) * lean * t * t, cz = bz + Math.sin(out) * lean * t * t, cy = height * (t - 0.12 * t * t);
      const w = width * (1 - t * 0.9);
      const n = [Math.cos(out) * 0.4, 0.88, Math.sin(out) * 0.4];
      rows.push({ l: [cx - sx * w, cy, cz - sz * w], r: [cx + sx * w, cy, cz + sz * w], n, t });
    }
    strip(v, idx, rows);
    // Seed head at the top of the tall stalks: a narrow tapered spike.
    if (tall) {
      const top = rows[segs], tx = (top.l[0] + top.r[0]) / 2, ty = top.l[1], tz = (top.l[2] + top.r[2]) / 2;
      const head = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3, w = 0.03 * Math.sin(Math.PI * (0.15 + t * 0.85));
        head.push({ l: [tx - sx * w, ty + t * 0.12, tz - sz * w], r: [tx + sx * w, ty + t * 0.12, tz + sz * w], n: [0, 1, 0], t: 1 });
      }
      strip(v, idx, head);
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** A low broad-leaved weed: a rosette of ribbed, drooping leaves (plantain, dock, dandelion). */
export function weedMesh(seed: number, leaves = 9): MeshData {
  const r = rng(seed);
  const v: number[] = [], idx: number[] = [];
  for (let k = 0; k < leaves; k++) {
    const a = (k / leaves) * Math.PI * 2 + r() * 0.5;
    const len = 0.3 + r() * 0.2, width = 0.06 + r() * 0.05, rise = 0.2 + r() * 0.25;
    const dx = Math.cos(a), dz = Math.sin(a), sx = -dz, sz = dx;
    const rows = [];
    for (let j = 0; j <= 5; j++) {
      const t = j / 5, along = len * t;
      const y = rise * Math.sin(t * Math.PI * 0.75) * (1 - t * 0.4);
      const w = width * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
      // A slight fold along the midrib.
      const cx = dx * along, cz = dz * along;
      rows.push({ l: [cx - sx * w, y - w * 0.2, cz - sz * w], r: [cx + sx * w, y - w * 0.2, cz + sz * w], n: [dx * 0.2, 0.95, dz * 0.2], t });
    }
    strip(v, idx, rows);
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/**
 * A flat patch of earth with a ragged outline (no circles): radius about 0.5, domed a few
 * millimetres so it sits on the floor without fighting it.
 */
export function patchMesh(seed: number, segs = 28): MeshData {
  const v: number[] = [], idx: number[] = [];
  v.push(0, 0.02, 0, 0, 1, 0, 0.5, 0.5);
  for (let j = 0; j <= segs; j++) {
    const a = (j / segs) * Math.PI * 2;
    const rad = 0.5 * (0.62 + 0.38 * (noise3(Math.cos(a) * 1.6 + 3, Math.sin(a) * 1.6 + 5, 0, seed) * 0.65 + noise3(Math.cos(a) * 4 + 9, Math.sin(a) * 4, 2, seed + 3) * 0.35));
    v.push(Math.cos(a) * rad, 0.002, Math.sin(a) * rad, 0, 1, 0, 0.5 + Math.cos(a) * rad, 0.5 + Math.sin(a) * rad);
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + j + 1, 1 + j);
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/**
 * A cluster of real leaves for a canopy: a few hundred small pointed leaves, each folded along its
 * midrib, scattered through a sphere of radius 0.5 (denser near the surface) and turned to face
 * roughly outward and up. Two-sided, so light and sky show between them like a real crown.
 */
export function leafClusterMesh(seed: number, leaves = 240): MeshData {
  const r = rng(seed);
  const v: number[] = [], idx: number[] = [];
  for (let k = 0; k < leaves; k++) {
    let d = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    d = [d[0] / dl, d[1] / dl, d[2] / dl];
    const depth = 0.5 * (0.35 + 0.65 * Math.pow(r(), 0.4));
    const c = [d[0] * depth, d[1] * depth * 0.85, d[2] * depth];
    // The leaf hangs from its stalk: its length points outward and a little down.
    let len = [d[0] + (r() - 0.5) * 0.9, d[1] * 0.3 - 0.35 + (r() - 0.5) * 0.6, d[2] + (r() - 0.5) * 0.9];
    const ll = Math.hypot(len[0], len[1], len[2]) || 1;
    len = [len[0] / ll, len[1] / ll, len[2] / ll];
    // Width across, roughly horizontal; face normal from the two.
    let wid = [len[2], 0, -len[0]];
    const wl = Math.hypot(wid[0], wid[2]) || 1;
    wid = [wid[0] / wl, 0, wid[2] / wl];
    let n = [len[1] * wid[2] - len[2] * wid[1], len[2] * wid[0] - len[0] * wid[2], len[0] * wid[1] - len[1] * wid[0]];
    if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
    // Light the crown as a volume: blend the face normal with the outward direction.
    const bn = [n[0] * 0.5 + d[0] * 0.6, n[1] * 0.5 + d[1] * 0.6 + 0.25, n[2] * 0.5 + d[2] * 0.6];
    const bl = Math.hypot(bn[0], bn[1], bn[2]);
    const nn = [bn[0] / bl, bn[1] / bl, bn[2] / bl];
    const L = 0.055 + r() * 0.04, W = L * (0.38 + r() * 0.2), fold = W * 0.35;
    const P = (along: number, across: number, lift: number) => [c[0] + len[0] * along + wid[0] * across + n[0] * lift, c[1] + len[1] * along + wid[1] * across + n[1] * lift, c[2] + len[2] * along + wid[2] * across + n[2] * lift];
    const base = v.length / 8;
    // Stalk end, two sides at the widest point (folded up a touch), tip.
    for (const [pt, uv] of [[P(0, 0, 0), [0.5, 1]], [P(L * 0.45, -W, fold), [0, 0.5]], [P(L * 0.45, W, fold), [1, 0.5]], [P(L, 0, 0), [0.5, 0]]] as const) v.push(pt[0], pt[1], pt[2], nn[0], nn[1], nn[2], uv[0], uv[1]);
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2, base, base + 3, base + 1, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/**
 * A conifer bough: a drooping, tapering frond along +x from the origin to x = 1 with needled
 * side shoots, about 0.4 wide. Placed in rings around a trunk.
 */
export function frondMesh(seed: number): MeshData {
  const r = rng(seed);
  const v: number[] = [], idx: number[] = [];
  const droop = (x: number) => -0.35 * x * x;
  const rows = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6, w = 0.2 * (1 - t * 0.85) + 0.02;
    rows.push({ l: [t, droop(t), -w], r: [t, droop(t) + w * 0.25, w], n: [0.15, 0.95, 0], t });
  }
  strip(v, idx, rows);
  // Side shoots angled down and forward, so the bough has depth seen from below.
  for (let k = 1; k <= 5; k++) {
    const t = k / 6;
    for (const side of [-1, 1]) {
      const len = 0.18 * (1 - t * 0.6) + r() * 0.05;
      const o = [t, droop(t), 0];
      const e = [t + len * 0.6, droop(t) - len * 0.5, side * len];
      const w = 0.035;
      strip(v, idx, [{ l: [o[0] - w, o[1], o[2]], r: [o[0] + w, o[1], o[2]], n: [0, 0.9, side * 0.4], t: 0.3 }, { l: [e[0] - w * 0.4, e[1], e[2]], r: [e[0] + w * 0.4, e[1], e[2]], n: [0, 0.9, side * 0.4], t: 1 }]);
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** A finely divided two-sided sheet in the x-y plane, -0.5..0.5, for cloth that ripples. */
export function clothMesh(sx = 14, sy = 6): MeshData {
  const v: number[] = [], idx: number[] = [];
  for (const side of [1, -1]) {
    const base = v.length / 8;
    for (let j = 0; j <= sy; j++) for (let i = 0; i <= sx; i++) v.push(i / sx - 0.5, j / sy - 0.5, 0, 0, 0, side, i / sx, 1 - j / sy);
    for (let j = 0; j < sy; j++) {
      for (let i = 0; i < sx; i++) {
        const a = base + j * (sx + 1) + i, b = a + sx + 1;
        if (side > 0) idx.push(a, a + 1, b, a + 1, b + 1, b); else idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}
