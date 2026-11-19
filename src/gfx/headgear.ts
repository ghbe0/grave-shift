// Head-fitted meshes for every customization option: helmets, caps, hats, hoods and hair, beards
// and stubble, masks and face paint, goggles, glasses and night vision.
//
// All are built in the head mesh's own unit space (the head is a sculpted sphere of radius about
// 0.5: x right, y up, the face looking down -z) and drawn with exactly the head's transform, so
// they sit on it the way real kit sits on a skull. Each piece that needs a second colour (a lens,
// a strap, a badge) is a separate mesh. Shapes follow the head's own surface (`headShape`), so a
// beanie hugs the cranium, a beard grows from the jaw and a helmet clears the brow.
import { headShape, pack } from './anatomy';
import { rng } from './nature';
import type { MeshData } from './renderer';

type V = [number, number, number];
const shape = headShape(0);
/** Head surface radius in a unit direction. */
const H = (d: V) => 0.5 * shape(d[0], d[1], d[2]);
const dirOf = (th: number, ph: number): V => [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)];
const add = (a: V, b: V, k = 1): V => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const deg = Math.PI / 180;

/** Collects triangles; normals are smoothed per vertex when packed. */
class Builder {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  vert(p: V, u = 0, v = 0): number { this.pos.push(p[0], p[1], p[2]); this.uv.push(u, v); return this.pos.length / 3 - 1; }
  quad(a: number, b: number, c: number, d: number, flip = false): void {
    if (flip) this.idx.push(a, c, b, a, d, c); else this.idx.push(a, b, c, a, c, d);
  }
  /**
   * A cap of the sphere of directions: for each longitude `ph`, latitude runs from `from(ph)` to
   * `to(ph)` (radians from the crown), at radius `r(dir, th, ph)`. Smooth cut edges, any shape.
   * `inner` adds the underside (reversed, slightly smaller) so it has thickness from below.
   */
  cap(r: (d: V, th: number, ph: number) => number, from: (ph: number) => number, to: (ph: number) => number, rings = 28, segs = 72, inner = 0, ph0 = 0, ph1 = Math.PI * 2): V[][] {
    const rows: V[][] = [];
    const start = this.pos.length / 3;
    for (let j = 0; j <= segs; j++) {
      const ph = ph0 + ((ph1 - ph0) * j) / segs, a = from(ph), b = to(ph);
      const col: V[] = [];
      for (let i = 0; i <= rings; i++) {
        const th = a + ((b - a) * i) / rings, d = dirOf(th, ph);
        const p: V = [d[0] * r(d, th, ph), d[1] * r(d, th, ph), d[2] * r(d, th, ph)];
        col.push(p);
        this.vert(p, j / segs, i / rings);
      }
      rows.push(col);
    }
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < rings; i++) {
        const a = start + j * (rings + 1) + i, b = a + rings + 1;
        this.quad(a, a + 1, b + 1, b);
      }
    }
    if (inner > 0) {
      const s2 = this.pos.length / 3;
      for (const col of rows) for (const p of col) this.vert([p[0] * (1 - inner), p[1] * (1 - inner), p[2] * (1 - inner)]);
      for (let j = 0; j < segs; j++) {
        for (let i = 0; i < rings; i++) {
          const a = s2 + j * (rings + 1) + i, b = a + rings + 1;
          this.quad(a, a + 1, b + 1, b, true);
        }
      }
    }
    return rows;
  }
  /** A round tube along a path. */
  tube(path: V[], radius: number | ((t: number) => number), sides = 8, ends = true): void {
    const n = path.length;
    if (n < 2) return;
    const start = this.pos.length / 3;
    let ref: V = [0, 1, 0];
    for (let i = 0; i < n; i++) {
      const t = norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
      if (Math.abs(t[0] * ref[0] + t[1] * ref[1] + t[2] * ref[2]) > 0.95) ref = [1, 0, 0];
      const a = norm(cross(t, ref)), b = cross(t, a);
      const rr = typeof radius === 'number' ? radius : radius(i / (n - 1));
      for (let k = 0; k <= sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        this.vert(add(add(path[i], a, Math.cos(ang) * rr), b, Math.sin(ang) * rr), k / sides, i / (n - 1));
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const a = start + i * (sides + 1) + k, b = a + sides + 1;
        this.quad(a, a + 1, b + 1, b);
      }
    }
    if (ends) {
      for (const [i, flip] of [[0, true], [n - 1, false]] as const) {
        const c = this.vert(path[i]);
        for (let k = 0; k < sides; k++) {
          const a = start + i * (sides + 1) + k;
          if (flip) this.idx.push(c, a + 1, a); else this.idx.push(c, a, a + 1);
        }
      }
    }
  }
  /** A box with half-extents along three axes, bevelled by `bevel` (as a fraction of the smallest side). */
  box(c: V, ax: V, ay: V, az: V, h: V): void {
    const corners: V[] = [];
    for (const sz of [-1, 1]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) corners.push(add(add(add(c, ax, sx * h[0]), ay, sy * h[1]), az, sz * h[2]));
    // Faces with their own vertices so edges stay crisp.
    const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const f of faces) {
      const v = f.map(i => this.vert(corners[i]));
      this.quad(v[0], v[1], v[2], v[3]);
    }
  }
  /** A ribbon (flat, two-sided) along a path, `width` across in the direction `side(t)`. */
  ribbon(path: V[], width: number | ((t: number) => number), side: (t: number, p: V) => V): void {
    const n = path.length;
    for (const flip of [false, true]) {
      const start = this.pos.length / 3;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1), w = typeof width === 'number' ? width : width(t), s = side(t, path[i]);
        this.vert(add(path[i], s, -w / 2), 0, t);
        this.vert(add(path[i], s, w / 2), 1, t);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = start + i * 2;
        this.quad(a, a + 1, a + 3, a + 2, flip);
      }
    }
  }
  /** A closed cylinder from a to b. */
  cyl(a: V, b: V, r: number, sides = 16): void { this.tube([a, b], r, sides, true); }
  /** A closed ellipsoid. */
  blob(c: V, rx: number, ry: number, rz: number, rings = 8, segs = 12): void {
    const start = this.pos.length / 3;
    for (let i = 0; i <= rings; i++) {
      for (let j = 0; j <= segs; j++) {
        const d = dirOf((i / rings) * Math.PI, (j / segs) * Math.PI * 2);
        this.vert([c[0] + d[0] * rx, c[1] + d[1] * ry, c[2] + d[2] * rz]);
      }
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) { const a = start + i * (segs + 1) + j, b = a + segs + 1; this.quad(a, b, b + 1, a + 1); }
  }
  /**
   * Hair: `count` tapered strands growing from random points of the head surface where `keep`
   * holds, each from the surface outward along `grow(dir, rand)`.
   */
  strands(seed: number, count: number, lift: number, keep: (d: V) => boolean, grow: (d: V, r: () => number) => { dir: V; length: number; width: number }): void {
    const r = rng(seed);
    let made = 0, tries = 0;
    while (made < count && tries < count * 30) {
      tries++;
      const d = norm([r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]);
      if (!keep(d)) continue;
      made++;
      const root: V = [d[0] * (H(d) + lift), d[1] * (H(d) + lift), d[2] * (H(d) + lift)];
      const g = grow(d, r);
      const mid = add(add(root, g.dir, g.length * 0.5), d, g.length * 0.08);
      const tip = add(root, g.dir, g.length);
      const across = norm(cross(g.dir, d));
      for (const flip of [false, true]) {
        const a = this.vert(add(root, across, -g.width)), b = this.vert(add(root, across, g.width));
        const c = this.vert(add(mid, across, g.width * 0.6)), e = this.vert(add(mid, across, -g.width * 0.6));
        const t = this.vert(tip);
        if (flip) { this.idx.push(a, e, b, b, e, c, e, t, c); } else { this.idx.push(a, b, e, b, c, e, e, c, t); }
      }
    }
  }
  done(): MeshData { return pack(this.pos, this.idx, this.uv); }
}

