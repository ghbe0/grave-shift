// Scenery that makes a level read as a place rather than a set of boxes: trees, bushes, ivy,
// turf and grass breaking through the concrete, barrels, sandbags, boulders, pipes, puddles and
// litter. Trees, barrels, sandbags and boulders have collision in the simulation (map characters
// T, O, S and R arrive as boxes with materials 13 to 16); everything else is decoration, placed
// from a fixed seed so every player sees the same level.
import { clothMesh, coneMesh, frondMesh, grassClumpMesh, leafClusterMesh, lumpMesh, patchMesh, rng, weedMesh } from '../gfx/nature';
import { FLAG_CABLE, FLAG_CLOTH, FLAG_FOLIAGE, FLAG_GRASS, FLAG_NOSHADOW, FLAG_WATER, MAT, type Draw, type Renderer } from '../gfx/renderer';
import { Batch, type V3 } from './batch';

type RGB = [number, number, number];
export const SCENERY_MATS = { tree: 13, barrels: 14, sandbags: 15, boulder: 16 };

const BARK: RGB = [1, 1, 1];
const LEAF_TINTS: RGB[] = [[1.5, 1.5, 1.4], [1.2, 1.6, 1.1], [1.7, 1.5, 0.9], [1.05, 1.4, 1.2]];
const PINE: RGB = [0.75, 1.2, 1.05];
const GRASS: RGB[] = [[0.09, 0.19, 0.045], [0.13, 0.24, 0.06], [0.17, 0.24, 0.08], [0.22, 0.22, 0.09], [0.11, 0.2, 0.07]];
const WEED: RGB[] = [[0.1, 0.24, 0.06], [0.14, 0.28, 0.08], [0.08, 0.2, 0.07]];
const GRASSY = FLAG_FOLIAGE | FLAG_GRASS;
const LITTER: RGB[] = [[0.35, 0.2, 0.06], [0.42, 0.3, 0.08], [0.25, 0.13, 0.05], [0.3, 0.3, 0.1]];

export interface Site {
  boxes: Float32Array;
  size: [number, number];
  seed: number;
  /** 0 steelworks, 1 harbour, 2 town, 3 lunar. */
  theme: number;
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
  private clumps = new Batch();
  private clumpsB = new Batch();
  private weeds = new Batch();
  private patches = new Batch();
  private canopy = new Batch();
  private fronds = new Batch();
  private cloth = new Batch();
  private glow = new Batch();
  private meshes: { cube: number; sphere: number; cylinder: number; lump: number; cone: number; rock: number; clump: number; clumpB: number; weed: number; patch: number; canopy: number; frond: number; cloth: number };
  private rnd: () => number;

