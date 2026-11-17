// Sculpted meshes for people and the dead: a torso with chest, waist and hips, muscled thighs,
// calves and arms, hands with a thumb, boots, a head with brow, nose, cheekbones, jaw and ears,
// and rounded-edged shapes for gear (plates, pouches, packs, helmet shells).
//
// Each is lofted from cross-sections along its length, so it bends and bulges where a body does
// instead of being a box or a sphere. All are unit-sized: they span y -0.5..0.5 and about
// -0.5..0.5 across, so the scene can stretch them between two joints.
import type { MeshData } from './renderer';

/**
 * One cross-section of a loft. `rx`, `rz`: half-width and half-depth (0.5 fills the unit box);
 * `dx`, `dz`: offset of its centre; `p`: superellipse exponent (2 = ellipse, higher = squarer
 * with rounded corners); `back`: extra depth on the -z side only (calves, buttocks, shoulder blades).
 */
export interface Ring { y: number; rx: number; rz: number; dx?: number; dz?: number; p?: number; back?: number; front?: number }

/** Smooth vertex normals from triangles. */
function normals(pos: number[], idx: number[]): number[] {
  const n = new Array(pos.length).fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const v = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const k of [a, b, c]) { n[k] += f[0]; n[k + 1] += f[1]; n[k + 2] += f[2]; }
  }
  for (let k = 0; k < n.length; k += 3) {
    const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
    n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
  }
  return n;
}

function pack(pos: number[], idx: number[], uv: number[]): MeshData {
  const nrm = normals(pos, idx);
  const count = pos.length / 3;
  const v = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) v.set([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2], uv[i * 2], uv[i * 2 + 1]], i * 8);
  return { vertices: v, indices: count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) };
}