/** Points along the cut edge of a cap, pushed `out` from the surface. */
const edge = (rows: V[][], end: 'first' | 'last', out = 0): V[] => rows.map(col => { const p = end === 'last' ? col[col.length - 1] : col[0]; return add(p, norm(p), out); });

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0 at the back of the head (ph = 0), 1 at the face (ph = pi). */
const frontness = (ph: number) => 0.5 - 0.5 * Math.cos(ph);
/** 1 over the ears (ph = +-90 degrees), falling off either side. */
const earness = (ph: number) => Math.exp(-(((Math.abs(Math.atan2(Math.sin(ph), Math.cos(ph))) - Math.PI / 2) / 0.45) ** 2));

// ---- Helmets -------------------------------------------------------------------------------

function helmet(high: boolean): { shell: MeshData; trim: MeshData } {
  const s = new Builder(), t = new Builder();
  // The rim: low at the nape, high over the brow; a high-cut helmet is cut away over the ears.
  const cut = (ph: number) => lerp(112, 66, frontness(ph)) * deg - (high ? 26 * deg * earness(ph) : 4 * deg * earness(ph));
  const radius = (d: V) => H(d) * 1.13 + 0.025 + 0.02 * Math.max(0, d[1]);
  const rows = s.cap(radius, () => 0.001, cut, 30, 84, 0.06);
  // A rolled rubber edge trim round the rim, and the stiffening ridge running front to back.
  const rim = edge(rows, 'last', 0.004);
  t.tube([...rim, rim[0]], 0.026, 6, false);
  const ridge: V[] = [];
  for (let k = 0; k <= 16; k++) { const th = lerp(-55, 70, k / 16) * deg, d = dirOf(Math.abs(th), th < 0 ? Math.PI : 0); ridge.push(add([d[0], d[1], d[2]].map(v => v * (H(d) * 1.13 + 0.025 + 0.02 * Math.max(0, d[1]))) as V, d, 0.008)); }
  s.tube(ridge, 0.018, 6, false);
  // Accessory rails on both sides, with bolts; the night-vision shroud on the front; hook-and-loop
  // panels on top and back; a counterweight pouch at the back.
  for (const sd of [-1, 1]) {
    const rail: V[] = [];
    for (let k = 0; k <= 10; k++) {
      const ph = sd * lerp(55, 128, k / 10) * deg, th = cut(ph) - (high ? 14 : 18) * deg, d = dirOf(th, ph);
      rail.push(add(d.map(v => v * (H(d) * 1.13 + 0.025)) as V, d, 0.025));
    }
    t.tube(rail, 0.03, 4, true);
    for (const k of [2, 5, 8]) { const p = rail[k]; t.blob(add(p, norm(p), 0.028), 0.016, 0.016, 0.016, 4, 6); }
    // Pad bolts on the shell.
    const bd = dirOf(55 * deg, sd * 90 * deg);
    t.cyl(bd.map(v => v * (H(bd) * 1.13 + 0.03)) as V, bd.map(v => v * (H(bd) * 1.13 + 0.05)) as V, 0.025, 10);
  }
  {
    const d = dirOf(52 * deg, Math.PI), p = d.map(v => v * (H(d) * 1.13 + 0.045)) as V;
    const up = norm(cross(cross(d, [0, 1, 0]), d)), across: V = [1, 0, 0];
    t.box(p, across, up, d, [0.11, 0.07, 0.02]);
    t.box(add(p, d, 0.03), across, up, d, [0.05, 0.035, 0.022]); // the mount receiver
  }
  for (const [th, ph, w, h] of [[18, 0, 0.16, 0.12], [72, 0, 0.13, 0.09]] as const) {
    const d = dirOf(Math.max(th, 1) * deg, ph), p = d.map(v => v * (H(d) * 1.13 + 0.04)) as V;
    const up = norm(cross(cross(d, [0, 1, 0]), d)), across = norm(cross(up, d));
    s.box(p, across, Math.abs(d[1]) > 0.95 ? [0, 0, 1] : up, d, [w, h, 0.012]);
  }
  {
    const d = dirOf(100 * deg, 0), p = d.map(v => v * (H(d) * 1.13 + 0.07)) as V;
    t.box(p, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.12, 0.06, 0.05]);
  }
  // Chin strap harness: a strap from each side down round the jaw to a buckle under the chin.
  for (const sd of [-1, 1]) {
    const path: V[] = [[sd * 0.52, high ? 0.08 : -0.02, 0.08], [sd * 0.5, -0.18, -0.02], [sd * 0.42, -0.4, -0.18], [sd * 0.24, -0.54, -0.3], [sd * 0.02, -0.58, -0.32]];
    t.ribbon(path, 0.06, (_, p) => norm([0, -p[2] * 0.2, 1]));
    t.ribbon([[sd * 0.5, 0.04, 0.2], [sd * 0.46, -0.24, 0.16], [sd * 0.42, -0.4, -0.18]], 0.05, () => [0, 0, 1]);
  }
  t.box([0, -0.585, -0.32], [1, 0, 0], [0, 0, 1], [0, 1, 0], [0.05, 0.035, 0.015]);
  return { shell: s.done(), trim: t.done() };
}