  constructor(renderer: Renderer, cube: number, sphere: number, cylinder: number, private site: Site) {
    this.meshes = {
      cube, sphere, cylinder,
      lump: renderer.createMesh(lumpMesh(11, 0.5, 2.2)),
      cone: renderer.createMesh(coneMesh()),
      rock: renderer.createMesh(lumpMesh(23, 0.42, 1.3, 0.55, 9, 12)),
      clump: renderer.createMesh(grassClumpMesh(5)),
      clumpB: renderer.createMesh(grassClumpMesh(17, 22)),
      weed: renderer.createMesh(weedMesh(3)),
      patch: renderer.createMesh(patchMesh(8)),
      canopy: renderer.createMesh(leafClusterMesh(21)),
      frond: renderer.createMesh(frondMesh(4)),
      cloth: renderer.createMesh(clothMesh()),
    };
    this.rnd = rng(9001 + site.seed * 131);
    this.props();
    // Below a quarter detail (the ?low test switch on software renderers) only the props that
    // have collision are drawn.
    if (site.detail >= 0.25) {
      if (site.theme === 3) {
        this.hull();
        this.moonscape();
      } else {
        this.architecture();
        this.backdrop();
        if (site.theme === 1) this.harbour();
        this.markings();
        this.walls();
        this.ground();
        this.cracks();
        this.litter();
        this.overhead();
      }
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

  /** Station equipment standing where another map would have trees, barrels, sandbags and boulders. */
  private lunarProp(mat: number, x: number, z: number): void {
    const WHITE: RGB = [1.5, 1.5, 1.5], FOIL: RGB = [1.3, 1.0, 0.4];
    if (mat === SCENERY_MATS.tree) {
      // Communications mast: a braced pole with a dish, a beacon and cross-arms.
      const h = this.range(5.2, 6.4);
      this.cylinder.box(x, h / 2, z, 0.16, h, 0.16, WHITE, MAT.painted);
      this.cylinder.box(x, 0.2, z, 0.7, 0.4, 0.7, [0.6, 0.6, 0.62], MAT.gunmetal);
      for (let k = 0; k < 3; k++) { const a = k * 2.094; this.sphere.limb([x + Math.cos(a) * 1.3, 0.05, z + Math.sin(a) * 1.3], [x, h * 0.6, z], 0.02, [0.7, 0.7, 0.7], MAT.gunmetal); }
      const yaw = this.range(0, 6.28);
      this.sphere.box(x + Math.sin(yaw) * 0.35, h * 0.82, z + Math.cos(yaw) * 0.35, 1.3, 1.3, 0.28, WHITE, MAT.painted, 0, 0, yaw, 0.35);
      this.cube.box(x, h * 0.55, z, 1.4, 0.05, 0.05, [0.7, 0.7, 0.7], MAT.gunmetal, 0, 0, yaw);
      this.glow.box(x, h + 0.1, z, 0.12, 0.12, 0.12, [1, 0.15, 0.1], -1, 6, FLAG_NOSHADOW);
    } else if (mat === SCENERY_MATS.barrels) {
      // Gas cylinders in a rack.
      for (const dx of [-0.33, 0.33]) {
        this.sphere.box(x + dx, 0.55, z, 0.5, 1.15, 0.5, dx < 0 ? WHITE : [1.4, 0.55, 0.2], MAT.painted);
        this.cylinder.box(x + dx, 1.08, z, 0.14, 0.12, 0.14, [0.7, 0.7, 0.7], MAT.gunmetal);
      }
      this.cube.box(x, 0.5, z, 1.34, 0.06, 0.7, [0.5, 0.5, 0.52], MAT.gunmetal);
    } else if (mat === SCENERY_MATS.sandbags) {
      // Cargo cases, strapped down.
      for (const [dx, w] of [[-0.55, 0.85], [0.42, 1.05]]) {
        this.cube.box(x + dx, 0.42, z, w, 0.84, 0.6, dx < 0 ? FOIL : WHITE, MAT.painted, 0, 0, this.range(-0.06, 0.06));
        this.cube.box(x + dx, 0.42, z, 0.08, 0.86, 0.62, [0.15, 0.15, 0.16], MAT.fabric);
      }
    } else if (mat === SCENERY_MATS.boulder) {
      const stone: RGB = [1.25, 1.24, 1.28];
      this.rocks.box(x, 0.36, z, 1.5, 1.15, 1.25, stone, MAT.concrete, 0, 0, this.range(0, 6.28));
      this.rocks.box(x + this.range(0.5, 0.75), 0.16, z + this.range(-0.5, 0.5), 0.6, 0.45, 0.5, stone, MAT.concrete, 0, 0, this.range(0, 6.28));
    }
  }

  /** Pressure-hull panelling, portholes, hatches and service runs on the outpost's modules. */
  private hull(): void {
    const s = this.site;
    const WHITE: RGB = [1.45, 1.45, 1.48], SEAM: RGB = [0.75, 0.77, 0.8], FOIL: RGB = [1.3, 1.0, 0.4];
    for (const w of this.wallSpots()) {
      const yaw = w.nx !== 0 ? Math.PI / 2 : 0;
      const at = (d: number, out: number): [number, number] => [w.x + w.nz * d + w.nx * out, w.z + w.nx * d + w.nz * out];
      const panel = (d: number, y: number, out: number, wd: number, ht: number, th: number, c: ArrayLike<number>, layer: number, glow = 0, rough = 1) => {
        const [px, pz] = at(d, out);
        (glow > 0 ? this.glow : this.cube).box(px, y, pz, wd, ht, th, c, layer, glow, glow > 0 ? FLAG_NOSHADOW : 0, yaw, 0, 0, 0, rough);
      };
      panel(0, 3.6, 0.03, 1.96, 6.8, 0.06, [0.8, 0.82, 0.85], -1, 0, 0.45); // clean composite plating
      for (const y of [1.2, 2.4, 3.6, 4.8, 6.0]) panel(0, y, 0.065, 2.0, 0.05, 0.03, SEAM, MAT.gunmetal);
      panel(0.98, 3.6, 0.07, 0.06, 6.8, 0.05, SEAM, MAT.gunmetal);
      panel(0, 0.25, 0.08, 2.0, 0.5, 0.08, [0.85, 0.62, 0.2], -1, 0, 0.25); // foil skirt
      const pick = ((Math.floor(w.x) * 29 + Math.floor(w.z) * 13 + (w.nx + 1) * 7 + (w.nz + 1)) >>> 0) % 9;
      const [px, pz] = at(0, 0.09);
      if (pick < 2) {
        // Porthole with a warm cabin light behind it.
        this.cylinder.box(px, 1.9, pz, 0.9, 0.08, 0.9, SEAM, MAT.gunmetal, 0, 0, yaw, Math.PI / 2);
        this.glow.box(px + w.nx * 0.03, 1.9, pz + w.nz * 0.03, 0.5, 0.5, 0.03, pick ? [1, 0.8, 0.5] : [0.5, 0.75, 1], -1, 1.4, FLAG_NOSHADOW, yaw);
      } else if (pick === 2) {
        // Radiator panel.
        panel(0, 4.4, 0.14, 1.5, 1.8, 0.06, [0.2, 0.22, 0.26], MAT.gunmetal);
        for (let k = -3; k <= 3; k++) panel(k * 0.2, 4.4, 0.18, 0.04, 1.8, 0.03, [0.6, 0.6, 0.62], MAT.gunmetal);
      } else if (pick === 3) {
        // Service hatch with a warning stripe and status light.
        panel(0, 1.2, 0.09, 1.0, 1.5, 0.06, [1.1, 1.1, 1.12], MAT.painted);
        panel(0, 2.02, 0.1, 1.0, 0.1, 0.06, [0.9, 0.7, 0.1], MAT.painted);
        panel(0.36, 1.2, 0.13, 0.08, 0.08, 0.04, [0.2, 1, 0.4], -1, 5);
      } else if (pick === 4) {
        const [qx, qz] = at(0, 0.16);
        this.cylinder.box(qx, 5.4, qz, 0.14, 2.02, 0.14, FOIL, MAT.painted, 0, 0, yaw, 0, Math.PI / 2); // insulated line
        this.cylinder.box(qx, 5.0, qz, 0.08, 2.02, 0.08, SEAM, MAT.gunmetal, 0, 0, yaw, 0, Math.PI / 2);
      } else if (pick === 5) {
        // Floodlight on an arm.
        const [qx, qz] = at(0, 0.5);
        this.cube.box((px + qx) / 2, 6.2, (pz + qz) / 2, w.nx ? 0.5 : 0.06, 0.06, w.nz ? 0.5 : 0.06, SEAM, MAT.gunmetal);
        this.glow.box(qx, 6.1, qz, 0.3, 0.12, 0.3, [0.9, 0.95, 1], -1, 6, FLAG_NOSHADOW);
      }
    }
    // Module roofs are domed: a shallow cap over each wall cell, plus tanks and dishes.
    for (let x = 1; x < s.size[0]; x += 2) {
      for (let z = 1; z < s.size[1]; z += 2) {
        if (!s.wallAt(x, z)) continue;
        const edge = x < 6 || z < 6 || x > s.size[0] - 6 || z > s.size[1] - 6;
        if (edge) continue; // the crater wall, dressed by the moonscape
        this.cube.box(x, 7.12, z, 2.1, 0.24, 2.1, SEAM, MAT.gunmetal);
        const roll = this.rnd();
        if (roll < 0.1) this.sphere.box(x, 7.7, z, 1.3, 1.2, 1.3, WHITE, MAT.painted);
        else if (roll < 0.16) { const yaw = this.range(0, 6.28); this.cylinder.box(x, 7.8, z, 0.1, 1.2, 0.1, SEAM, MAT.gunmetal); this.sphere.box(x, 8.5, z, 1.6, 1.6, 0.3, WHITE, MAT.painted, 0, 0, yaw, 0.6); }
        else if (roll < 0.22) this.cube.box(x, 7.5, z, 1.8, 0.06, 1.2, [0.1, 0.14, 0.35], MAT.gunmetal, 0, 0, 0, 0.5, 0, 0.6, 0.25); // solar panel
      }
    }
  }

  /** Outside the modules: the crater wall, craters, loose rock, a landing pad, Earth and the stars. */
  private moonscape(): void {
    const s = this.site;
    const ROCK: RGB = [1.2, 1.2, 1.24];
    const r = rng(404 + s.seed * 7);
    const range = (a: number, b: number) => a + (b - a) * r();
    const cx = s.size[0] / 2, cz = s.size[1] / 2;
    // The enclosing wall becomes a crater rim: boulders piled against and over it.
    for (let x = 1; x < s.size[0]; x += 2) {
      for (let z = 1; z < s.size[1]; z += 2) {
        const edge = x < 6 || z < 6 || x > s.size[0] - 6 || z > s.size[1] - 6;
        if (!edge || !s.wallAt(x, z)) continue;
        const h = range(7.5, 11);
        this.rocks.box(x + range(-0.4, 0.4), h * 0.45, z + range(-0.4, 0.4), range(3.4, 4.6), h, range(3.4, 4.6), ROCK, MAT.concrete, 0, 0, range(0, 6.28));
      }
    }
    // Distant ridges and peaks.
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * 6.28 + range(-0.1, 0.1), d = Math.max(s.size[0], s.size[1]) * 0.75 + range(10, 60);
      const h = range(10, 34);
      this.rocks.box(cx + Math.cos(a) * d, h * 0.3, cz + Math.sin(a) * d, range(30, 60), h, range(26, 50), [1.0, 1.0, 1.04], MAT.concrete, 0, 0, range(0, 6.28));
    }
    // Earth, a little above the horizon, and a field of stars.
    this.sphere.box(cx - 150, 120, cz - 260, 46, 46, 46, [0.12, 0.3, 0.75], -1, 0.9, FLAG_NOSHADOW);
    this.sphere.box(cx - 147, 124, cz - 255, 30, 16, 30, [0.8, 0.85, 0.9], -1, 0.8, FLAG_NOSHADOW, 0.5, 0.3); // cloud band
    for (let k = 0; k < 260; k++) {
      const a = range(0, 6.28), e = range(0.12, 1.5), d = 330;
      const sz = range(0.5, 1.5);
      this.glow.box(cx + Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d, cz + Math.sin(a) * Math.cos(e) * d, sz, sz, sz, [1, 1, range(0.8, 1)], -1, range(1.5, 4), FLAG_NOSHADOW);
    }
    // Craters and loose rock on the regolith.
    const open = (x: number, z: number) => !s.solidAt(x, z) && !s.solidAt(x + 1, z) && !s.solidAt(x - 1, z) && !s.solidAt(x, z + 1) && !s.solidAt(x, z - 1);
    const area = s.size[0] * s.size[1];
    for (let k = 0; k < Math.round(area / 90); k++) {
      const x = range(7, s.size[0] - 7), z = range(7, s.size[1] - 7);
      if (!open(x, z)) continue;
      const rad = range(0.7, 1.8);
      this.cylinder.box(x, 0.006, z, rad * 2, 0.012, rad * 2, [0.55, 0.55, 0.58], MAT.concrete, 0, FLAG_NOSHADOW);
      for (let j = 0; j < 9; j++) { const a = (j / 9) * 6.28; this.rocks.box(x + Math.cos(a) * rad, 0.03, z + Math.sin(a) * rad, rad * 0.75, 0.16, 0.3, ROCK, MAT.concrete, 0, 0, -a + 1.57); }
    }
    for (let k = 0; k < Math.round((area / 14) * s.detail); k++) {
      const x = range(6.5, s.size[0] - 6.5), z = range(6.5, s.size[1] - 6.5);
      if (s.solidAt(x, z)) continue;
      const sz = range(0.08, 0.3);
      this.rocks.box(x, sz * 0.3, z, sz * 1.3, sz, sz, ROCK, MAT.concrete, 0, 0, range(0, 6.28));
    }
    // Rover tracks and a landing pad marked out near the middle.
    for (let k = 0; k < 40; k++) {
      const x = range(8, s.size[0] - 8), z = range(8, s.size[1] - 8);
      if (open(x, z)) for (const d of [-0.5, 0.5]) this.cube.box(x, 0.005, z + d, 2.4, 0.008, 0.22, [0.6, 0.6, 0.63], MAT.concrete, 0, FLAG_NOSHADOW);
    }
    // Boot prints wandering between the modules: alternating left and right, slightly offset.
    for (let k = 0; k < Math.round(area / 160); k++) {
      let x = range(8, s.size[0] - 8), z = range(8, s.size[1] - 8), dir = range(0, 6.28);
      for (let st = 0; st < 22; st++) {
        dir += range(-0.25, 0.25);
        x += Math.cos(dir) * 0.38; z += Math.sin(dir) * 0.38;
        if (!open(x, z)) break;
        const sd = st % 2 ? 0.11 : -0.11;
        this.cube.box(x - Math.sin(dir) * sd, 0.004, z + Math.cos(dir) * sd, 0.27, 0.006, 0.11, [0.42, 0.42, 0.45], MAT.concrete, 0, FLAG_NOSHADOW, -dir);
      }
    }
    // Power and data lines snaking over the regolith between the modules.
    for (let k = 0; k < Math.round(area / 300); k++) {
      let x = range(8, s.size[0] - 8), z = range(8, s.size[1] - 8), dir = range(0, 6.28);
      const c: RGB = r() < 0.5 ? [0.08, 0.08, 0.09] : [0.9, 0.55, 0.1];
      for (let st = 0; st < 14; st++) {
        dir += range(-0.4, 0.4);
        const nx = x + Math.cos(dir) * 0.8, nz = z + Math.sin(dir) * 0.8;
        if (s.solidAt(nx, nz)) break;
        this.sphere.limb([x, 0.03, z], [nx, 0.03, nz], 0.03, c, MAT.polymer, 0, 0.025, [0, 1, 0], 1.2);
        x = nx; z = nz;
      }
    }
    // Supply cases and regolith ripples swept up against the hull.
    for (const w of this.wallSpots()) {
      if (r() < 0.12) {
        const [bx, bz] = [w.x + w.nx * 0.6 + w.nz * range(-0.6, 0.6), w.z + w.nz * 0.6 + w.nx * range(-0.6, 0.6)];
        if (open(bx, bz)) {
          const wd = range(0.5, 0.8);
          this.cube.box(bx, wd * 0.3, bz, wd, wd * 0.6, wd * 0.7, r() < 0.5 ? [1.4, 1.4, 1.42] : [1.3, 0.95, 0.35], MAT.painted, 0, 0, range(0, 6.28));
          this.cube.box(bx, wd * 0.62, bz, wd * 0.3, 0.02, wd * 0.05, [0.2, 0.2, 0.2], MAT.polymer, 0, 0, range(0, 6.28));
        }
      }
      if (r() < 0.5) this.rocks.box(w.x + w.nx * 0.35, 0.02, w.z + w.nz * 0.35, w.nx ? 0.6 : 2, 0.12, w.nx ? 2 : 0.6, ROCK, MAT.concrete, 0, 0, 0);
    }
    for (let j = 0; j < 20; j++) {
      const a = (j / 20) * 6.28, px = cx + Math.cos(a) * 3.2, pz = cz + Math.sin(a) * 3.2;
      if (!s.solidAt(px, pz)) { this.cube.box(px, 0.007, pz, 0.7, 0.01, 0.16, [0.9, 0.7, 0.1], MAT.painted, 0, FLAG_NOSHADOW, -a); if (j % 5 === 0) this.glow.box(px, 0.05, pz, 0.1, 0.06, 0.1, [0.3, 0.6, 1], -1, 5, FLAG_NOSHADOW); }
    }
  }

  /** The dock beyond the wall: a ship alongside, container stacks, gantry cranes and black water. */
  private harbour(): void {
    const s = this.site;
    const r = rng(808 + s.seed);
    const range = (a: number, b: number) => a + (b - a) * r();
    const L = s.size[0];
    // Water and a ship along the far (low z) side.
    this.cube.box(L / 2, -0.3, -70, 400, 0.2, 120, [0.02, 0.03, 0.05], -1, 0, FLAG_NOSHADOW, 0, 0, 0, 0.2, 0.08);
    const sx = L * 0.45, sz = -26;
    this.cube.box(sx, 6, sz, 70, 13, 13, [0.35, 0.1, 0.08], MAT.painted); // hull
    this.cube.box(sx, 13.2, sz, 70.4, 1.4, 13.4, [0.12, 0.12, 0.14], MAT.painted);
    this.cube.box(sx + 24, 19, sz, 12, 10, 11, [1.2, 1.2, 1.15], MAT.painted); // superstructure
    this.cylinder.box(sx + 26, 27, sz, 3, 6, 3, [0.9, 0.3, 0.1], MAT.painted); // funnel
    for (let k = 0; k < 9; k++) this.glow.box(sx + 19 + k * 1.2, 21, sz + 5.6, 0.6, 0.6, 0.05, [1, 0.8, 0.5], -1, 1.6, FLAG_NOSHADOW);
    const COLORS: RGB[] = [[0.7, 0.2, 0.15], [0.15, 0.35, 0.6], [0.2, 0.5, 0.3], [0.75, 0.55, 0.15], [0.5, 0.5, 0.52]];
    for (let k = 0; k < 12; k++) for (let lvl = 0; lvl < 2 + (k % 2); lvl++) this.cube.box(sx - 30 + k * 4.4, 15.3 + lvl * 2.6, sz + range(-2, 2), 4.2, 2.5, 6, COLORS[(k + lvl) % 5], MAT.painted);
    // Container stacks along the other sides.
    for (let k = 0; k < 16; k++) {
      const side = k % 3, along = range(-10, (side === 0 ? L : s.size[1]) + 10);
      const x = side === 0 ? along : side === 1 ? -range(12, 30) : L + range(12, 30);
      const z = side === 0 ? s.size[1] + range(12, 30) : along;
      const yaw = r() < 0.5 ? 0 : Math.PI / 2;
      for (let lvl = 0; lvl < 1 + Math.floor(r() * 4); lvl++) this.cube.box(x, 1.3 + lvl * 2.6, z, 12, 2.55, 2.45, COLORS[Math.floor(r() * 5)], MAT.painted, 0, 0, yaw + range(-0.03, 0.03));
    }
    // Gantry cranes over the quay.
    for (const gx of [L * 0.15, L * 0.8]) {
      const z = -8, Y: RGB = [0.95, 0.7, 0.1];
      for (const [dx, dz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) this.cube.box(gx + dx, 14, z + dz, 0.9, 28, 0.9, Y, MAT.painted);
      this.cube.box(gx, 28.5, z, 11.5, 1.6, 11.5, Y, MAT.painted);
      this.cube.box(gx, 30.5, z - 16, 2, 1.6, 46, Y, MAT.painted); // boom out over the ship
      this.cube.box(gx, 24, z - 26, 0.15, 12, 0.15, [0.2, 0.2, 0.2], MAT.gunmetal);
      this.glow.box(gx, 31.6, z - 38, 0.4, 0.4, 0.4, [1, 0.15, 0.1], -1, 4, FLAG_NOSHADOW);
      for (const dx of [-4, 4]) this.glow.box(gx + dx, 27.4, z + 5, 0.8, 0.3, 0.3, [1, 0.9, 0.7], -1, 5, FLAG_NOSHADOW);
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
    add(m.patch, this.patches, false);
    add(m.clump, this.clumps, false);
    add(m.clumpB, this.clumpsB, false);
    add(m.weed, this.weeds, false);
    add(m.canopy, this.canopy, true);
    add(m.frond, this.fronds, true);
    add(m.cloth, this.cloth, true);
    add(m.cube, this.glow, false);
  }
  get instanceCount(): number {
    return this.cube.n + this.sphere.n + this.cylinder.n + this.leaves.n + this.cones.n + this.rocks.n + this.clumps.n + this.clumpsB.n + this.weeds.n + this.patches.n + this.canopy.n + this.fronds.n + this.cloth.n + this.glow.n;
  }

  private range(a: number, b: number): number { return a + (b - a) * this.rnd(); }
  private pick<T>(list: T[]): T { return list[Math.floor(this.rnd() * list.length) % list.length]; }

  /** A cluster of leaves: a ragged outer shell over a darker solid core, so gaps show depth, not sky. */
  private leafBall(x: number, y: number, z: number, r: number, tint: RGB, squash = 1): void {
    const yaw = this.range(0, 6.28), d = r * 2;
    // A dark, solid heart so the crown never looks hollow, inside layered leaf cards that let
    // light and sky through at the edges.
    this.leaves.box(x, y, z, d * 0.68, d * 0.68 * squash, d * 0.68, [tint[0] * 0.4, tint[1] * 0.4, tint[2] * 0.4], MAT.leaves, 0, 0, yaw);
    // Real leaves round it; the tint varies a little from cluster to cluster.
    const shade = this.range(0.85, 1.12);
    this.canopy.box(x, y, z, d * 1.22, d * 1.22 * squash, d * 1.22, [tint[0] * 0.11 * shade, tint[1] * 0.22 * shade, tint[2] * 0.06 * shade], -1, 0, FLAG_FOLIAGE, yaw, this.range(-0.4, 0.4), this.range(-0.4, 0.4), 0, 0.7);
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
      // Twigs fork off each bough, each carrying a smaller spray.
      for (let j = 0; j < 2; j++) {
        const f = this.range(0.45, 0.8);
        const mid: V3 = [from[0] + (end[0] - from[0]) * f, from[1] + (end[1] - from[1]) * f, from[2] + (end[2] - from[2]) * f];
        const ta = a + (j ? 0.9 : -0.9) + this.range(-0.3, 0.3), tl = this.range(0.5, 0.9);
        const tip: V3 = [mid[0] + Math.cos(ta) * tl, mid[1] + this.range(0.1, 0.5), mid[2] + Math.sin(ta) * tl];
        this.sphere.limb(mid, tip, 0.04, BARK, MAT.bark, 0, 0.025);
        this.leafBall(tip[0], tip[1] + 0.1, tip[2], this.range(0.45, 0.7), tint, 0.85);
      }
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
    this.sphere.limb([x, h * 0.5, z], [x, h + 0.3, z], 0.12, BARK, MAT.bark, 0, 0.03);
    // A dark inner cone for density, then whorls of drooping boughs, long at the bottom and
    // short near the top.
    this.cones.box(x, 1.2 + (h - 1.2) / 2, z, 2.4, h - 1.0, 2.4, [PINE[0] * 0.3, PINE[1] * 0.3, PINE[2] * 0.3], MAT.leaves, 0, 0, this.range(0, 6.28));
    const whorls = 9;
    for (let k = 0; k < whorls; k++) {
      const t = k / (whorls - 1);
      const y = 1.3 + t * (h - 1.1), len = (1.9 - t * 1.55) * this.range(0.9, 1.1);
      const n = 7 + Math.round((1 - t) * 4);
      const turn = this.range(0, 6.28);
      for (let j = 0; j < n; j++) {
        const shade = this.range(0.8, 1.1);
        this.fronds.box(x, y, z, len, len, len, [PINE[0] * shade, PINE[1] * shade, PINE[2] * shade], MAT.leaves, 0, FLAG_FOLIAGE, turn + (j / n) * 6.28 + this.range(-0.15, 0.15), 0, this.range(-0.1, 0.2));
      }
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

  /**
   * A patch of earth and grass: ragged soil shapes, grass that is thick in the middle and thins
   * out at the edges, weeds among it, and the odd longer clump.
   */
  private turf(x: number, z: number, r: number): void {
    const pieces = 2 + Math.floor(this.rnd() * 2);
    for (let k = 0; k < pieces; k++) {
      const a = this.range(0, 6.28), d = k ? this.range(0.3, 0.6) * r : 0, rr = (k ? this.range(0.5, 0.8) : 1) * r;
      const cx = x + Math.cos(a) * d, cz = z + Math.sin(a) * d;
      const shade = this.range(0.85, 1.15);
      this.patches.box(cx, 0.002 + (this.patches.n % 7) * 0.002, cz, rr * 2.2, 1, rr * 2.2 * this.range(0.7, 1), [1.5 * shade, 1.45 * shade, 1.3 * shade], MAT.ground, 0, 0, this.range(0, 6.28));
    }
    const count = Math.round(r * r * 16 * this.site.detail);
    for (let t = 0; t < count; t++) {
      const ta = this.range(0, 6.28), td = Math.pow(this.rnd(), 0.8) * r * 1.05;
      // Shorter towards the edge.
      const size = (1.15 - (td / r) * 0.6) * this.range(0.75, 1.15);
      this.tuft(x + Math.cos(ta) * td, z + Math.sin(ta) * td, size);
    }
    for (let t = 0; t < Math.round(r * 2 * this.site.detail); t++) {
      const ta = this.range(0, 6.28), td = Math.sqrt(this.rnd()) * r;
      this.weed(x + Math.cos(ta) * td, z + Math.sin(ta) * td, this.range(0.7, 1.2));
    }
  }

  private tuft(x: number, z: number, size: number): void {
    if (this.site.solidAt(x, z)) return;
    const w = this.range(0.5, 0.85) * size, h = this.range(0.3, 0.6) * size;
    (this.rnd() < 0.5 ? this.clumps : this.clumpsB).box(x, 0.0, z, w, h, w, this.pick(GRASS), -1, 0, GRASSY, this.range(0, 6.28), 0, 0, 0, 0.8);
  }

  private weed(x: number, z: number, size: number): void {
    if (this.site.solidAt(x, z)) return;
    const w = this.range(0.6, 1.0) * size;
    this.weeds.box(x, 0.01, z, w, w * this.range(0.6, 1.1), w, this.pick(WEED), -1, 0, GRASSY, this.range(0, 6.28), 0, 0, 0, 0.6);
  }

  /** Cracks across the slab: jagged dark lines with grass and weeds growing out of them. */
  private cracks(): void {
    const s = this.site;
    const area = s.size[0] * s.size[1];
    for (let k = 0; k < Math.round(area / 110); k++) {
      let x = this.range(6, s.size[0] - 6), z = this.range(6, s.size[1] - 6);
      if (s.solidAt(x, z)) continue;
      let a = this.range(0, 6.28);
      const segs = 3 + Math.floor(this.rnd() * 5);
      for (let j = 0; j < segs; j++) {
        a += this.range(-0.7, 0.7);
        const len = this.range(0.4, 1.1);
        const nx = x + Math.cos(a) * len, nz = z + Math.sin(a) * len;
        if (s.solidAt(nx, nz)) break;
        const w = this.range(0.015, 0.04) * (1 - j / segs * 0.6);
        this.cube.box((x + nx) / 2, 0.004, (z + nz) / 2, len + w, 0.006, w, [0.02, 0.02, 0.02], -1, 0, FLAG_NOSHADOW, -a);
        // A branch now and then.
        if (this.rnd() < 0.25) {
          const b = a + (this.rnd() < 0.5 ? 1 : -1) * this.range(0.6, 1.2), bl = this.range(0.2, 0.5);
          this.cube.box(x + Math.cos(b) * bl / 2, 0.004, z + Math.sin(b) * bl / 2, bl, 0.006, w * 0.6, [0.03, 0.03, 0.03], -1, 0, FLAG_NOSHADOW, -b);
        }
        if (this.rnd() < 0.55 * s.detail) this.tuft(nx, nz, this.range(0.45, 0.8));
        else if (this.rnd() < 0.2) this.weed(nx, nz, this.range(0.4, 0.7));
        x = nx; z = nz;
      }
    }
  }

  /** Rubbish that collects in a place nobody cleans: paper, cans, bottles, tyres, pallets, cones. */
  private litter(): void {
    const s = this.site;
    const area = s.size[0] * s.size[1];
    const PAPER: RGB[] = [[0.9, 0.88, 0.8], [0.75, 0.72, 0.62], [0.6, 0.55, 0.45]];
    const CAN: RGB[] = [[0.7, 0.1, 0.08], [0.15, 0.3, 0.6], [0.75, 0.75, 0.78], [0.2, 0.5, 0.2]];
    for (let k = 0; k < Math.round(area / 14 * Math.max(0.4, s.detail)); k++) {
      const x = this.range(6.5, s.size[0] - 6.5), z = this.range(6.5, s.size[1] - 6.5);
      if (s.solidAt(x, z)) continue;
      const roll = this.rnd(), yaw = this.range(0, 6.28);
      if (roll < 0.45) {
        // Paper and card, crumpled a little.
        const w = this.range(0.12, 0.3);
        this.cube.box(x, 0.006, z, w, 0.004, w * this.range(0.6, 1.4), this.pick(PAPER), MAT.fabric, 0, 0, yaw, this.range(-0.08, 0.08), this.range(-0.08, 0.08));
      } else if (roll < 0.65) {
        this.cylinder.box(x, 0.033, z, 0.066, 0.12, 0.066, this.pick(CAN), MAT.painted, 0, 0, yaw, Math.PI / 2, 0, 0.7, 0.4); // can on its side
      } else if (roll < 0.75) {
        this.sphere.box(x, 0.035, z, 0.07, 0.25, 0.07, [0.15, 0.35, 0.18], -1, 0, 0, yaw, Math.PI / 2, 0, 0, 0.1); // bottle
      } else if (roll < 0.85) {
        // Rubble: a few chunks of broken concrete.
        for (let j = 0; j < 3 + Math.floor(this.rnd() * 4); j++) {
          const sz = this.range(0.06, 0.2);
          this.rocks.box(x + this.range(-0.35, 0.35), sz * 0.3, z + this.range(-0.35, 0.35), sz * 1.4, sz, sz * 1.1, [1.05, 1.03, 0.98], MAT.concrete, 0, 0, this.range(0, 6.28));
        }
      } else if (roll < 0.88 && this.clear(x, z, 0.6)) {
        // An old tyre lying flat.
        this.cylinder.box(x, 0.11, z, 0.7, 0.22, 0.7, [0.06, 0.06, 0.06], MAT.fabric, 0, 0, yaw, 0, 0, 0, 0.9);
        this.cylinder.box(x, 0.115, z, 0.36, 0.23, 0.36, [0.02, 0.02, 0.02], -1);
      } else if (roll < 0.91 && this.clear(x, z, 0.7)) {
        // A broken pallet.
        for (let j = -2; j <= 2; j++) this.cube.box(x + j * 0.24, 0.13, z, 0.1, 0.025, 1.1, [1.1, 0.95, 0.75], MAT.wood, 0, 0, yaw + (j === 1 ? 0.15 : 0));
        for (const d of [-0.45, 0, 0.45]) this.cube.box(x, 0.06, z + d, 1.2, 0.1, 0.1, [1.0, 0.85, 0.65], MAT.wood, 0, 0, yaw);
      } else if (roll < 0.93) {
        // Traffic cone, sometimes knocked over.
        const down = this.rnd() < 0.4;
        this.cones.box(x, down ? 0.16 : 0.36, z, 0.32, 0.7, 0.32, [0.95, 0.35, 0.08], MAT.polymer, 0, 0, yaw, down ? Math.PI / 2 : 0);
        if (!down) this.cube.box(x, 0.02, z, 0.42, 0.04, 0.42, [0.1, 0.1, 0.1], MAT.polymer, 0, 0, yaw);
      } else if (roll < 0.96 && this.clear(x, z, 0.5)) {
        // Cardboard box, soggy at the corners.
        const w = this.range(0.35, 0.6);
        this.cube.box(x, w * 0.35, z, w, w * 0.7, w * 0.8, [0.75, 0.55, 0.35], MAT.fabric, 0, 0, yaw, 0, this.range(-0.05, 0.05));
      }
    }
  }

  private clear(x: number, z: number, m: number): boolean {
    const s = this.site;
    return !s.solidAt(x, z) && !s.solidAt(x + m, z) && !s.solidAt(x - m, z) && !s.solidAt(x, z + m) && !s.solidAt(x, z - m);
  }

  /**
   * Things overhead that move in the wind: cables slung across between buildings, banners and
   * tarps on the walls.
   */
  private overhead(): void {
    const s = this.site;
    const spots = this.wallSpots();
    // Cables: from a wall spot straight across the open floor to the facing wall.
    let cables = 0;
    for (const w of spots) {
      if (cables > Math.round(spots.length / 14) || this.rnd() > 0.12) continue;
      let len = 0;
      while (len < 30 && !s.solidAt(w.x + w.nx * (len + 1), w.z + w.nz * (len + 1))) len += 1;
      if (len < 5 || len >= 30) continue;
      const y0 = this.range(5.2, 6.6), y1 = y0 + this.range(-0.6, 0.6);
      const a: V3 = [w.x + w.nx * 0.1, y0, w.z + w.nz * 0.1], b: V3 = [w.x + w.nx * (len + 0.9), y1, w.z + w.nz * (len + 0.9)];
      for (const off of [0, 0.25]) {
        const da: V3 = [a[0] + w.nz * off, a[1] - off * 0.4, a[2] + w.nx * off], db: V3 = [b[0] + w.nz * off, b[1] - off * 0.4, b[2] + w.nx * off];
        this.sphere.limb(da, db, 0.012, [0.05, 0.05, 0.05], -1, FLAG_CABLE, 0.012, [0, 1, 0], 0);
      }
      // Insulators at the ends; a lamp or a sign hung from some.
      for (const p of [a, b]) this.cylinder.box(p[0], p[1], p[2], 0.08, 0.12, 0.08, [0.85, 0.85, 0.8], MAT.polymer);
      cables++;
    }
    // Banners, faded flags and torn tarps on the walls.
    const CLOTH: RGB[] = [[0.55, 0.12, 0.1], [0.12, 0.22, 0.45], [0.3, 0.38, 0.25], [0.6, 0.58, 0.5], [0.2, 0.3, 0.55]];
    for (const w of spots) {
      if (this.rnd() > 0.05) continue;
      const c = this.pick(CLOTH);
      const n: V3 = [w.nx, 0, w.nz], tan: V3 = [w.nz, 0, -w.nx];
      if (this.rnd() < 0.5) {
        // A banner hanging from a short pole that sticks out from the wall.
        const y = this.range(4.2, 5.8), len = 1.5;
        this.cylinder.box(w.x + w.nx * len / 2, y, w.z + w.nz * len / 2, 0.04, len, 0.04, [0.6, 0.6, 0.6], MAT.gunmetal, 0, 0, Math.atan2(w.nx, w.nz), Math.PI / 2);
        const fw = 1.2, fh = this.range(1.0, 1.6);
        this.sheet([w.x + w.nx * (len / 2 + 0.1), y - fh / 2 - 0.03, w.z + w.nz * (len / 2 + 0.1)], fh, [n[0] * fw, 0, n[2] * fw], tan, c);
      } else {
        // A tarp or banner hanging against the wall from its top edge.
        const fw = this.range(1.4, 1.9), fh = this.range(1.2, 2.4), y = this.range(3.4, 5.8);
        this.sheet([w.x + w.nx * 0.28, y - fh / 2, w.z + w.nz * 0.28], fh, [tan[0] * fw, 0, tan[2] * fw], n, c);
      }
    }
  }

  /** A sheet of cloth hanging from its top edge: `across` spans its width, `facing` its face. */
  private sheet(centre: V3, height: number, across: V3, facing: V3, c: RGB): void {
    this.cloth.mat([0, -height, 0, 0, across[0], across[1], across[2], 0, facing[0], facing[1], facing[2], 0, centre[0], centre[1], centre[2], 1], c, MAT.fabric, 0, 1, 0, FLAG_CLOTH);
  }

  /** The props that have collision: drawn where the simulation put their boxes. */
  private props(): void {
    const b = this.site.boxes;
    for (let o = 0; o < b.length; o += 8) {
      const mat = b[o + 6];
      const x = (b[o] + b[o + 3]) / 2, z = (b[o + 2] + b[o + 5]) / 2;
      if (this.site.theme === 3) {
        this.lunarProp(mat, x, z);
      } else if (mat === SCENERY_MATS.tree) {
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
          this.canopy.box(ix, 7.1 - len / 2, iz, this.range(0.5, 1.0), len, this.range(0.3, 0.42), [tint[0] * 0.1 * shade, tint[1] * 0.2 * shade, tint[2] * 0.06 * shade], -1, 0, FLAG_FOLIAGE, yaw, 0, this.range(-0.12, 0.12), 0, 0.7);
        }
        const [cx, cz] = along(0, 0.1);
        this.canopy.box(cx, 6.85, cz, 2.3, 0.9, 0.55, [tint[0] * 0.1, tint[1] * 0.2, tint[2] * 0.06], -1, 0, FLAG_FOLIAGE, yaw, 0, 0, 0, 0.7);
      } else if (roll < 0.32 * detail) {
        // Creeper climbing from the ground, with weeds at its foot.
        const tint = this.pick(LEAF_TINTS), rise = this.range(1.6, 3.4);
        for (let k = 0; k < 4; k++) {
          const len = rise * this.range(0.4, 1), shade = this.range(0.75, 1.1);
          const [ix, iz] = along(this.range(-0.8, 0.8), 0.08);
          this.canopy.box(ix, len / 2 - 0.1, iz, this.range(0.6, 1.1), len, this.range(0.3, 0.42), [tint[0] * 0.1 * shade, tint[1] * 0.2 * shade, tint[2] * 0.06 * shade], -1, 0, FLAG_FOLIAGE, yaw, 0, this.range(-0.15, 0.15), 0, 0.7);
        }
        for (let k = 0; k < 4; k++) { const [tx, tz] = along(this.range(-0.9, 0.9), this.range(0.25, 0.6)); this.tuft(tx, tz, 1.1); }
      } else if (roll < 0.42) {
        const [bx, bz] = along(this.range(-0.4, 0.4), this.range(0.55, 0.8));
        this.bushIfClear(bx, bz, this.range(0.7, 1.05));
      }
      // Grass along the foot of the wall: a strip of soil and a run of clumps where wind and rain
      // leave dirt, on about half the walls; weeds in the crack on the rest.
      if (this.rnd() < 0.5) {
        const [sx2, sz2] = along(0, 0.32);
        if (!this.site.solidAt(sx2, sz2)) this.patches.box(sx2, 0.003, sz2, w.nx ? 0.9 : 2.3, 1, w.nx ? 2.3 : 0.9, [1.4, 1.35, 1.2], MAT.ground, 0, 0, this.range(-0.1, 0.1));
        for (let k = 0; k < Math.round(9 * detail); k++) { const [tx, tz] = along(this.range(-1.05, 1.05), this.range(0.1, 0.55)); this.tuft(tx, tz, this.range(0.7, 1.2)); }
        if (this.rnd() < 0.6) { const [tx, tz] = along(this.range(-0.9, 0.9), this.range(0.2, 0.5)); this.weed(tx, tz, this.range(0.8, 1.2)); }
      } else {
        const weeds = Math.round(this.range(1, 4) * detail);
        for (let k = 0; k < weeds; k++) { const [tx, tz] = along(this.range(-1, 1), this.range(0.08, 0.25)); this.tuft(tx, tz, 0.65); }
      }
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
    for (let k = 0; k < Math.round(area / 420); k++) {
      const p = spot(1.2);
      if (!p) continue;
      const r = this.range(0.35, 0.9);
      // A damp darker rim, then rippling water with a ragged outline.
      this.patches.box(p[0], 0.002, p[1], r * 2.6, 1, r * 2, [0.45, 0.45, 0.47], MAT.concrete, 0, 0, this.range(0, 6.28));
      for (let j = 0; j < 2; j++) this.patches.box(p[0] + j * this.range(-0.6, 0.6), 0.006 + j * 0.002, p[1] + j * this.range(-0.6, 0.6), r * (j ? 1.3 : 2.1), 1, r * (j ? 1.0 : 1.5), [0.03, 0.035, 0.04], -1, 0, FLAG_WATER, this.range(0, 6.28), 0, 0, 0, 0.05);
    }
    // Lone weeds pushing through cracks.
    for (let k = 0; k < Math.round((area / 9) * s.detail); k++) {
      const x = this.range(6.5, s.size[0] - 6.5), z = this.range(6.5, s.size[1] - 6.5);
      if (this.rnd() < 0.75) this.tuft(x, z, this.range(0.4, 0.8)); else this.weed(x, z, this.range(0.5, 0.9));
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