/** Smoothly interpolates a list of rings (Catmull-Rom on every field) to `n` evenly spaced in y. */
function resample(rings: Ring[], n: number): Ring[] {
  const out: Ring[] = [];
  const keys: (keyof Ring)[] = ['rx', 'rz', 'dx', 'dz', 'p', 'back', 'front'];
  const y0 = rings[0].y, y1 = rings[rings.length - 1].y;
  for (let i = 0; i < n; i++) {
    const y = y0 + ((y1 - y0) * i) / (n - 1);
    let k = 0;
    while (k < rings.length - 2 && rings[k + 1].y < y) k++;
    const a = rings[Math.max(0, k - 1)], b = rings[k], c = rings[k + 1], d = rings[Math.min(rings.length - 1, k + 2)];
    const t = (y - b.y) / Math.max(1e-6, c.y - b.y);
    const r: Ring = { y, rx: 0, rz: 0 };
    for (const key of keys) {
      const g = (q: Ring) => (q[key] as number | undefined) ?? (key === 'p' ? 2 : 0);
      const [p0, p1, p2, p3] = [g(a), g(b), g(c), g(d)];
      const t2 = t * t, t3 = t2 * t;
      (r as unknown as Record<string, number>)[key] = Math.max(key === 'dx' || key === 'dz' ? -9 : 0, 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
    }
    out.push(r);
  }
  return out;
}

/** A closed surface lofted through `rings` (bottom to top), with rounded end caps. */
export function loft(rings: Ring[], segs = 18, steps = 24): MeshData {
  const rs = resample(rings, steps);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  rs.forEach((r, i) => {
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const e = 2 / (r.p ?? 2);
      const x = Math.sign(c) * Math.pow(Math.abs(c), e) * r.rx;
      let z = Math.sign(s) * Math.pow(Math.abs(s), e) * r.rz;
      if (s < 0 && r.back) z -= r.back * Math.pow(-s, 2);
      if (s > 0 && r.front) z += r.front * Math.pow(s, 2);
      pos.push(x + (r.dx ?? 0), r.y, z + (r.dz ?? 0));
      uv.push(j / segs, i / (rs.length - 1));
    }
  });
  const row = segs + 1;
  for (let i = 0; i < rs.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * row + j, b = a + row;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Caps: a centre point at each end, slightly domed.
  for (const [ring, dir] of [[0, -1], [rs.length - 1, 1]] as const) {
    const r = rs[ring];
    const c = pos.length / 3;
    pos.push(r.dx ?? 0, r.y + dir * Math.min(r.rx, r.rz) * 0.35, r.dz ?? 0);
    uv.push(0.5, ring ? 1 : 0);
    for (let j = 0; j < segs; j++) {
      const a = ring * row + j;
      if (dir < 0) idx.push(c, a + 1, a); else idx.push(c, a, a + 1);
    }
  }
  return pack(pos, idx, uv);
}

/**
 * A sphere pushed in and out by `shape(x, y, z)`, which returns a radius multiplier for the unit
 * direction (x right, y up, z back; the face looks down -z like everything else in the game).
 */
export function sculpt(shape: (x: number, y: number, z: number) => number, rings = 26, segs = 32): MeshData {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI;
    for (let j = 0; j <= segs; j++) {
      const ph = (j / segs) * Math.PI * 2;
      const x = Math.sin(th) * Math.sin(ph), y = Math.cos(th), z = Math.sin(th) * Math.cos(ph);
      const r = 0.5 * shape(x, y, z);
      pos.push(x * r, y * r, z * r);
      uv.push(j / segs, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return pack(pos, idx, uv);
}

const bump = (x: number, y: number, z: number, cx: number, cy: number, cz: number, w: number) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) / (w * w));

/** A human head: cranium, brow ridge, eye sockets, nose, cheekbones, jaw, chin and ears. */
export function headMesh(gaunt = 0): MeshData {
  return sculpt((x, y, z) => {
    let r = 1;
    // Longer front to back than side to side; the cranium swells at the back.
    r *= 1 - 0.1 * x * x + 0.06 * Math.max(0, z) * Math.max(0, y + 0.2);
    // Jaw narrows below the cheekbones; the chin comes forward.
    if (y < -0.05) r *= 1 - 0.28 * (-y - 0.05) * (0.6 + 0.4 * x * x) * (1 + gaunt * 0.4);
    r += 0.09 * bump(x, y, z, 0, -0.78, -0.62, 0.32); // chin
    r += 0.07 * bump(x, y, z, 0, 0.32, -0.95, 0.42); // brow ridge
    r -= (0.08 + gaunt * 0.06) * (bump(x, y, z, -0.33, 0.12, -0.93, 0.2) + bump(x, y, z, 0.33, 0.12, -0.93, 0.2)); // eye sockets
    r += 0.2 * bump(x, y, z, 0, -0.12, -1, 0.17); // nose bridge to tip
    r += 0.1 * bump(x, y, z, 0, -0.3, -0.98, 0.14);
    r += 0.06 * (bump(x, y, z, -0.6, -0.05, -0.72, 0.25) + bump(x, y, z, 0.6, -0.05, -0.72, 0.25)) * (1 - gaunt * 1.5); // cheekbones
    r -= gaunt * 0.1 * (bump(x, y, z, -0.62, -0.35, -0.6, 0.3) + bump(x, y, z, 0.62, -0.35, -0.6, 0.3)); // hollow cheeks
    r += 0.03 * bump(x, y, z, 0, -0.5, -0.9, 0.2); // lips
    r += 0.16 * (bump(x, y, z, -1, 0.02, 0.05, 0.18) + bump(x, y, z, 1, 0.02, 0.05, 0.18)); // ears
    return r;
  });
}

/** Rounded-edged block for gear: plates, pouches, packs, boxes on a belt. */
export function gearMesh(): MeshData {
  return loft([
    { y: -0.5, rx: 0.4, rz: 0.4, p: 6 }, { y: -0.47, rx: 0.49, rz: 0.49, p: 6 }, { y: 0, rx: 0.5, rz: 0.5, p: 6 },
    { y: 0.47, rx: 0.49, rz: 0.49, p: 6 }, { y: 0.5, rx: 0.4, rz: 0.4, p: 6 },
  ], 24, 10);
}

/** All the parts, keyed by name. */
export function bodyParts(): Record<string, MeshData> {
  return {
    // Pelvis (bottom) to the base of the neck (top). -z is the front.
    torso: loft([
      { y: -0.5, rx: 0.36, rz: 0.3, p: 2.4 },
      { y: -0.42, rx: 0.44, rz: 0.36, p: 2.6, back: 0.06 }, // hips and seat
      { y: -0.22, rx: 0.4, rz: 0.32, p: 2.4 }, // waist
      { y: 0.0, rx: 0.42, rz: 0.34, p: 2.4, front: 0.02 },
      { y: 0.18, rx: 0.47, rz: 0.37, p: 2.6, front: 0.06, back: 0.03 }, // chest
      { y: 0.34, rx: 0.5, rz: 0.36, p: 2.8, front: 0.04, back: 0.05 }, // shoulders and blades
      { y: 0.44, rx: 0.42, rz: 0.3, p: 2.6 }, // trapezius
      { y: 0.5, rx: 0.17, rz: 0.17 }, // neck base
    ], 24, 22),
    // Thin, stooped variant for the dead.
    torsoGaunt: loft([
      { y: -0.5, rx: 0.32, rz: 0.26 },
      { y: -0.4, rx: 0.36, rz: 0.28, back: 0.03 },
      { y: -0.2, rx: 0.3, rz: 0.24 }, // sunken belly
      { y: 0.05, rx: 0.4, rz: 0.3, p: 2.3, front: 0.05 }, // ribs showing
      { y: 0.25, rx: 0.45, rz: 0.32, p: 2.4, back: 0.08 }, // hunched back
      { y: 0.42, rx: 0.4, rz: 0.27, back: 0.06 },
      { y: 0.5, rx: 0.15, rz: 0.15 },
    ], 22, 20),
    // Hip (y -0.5) to knee (y 0.5). +z is the front for legs.
    thigh: loft([
      { y: -0.5, rx: 0.42, rz: 0.42 },
      { y: -0.3, rx: 0.46, rz: 0.44, front: 0.05 }, // quadriceps
      { y: 0.1, rx: 0.4, rz: 0.4, front: 0.04 },
      { y: 0.42, rx: 0.33, rz: 0.34, front: 0.02 }, // above the knee
      { y: 0.5, rx: 0.32, rz: 0.33, front: 0.04 }, // kneecap
    ], 18, 14),
    // Knee to ankle: the calf swells behind.
    shin: loft([
      { y: -0.5, rx: 0.42, rz: 0.42 },
      { y: -0.25, rx: 0.44, rz: 0.4, back: 0.12 }, // calf
      { y: 0.15, rx: 0.36, rz: 0.34, back: 0.04 },
      { y: 0.5, rx: 0.28, rz: 0.28 }, // ankle
    ], 18, 12),
    // Shoulder to elbow.
    upperArm: loft([
      { y: -0.5, rx: 0.46, rz: 0.46 }, // deltoid
      { y: -0.28, rx: 0.44, rz: 0.42, front: 0.06 }, // biceps
      { y: 0.2, rx: 0.38, rz: 0.36, back: 0.04 }, // triceps
      { y: 0.5, rx: 0.34, rz: 0.34 },
    ], 16, 12),
    // Elbow to wrist: thick near the elbow, slim at the wrist.
    forearm: loft([
      { y: -0.5, rx: 0.42, rz: 0.4 },
      { y: -0.25, rx: 0.46, rz: 0.42, p: 2.2 },
      { y: 0.25, rx: 0.36, rz: 0.32 },
      { y: 0.5, rx: 0.3, rz: 0.24, p: 2.3 },
    ], 16, 12),
    // Hand: wrist (y -0.5) to fingertips (y 0.5), flat across the palm, with the thumb side bulging.
    hand: loft([
      { y: -0.5, rx: 0.28, rz: 0.2 },
      { y: -0.25, rx: 0.42, rz: 0.22, p: 2.6, dx: 0.06 }, // heel of the hand and thumb
      { y: 0.05, rx: 0.46, rz: 0.2, p: 3 }, // knuckles
      { y: 0.3, rx: 0.42, rz: 0.17, p: 3 }, // fingers
      { y: 0.5, rx: 0.32, rz: 0.12, p: 2.4 },
    ], 16, 12),
    // Neck.
    neck: loft([{ y: -0.5, rx: 0.48, rz: 0.46 }, { y: 0, rx: 0.42, rz: 0.42, front: 0.04 }, { y: 0.5, rx: 0.4, rz: 0.4 }], 14, 6),
    // Boot: heel (y -0.5) to toe (y 0.5), lying flat; +z is up. A thick sole, a raised ankle cuff.
    boot: loft([
      { y: -0.5, rx: 0.3, rz: 0.36, p: 3, dz: 0.06 },
      { y: -0.35, rx: 0.36, rz: 0.48, p: 3.2, dz: 0.12 }, // heel and ankle cuff
      { y: -0.05, rx: 0.4, rz: 0.4, p: 3.2, dz: 0.04 },
      { y: 0.25, rx: 0.44, rz: 0.3, p: 3, dz: -0.05 }, // ball of the foot
      { y: 0.5, rx: 0.32, rz: 0.2, p: 2.6, dz: -0.1 }, // toe cap
    ], 18, 12),
    head: headMesh(0),
    headDead: headMesh(1),
    gear: gearMesh(),
    // Helmet shell: a dome cut off above the ears, with a slight flare at the rim.
    helmet: sculpt((x, y, z) => (y < -0.25 ? 0.62 + 0.35 * (y + 1) : 1 + 0.04 * Math.max(0, z) - 0.04 * x * x)),
  };
}