/** Ear defenders with a headband and a boom microphone, worn under a high-cut helmet. */
function headset(): MeshData {
  const b = new Builder();
  for (const sd of [-1, 1]) {
    b.cyl([sd * 0.5, 0.0, 0.03], [sd * 0.66, 0.0, 0.03], 0.21, 20); // cup
    b.tube(Array.from({ length: 21 }, (_, k) => { const a = (k / 20) * Math.PI * 2; return [sd * 0.505, Math.cos(a) * 0.2, 0.03 + Math.sin(a) * 0.2] as V; }), 0.035, 6, false); // cushion
    b.box([sd * 0.67, 0.08, 0.03], [0, 0, 1], [0, 1, 0], [1, 0, 0], [0.06, 0.04, 0.02]); // volume knob housing
  }
  // Headband over the helmet, round its outside.
  const band: V[] = [];
  for (let k = 0; k <= 24; k++) { const a = lerp(-1, 1, k / 24) * 80 * deg; const d: V = [Math.sin(a), Math.cos(a), 0.05]; band.push(add(d.map(v => v * 0.68) as V, [0, -0.04, 0.03])); }
  b.ribbon(band, 0.07, () => [0, 0, 1]);
  // Boom mic from the left cup round to the mouth.
  const boom: V[] = [[-0.62, -0.08, -0.05], [-0.6, -0.22, -0.2], [-0.48, -0.34, -0.42], [-0.25, -0.38, -0.56], [-0.1, -0.36, -0.6]];
  b.tube(boom, 0.018, 6, false);
  b.blob([-0.08, -0.36, -0.6], 0.045, 0.04, 0.045);
  b.tube([[-0.6, -0.2, 0.08], [-0.55, -0.45, 0.12], [-0.4, -0.7, 0.15]], 0.016, 6, true); // cable
  return b.done();
}

// ---- Caps and hats -------------------------------------------------------------------------

function fieldCap(): MeshData {
  const b = new Builder();
  const top = 0.53;
  const cut = (ph: number) => lerp(96, 80, frontness(ph)) * deg;
  const r = (d: V) => { const base = H(d) * 1.07 + 0.02; return d[1] * base > top ? top / d[1] : base; };
  const rows = b.cap(r, () => 0.001, cut, 24, 72, 0.04);
  const rim = edge(rows, 'last');
  b.tube([...rim, rim[0]], 0.018, 6, false);
  // Brim: a stiff curved peak, two layers with a thick edge.
  const brim: V[][] = [];
  for (let j = 0; j <= 16; j++) {
    const ph = Math.PI + lerp(-1, 1, j / 16) * 62 * deg, d = dirOf(cut(ph), ph), e = d.map(v => v * r(d)) as V;
    const out = norm([d[0], 0, d[2]]), u = lerp(-1, 1, j / 16);
    const reach = 0.36 * (1 - 0.55 * u * u);
    brim.push([0, 0.25, 0.5, 0.75, 1].map(v => add(add(e, out, reach * v), [0, -1, 0], (0.03 + 0.05 * v * v) * (1 - 0.3 * u * u) + 0.02 * u * u * v)) as V[]);
  }
  for (const [off, flip] of [[0, false], [-0.02, true]] as const) {
    const start = b.pos.length / 3;
    for (const col of brim) for (const p of col) b.vert(add(p, [0, off, 0]));
    for (let j = 0; j < 16; j++) for (let i = 0; i < 4; i++) { const a = start + j * 5 + i, c = a + 5; b.quad(a, c, c + 1, a + 1, flip); }
  }
  b.tube(brim.map(col => add(col[4], [0, -0.01, 0])), 0.013, 6, false);
  // Panel seams up to a button on the crown; ventilation eyelets; the adjuster strap at the back.
  for (const ph of [Math.PI, Math.PI + 1.05, Math.PI - 1.05, 0.55, -0.55]) {
    const seam: V[] = [];
    for (let k = 0; k <= 10; k++) { const th = lerp(cut(ph) - 3 * deg, 6 * deg, k / 10), d = dirOf(th, ph); seam.push(add(d.map(v => v * r(d)) as V, d, 0.004)); }
    b.tube(seam, 0.008, 4, false);
  }
  b.cyl([0, top - 0.005, 0], [0, top + 0.03, 0], 0.035, 10);
  for (const sd of [-1, 1]) { const d = dirOf(40 * deg, Math.PI + sd * 1.5); b.cyl(d.map(v => v * r(d)) as V, d.map(v => v * (r(d) + 0.012)) as V, 0.02, 8); }
  { const d = dirOf(92 * deg, 0), p = d.map(v => v * (r(d) + 0.01)) as V; b.box(p, [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.13, 0.03, 0.01]); }
  return b.done();
}

