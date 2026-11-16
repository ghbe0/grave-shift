// Scenery that makes a level read as a place rather than a set of boxes: trees, bushes, ivy,
// turf and grass breaking through the concrete, barrels, sandbags, boulders, pipes, puddles and
// litter. Trees, barrels, sandbags and boulders have collision in the simulation (map characters
// T, O, S and R arrive as boxes with materials 13 to 16); everything else is decoration, placed
// from a fixed seed so every player sees the same level.
import { coneMesh, lumpMesh, rng, tuftMesh } from '../gfx/nature';
import { FLAG_FOLIAGE, FLAG_NOSHADOW, MAT, type Draw, type Renderer } from '../gfx/renderer';
import { Batch, type V3 } from './batch';

type RGB = [number, number, number];
export const SCENERY_MATS = { tree: 13, barrels: 14, sandbags: 15, boulder: 16 };

const BARK: RGB = [1, 1, 1];
const LEAF_TINTS: RGB[] = [[1.5, 1.5, 1.4], [1.2, 1.6, 1.1], [1.7, 1.5, 0.9], [1.05, 1.4, 1.2]];
const PINE: RGB = [0.75, 1.2, 1.05];
const GRASS: RGB[] = [[0.08, 0.17, 0.04], [0.12, 0.22, 0.05], [0.16, 0.22, 0.07], [0.2, 0.2, 0.08]];
const LITTER: RGB[] = [[0.35, 0.2, 0.06], [0.42, 0.3, 0.08], [0.25, 0.13, 0.05], [0.3, 0.3, 0.1]];

export interface Site {
  boxes: Float32Array;
  size: [number, number];
  seed: number;
  /** 0..1: how much decoration to place (phones get less). */
  detail: number;
  solidAt(x: number, z: number): boolean;
  wallAt(x: number, z: number): boolean;
}

export class Scenery {
  private cube = new Batch();
  private sphere = new Batch();
  private cylinder = new Batch();
  private leaves = new Batch();
  private cones = new Batch();
  private rocks = new Batch();
  private tufts = new Batch();
  private meshes: { cube: number; sphere: number; cylinder: number; lump: number; cone: number; rock: number; tuft: number };
  private rnd: () => number;

  constructor(renderer: Renderer, cube: number, sphere: number, cylinder: number, private site: Site) {
    this.meshes = {
      cube, sphere, cylinder,
      lump: renderer.createMesh(lumpMesh(11, 0.5, 2.2)),
      cone: renderer.createMesh(coneMesh()),
      rock: renderer.createMesh(lumpMesh(23, 0.42, 1.3, 0.55, 9, 12)),
      tuft: renderer.createMesh(tuftMesh(5)),
    };
    this.rnd = rng(9001 + site.seed * 131);
    this.props();
    // Below a quarter detail (the ?low test switch on software renderers) only the props that
    // have collision are drawn.
    if (site.detail >= 0.25) {
      this.walls();
      this.ground();
    }
  }

  /** Draw calls for the static scenery, appended to the frame's instance buffer by `add`. */
  draws(add: (mesh: number, batch: Batch, shadow: boolean) => void): void {
    const m = this.meshes;
    add(m.cube, this.cube, true);
    add(m.sphere, this.sphere, true);
    add(m.cylinder, this.cylinder, true);
    add(m.lump, this.leaves, true);
    add(m.cone, this.cones, true);
    add(m.rock, this.rocks, true);
    add(m.tuft, this.tufts, false);
  }
  get instanceCount(): number {
    return this.cube.n + this.sphere.n + this.cylinder.n + this.leaves.n + this.cones.n + this.rocks.n + this.tufts.n;
  }

  private range(a: number, b: number): number { return a + (b - a) * this.rnd(); }
  private pick<T>(list: T[]): T { return list[Math.floor(this.rnd() * list.length) % list.length]; }

  /** A cluster of leaves: a ragged outer shell over a darker solid core, so gaps show depth, not sky. */
  private leafBall(x: number, y: number, z: number, r: number, tint: RGB, squash = 1): void {
    const yaw = this.range(0, 6.28), d = r * 2;
    this.sphere.box(x, y, z, d * 0.78, d * 0.78 * squash, d * 0.78, [tint[0] * 0.45, tint[1] * 0.45, tint[2] * 0.45], MAT.leaves, 0, 0, yaw);
    this.leaves.box(x, y, z, d * 1.15, d * 1.15 * squash, d * 1.15, tint, MAT.leaves, 0, FLAG_FOLIAGE, yaw, this.range(-0.4, 0.4), this.range(-0.4, 0.4));
  }

