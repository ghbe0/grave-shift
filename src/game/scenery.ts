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
  private glow = new Batch();
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
      this.architecture();
      this.backdrop();
      this.markings();
      this.walls();
      this.ground();
    }
  }

  /** What kind of building a wall cell belongs to: blocks of about 10 m share a style and height. */
  private building(x: number, z: number): { style: number; extra: number; warm: boolean } {
    const bx = Math.floor(x / 10), bz = Math.floor(z / 10);
    let h = Math.imul(bx * 73856093 ^ bz * 19349663 ^ (this.site.seed + 7) * 83492791, 2654435761) >>> 0;
    h ^= h >>> 15;
    const r = (n: number) => ((h >>> n) & 255) / 255;
    // 0 bare concrete, 1 brick, 2 corrugated steel.
    return { style: r(0) < 0.3 ? 0 : r(0) < 0.72 ? 1 : 2, extra: r(8) < 0.25 ? 0 : 1.5 + Math.floor(r(16) * 4) * 1.4, warm: r(24) < 0.5 };
  }

  /**
   * Turns the enclosing walls into buildings: brick and corrugated-steel facades with windows,
   * doors and downpipes, and upper storeys with parapets, roof plant and chimneys at different
   * heights, so the skyline is no longer one flat line of concrete.
   */
  private architecture(): void {
    const s = this.site;
    const H = 7;
    const BRICK: RGB = [1.25, 1.0, 0.9], STEEL: RGB[] = [[0.55, 0.62, 0.66], [0.62, 0.5, 0.42], [0.45, 0.55, 0.5]];
    // Upper storeys and roofs over every wall cell.
    for (let x = 1; x < s.size[0]; x += 2) {
      for (let z = 1; z < s.size[1]; z += 2) {
        if (!s.wallAt(x, z)) continue;
        const b = this.building(x, z);
        if (b.extra <= 0) continue;
        const tint: RGB = b.style === 1 ? BRICK : b.style === 2 ? STEEL[(Math.floor(x / 10) + Math.floor(z / 10)) % 3] : [0.95, 0.95, 0.95];
        const layer = b.style === 1 ? MAT.brick : b.style === 2 ? MAT.painted : MAT.concrete;
        this.cube.box(x, H + b.extra / 2, z, 2, b.extra, 2, tint, layer);
        this.cube.box(x, H + b.extra + 0.12, z, 2.12, 0.24, 2.12, [0.7, 0.7, 0.7], MAT.concrete); // parapet
        const roll = this.rnd();
        if (roll < 0.06) {
          // Roof plant: an air handler with a vent stack.
          this.cube.box(x, H + b.extra + 0.75, z, 1.3, 1.0, 1.1, [0.75, 0.78, 0.8], MAT.painted, 0, 0, this.range(0, 0.4));
          this.cylinder.box(x + 0.3, H + b.extra + 1.6, z, 0.3, 0.8, 0.3, [0.8, 0.8, 0.8], MAT.gunmetal);
        } else if (roll < 0.1) {
          this.cube.box(x, H + b.extra + 1.0, z, 0.7, 1.8, 0.7, b.style === 1 ? BRICK : [0.8, 0.8, 0.8], b.style === 1 ? MAT.brick : MAT.concrete); // chimney
        } else if (roll < 0.13) {
          // Water tank on legs.
          this.cylinder.box(x, H + b.extra + 1.9, z, 1.5, 1.6, 1.5, [0.9, 0.9, 0.9], MAT.rust);
          for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) this.cylinder.box(x + dx, H + b.extra + 0.6, z + dz, 0.08, 1.1, 0.08, [0.6, 0.6, 0.6], MAT.gunmetal);
        } else if (roll < 0.16) {
          this.cylinder.box(x, H + b.extra + 1.7, z, 0.05, 3, 0.05, [0.7, 0.7, 0.7], MAT.gunmetal); // aerial
        }
      }
    }
    // Facades on every wall face that looks onto open floor.
    for (const w of this.wallSpots()) {
      const b = this.building(w.x - w.nx, w.z - w.nz);
      const yaw = w.nx !== 0 ? Math.PI / 2 : 0;
      const at = (d: number, out: number): [number, number] => [w.x + w.nz * d + w.nx * out, w.z + w.nx * d + w.nz * out];
      const panel = (d: number, y: number, out: number, wd: number, ht: number, th: number, c: ArrayLike<number>, layer: number, glow = 0, rough = 1, metal = 0) => {
        const [px, pz] = at(d, out);
        (glow > 0 ? this.glow : this.cube).box(px, y, pz, wd, ht, th, c, layer, glow, glow > 0 ? FLAG_NOSHADOW : 0, yaw, 0, 0, metal, rough);
      };
      if (b.style === 0) continue;
      if (b.style === 1) {
        panel(0, 3.9, 0.035, 2.0, 6.3, 0.07, BRICK, MAT.brick);
        // Stone string course between the floors.
        panel(0, 3.55, 0.07, 2.0, 0.16, 0.14, [0.85, 0.83, 0.8], MAT.concrete);
      } else {
        const tint = STEEL[(Math.floor((w.x - w.nx) / 10) + Math.floor((w.z - w.nz) / 10)) % 3];
        panel(0, 3.9, 0.03, 2.0, 6.3, 0.06, tint, MAT.painted);
        for (let k = -4; k <= 4; k++) panel(k * 0.22, 3.9, 0.07, 0.07, 6.3, 0.05, [tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8], MAT.painted); // ribs
      }
      // One feature per face, chosen from its position so it never changes.
      const pick = ((Math.floor(w.x) * 31 + Math.floor(w.z) * 17 + (w.nx + 1) * 5 + (w.nz + 1) * 3) >>> 0) % 10;
      const frame: RGB = b.style === 1 ? [0.85, 0.85, 0.82] : [0.3, 0.32, 0.35];
      const window = (y: number, lit: boolean) => {
        panel(0, y, 0.09, 1.3, 1.5, 0.1, frame, MAT.painted);
        const glass: RGB = lit ? (b.warm ? [1, 0.75, 0.42] : [0.6, 0.8, 1]) : [0.03, 0.04, 0.05];
        panel(0, y, 0.15, 1.1, 1.3, 0.03, glass, -1, lit ? 1.6 : 0, 0.06);
        panel(0, y, 0.17, 0.05, 1.3, 0.03, frame, MAT.painted); // mullion
        panel(0, y, 0.17, 1.1, 0.05, 0.03, frame, MAT.painted); // transom
        panel(0, y - 0.8, 0.14, 1.45, 0.08, 0.22, [0.8, 0.8, 0.78], MAT.concrete); // sill
      };
      if (pick < 4) {
        window(5.1, ((pick * 7 + Math.floor(w.x + w.z)) % 5) === 0);
        if (b.style === 1 && pick < 2) window(2.1, false);
      } else if (pick === 4) {
        // A steel door with a lamp bracket above it.
        panel(0, 1.12, 0.09, 1.1, 2.2, 0.08, [0.35, 0.42, 0.4], MAT.painted);
        panel(0, 2.3, 0.1, 1.3, 0.12, 0.14, frame, MAT.painted);
        panel(0.38, 1.1, 0.14, 0.05, 0.16, 0.05, [0.8, 0.8, 0.8], MAT.gunmetal);
      } else if (pick === 5) {
        // Downpipe from the gutter.
        const [px, pz] = at(0.7, 0.12);
        this.cylinder.box(px, 3.6, pz, 0.12, 6.8, 0.12, [0.5, 0.52, 0.55], MAT.painted);
        for (const y of [1.2, 3.4, 5.6]) panel(0.7, y, 0.1, 0.2, 0.06, 0.2, [0.4, 0.4, 0.4], MAT.gunmetal);
      } else if (pick === 6 && b.style === 2) {
        // Roller shutter.
        panel(0, 1.6, 0.09, 1.9, 3.2, 0.08, [0.6, 0.62, 0.6], MAT.gunmetal);
        for (let y = 0.2; y < 3.2; y += 0.25) panel(0, y, 0.14, 1.9, 0.04, 0.03, [0.4, 0.4, 0.4], MAT.gunmetal);
      } else if (pick === 7) {
        // Electrical cabinet with conduit.
        panel(-0.3, 1.4, 0.14, 0.6, 0.9, 0.24, [0.55, 0.6, 0.58], MAT.painted);
        const [px, pz] = at(-0.3, 0.1);
        this.cylinder.box(px, 4.4, pz, 0.05, 5.1, 0.05, [0.7, 0.7, 0.7], MAT.gunmetal);
      }
    }
  }

  /** The world beyond the walls: neighbouring blocks, chimney stacks, a crane and a tree line. */
  private backdrop(): void {
    const s = this.site;
    const r = rng(77 + s.seed * 19);
    const range = (a: number, b: number) => a + (b - a) * r();
    const cx = s.size[0] / 2, cz = s.size[1] / 2;
    const reach = Math.max(s.size[0], s.size[1]) / 2;
    const count = 26;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + range(-0.08, 0.08);
      const d = reach + range(14, 46);
      const x = cx + Math.cos(a) * d * (s.size[0] / (reach * 2)) * 1.25, z = cz + Math.sin(a) * d * (s.size[1] / (reach * 2)) * 1.25;
      if (x > -4 && x < s.size[0] + 4 && z > -4 && z < s.size[1] + 4) continue;
      const kind = r();
      if (kind < 0.55) {
        // An office or tenement block with rows of windows, a few of them lit.
        const w = range(8, 16), h = range(11, 30), dp = range(8, 14), yaw = range(0, 3.14);
        const tone = range(0.5, 0.95);
        this.cube.box(x, h / 2, z, w, h, dp, [tone, tone * 0.97, tone * 0.93], r() < 0.5 ? MAT.concrete : MAT.brick, 0, 0, yaw);
        this.cube.box(x, h + 0.3, z, w + 0.4, 0.6, dp + 0.4, [0.6, 0.6, 0.6], MAT.concrete, 0, 0, yaw);
        const warm = r() < 0.6;
        for (let fy = 2.5; fy < h - 1.5; fy += 3.2) {
          for (const side of [-1, 1]) {
            for (let fx = -w / 2 + 1.4; fx < w / 2 - 1; fx += 2.4) {
              if (r() > 0.22) continue;
              const lx = fx, lz = side * (dp / 2 + 0.04);
              const wx = x + lx * Math.cos(yaw) + lz * Math.sin(yaw), wz = z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
              this.glow.box(wx, fy, wz, 1.2, 1.5, 0.06, warm ? [1, 0.74, 0.4] : [0.6, 0.8, 1], -1, 1.3, FLAG_NOSHADOW, yaw);
            }
          }
        }
      } else if (kind < 0.7) {
        // Chimney stack with warning bands.
        const h = range(26, 40);
        this.cylinder.box(x, h / 2, z, 3.2, h, 3.2, [1.1, 0.95, 0.85], MAT.brick);
        for (const f of [0.78, 0.9]) this.cylinder.box(x, h * f, z, 3.3, 1.2, 3.3, [0.8, 0.2, 0.15], MAT.painted);
        this.glow.box(x, h + 0.4, z, 0.4, 0.4, 0.4, [1, 0.15, 0.1], -1, 4, FLAG_NOSHADOW);
      } else if (kind < 0.78) {
        // Tower crane.
        const h = range(30, 40), yaw = range(0, 6.28), jib = 24;
        this.cube.box(x, h / 2, z, 1.2, h, 1.2, [0.95, 0.7, 0.1], MAT.painted);
        this.cube.box(x + Math.sin(yaw) * jib * 0.3, h, z + Math.cos(yaw) * jib * 0.3, 0.9, 0.9, jib, [0.95, 0.7, 0.1], MAT.painted, 0, 0, yaw);
        this.cube.box(x, h + 2, z, 0.6, 4, 0.6, [0.95, 0.7, 0.1], MAT.painted);
        this.glow.box(x, h + 4.2, z, 0.35, 0.35, 0.35, [1, 0.15, 0.1], -1, 4, FLAG_NOSHADOW);
      } else {
        // A stand of trees.
        for (let n = 0; n < 4; n++) {
          const tx = x + range(-7, 7), tz = z + range(-7, 7), h = range(7, 12);
          this.sphere.limb([tx, 0, tz], [tx, h * 0.6, tz], 0.3, BARK, MAT.bark);
          const tint = LEAF_TINTS[n % LEAF_TINTS.length];
          this.sphere.box(tx, h * 0.75, tz, h * 0.6, h * 0.55, h * 0.6, [tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7], MAT.leaves, 0, 0, range(0, 6.28));
          this.leaves.box(tx, h * 0.75, tz, h * 0.72, h * 0.66, h * 0.72, tint, MAT.leaves, 0, FLAG_FOLIAGE, range(0, 6.28));
        }
      }
    }
  }

  /** Paint and ironwork on the ground: lane and bay lines, hazard stripes, manholes and drains. */
  private markings(): void {
    const s = this.site;
    const paint: RGB = [0.75, 0.72, 0.6], yellow: RGB = [0.85, 0.65, 0.1];
    const clear = (x: number, z: number) => !s.solidAt(x, z);
    // A dashed centre line down the longest clear run of each row and column band.
    for (let z = 9; z < s.size[1] - 8; z += 12) {
      for (let x = 7; x < s.size[0] - 7; x += 3) {
        if (clear(x, z) && clear(x + 1, z) && clear(x - 1, z) && clear(x, z + 2) && clear(x, z - 2)) this.cube.box(x, 0.006, z, 1.6, 0.008, 0.14, paint, MAT.painted, 0, FLAG_NOSHADOW);
      }
    }
    // Parking bays against some walls.
    for (const w of this.wallSpots()) {
      const k = ((Math.floor(w.x / 2) * 13 + Math.floor(w.z / 2) * 7) >>> 0) % 9;
      const yaw = w.nx !== 0 ? Math.PI / 2 : 0;
      const at = (d: number, out: number): [number, number] => [w.x + w.nz * d + w.nx * out, w.z + w.nx * d + w.nz * out];
      if (k === 0 || k === 1) {
        const [px, pz] = at(1, 2.2);
        if (clear(px, pz)) this.cube.box(px, 0.006, pz, 0.12, 0.008, 4, paint, MAT.painted, 0, FLAG_NOSHADOW, yaw);
      } else if (k === 2) {
        // Hazard chevrons at the foot of the wall.
        for (let j = -3; j <= 3; j++) { const [px, pz] = at(j * 0.28, 0.45); if (clear(px, pz)) this.cube.box(px, 0.006, pz, 0.12, 0.008, 0.7, j % 2 ? yellow : [0.05, 0.05, 0.05], MAT.painted, 0, FLAG_NOSHADOW, yaw + 0.6); }
      } else if (k === 3) {
        // Drain grate.
        const [px, pz] = at(0, 0.5);
        if (clear(px, pz)) {
          this.cube.box(px, 0.008, pz, 0.9, 0.012, 0.4, [0.25, 0.25, 0.27], MAT.gunmetal, 0, FLAG_NOSHADOW, yaw);
          for (let j = -3; j <= 3; j++) { const [gx, gz] = at(j * 0.11, 0.5); this.cube.box(gx, 0.016, gz, 0.03, 0.006, 0.36, [0.02, 0.02, 0.02], -1, 0, FLAG_NOSHADOW, yaw); }
        }
      }
    }
    // Manhole covers.
    for (let k = 0; k < Math.round((s.size[0] * s.size[1]) / 420); k++) {
      const x = this.range(8, s.size[0] - 8), z = this.range(8, s.size[1] - 8);
      if (!clear(x, z) || !clear(x + 0.6, z) || !clear(x - 0.6, z) || !clear(x, z + 0.6) || !clear(x, z - 0.6)) continue;
      this.cylinder.box(x, 0.006, z, 0.9, 0.012, 0.9, [0.5, 0.5, 0.52], MAT.gunmetal, 0, FLAG_NOSHADOW);
      this.cylinder.box(x, 0.012, z, 0.7, 0.012, 0.7, [0.32, 0.32, 0.34], MAT.gunmetal, 0, FLAG_NOSHADOW);
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
    add(m.cube, this.glow, false);
  }
  get instanceCount(): number {
    return this.cube.n + this.sphere.n + this.cylinder.n + this.leaves.n + this.cones.n + this.rocks.n + this.tufts.n + this.glow.n;
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