function beanie(): MeshData {
  const b = new Builder();
  const cut = (ph: number) => lerp(104, 78, frontness(ph)) * deg;
  // Knit ribs run up from the band; the turned-up cuff stands proud; it peaks a little on top.
  const r = (d: V, th: number, ph: number) => {
    const cuff = th > cut(ph) - 20 * deg ? 0.035 : 0;
    return (H(d) * 1.06 + 0.02 + cuff) * (1 + 0.012 * Math.cos(ph * 44)) * (1 + 0.07 * Math.max(0, d[1]) ** 6);
  };
  const rows = b.cap(r, () => 0.001, cut, 34, 176, 0.05);
  const rim = edge(rows, 'last');
  b.tube([...rim, rim[0]], 0.03, 6, false);
  // The fold line of the cuff.
  const fold = rows.map(col => col[Math.round(col.length * 0.7)]);
  b.tube([...fold, fold[0]], 0.014, 5, false);
  return b.done();
}

function boonie(): { hat: MeshData; band: MeshData } {
  const b = new Builder(), bd = new Builder();
  const top = 0.56;
  const cut = (ph: number) => lerp(94, 82, frontness(ph)) * deg;
  const r = (d: V) => { const base = H(d) * 1.12 + 0.03; return d[1] * base > top ? top / d[1] : base; };
  b.cap(r, () => 0.001, cut, 24, 72, 0.04);
  // Hat band round the crown (second colour) with eyelets each side.
  bd.cap(d => r(d) + 0.012, ph => cut(ph) - 18 * deg, ph => cut(ph) - 2 * deg, 4, 72);
  for (const sd of [-1, 1]) for (const k of [-1, 1]) { const d = dirOf(50 * deg, sd * 90 * deg + k * 12 * deg); bd.tube(Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * Math.PI * 2; const p = d.map(v => v * (r(d) + 0.006)) as V; const u = norm(cross(d, [0, 1, 0])); return add(add(p, u, Math.cos(a) * 0.02), [0, 1, 0], Math.sin(a) * 0.02); }), 0.006, 4, false); }
  // Wide floppy brim, drooping and waving, with rings of stitching.
  const ringsN = 6, segs = 64;
  const brimPt = (j: number, v: number): V => {
    const ph = (j / segs) * Math.PI * 2, d = dirOf(cut(ph), ph), e = d.map(x => x * r(d)) as V;
    const out = norm([d[0], 0, d[2]]);
    return add(add(e, out, 0.36 * v), [0, -1, 0], 0.04 * v + 0.14 * v ** 1.6 + 0.04 * Math.sin(ph * 3 + 1) * v ** 2);
  };
  for (const [off, flip] of [[0, false], [-0.015, true]] as const) {
    const start = b.pos.length / 3;
    for (let j = 0; j <= segs; j++) for (let i = 0; i <= ringsN; i++) b.vert(add(brimPt(j, i / ringsN), [0, off, 0]));
    for (let j = 0; j < segs; j++) for (let i = 0; i < ringsN; i++) { const a = start + j * (ringsN + 1) + i, c = a + ringsN + 1; b.quad(a, c, c + 1, a + 1, flip); }
  }
  for (const v of [0.35, 0.65, 0.97]) b.tube(Array.from({ length: segs + 1 }, (_, j) => add(brimPt(j, v), [0, 0.006, 0])), v > 0.9 ? 0.012 : 0.006, 4, false);
  // Chin cord hanging loose under the jaw.
  bd.tube([[-0.58, -0.05, 0.02], [-0.45, -0.45, -0.12], [-0.2, -0.68, -0.22], [0.2, -0.68, -0.22], [0.45, -0.45, -0.12], [0.58, -0.05, 0.02]], 0.012, 5, false);
  bd.blob([0, -0.68, -0.22], 0.03, 0.04, 0.03);
  return { hat: b.done(), band: bd.done() };
}

function bandana(): MeshData {
  const b = new Builder();
  const cut = (ph: number) => lerp(102, 74, frontness(ph)) * deg;
  const r = (d: V, _th: number, ph: number) => (H(d) * 1.04 + 0.012) * (1 + 0.01 * Math.sin(ph * 9 + d[1] * 12));
  const rows = b.cap(r, () => 0.001, cut, 24, 72, 0.03);
  const rim = edge(rows, 'last');
  b.tube([...rim, rim[0]], 0.016, 5, false);
  // The knot at the back and two tails hanging from it.
  const kn: V = [0, -0.06, 0.6];
  b.blob(kn, 0.07, 0.05, 0.05);
  b.blob(add(kn, [0.05, -0.02, 0.02]), 0.05, 0.04, 0.04);
  for (const sd of [-1, 1]) {
    const path: V[] = [kn, add(kn, [sd * 0.06, -0.12, 0.05]), add(kn, [sd * 0.1, -0.26, 0.06]), add(kn, [sd * 0.13, -0.38, 0.04])];
    b.ribbon(path, t => 0.11 * (1 - t * 0.6), () => [1, 0, 0]);
  }
  return b.done();
}