  private bush(x: number, z: number, size: number): void {
    const tint = this.pick(LEAF_TINTS);
    const n = 3 + Math.floor(this.rnd() * 3);
    for (let k = 0; k < n; k++) {
      const a = this.range(0, 6.28), d = k ? this.range(0.2, 0.55) * size : 0;
      const r = this.range(0.32, 0.55) * size;
      this.leafBall(x + Math.cos(a) * d, r * 0.8, z + Math.sin(a) * d, r, tint, 0.85);
    }
  }

  private broadleaf(x: number, z: number): void {
    const h = this.range(3.3, 4.3);
    const lean: [number, number] = [this.range(-0.35, 0.35), this.range(-0.35, 0.35)];
    const at = (t: number): V3 => [x + lean[0] * t * t, h * t, z + lean[1] * t * t];
    // Trunk in three tapering pieces, with a flare at the roots.
    const radii = [0.27, 0.22, 0.17, 0.13];
    for (let k = 0; k < 3; k++) this.sphere.limb(at(k / 3 - 0.02), at((k + 1) / 3), radii[k], BARK, MAT.bark, 0, radii[k + 1]);
    for (let k = 0; k < 4; k++) {
      const a = k * 1.57 + this.range(-0.5, 0.5);
      this.sphere.limb([x, 0.25, z], [x + Math.cos(a) * 0.55, -0.05, z + Math.sin(a) * 0.55], 0.1, BARK, MAT.bark);
    }
    const tint = this.pick(LEAF_TINTS);
    const top = at(1);
    // Boughs fan out from the upper trunk, each ending in a cluster of leaves.
    const boughs = 4 + Math.floor(this.rnd() * 2);
    for (let k = 0; k < boughs; k++) {
      const a = (k / boughs) * 6.28 + this.range(-0.4, 0.4);
      const from = at(this.range(0.6, 0.92));
      const reach = this.range(1.0, 1.7);
      const end: V3 = [from[0] + Math.cos(a) * reach, from[1] + this.range(0.5, 1.3), from[2] + Math.sin(a) * reach];
      this.sphere.limb(from, end, 0.085, BARK, MAT.bark, 0, 0.06);
      this.leafBall(end[0], end[1] + 0.25, end[2], this.range(0.85, 1.2), tint, 0.85);
    }
    this.leafBall(top[0], top[1] + 0.9, top[2], this.range(1.1, 1.45), tint, 0.9);
    this.leafBall(top[0] + this.range(-0.5, 0.5), top[1] + 1.7, top[2] + this.range(-0.5, 0.5), this.range(0.75, 1.0), tint, 0.9);
    // Smaller sprays around the edge break up the outline.
    for (let k = 0; k < Math.round(7 * Math.min(1, this.site.detail * 2)); k++) {
      const a = this.range(0, 6.28), d = this.range(1.3, 2.3);
      this.leafBall(top[0] + Math.cos(a) * d, top[1] + this.range(0.2, 1.9), top[2] + Math.sin(a) * d, this.range(0.4, 0.65), tint, 0.8);
    }
    this.underTree(x, z, tint);
  }