function beret(): { beret: MeshData; badge: MeshData } {
  const b = new Builder(), g = new Builder();
  const cut = (ph: number) => lerp(86, 70, frontness(ph)) * deg;
  // A soft crown pulled down to the right, full and flat on top.
  const r = (d: V, th: number) => {
    const base = H(d) * 1.05 + 0.02;
    // Full and soft, pulled down over the right ear; flat on top and lower on that side.
    const swell = Math.max(0, Math.sin(th * 1.7)) * (0.05 + 0.2 * Math.max(0, d[0] + 0.2));
    const top = 0.43 - 0.08 * d[0];
    return Math.min(base + swell, top / Math.max(0.15, d[1]));
  };
  const rows = b.cap(r, () => 0.001, cut, 26, 72, 0.05);
  const rim = edge(rows, 'last');
  b.tube([...rim, rim[0]], 0.03, 6, false); // leather headband
  b.cyl([0.04, 0.5, 0.02], [0.04, 0.54, 0.02], 0.02, 8); // the little stalk on top
  // Badge over the left eye: a shield with a raised boss.
  const d = dirOf(58 * deg, Math.PI - 0.45), p = d.map(v => v * (r(d, 58 * deg) + 0.02)) as V;
  const up = norm(cross(cross(d, [0, 1, 0]), d)), across = norm(cross(up, d));
  g.box(p, across, up, d, [0.055, 0.07, 0.012]);
  g.blob(add(p, d, 0.015), 0.03, 0.03, 0.012);
  return { beret: b.done(), badge: g.done() };
}

function hood(): MeshData {
  const b = new Builder();
  // Open at the face from the forehead to under the chin; drapes to the shoulders behind.
  const opening = (ph: number) => { const f = Math.abs(Math.atan2(Math.sin(ph), Math.cos(ph))); const fromFront = Math.PI - f; return fromFront < 0.95 ? lerp(42, 150, (fromFront / 0.95) ** 1.6) * deg : 165 * deg; };
  const r = (d: V, th: number, ph: number) => {
    const drape = Math.max(0, th - 95 * deg) * (0.45 + 0.4 * (1 - frontness(ph)));
    return (H(d) * 1.18 + 0.05 + drape * 0.25) * (1 + 0.015 * Math.sin(ph * 7 + th * 5));
  };
  const rows = b.cap(r, () => 0.001, opening, 32, 96, 0.04);
  // A thick hem round the face opening, and drawstrings.
  const hem = edge(rows, 'last').filter((_, j) => { const ph = (j / 96) * Math.PI * 2; return Math.PI - Math.abs(Math.atan2(Math.sin(ph), Math.cos(ph))) < 1.05; });
  hem.sort((a, c) => Math.atan2(a[0], -a[2]) - Math.atan2(c[0], -c[2]));
  b.tube(hem, 0.03, 6, false);
  for (const sd of [-1, 1]) {
    const top: V = [sd * 0.42, -0.42, -0.3];
    b.tube([top, add(top, [0, -0.15, -0.03]), add(top, [sd * 0.02, -0.3, -0.04]), add(top, [sd * 0.03, -0.42, -0.02])], 0.012, 5, false);
    b.blob(add(top, [sd * 0.03, -0.45, -0.02]), 0.025, 0.04, 0.025);
  }
  return b.done();
}

function hair(): MeshData {
  const b = new Builder();
  // Hairline: forehead in front, above the ears, low at the nape.
  const line = (ph: number) => lerp(118, 48, frontness(ph)) * deg - 22 * deg * earness(ph);
  b.cap((d, th) => H(d) * 1.01 + 0.006 + 0.008 * Math.sin(th * 30) * Math.sin(Math.atan2(d[0], d[2]) * 23), () => 0.001, line, 22, 64);
  // Thousands of short strands combed back and down, longer on top.
  const inside = (d: V) => { const th = Math.acos(Math.max(-1, Math.min(1, d[1]))), ph = Math.atan2(d[0], d[2]); return th < line(ph) - 2 * deg; };
  b.strands(41, 2400, 0.004, inside, (d, r) => {
    // Combed back and down: the direction (0, -0.4, 1) laid flat along the scalp.
    const g: V = [0, -0.4, 1], k = g[0] * d[0] + g[1] * d[1] + g[2] * d[2];
    const back = norm(sub(g, [d[0] * k, d[1] * k, d[2] * k]));
    const dir = norm(add(add(back, d, 0.6), [r() - 0.5, r() - 0.5, r() - 0.5], 0.5));
    return { dir, length: 0.03 + 0.04 * Math.max(0, d[1]) + r() * 0.02, width: 0.012 };
  });
  return b.done();
}

// ---- Faces ---------------------------------------------------------------------------------

/** Where a beard grows: jaw, chin and cheeks below the cheekbones, sideburns up to the ears. */
const beardZone = (d: V) => {
  const [x, y, z] = d;
  if (z > 0.25) return false;
  const mouth = Math.abs(x) < 0.26 && y > -0.42 && y < -0.24 && z < -0.75;
  if (mouth) return false;
  const jaw = y < -0.1 + 0.25 * Math.max(0, Math.abs(x) - 0.55) && y > -0.98;
  const sideburn = Math.abs(x) > 0.82 && y < 0.18 && z < 0.2 && z > -0.45;
  return jaw || sideburn;
};
const lipZone = (d: V) => Math.abs(d[0]) < 0.36 && d[1] > -0.3 && d[1] < -0.17 && d[2] < -0.8;

function beard(full: boolean): MeshData {
  const b = new Builder();
  const keep = (d: V) => beardZone(d) || lipZone(d);
  if (full) {
    b.strands(17, 6500, 0.0, keep, (d, r) => {
      const chin = Math.max(0, -d[1] - 0.6);
      const lip = lipZone(d);
      const dir = norm(lip ? [d[0] * 0.8, -1, -0.25] : add(add([0, -1, 0], d, 0.7 + r() * 0.3), [r() - 0.5, 0, r() - 0.5], 0.4));
      return { dir, length: lip ? 0.05 : 0.05 + chin * 0.2 + r() * 0.04, width: 0.013 };
    });
  } else {
    // Stubble: a dense, very short shadow of bristles.
    b.strands(19, 5200, 0.0, keep, (d, r) => ({ dir: norm(add(d, [0, -0.6, 0], 1 + r() * 0.3)), length: 0.009 + r() * 0.006, width: 0.006 }));
  }
  return b.done();
}

function moustache(): MeshData {
  const b = new Builder();
  b.strands(23, 1400, 0.0, lipZone, (d, r) => ({ dir: norm([d[0] * 1.6, -1, -0.15 + (r() - 0.5) * 0.2]), length: 0.045 + Math.abs(d[0]) * 0.08 + r() * 0.02, width: 0.012 }));
  return b.done();
}

function balaclava(): MeshData {
  const b = new Builder();
  // The whole head bar an eye slot, in rib knit, carried down over the neck.
  const r = (d: V, _th: number, ph: number) => (H(d) * 1.035 + 0.012) * (1 + 0.008 * Math.cos(ph * 60));
  const slot = (ph: number) => { const f = Math.PI - Math.abs(Math.atan2(Math.sin(ph), Math.cos(ph))); return f < 0.78 ? [74, 94] : null; };
  // Top part down to the slot, then the slot edges, then below the slot to the neck.
  b.cap(r, () => 0.001, ph => (slot(ph)?.[0] ?? 100) * deg, 24, 96);
  const low = b.cap(r, ph => (slot(ph)?.[1] ?? 100) * deg, () => 150 * deg, 24, 96);
  // Neck tube.
  const ring = edge(low, 'last');
  const neck: V[][] = [ring, ring.map(p => add([p[0] * 1.05, p[1], p[2] * 1.05], [0, -0.35, 0]))];
  const start = b.pos.length / 3;
  for (const row of neck) for (const p of row) b.vert(p);
  const n = ring.length;
  for (let j = 0; j < n - 1; j++) b.quad(start + j, start + n + j, start + n + j + 1, start + j + 1);
  // Hems round the eye slot.
  for (const th of [74, 94]) {
    const hem: V[] = [];
    for (let k = 0; k <= 20; k++) { const ph = Math.PI + lerp(-0.78, 0.78, k / 20), d = dirOf(th * deg, ph); hem.push(d.map(v => v * r(d, th * deg, ph)) as V); }
    b.tube(hem, 0.018, 5, false);
  }
  return b.done();
}

function facePaint(): { a: MeshData; b: MeshData } {
  const a = new Builder(), c = new Builder();
  // Diagonal bands of two colours across brow, cheeks and nose, leaving the eyes and mouth.
  for (const [bld, phase] of [[a, 0], [c, 0.5]] as const) {
    const keep = (d: V) => {
      if (d[2] > -0.35 || d[1] > 0.5 || d[1] < -0.62) return false;
      const s = d[0] * 0.85 + d[1] * 1.7;
      const f = ((s * 2.3 + phase) % 1 + 1) % 1;
      return f < 0.38;
    };
    // Fine grid of tiny surface quads where the band is.
    for (let i = 0; i < 90; i++) for (let j = 0; j < 90; j++) {
      const th = lerp(55, 150, i / 90) * deg, ph = Math.PI + lerp(-1.2, 1.2, j / 90);
      const corners = [[th, ph], [th + 1.06 * deg, ph], [th + 1.06 * deg, ph + 0.0267], [th, ph + 0.0267]].map(([t, p]) => dirOf(t, p));
      if (!corners.every(keep)) continue;
      const v = corners.map(d => bld.vert(d.map(x => x * (H(d) + 0.008)) as V));
      bld.quad(v[0], v[1], v[2], v[3]);
    }
  }
  return { a: a.done(), b: c.done() };
}

function respirator(): { body: MeshData; filters: MeshData } {
  const b = new Builder(), f = new Builder();
  // Moulded rubber body over nose and mouth, with a seal round its edge.
  const rows = b.cap((d, th) => H(d) * 1.02 + 0.03 + 0.09 * Math.sin(((th - 95 * deg) / (60 * deg)) * Math.PI) * Math.max(0, -d[2]), () => 95 * deg, () => 155 * deg, 14, 40, 0.05, Math.PI - 0.95, Math.PI + 0.95);
  for (const end of ['first', 'last'] as const) b.tube(edge(rows, end), 0.022, 5, false);
  b.tube(rows[0], 0.022, 5, false);
  b.tube(rows[rows.length - 1], 0.022, 5, false);
  // Exhale valve at the front and the filter cartridges on the cheeks.
  b.cyl([0, -0.36, -0.6], [0, -0.38, -0.7], 0.07, 14);
  for (let k = 0; k < 6; k++) b.box([0, -0.38 + (k - 2.5) * 0.02, -0.705], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.05, 0.004, 0.004]);
  for (const sd of [-1, 1]) {
    const base: V = [sd * 0.3, -0.3, -0.52], tip = add(base, norm([sd * 0.7, -0.35, -0.6]), 0.14);
    f.cyl(base, tip, 0.13, 20);
    f.tube(Array.from({ length: 21 }, (_, k) => { const a = (k / 20) * Math.PI * 2, ax = norm(sub(tip, base)), u = norm(cross(ax, [0, 1, 0])), w = cross(ax, u); return add(add(tip, u, Math.cos(a) * 0.13), w, Math.sin(a) * 0.13); }), 0.012, 4, false);
    // Head straps from the mask round the back of the head.
    for (const y of [0.15, -0.3]) {
      const strap: V[] = [];
      for (let k = 0; k <= 16; k++) { const ph = sd * lerp(130, 0, k / 16) * deg, d = norm([Math.sin(ph), y, Math.cos(ph)]); strap.push(d.map(v => v * (H(d) + 0.015)) as V); }
      b.ribbon(strap, 0.045, () => [0, 1, 0]);
    }
  }
  return { body: b.done(), filters: f.done() };
}