  private conifer(x: number, z: number): void {
    const h = this.range(5.6, 6.6);
    this.sphere.limb([x, -0.1, z], [x, h * 0.55, z], 0.2, BARK, MAT.bark, 0, 0.12);
    const tiers = 5;
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1);
      const y = 1.5 + t * (h - 2.3), w = (2.9 - t * 2.1) * this.range(0.9, 1.1), th = 1.9 - t * 0.5;
      const yaw = this.range(0, 6.28);
      this.cones.box(x, y + th / 2, z, w * 0.82, th * 0.9, w * 0.82, [PINE[0] * 0.4, PINE[1] * 0.4, PINE[2] * 0.4], MAT.leaves, 0, 0, yaw);
      this.cones.box(x, y + th / 2, z, w, th, w, PINE, MAT.leaves, 0, FLAG_FOLIAGE, yaw);
    }
    this.underTree(x, z, PINE);
  }

  /** Turf, grass, a bush or two and fallen leaves around the foot of a tree. */
  private underTree(x: number, z: number, tint: RGB): void {
    this.turf(x, z, this.range(1.7, 2.4));
    if (this.rnd() < 0.7) { const a = this.range(0, 6.28); this.bushIfClear(x + Math.cos(a) * 1.3, z + Math.sin(a) * 1.3, this.range(0.7, 1.0)); }
    const n = Math.round(22 * this.site.detail);
    for (let k = 0; k < n; k++) {
      const a = this.range(0, 6.28), d = this.range(0.4, 3.2);
      const lx = x + Math.cos(a) * d, lz = z + Math.sin(a) * d;
      if (this.site.solidAt(lx, lz)) continue;
      const c = tint === PINE ? LITTER[2] : this.pick(LITTER);
      this.cube.box(lx, 0.045, lz, 0.11, 0.006, 0.07, c, -1, 0, FLAG_NOSHADOW, this.range(0, 6.28), this.range(-0.15, 0.15));
    }
  }

  private bushIfClear(x: number, z: number, size: number): void {
    const s = this.site;
    if (x < 1 || z < 1 || x > s.size[0] - 1 || z > s.size[1] - 1 || s.solidAt(x, z)) return;
    this.bush(x, z, size);
  }

  /** A patch of earth and short grass: overlapping discs make an irregular outline. */
  private turf(x: number, z: number, r: number): void {
    const discs = 3 + Math.floor(this.rnd() * 2);
    for (let k = 0; k < discs; k++) {
      const a = this.range(0, 6.28), d = k ? this.range(0.3, 0.7) * r : 0, rr = (k ? this.range(0.45, 0.75) : 1) * r;
      const cx = x + Math.cos(a) * d, cz = z + Math.sin(a) * d;
      // Slightly different heights stop overlapping discs flickering against each other.
      this.cylinder.box(cx, 0.008 + this.cylinder.n % 7 * 0.003, cz, rr * 2, 0.03, rr * 2 * this.range(0.75, 1), [1.6, 1.6, 1.5], MAT.ground, 0, 0, this.range(0, 6.28));
      const tufts = Math.round(rr * rr * 5.5 * this.site.detail);
      for (let t = 0; t < tufts; t++) {
        const ta = this.range(0, 6.28), td = Math.sqrt(this.rnd()) * rr * 0.92;
        this.tuft(cx + Math.cos(ta) * td, cz + Math.sin(ta) * td, 1);
      }
    }
  }

  private tuft(x: number, z: number, size: number): void {
    if (this.site.solidAt(x, z)) return;
    const w = this.range(0.45, 0.85) * size, h = this.range(0.22, 0.55) * size;
    this.tufts.box(x, 0.02, z, w, h, w, this.pick(GRASS), -1, 0, FLAG_FOLIAGE, this.range(0, 6.28), 0, 0, 0, 0.75);
  }

  /** The props that have collision: drawn where the simulation put their boxes. */
  private props(): void {
    const b = this.site.boxes;
    for (let o = 0; o < b.length; o += 8) {
      const mat = b[o + 6];
      const x = (b[o] + b[o + 3]) / 2, z = (b[o + 2] + b[o + 5]) / 2;
      if (mat === SCENERY_MATS.tree) {
        if (this.rnd() < 0.3) this.conifer(x, z); else this.broadleaf(x, z);
      } else if (mat === SCENERY_MATS.barrels) {
        const paints: RGB[] = [[0.75, 0.2, 0.14], [0.2, 0.36, 0.6], [0.6, 0.55, 0.2], [0.35, 0.4, 0.35]];
        for (const dx of [-0.33, 0.33]) {
          const rusty = this.rnd() < 0.4;
          const c = rusty ? [1, 1, 1] : this.pick(paints);
          const layer = rusty ? MAT.rust : MAT.painted;
          this.cylinder.box(x + dx, 0.5, z + this.range(-0.03, 0.03), 0.6, 1.0, 0.6, c, layer, 0, 0, this.range(0, 6.28));
          for (const y of [0.04, 0.36, 0.68, 0.99]) this.cylinder.box(x + dx, y, z, 0.635, 0.035, 0.635, [0.8, 0.8, 0.8], MAT.gunmetal);
          this.cylinder.box(x + dx, 1.012, z, 0.56, 0.012, 0.56, [0.45, 0.45, 0.45], MAT.gunmetal);
          this.cylinder.box(x + dx + 0.14, 1.03, z + 0.1, 0.07, 0.03, 0.07, [0.3, 0.3, 0.3], MAT.gunmetal); // bung
        }
        this.tuft(x + 0.8, z + 0.3, 0.9);
      } else if (mat === SCENERY_MATS.sandbags) {
        const tan: RGB = [2.5, 2.15, 1.55];
        for (let row = 0; row < 3; row++) {
          const n = row === 1 ? 4 : 3, span = row === 1 ? 1.5 : 1.34;
          for (let k = 0; k < n; k++) {
            const bx = x + ((k / (n - 1) - 0.5) * span);
            const shade = this.range(0.82, 1.08);
            this.sphere.box(bx + this.range(-0.03, 0.03), 0.15 + row * 0.27, z + this.range(-0.05, 0.05), row === 1 ? 0.54 : 0.68, 0.32, 0.5, [tan[0] * shade, tan[1] * shade, tan[2] * shade], MAT.fabric, 0, 0, this.range(-0.12, 0.12));
          }
        }
      } else if (mat === SCENERY_MATS.boulder) {
        const stone: RGB = [1.25, 1.2, 1.1];
        this.rocks.box(x, 0.36, z, 1.5, 1.15, 1.25, stone, MAT.concrete, 0, 0, this.range(0, 6.28));
        this.rocks.box(x + this.range(0.5, 0.75), 0.16, z + this.range(-0.5, 0.5), 0.6, 0.45, 0.5, stone, MAT.concrete, 0, 0, this.range(0, 6.28));
        this.rocks.box(x - this.range(0.5, 0.7), 0.11, z + this.range(-0.4, 0.6), 0.4, 0.3, 0.36, stone, MAT.concrete, 0, 0, this.range(0, 6.28));
        // Moss on the shaded side.
        this.leaves.box(x - 0.1, 0.62, z + 0.05, 1.1, 0.5, 0.9, [0.7, 0.95, 0.5], MAT.leaves, 0, FLAG_FOLIAGE, this.range(0, 6.28));
        this.turf(x, z, 1.3);
      }
    }
  }

  /** Spots on the open side of a wall: position at the wall's face and the direction it faces. */
  private wallSpots(): { x: number; z: number; nx: number; nz: number }[] {
    const s = this.site, out = [];
    for (let x = 1; x < s.size[0]; x += 2) {
      for (let z = 1; z < s.size[1]; z += 2) {
        if (s.solidAt(x, z)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (s.wallAt(x + dx * 2, z + dz * 2) && !s.solidAt(x + dx * 0.9, z + dz * 0.9)) out.push({ x: x + dx, z: z + dz, nx: -dx, nz: -dz });
        }
      }
    }
    return out;
  }

  /** Ivy, pipes, weeds and rubble along the walls. */
  private walls(): void {
    const detail = this.site.detail;
    for (const w of this.wallSpots()) {
      const yaw = w.nx !== 0 ? Math.PI / 2 : 0; // long axis of a wall-hugging object
      const along = (d: number, out: number): [number, number] => [w.x + w.nz * d + w.nx * out, w.z + w.nx * d + w.nz * out];
      const roll = this.rnd();
      if (roll < 0.2 * detail) {
        // Ivy hanging from the top of the wall.
        // Several trailing strands of different lengths, thick at the top.
        const tint = this.pick(LEAF_TINTS), drop = this.range(2.0, 4.0);
        const strands = 4 + Math.floor(this.rnd() * 3);
        for (let k = 0; k < strands; k++) {
          const len = drop * this.range(0.35, 1), shade = this.range(0.75, 1.1);
          const [ix, iz] = along(this.range(-1.1, 1.1), 0.08);
          this.leaves.box(ix, 7.1 - len / 2, iz, this.range(0.5, 1.0), len, this.range(0.28, 0.4), [tint[0] * shade, tint[1] * shade, tint[2] * shade], MAT.leaves, 0, FLAG_FOLIAGE, yaw, 0, this.range(-0.12, 0.12));
        }
        const [cx, cz] = along(0, 0.1);
        this.leaves.box(cx, 6.85, cz, 2.3, 0.9, 0.5, tint, MAT.leaves, 0, FLAG_FOLIAGE, yaw);
      } else if (roll < 0.32 * detail) {
        // Creeper climbing from the ground, with weeds at its foot.
        const tint = this.pick(LEAF_TINTS), rise = this.range(1.6, 3.4);
        for (let k = 0; k < 4; k++) {
          const len = rise * this.range(0.4, 1), shade = this.range(0.75, 1.1);
          const [ix, iz] = along(this.range(-0.8, 0.8), 0.08);
          this.leaves.box(ix, len / 2 - 0.1, iz, this.range(0.6, 1.1), len, this.range(0.28, 0.4), [tint[0] * shade, tint[1] * shade, tint[2] * shade], MAT.leaves, 0, FLAG_FOLIAGE, yaw, 0, this.range(-0.15, 0.15));
        }
        for (let k = 0; k < 4; k++) { const [tx, tz] = along(this.range(-0.9, 0.9), this.range(0.25, 0.6)); this.tuft(tx, tz, 1.1); }
      } else if (roll < 0.42) {
        const [bx, bz] = along(this.range(-0.4, 0.4), this.range(0.55, 0.8));
        this.bushIfClear(bx, bz, this.range(0.7, 1.05));
      }
      // Weeds in the crack where wall meets floor.
      const weeds = Math.round(this.range(0, 3.4) * detail);
      for (let k = 0; k < weeds; k++) { const [tx, tz] = along(this.range(-1, 1), this.range(0.12, 0.3)); this.tuft(tx, tz, 0.7); }
      // Chips of fallen concrete.
      if (this.rnd() < 0.3) {
        const [rx, rz] = along(this.range(-0.9, 0.9), this.range(0.2, 0.6));
        const sz = this.range(0.12, 0.3);
        if (!this.site.solidAt(rx, rz)) this.rocks.box(rx, sz * 0.28, rz, sz * 1.3, sz, sz, [1.1, 1.08, 1.0], MAT.concrete, 0, 0, this.range(0, 6.28));
      }
      // A run of pipe high on some walls, on brackets.
      const h = (Math.floor(w.x / 2) * 7 + Math.floor(w.z / 2) * 13) % 5;
      if (h < 2) {
        const y = 4.6 + (h ? 0.35 : 0), [px, pz] = along(0, 0.16);
        this.cylinder.box(px, y, pz, 0.11, 2.02, 0.11, h ? [1, 1, 1] : [0.7, 0.75, 0.8], h ? MAT.rust : MAT.painted, 0, 0, yaw, 0, Math.PI / 2);
        this.cube.box(px - w.nx * 0.08, y - 0.02, pz - w.nz * 0.08, w.nx ? 0.2 : 0.05, 0.2, w.nz ? 0.2 : 0.05, [0.6, 0.6, 0.6], MAT.gunmetal);
      }
    }
  }

  /** Turf, weeds, puddles and litter scattered over the open floor. */
  private ground(): void {
    const s = this.site;
    const area = s.size[0] * s.size[1];
    const open = (x: number, z: number, margin: number) => !s.solidAt(x, z) && !s.solidAt(x + margin, z) && !s.solidAt(x - margin, z) && !s.solidAt(x, z + margin) && !s.solidAt(x, z - margin);
    const spot = (margin: number): [number, number] | null => {
      for (let tries = 0; tries < 12; tries++) {
        const x = this.range(7, s.size[0] - 7), z = this.range(7, s.size[1] - 7);
        if (open(x, z, margin)) return [x, z];
      }
      return null;
    };
    for (let k = 0; k < Math.round(area / 150); k++) {
      const p = spot(0.9);
      if (p) this.turf(p[0], p[1], this.range(0.9, 1.9));
    }
    // Puddles: thin, dark and glossy, so they mirror the sky and the lamps.
    for (let k = 0; k < Math.round(area / 260); k++) {
      const p = spot(1.2);
      if (!p) continue;
      const r = this.range(0.7, 1.5);
      for (let j = 0; j < 2; j++) this.cylinder.box(p[0] + j * this.range(-0.6, 0.6), 0.004 + j * 0.002, p[1] + j * this.range(-0.6, 0.6), r * (j ? 1.1 : 2), 0.01, r * (j ? 0.9 : 1.4), [0.035, 0.04, 0.045], -1, 0, 0, this.range(0, 6.28), 0, 0, 0, 0.05);
    }
    // Lone weeds pushing through cracks.
    for (let k = 0; k < Math.round((area / 9) * s.detail); k++) {
      const x = this.range(6.5, s.size[0] - 6.5), z = this.range(6.5, s.size[1] - 6.5);
      this.tuft(x, z, this.range(0.5, 0.9));
    }
  }
}

export function sceneryDraws(scenery: Scenery, draws: Draw[], out: Batch): void {
  scenery.draws((mesh, batch, shadow) => {
    if (!batch.n) return;
    draws.push({ mesh, first: out.n, count: batch.n, shadow });
    out.append(batch);
  });
}