// ---- Eyewear -------------------------------------------------------------------------------

function goggles(): { lens: MeshData; frame: MeshData } {
  const l = new Builder(), fr = new Builder();
  const c: V = [0, 0.1, 0.02], R = 0.66;
  const rows = l.cap(() => R, () => 66 * deg, () => 97 * deg, 8, 30, 0, Math.PI - 0.82, Math.PI + 0.82);
  // The lens is a band of a sphere centred behind the eyes.
  for (let i = 0; i < l.pos.length; i += 3) { l.pos[i] += c[0]; l.pos[i + 1] += c[1] - 0.1; l.pos[i + 2] += c[2]; }
  const rim: V[] = [...rows.map(col => col[0]), ...rows.slice().reverse().map(col => col[col.length - 1])].map(p => add(p, [c[0], c[1] - 0.1, c[2]]));
  fr.tube([...rim, rim[0]], 0.035, 6, false);
  // Foam behind the frame to the face, and the strap round the back of the head.
  fr.ribbon(rows.map(col => add(col[Math.floor(col.length / 2)], [c[0], c[1] - 0.1 - 0.0, c[2] + 0.07])), 0.18, () => [0, 1, 0]);
  const strap: V[] = [];
  for (let k = 0; k <= 24; k++) { const ph = lerp(-125, 125, k / 24) * deg, d = norm([Math.sin(ph), 0.18, Math.cos(ph)]); strap.push(d.map(v => v * (H(d) + 0.02)) as V); }
  fr.ribbon(strap, 0.1, () => [0, 1, 0]);
  for (const sd of [-1, 1]) fr.box([sd * 0.56, 0.12, -0.18], [0, 0, 1], [0, 1, 0], [1, 0, 0], [0.06, 0.05, 0.02]); // strap clips
  return { lens: l.done(), frame: fr.done() };
}

function spectacles(heavy: boolean): { lens: MeshData; frame: MeshData } {
  const l = new Builder(), fr = new Builder();
  const lensR = heavy ? 0.13 : 0.11;
  for (const sd of [-1, 1]) {
    const c: V = [sd * 0.17, 0.1, -0.52 - Math.abs(sd) * 0.0];
    // A slightly curved lens, teardrop for shades, rounded rectangle for glasses.
    const outline: V[] = [];
    for (let k = 0; k <= 28; k++) {
      const a = (k / 28) * Math.PI * 2;
      const rx = lensR * (heavy ? 1 + 0.12 * Math.max(0, -Math.sin(a)) * (sd * Math.cos(a) > 0 ? 1.4 : 0.6) : 1.15), ry = lensR * (heavy ? 0.95 : 0.8);
      const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
      outline.push([c[0] + x, c[1] + y, c[2] - 0.02 + (x * x + y * y) * 1.2 + sd * x * 0.15]);
    }
    const centre = l.vert([c[0], c[1], c[2] - 0.03]);
    const ring = outline.map(p => l.vert(p));
    for (let k = 0; k < 28; k++) { l.idx.push(centre, ring[k + 1], ring[k], centre, ring[k], ring[k + 1]); }
    fr.tube(outline, heavy ? 0.018 : 0.011, 6, false);
    // Arm from the outer edge back to the ear.
    const hinge: V = [sd * (0.17 + lensR * 1.15), 0.13, -0.47];
    fr.tube([hinge, [sd * 0.47, 0.13, -0.3], [sd * 0.53, 0.11, -0.05], [sd * 0.52, 0.02, 0.08]], heavy ? 0.016 : 0.01, 6, true);
  }
  fr.tube([[-0.07, 0.15, -0.57], [0, 0.17, -0.585], [0.07, 0.15, -0.57]], heavy ? 0.016 : 0.011, 6, false); // bridge
  for (const sd of [-1, 1]) fr.blob([sd * 0.05, 0.05, -0.56], 0.015, 0.025, 0.012); // nose pads
  return { lens: l.done(), frame: fr.done() };
}

function nightVision(): { body: MeshData; glass: MeshData } {
  const b = new Builder(), g = new Builder();
  // Mount on the shroud, an arm, the bridge and two tubes flipped up in front of the helmet.
  const m: V = [0, 0.42, -0.6];
  b.box(m, [1, 0, 0], norm([0, 0.6, -0.8]), norm([0, 0.8, 0.6]), [0.06, 0.05, 0.04]);
  const pivot = add(m, [0, 0.06, -0.08]);
  b.cyl(add(pivot, [-0.07, 0, 0]), add(pivot, [0.07, 0, 0]), 0.03, 10);
  const up = norm([0, 0.85, -0.5]);
  const bridge = add(pivot, up, 0.12);
  b.box(bridge, [1, 0, 0], up, norm(cross([1, 0, 0], up)), [0.13, 0.06, 0.04]);
  for (const sd of [-1, 1]) {
    const back = add(bridge, [sd * 0.1, 0, 0]);
    const front = add(back, up, 0.3);
    b.cyl(add(back, up, -0.05), front, 0.07, 16);
    b.cyl(add(back, up, -0.09), add(back, up, -0.04), 0.075, 16); // eyecup
    for (let k = 1; k <= 3; k++) b.tube(Array.from({ length: 17 }, (_, i) => { const a = (i / 16) * Math.PI * 2, u: V = [1, 0, 0], w = norm(cross(up, u)); return add(add(add(back, up, 0.06 * k), u, Math.cos(a) * 0.074), w, Math.sin(a) * 0.074); }), 0.008, 4, false); // grip rings
    g.cyl(add(front, up, -0.005), add(front, up, 0.01), 0.06, 16);
  }
  b.box(add(bridge, norm(cross([1, 0, 0], up)), -0.06), [1, 0, 0], up, norm(cross([1, 0, 0], up)), [0.05, 0.05, 0.03]); // battery
  return { body: b.done(), glass: g.done() };
}

// ---- Face ----------------------------------------------------------------------------------

/** Eyeballs set in the sockets, irises with pupils, upper lids, lips and eyebrows of real hairs. */
function features(): { eyes: MeshData; iris: MeshData; lids: MeshData; lips: MeshData; brows: MeshData } {
  const eyes = new Builder(), iris = new Builder(), lids = new Builder(), lips = new Builder(), brows = new Builder();
  for (const sd of [-1, 1]) {
    const d = norm([sd * 0.33, 0.12, -0.93]);
    const c = d.map(v => v * (H(d) - 0.045)) as V;
    eyes.blob(c, 0.058, 0.05, 0.055, 10, 14);
    // Iris and pupil looking straight ahead.
    const front = add(c, [0, 0, -1], 0.051);
    iris.blob(front, 0.026, 0.026, 0.007, 6, 14);
    // Upper lid: a thick crease over the top of the eyeball; a thinner lower lid.
    const lid: V[] = [], low: V[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = lerp(200, 340, k / 10) * deg;
      lid.push(add(c, [Math.cos(a) * 0.075 * (sd > 0 ? -1 : 1) * -1, -Math.sin(a) * 0.05 + 0.006, -0.035 - Math.abs(Math.sin(a)) * 0.02]));
      low.push(add(c, [Math.cos(a) * 0.07 * (sd > 0 ? -1 : 1) * -1, Math.sin(a) * 0.05 - 0.004, -0.035 - Math.abs(Math.sin(a)) * 0.018]));
    }
    lids.tube(lid, 0.016, 6, true);
    lids.tube(low, 0.009, 5, true);
    // Eyebrow: short hairs on the brow ridge, swept outward.
    brows.strands(70 + sd, 220, 0.004, q => q[2] < -0.75 && q[1] > 0.27 && q[1] < 0.39 && sd * q[0] > 0.12 && sd * q[0] < 0.55 + 0 * (q[1] - 0.33), (_, r) => ({ dir: norm([sd * 0.9, 0.25 + (r() - 0.5) * 0.3, -0.3]), length: 0.035 + r() * 0.02, width: 0.009 }));
  }
  // Lips: fuller lower lip, a defined upper lip with a dip in the middle.
  const lipLine = (y: number, w: number, dip: number): V[] => Array.from({ length: 13 }, (_, k) => {
    const u = lerp(-1, 1, k / 12), d = norm([u * w, y - dip * Math.exp(-u * u * 20) + 0.04 * u * u, -0.9]);
    return d.map(v => v * (H(d) + 0.005)) as V;
  });
  lips.tube(lipLine(-0.3, 0.25, 0.02), t => 0.014 * Math.sin(Math.PI * (0.08 + t * 0.84)), 8, true);
  lips.tube(lipLine(-0.36, 0.22, -0.01), t => 0.018 * Math.sin(Math.PI * (0.08 + t * 0.84)), 8, true);
  return { eyes: eyes.done(), iris: iris.done(), lids: lids.done(), lips: lips.done(), brows: brows.done() };
}

/** Every head-fitted mesh, keyed by part name. */
export function headgearParts(): Record<string, MeshData> {
  const ft = features();
  const h = helmet(false), hh = helmet(true), bo = boonie(), be = beret(), fp = facePaint(), rs = respirator(), go = goggles(), sh = spectacles(true), gl = spectacles(false), nv = nightVision();
  return {
    hgHelmet: h.shell, hgHelmetTrim: h.trim, hgHigh: hh.shell, hgHighTrim: hh.trim, hgHeadset: headset(),
    hgCap: fieldCap(), hgBeanie: beanie(), hgBoonie: bo.hat, hgBoonieBand: bo.band, hgBandana: bandana(),
    hgBeret: be.beret, hgBadge: be.badge, hgHood: hood(), hgHair: hair(),
    fcStubble: beard(false), fcBeard: beard(true), fcMoustache: moustache(), fcBalaclava: balaclava(),
    fcPaintA: fp.a, fcPaintB: fp.b, fcMask: rs.body, fcFilters: rs.filters,
    ewGoggleLens: go.lens, ewGoggleFrame: go.frame, ewShadeLens: sh.lens, ewShadeFrame: sh.frame,
    ewGlassLens: gl.lens, ewGlassFrame: gl.frame, ewNvg: nv.body, ewNvgGlass: nv.glass,
    ftEyes: ft.eyes, ftIris: ft.iris, ftLids: ft.lids, ftLips: ft.lips, ftBrows: ft.brows,
  };
}
