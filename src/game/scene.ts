// Turns match state into a renderer `Frame`: the textured level with trim and lamps,
// interactables, jointed animated characters, the first-person weapon and arms, tracers, muzzle
// flashes and lights, plus camera and post-processing settings.
import { WF, type Sim } from '../core/sim';
import { loadModel, type Model } from '../gfx/loader';
import { compose, invert, lookAt, mat4, mul, ortho, perspective, transformPoint } from '../gfx/mat';
import { cubeMesh, cylinderMesh, FLAG_NOSHADOW, FLAG_VIEWMODEL, LIGHT_FLOATS, MAT, MAX_LIGHTS, sphereMesh, type Draw, type Frame, type Renderer } from '../gfx/renderer';
import { Batch, type V3 } from './batch';
import { bodyParts } from '../gfx/anatomy';
import { BOOTS, CAMOS, FATIGUES, GLOVES, HELMETS, SKINS, VESTS, type Look } from './look';
import { Scenery, SCENERY_MATS } from './scenery';
import { MODES, TEAM_COLORS } from './rules';
import type { Session, View } from './session';

type RGB = [number, number, number];

/** Map box material id -> procedural layer and tint. */
const SURFACES: { layer: number; tint: RGB }[] = [
  { layer: MAT.floor, tint: [1, 1, 1] }, // 0 floor
  { layer: MAT.concrete, tint: [1, 1, 1] }, // 1 wall
  { layer: MAT.wood, tint: [0.95, 0.9, 0.85] }, // 2 crate stack
  { layer: MAT.painted, tint: [0.9, 0.95, 1] }, // 3 platform / stairs
  { layer: MAT.rust, tint: [1, 1, 1] }, // 4 door
  { layer: MAT.painted, tint: [0.7, 0.7, 0.75] }, // 5 perk machine
  { layer: MAT.wood, tint: [0.55, 0.5, 0.5] }, // 6 mystery crate
  { layer: MAT.gunmetal, tint: [1.4, 1.3, 1.6] }, // 7 upgrade bench
  { layer: MAT.painted, tint: [2.2, 1.8, 0.5] }, // 8 power switch
  { layer: MAT.painted, tint: [0.6, 1.5, 1.4] }, // 9 tonic dispenser
  { layer: MAT.wood, tint: [0.8, 0.75, 0.7] }, // 10 workbench
  { layer: MAT.gunmetal, tint: [1.2, 1.2, 1.3] }, // 11 console
  { layer: MAT.painted, tint: [0.6, 0.6, 0.6] }, // 12 wall-buy pedestal
];
const PERK_COLORS: RGB[] = [[0.9, 0.2, 0.15], [0.2, 0.85, 0.3], [1, 0.65, 0.1], [0.2, 0.5, 1], [1, 0.9, 0.2], [0.7, 0.3, 1]];
const POWERUP_COLORS: RGB[] = [[0.2, 1, 0.3], [1, 0.2, 0.2], [1, 0.85, 0.1], [0.9, 0.9, 1], [0.3, 0.6, 1]];
export const PLAYER_COLORS: RGB[] = [[0.2, 0.55, 1], [1, 0.45, 0.15], [0.3, 0.85, 0.35], [0.9, 0.3, 0.8], [1, 0.85, 0.2], [0.3, 0.9, 0.9], [0.9, 0.25, 0.25], [0.75, 0.75, 0.8]];
/** Clothing tints for the undead, picked per zombie. */
const RAGS: RGB[] = [[1.5, 1.4, 1.25], [1.1, 1.2, 1.4], [1.6, 1.4, 1.1], [1.15, 1.3, 1.1], [1.45, 1.1, 1.05], [0.8, 0.8, 0.85], [1.7, 1.65, 1.55]];
const LAMP: RGB = [1.0, 0.72, 0.42];

const I = { door: 1, wallbuy: 2, perk: 3, crate: 4, bench: 5, tonic: 6, power: 7, workbench: 8, part: 9, console: 10 };

interface Tracer { a: number[]; b: number[]; t: number; color: RGB }
/**
 * A short-lived effect box. `radius` > 0 also lights the world. `glow` overrides the brightness
 * (above 1 draws it unlit and glowing, otherwise lit like smoke); `vel` moves it (debris) and
 * `rise` lifts it over its life (fire and smoke).
 */
interface Flash { pos: number[]; t: number; life: number; color: RGB; radius: number; size: number; glow?: number; vel?: number[]; rise?: number }
interface LightSrc { pos: number[]; radius: number; color: RGB; intensity: number; flicker?: number }

export interface SceneSettings { fov: number; motionBlur: boolean; dof: boolean; /** 0 first person .. 1 third person. */ third?: number; /** Which way our own body faces in third person (default: the view). */ bodyYaw?: number }

/** A character's facing frame: positions are given as (right, up, forward) offsets. */
function frame(x: number, y: number, z: number, yaw: number) {
  const r: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)], f: V3 = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  const at = (lx: number, ly: number, lz: number): V3 => [x + r[0] * lx + f[0] * lz, y + ly, z + r[2] * lx + f[2] * lz];
  return { at, right: r, fwd: f };
}

/** Two-bone chain from `root`: thigh then shin (or upper arm then forearm), swinging in the forward plane. */
function chain(at: (x: number, y: number, z: number) => V3, root: [number, number, number], l1: number, l2: number, a1: number, a2: number, side = 0): [V3, V3] {
  const k: [number, number, number] = [root[0] + side * 0.5 * l1, root[1] - Math.cos(a1) * l1, root[2] + Math.sin(a1) * l1];
  const e: [number, number, number] = [k[0] + side * l2 * 0.5, k[1] - Math.cos(a1 - a2) * l2, k[2] + Math.sin(a1 - a2) * l2];
  return [at(...k), at(...e)];
}

export class Scene {
  private cube: number;
  private sphere: number;
  private cylinder: number;
  private world = new Batch();
  private worldRound = new Batch();
  private worldGlow = new Batch();
  private models = new Map<string, Model | null>();
  private tracers: Tracer[] = [];
  private flashes: Flash[] = [];
  /** Weapons the mystery crate cycles through while it rolls. */
  private crateWeapons: number[] = [];
  /** Time of the last rocket smoke puff (puffs are spaced in time, whatever the frame rate). */
  private smokeAt = 0;
  private prevViewProj = mat4();
  private frameData = new Batch();
  private lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS);
  private time = 0;
  private kick = 0;
  private sway = [0, 0];
  private lastAngles = [0, 0];
  private muzzle = 0;
  /** Smoothed first-person pose values (0..1) and their velocities. */
  private anim = { sprint: 0, reload: 0, lower: 0, melee: 0, crouch: 0, fall: 0, strafe: 0 };
  private animVel = { sprint: 0, reload: 0, lower: 0, melee: 0, crouch: 0, fall: 0, strafe: 0 };
  private barrAxis: boolean[];
  private staticLights: LightSrc[] = [];
  /** Per-zombie animation state, and the bodies of the recently killed. */
  private zanim = new Map<number, { phase: number; yaw: number; speed: number; attack: number; flinch: number; x: number; z: number; hp: number; kind: number; seen: number }>();
  /** Sculpted body-part meshes, each with a batch for the world and one for the first-person view. */
  private parts: Record<string, { mesh: number; batch: Batch; vm: Batch }> = {};
  private panim = new Map<number, { phase: number; x: number; z: number; speed: number; crouch: number; reload: number; swap: number; lean: number; seen: number }>();
  private corpses: { id: number; x: number; y: number; z: number; yaw: number; kind: number; t: number; rec: Float32Array }[] = [];
  private switchAt: { x: number; z: number; nx: number; nz: number } | null = null;
  private lever = 0;
  private leverVel = 0;
  private scenery: Scenery;
  /** Per-frame batches, reused so a 360 fps loop does not churn the garbage collector. */
  private casters = new Batch();
  private round = new Batch();
  private glows = new Batch();
  private vm = new Batch();
  private groups = new Map<string, { mesh: number; shadow: boolean; batch: Batch }>();
  /** Red screen-edge flash, 0..1. */
  hurt = 0;

  constructor(private renderer: Renderer, private sim: Sim, private session: Session, private lookOf: (id: number) => Look, detail = 1) {
    this.cube = renderer.createMesh(cubeMesh());
    this.sphere = renderer.createMesh(sphereMesh());
    this.cylinder = renderer.createMesh(cylinderMesh());
    for (const [name, data] of Object.entries(bodyParts())) this.parts[name] = { mesh: renderer.createMesh(data), batch: new Batch(), vm: new Batch() };
    const b = session.boxes;
    for (let o = 0; o < b.length; o += 8) {
      const flags = b[o + 7] & 0xff;
      if (flags & (2 | 4)) continue; // hidden, or a door (doors are drawn while closed)
      if (b[o + 6] >= SCENERY_MATS.tree && b[o + 6] <= SCENERY_MATS.boulder) continue; // drawn by the scenery
      if (b[o + 6] === 8) { this.switchgear(b, o); continue; }
      if ([5, 6, 7, 9, 10, 11, 12].includes(b[o + 6])) this.machineDetail(b, o);
      this.addBox(this.world, b, o);
      if (b[o + 6] === 1) this.trimWall(b, o);
      if (b[o + 6] === 2) this.crateDetail(b, o);
      if (b[o + 6] === 17) this.roofDetail(b, o);
      if (b[o + 6] === 18) this.openingDetail(b, o);
    }
    this.placeLamps();
    this.scenery = new Scenery(renderer, this.cube, this.sphere, this.cylinder, {
      boxes: b, size: session.mapInfo.size as [number, number], seed: session.start.map, detail, theme: session.mapInfo.theme,
      solidAt: (x, z) => this.solidAt(x, z), wallAt: (x, z) => this.wallAt(x, z),
    });
    // A barricade's boards span whichever way its opening is walled in.
    this.barrAxis = session.mapInfo.barricades.map(p => this.wallAt(p[0] - 2, p[2]) && this.wallAt(p[0] + 2, p[2]));
    for (const w of sim.catalog.weapons) this.load(`weapons/${w.slug}`);
    this.load('props/rocket');
    this.crateWeapons = sim.catalog.weapons.filter(w => w.flags & WF.crate).map(w => w.id);
    for (const p of sim.catalog.maps[session.start.map].props) this.load(`props/${p}`);
  }

  private load(name: string): void {
    this.models.set(name, null);
    // A missing or broken model is not fatal: the object is simply not drawn.
    loadModel(this.renderer, `assets/${name}.glb`).then(model => this.models.set(name, model), e => console.warn(`model ${name}:`, e));
  }
  private wallAt(x: number, z: number): boolean {
    const b = this.session.boxes;
    for (let o = 0; o < b.length; o += 8) if (b[o + 6] === 1 && x > b[o] && x < b[o + 3] && z > b[o + 2] && z < b[o + 5]) return true;
    return false;
  }
  /** Any visible geometry above the floor at this point. */
  private solidAt(x: number, z: number): boolean {
    const b = this.session.boxes;
    for (let o = 0; o < b.length; o += 8) if (!(b[o + 7] & 2) && b[o + 4] > 0.2 && x > b[o] && x < b[o + 3] && z > b[o + 2] && z < b[o + 5]) return true;
    return false;
  }
  private addBox(batch: Batch, b: Float32Array, o: number): void {
    // 17: roof slab, 18: brick wall around a window or doorway.
    // The moon's surface is grey regolith, not a poured floor.
    if (b[o + 6] === 0 && this.session.mapInfo.theme === 3) {
      batch.box((b[o] + b[o + 3]) / 2, (b[o + 1] + b[o + 4]) / 2, (b[o + 2] + b[o + 5]) / 2, b[o + 3] - b[o], b[o + 4] - b[o + 1], b[o + 5] - b[o + 2], [1.5, 1.5, 1.55], MAT.concrete);
      return;
    }
    const s = b[o + 6] === 17 ? { layer: MAT.concrete, tint: [0.8, 0.8, 0.82] as RGB } : b[o + 6] === 18 ? { layer: MAT.brick, tint: [1.25, 1.0, 0.9] as RGB } : SURFACES[b[o + 6]] ?? SURFACES[1];
    batch.box((b[o] + b[o + 3]) / 2, (b[o + 1] + b[o + 4]) / 2, (b[o + 2] + b[o + 5]) / 2, b[o + 3] - b[o], b[o + 4] - b[o + 1], b[o + 5] - b[o + 2], s.tint, s.layer);
  }

  /** Steel skirting, a mid-height ledge and a concrete cap give walls a built, layered look. */
  private trimWall(b: Float32Array, o: number): void {
    const [x0, , z0, x1, y1, z1] = b.subarray(o, o + 6);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    this.world.box(cx, 0.18, cz, w + 0.08, 0.36, d + 0.08, [0.55, 0.55, 0.6], MAT.painted);
    this.world.box(cx, 2.6, cz, w + 0.05, 0.12, d + 0.05, [0.8, 0.8, 0.8], MAT.concrete);
    this.world.box(cx, y1 - 0.1, cz, w + 0.12, 0.2, d + 0.12, [0.75, 0.75, 0.75], MAT.concrete);
  }

  /** Under a roof: strip lights on the ceiling. On top: a raised edge and felt. */
  private roofDetail(b: Float32Array, o: number): void {
    const [x0, y0, z0, x1, y1, z1] = b.subarray(o, o + 6);
    const TUBE: RGB = [0.95, 0.97, 1];
    for (let x = x0 + 4; x < x1 - 2; x += 7) {
      for (let z = z0 + 4; z < z1 - 2; z += 7) {
        if (this.solidAt(x, z)) continue;
        this.world.box(x, y0 - 0.05, z, 1.5, 0.1, 0.24, [0.7, 0.7, 0.7], MAT.gunmetal);
        this.worldGlow.box(x, y0 - 0.11, z, 1.3, 0.04, 0.12, TUBE, -1, 7, FLAG_NOSHADOW);
        this.staticLights.push({ pos: [x, y0 - 0.4, z], radius: 9, color: TUBE, intensity: 7, flicker: (Math.floor(x) + Math.floor(z)) % 7 === 0 ? x : undefined });
      }
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    this.world.box(cx, y1 + 0.01, cz, w - 0.3, 0.02, d - 0.3, [0.35, 0.35, 0.37], MAT.floor);
    // Deck plating inside a lunar module.
    if (this.session.mapInfo.theme === 3) this.world.box(cx, 0.006, cz, w - 3.9, 0.012, d - 3.9, [0.8, 0.82, 0.86], MAT.floor);
    for (const [px, pz, sx, sz] of [[cx, z0 + 0.15, w, 0.3], [cx, z1 - 0.15, w, 0.3], [x0 + 0.15, cz, 0.3, d], [x1 - 0.15, cz, 0.3, d]]) this.world.box(px, y1 + 0.15, pz, sx, 0.3, sz, [0.75, 0.75, 0.75], MAT.concrete);
  }

  /** Frames, sills and lintels around window and door openings. */
  private openingDetail(b: Float32Array, o: number): void {
    const [x0, y0, z0, x1, y1, z1] = b.subarray(o, o + 6);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const FRAME: RGB = [0.85, 0.85, 0.82];
    if (y0 === 0) {
      // Window sill on top of the low wall.
      this.world.box(cx, y1 + 0.04, cz, x1 - x0 + 0.16, 0.08, z1 - z0 + 0.16, FRAME, MAT.concrete);
    } else {
      // Lintel under the wall above the opening, and jambs down to the sill or the floor.
      this.world.box(cx, y0 - 0.06, cz, x1 - x0 + 0.1, 0.12, z1 - z0 + 0.1, FRAME, MAT.concrete);
      const bottom = y0 < 2.35 ? 1.0 : 0;
      // The opening runs through the wall along whichever axis has open floor on both sides.
      const floorBlocked = (x: number, z: number) => {
        for (let q = 0; q < this.session.boxes.length; q += 8) { const k = this.session.boxes; if (!(k[q + 7] & 2) && k[q + 1] < 1.5 && k[q + 4] > 0.2 && x > k[q] && x < k[q + 3] && z > k[q + 2] && z < k[q + 5]) return true; }
        return false;
      };
      const alongX = !floorBlocked(cx, z0 - 0.5) && !floorBlocked(cx, z1 + 0.5);
      for (const side of [-1, 1]) {
        const jx = alongX ? cx + side * 0.95 : cx, jz = alongX ? cz : cz + side * 0.95;
        this.world.box(jx, (y0 + bottom) / 2, jz, alongX ? 0.1 : x1 - x0 + 0.06, y0 - bottom, alongX ? z1 - z0 + 0.06 : 0.1, [0.3, 0.33, 0.36], MAT.painted);
      }
    }
  }

  /**
   * The main breaker: a steel switchgear cabinet with gauges, warning stripes and conduit. Its big
   * knife-switch lever is drawn each frame (see `build`) so it can swing when the power comes on.
   */
  private switchgear(b: Float32Array, o: number): void {
    const x = (b[o] + b[o + 3]) / 2, z = (b[o + 2] + b[o + 5]) / 2;
    // Face whichever side has open floor.
    const n = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).find(([dx, dz]) => !this.solidAt(x + dx * 1.2, z + dz * 1.2)) ?? [1, 0];
    this.switchAt = { x, z, nx: n[0], nz: n[1] };
    const yaw = n[0] !== 0 ? Math.PI / 2 : 0;
    const face = (d: number, y: number, out: number, w: number, h: number, th: number, c: RGB, layer: number, batch = this.world, glow = 0) => {
      batch.box(x + n[0] * out + n[1] * d, y, z + n[1] * out + n[0] * d, w, h, th, c, layer, glow, glow ? FLAG_NOSHADOW : 0, yaw);
    };
    this.world.box(x, 0.06, z, 0.8, 0.12, 0.8, [0.7, 0.7, 0.7], MAT.concrete); // plinth
    this.world.box(x, 1.0, z, 0.64, 1.76, 0.64, [0.62, 0.66, 0.64], MAT.painted); // cabinet
    this.world.box(x, 1.91, z, 0.7, 0.06, 0.7, [0.5, 0.5, 0.5], MAT.gunmetal); // cap
    face(0, 1.05, 0.325, 0.5, 1.2, 0.02, [0.5, 0.54, 0.52], MAT.painted); // door panel
    face(0, 0.3, 0.33, 0.56, 0.12, 0.02, [0.9, 0.7, 0.1], MAT.painted); // hazard band
    for (let k = -2; k <= 2; k++) face(k * 0.11, 0.3, 0.342, 0.05, 0.12, 0.01, [0.05, 0.05, 0.05], MAT.painted);
    // Two dial gauges.
    for (const d of [-0.13, 0.13]) {
      this.worldRound.box(x + n[0] * 0.335 + n[1] * d, 1.66, z + n[1] * 0.335 + n[0] * d, 0.15, 0.03, 0.15, [0.85, 0.85, 0.8], MAT.painted, 0, 0, yaw, Math.PI / 2);
      face(d, 1.66, 0.352, 0.1, 0.012, 0.004, [0.05, 0.05, 0.05], -1);
    }
    // Hinge block for the lever, and conduit up the back and overhead.
    face(0, 1.2, 0.36, 0.34, 0.12, 0.08, [0.3, 0.3, 0.32], MAT.gunmetal);
    this.worldRound.box(x - n[0] * 0.2, 3.0, z - n[1] * 0.2, 0.09, 2.2, 0.09, [0.8, 0.8, 0.8], MAT.gunmetal);
    this.worldRound.box(x + n[0] * 0.1, 2.6, z + n[1] * 0.1, 0.06, 1.4, 0.06, [0.7, 0.7, 0.7], MAT.gunmetal);
  }

  /** A sculpted part stretched between two joints (`r` half-width, `rz` half-depth). */
  private seg(kind: string, a: V3, b: V3, r: number, c: ArrayLike<number>, layer: number, rz = r, side?: V3, flags = 0): void {
    const part = this.parts[kind];
    (flags & FLAG_VIEWMODEL ? part.vm : part.batch).limb(a, b, r, c, layer, flags, rz, side, 0.35);
  }
  /** A sculpted part placed like a box (centre, size, yaw/pitch/roll). */
  private put(kind: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, c: ArrayLike<number>, layer = -1, emissive = 0, flags = 0, yaw = 0, pitch = 0, roll = 0, metallic = 0, roughness = 1): void {
    const part = this.parts[kind];
    (flags & FLAG_VIEWMODEL ? part.vm : part.batch).box(x, y, z, sx, sy, sz, c, layer, emissive, flags, yaw, pitch, roll, metallic, roughness);
  }

  /** Which way a free-standing object should face: toward open floor. */
  private facing(x: number, z: number, reach = 1.3): [number, number] {
    return (([[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]).find(([dx, dz]) => !this.solidAt(x + dx * reach, z + dz * reach)) ?? [0, 1]);
  }

  /**
   * Detail on the machines and stands: perk machines get a sign box, display window, coin slot
   * and vents; the crate straps, latches and hinges; the upgrade bench a press head, gauge and
   * pipes; the tonic dispenser shelves of bottles; consoles a screen and keys; wall-buy stands a
   * price plate and a back board.
   */
  private machineDetail(b: Float32Array, o: number): void {
    const mat = b[o + 6];
    const [x0, , z0, x1, y1, z1] = b.subarray(o, o + 6);
    const x = (x0 + x1) / 2, z = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    const n = this.facing(x, z);
    const yaw = n[0] !== 0 ? Math.PI / 2 : 0;
    const half = (n[0] !== 0 ? w : d) / 2, span = n[0] !== 0 ? d : w;
    const face = (side: number, y: number, out: number, wd: number, ht: number, th: number, c: ArrayLike<number>, layer: number, glow = 0, rough = 1, metal = 0) => {
      (glow > 0 ? this.worldGlow : this.world).box(x + n[0] * (half + out) + n[1] * side, y, z + n[1] * (half + out) + n[0] * side, wd, ht, th, c, layer, glow, glow > 0 ? FLAG_NOSHADOW : 0, yaw, 0, 0, metal, rough);
    };
    const STEEL: RGB = [0.7, 0.7, 0.72], DARK: RGB = [0.12, 0.12, 0.13];
    if (mat === 5) {
      // Perk machine.
      this.world.box(x, 0.05, z, w + 0.1, 0.1, d + 0.1, DARK, MAT.gunmetal); // kick plate
      this.world.box(x, y1 + 0.06, z, w + 0.08, 0.12, d + 0.08, STEEL, MAT.gunmetal); // top trim
      face(0, 1.0, 0.012, span * 0.72, 0.8, 0.02, [0.04, 0.05, 0.06], -1, 0, 0.08); // display glass
      for (let k = 0; k < 3; k++) face(-span * 0.22 + k * span * 0.22, 0.86, 0.03, 0.09, 0.24, 0.05, [0.8, 0.85, 0.9], -1, 0, 0.15); // bottles behind glass
      face(0, 0.42, 0.02, span * 0.5, 0.16, 0.04, DARK, MAT.polymer); // dispensing slot
      face(span * 0.3, 1.25, 0.02, 0.05, 0.12, 0.03, STEEL, MAT.gunmetal); // coin slot
      face(span * 0.3, 1.08, 0.02, 0.06, 0.06, 0.03, [0.8, 0.1, 0.1], MAT.painted); // button
      for (let k = 0; k < 5; k++) face(0, 0.14 + k * 0.045, 0.012, span * 0.7, 0.014, 0.02, DARK, MAT.gunmetal); // vents
      for (const sd of [-1, 1]) face(sd * (span / 2 + 0.02), y1 / 2, -0.04, 0.04, y1, 0.06, STEEL, MAT.gunmetal); // corner rails
    } else if (mat === 6) {
      // Mystery crate: straps, latches, corner irons and rope handles.
      for (const sx of [-0.45, 0.45]) this.world.box(x + (n[0] !== 0 ? 0 : sx), y1 / 2, z + (n[0] !== 0 ? sx : 0), n[0] !== 0 ? w + 0.03 : 0.07, y1 + 0.03, n[0] !== 0 ? 0.07 : d + 0.03, DARK, MAT.gunmetal);
      for (const sd of [-0.45, 0.45]) { face(sd, y1 - 0.14, 0.012, 0.09, 0.12, 0.03, [0.75, 0.6, 0.3], MAT.gunmetal, 0, 0.4, 1); }
      face(0, y1 - 0.14, 0.02, 0.14, 0.16, 0.04, [0.75, 0.6, 0.3], MAT.gunmetal, 0, 0.4, 1); // lock plate
      this.world.box(x, y1 + 0.015, z, w + 0.04, 0.03, d + 0.04, [0.5, 0.45, 0.42], MAT.wood); // lid lip
      for (const cx of [x0, x1]) for (const cz of [z0, z1]) this.world.box(cx, y1 / 2, cz, 0.06, y1, 0.06, DARK, MAT.gunmetal);
    } else if (mat === 7) {
      // Upgrade bench: a press head on columns, a gauge, feed pipes and a work plate.
      this.world.box(x, 1.02, z, w * 0.9, 0.06, d * 0.9, STEEL, MAT.gunmetal); // work plate
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.worldRound.box(x + sx * w * 0.4, 1.6, z + sz * d * 0.4, 0.07, 1.2, 0.07, STEEL, MAT.gunmetal);
      this.world.box(x, 2.0, z, w * 0.8, 0.3, d * 0.8, [0.5, 0.42, 0.6], MAT.painted); // press head
      this.worldRound.box(x, 1.72, z, 0.22, 0.3, 0.22, STEEL, MAT.gunmetal); // ram
      face(span * 0.25, 1.5, 0.02, 0.16, 0.16, 0.03, [0.9, 0.9, 0.85], MAT.painted); // gauge
      face(span * 0.25, 1.5, 0.04, 0.1, 0.012, 0.01, [0.8, 0.1, 0.1], -1);
      for (const sd of [-0.3, 0.3]) this.worldRound.box(x - n[0] * half * 0.8 + n[1] * sd, 2.6, z - n[1] * half * 0.8 + n[0] * sd, 0.09, 1.0, 0.09, [0.9, 0.9, 0.9], MAT.rust);
      face(0, 0.5, 0.012, span * 0.6, 0.5, 0.02, DARK, MAT.gunmetal); // access door
    } else if (mat === 9) {
      // Tonic dispenser: rows of bottles behind glass, a chute and a keypad.
      face(0, 1.35, 0.012, span * 0.74, 1.3, 0.02, [0.03, 0.05, 0.05], -1, 0, 0.06);
      const liquids: RGB[] = [[0.2, 1, 0.9], [1, 0.4, 0.8], [1, 0.8, 0.2], [0.5, 0.6, 1]];
      for (let row = 0; row < 3; row++) for (let k = 0; k < 3; k++) face(-span * 0.22 + k * span * 0.22, 0.95 + row * 0.38, 0.03, 0.08, 0.2, 0.05, liquids[(row + k) % 4], -1, 0.9, 0.2);
      face(0, 0.38, 0.02, span * 0.5, 0.18, 0.04, DARK, MAT.polymer);
      face(span * 0.33, 1.3, 0.02, 0.08, 0.2, 0.03, STEEL, MAT.gunmetal);
      this.world.box(x, y1 + 0.05, z, w + 0.06, 0.1, d + 0.06, [0.2, 0.5, 0.48], MAT.painted);
    } else if (mat === 10) {
      // Workbench: a vice, a pegboard of tools and a shelf.
      this.world.box(x + n[1] * span * 0.3, y1 + 0.08, z + n[0] * span * 0.3, 0.14, 0.16, 0.2, STEEL, MAT.gunmetal, 0, 0, yaw);
      this.world.box(x - n[0] * half * 0.8, y1 + 0.5, z - n[1] * half * 0.8, n[0] !== 0 ? 0.04 : w, 0.9, n[0] !== 0 ? d : 0.04, [0.6, 0.5, 0.4], MAT.wood);
      for (let k = 0; k < 4; k++) this.world.box(x - n[0] * (half * 0.8 - 0.04) + n[1] * (-0.5 + k * 0.33), y1 + 0.55, z - n[1] * (half * 0.8 - 0.04) + n[0] * (-0.5 + k * 0.33), 0.04, 0.3, 0.04, k % 2 ? [0.7, 0.2, 0.1] : STEEL, MAT.gunmetal);
      this.world.box(x, 0.3, z, w * 0.9, 0.04, d * 0.9, [0.6, 0.5, 0.4], MAT.wood);
    } else if (mat === 11) {
      // Console: a tilted screen, a keyboard and status lamps.
      face(0, y1 + 0.28, -half * 0.5, span * 0.8, 0.5, 0.05, DARK, MAT.polymer);
      face(0, y1 + 0.28, -half * 0.5 + 0.03, span * 0.7, 0.4, 0.01, [0.1, 0.5, 0.6], -1, 1.2);
      this.world.box(x + n[0] * half * 0.3, y1 + 0.02, z + n[1] * half * 0.3, n[0] !== 0 ? 0.2 : span * 0.6, 0.03, n[0] !== 0 ? span * 0.6 : 0.2, [0.2, 0.2, 0.22], MAT.polymer);
      for (let k = 0; k < 3; k++) face(-0.2 + k * 0.2, y1 - 0.2, 0.012, 0.05, 0.05, 0.02, [[0.2, 1, 0.3], [1, 0.7, 0.1], [1, 0.2, 0.1]][k], -1, 3);
    } else if (mat === 12) {
      // Wall-buy stand: a steel post with a price plate and a hazard-striped foot.
      this.world.box(x, 0.04, z, w + 0.2, 0.08, d + 0.2, [0.85, 0.65, 0.1], MAT.painted);
      this.world.box(x, y1 + 0.02, z, w + 0.12, 0.04, d + 0.12, STEEL, MAT.gunmetal);
      face(0, y1 * 0.6, 0.012, span * 0.8, 0.2, 0.02, [0.9, 0.9, 0.85], MAT.painted);
      face(0, y1 * 0.6, 0.025, span * 0.5, 0.03, 0.01, DARK, -1);
    }
  }

  /** Crate stacks get dark steel corner straps. */
  private crateDetail(b: Float32Array, o: number): void {
    const [x0, y0, z0, x1, y1, z1] = b.subarray(o, o + 6);
    const h = y1 - y0;
    for (const x of [x0 + 0.03, x1 - 0.03]) for (const z of [z0 + 0.03, z1 - 0.03]) this.world.box(x, y0 + h / 2, z, 0.09, h + 0.01, 0.09, [0.6, 0.6, 0.6], MAT.gunmetal);
  }

  /** Wall lamps with conduit, spaced along walls that face open floor. */
  private placeLamps(): void {
    const { size } = this.session.mapInfo;
    const spots: { pos: V3; n: V3 }[] = [];
    for (let x = 1; x < size[0]; x += 2) {
      for (let z = 1; z < size[1]; z += 2) {
        if (this.solidAt(x, z)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (this.wallAt(x + dx * 2, z + dz * 2) && !this.solidAt(x + dx, z + dz)) {
            spots.push({ pos: [x + dx * 0.95, 3.3, z + dz * 0.95], n: [-dx, 0, -dz] });
          }
        }
      }
    }
    const chosen: typeof spots = [];
    for (const s of spots) if (chosen.every(c => Math.hypot(c.pos[0] - s.pos[0], c.pos[2] - s.pos[2]) > 9)) chosen.push(s);
    chosen.forEach((s, k) => {
      const [x, y, z] = s.pos, [nx, , nz] = s.n;
      const along = Math.abs(nx) > 0 ? 0 : Math.PI / 2;
      this.world.box(x + nx * 0.04, y + 0.12, z + nz * 0.04, 0.5, 0.08, 0.5, [0.7, 0.7, 0.7], MAT.gunmetal, 0, 0, along); // hood
      this.worldGlow.box(x + nx * 0.12, y, z + nz * 0.12, 0.34, 0.1, 0.16, LAMP, -1, 6, FLAG_NOSHADOW, along + Math.PI / 2);
      this.worldRound.box(x - nz * 0.4, y / 2, z + nx * 0.4, 0.07, y + 0.4, 0.07, [0.8, 0.8, 0.8], MAT.gunmetal); // conduit
      this.staticLights.push({ pos: [x + nx * 0.5, y - 0.1, z + nz * 0.5], radius: 11, color: LAMP, intensity: 9, flicker: k % 5 === 2 ? k : undefined });
    });
  }

  /** Visual reactions to simulation events. */
  handleEvent(e: Float32Array, view: View): void {
    const { V } = this.sim.L;
    const s = this.session;
    const rocket = (w: number) => ((this.sim.catalog.weapons[w]?.flags ?? 0) & WF.rocket) !== 0;
    if (e[0] === V.local && e[1] === 1 && rocket(e[2])) {
      // A rocket launch: no tracer, the projectile itself comes back in the snapshots.
      this.kick = 2.2;
      this.muzzle = 0.08;
    } else if (e[0] === V.local && e[1] === 1) {
      // Our own shot: draw the tracer immediately from a local trace instead of waiting for the host.
      const dir = [-Math.sin(view.yaw) * Math.cos(view.pitch), Math.sin(view.pitch), -Math.cos(view.yaw) * Math.cos(view.pitch)];
      const dist = s.game.raycast(view.pos, dir, 120);
      const right = [Math.cos(view.yaw), 0, -Math.sin(view.yaw)];
      const from = [view.pos[0] + dir[0] * 0.7 + right[0] * 0.12, view.pos[1] + dir[1] * 0.7 - 0.1, view.pos[2] + dir[2] * 0.7 + right[2] * 0.12];
      this.tracers.push({ a: from, b: [view.pos[0] + dir[0] * dist, view.pos[1] + dir[1] * dist, view.pos[2] + dir[2] * dist], t: 0.06, color: this.tracerColor(e[2]) });
      // Impact sparks where it hit the world.
      if (dist < 120) this.flashes.push({ pos: [view.pos[0] + dir[0] * (dist - 0.05), view.pos[1] + dir[1] * (dist - 0.05), view.pos[2] + dir[2] * (dist - 0.05)], t: 0.08, life: 0.08, color: [1, 0.75, 0.4], radius: 3, size: 0.08 });
      this.kick = 1;
      this.muzzle = 0.05;
    } else if (e[0] === V.shot && e[1] !== s.selfId) {
      const shooter = s.players().find(p => p.id === e[1]);
      const from = shooter ? [shooter.x - Math.sin(shooter.yaw) * 0.6, shooter.y + 1.35, shooter.z - Math.cos(shooter.yaw) * 0.6] : [e[3], e[4] + 4, e[5]];
      if (!rocket(e[2])) this.tracers.push({ a: from, b: [e[3], e[4], e[5]], t: 0.06, color: this.tracerColor(e[2]) });
      if (shooter) this.flashes.push({ pos: from, t: 0.05, life: 0.05, color: [1, 0.8, 0.4], radius: 7, size: 0.16 });
    } else if (e[0] === V.explode && e[5] === 0) {
      this.blast([e[1], e[2] + 0.4, e[3]], e[4]);
    } else if (e[0] === V.explode) {
      const stun = e[5] === 1;
      this.flashes.push({ pos: [e[1], e[2] + 0.5, e[3]], t: 0.35, life: 0.35, color: stun ? [0.5, 0.7, 1] : [1, 0.2, 0.2], radius: e[4] * 2.5, size: e[4] * 0.5 });
    } else if (e[0] === V.power && this.switchAt) {
      // Contacts arcing as the breaker closes.
      const sw = this.switchAt;
      for (let k = 0; k < 8; k++) this.flashes.push({ pos: [sw.x + sw.nx * 0.42, 1.2, sw.z + sw.nz * 0.42], t: 0.3 + Math.random() * 0.3, life: 0.6, color: [0.7, 0.85, 1], radius: 0, size: 0.04, glow: 8, vel: [sw.nx * 2 + (Math.random() - 0.5) * 3, 1 + Math.random() * 3, sw.nz * 2 + (Math.random() - 0.5) * 3] });
      this.flashes.push({ pos: [sw.x + sw.nx * 0.5, 1.3, sw.z + sw.nz * 0.5], t: 0.15, life: 0.15, color: [0.7, 0.85, 1], radius: 9, size: 0.2, glow: 8 });
    } else if (e[0] === V.zdeath && this.zanim.has(e[1]) && this.corpses.length < 24) {
      const a = this.zanim.get(e[1])!;
      const rec = new Float32Array(this.sim.L.Z._len);
      this.corpses.push({ id: e[1], x: a.x, y: e[3], z: a.z, yaw: a.yaw, kind: a.kind, t: 0, rec });
      this.flashes.push({ pos: [e[2], e[3] + 1, e[4]], t: 0.18, life: 0.18, color: [0.5, 0.04, 0.03], radius: 0, size: 0.4 });
    } else if (e[0] === V.zdeath) {
      this.flashes.push({ pos: [e[2], e[3] + 1, e[4]], t: 0.18, life: 0.18, color: [0.5, 0.04, 0.03], radius: 0, size: 0.6 });
    } else if (e[0] === V.powerup && e[5] === 1) {
      this.flashes.push({ pos: [e[2], e[3], e[4]], t: 0.4, life: 0.4, color: POWERUP_COLORS[e[1]] ?? [1, 1, 1], radius: 12, size: 0.8 });
    } else if ((e[0] === V.pdown || e[0] === V.zattack) && e[e[0] === V.pdown ? 1 : 2] === s.selfId) {
      this.hurt = 1;
    } else if (e[0] === V.hit) {
      this.flashes.push({ pos: [e[5], e[6], e[7]], t: 0.12, life: 0.12, color: [0.45, 0.03, 0.02], radius: 0, size: 0.22 });
    }
  }
  /** An explosion: a bright core that lights the area, fire, flying sparks and lingering smoke. */
  private blast(at: number[], r: number): void {
    const rnd = (k: number) => (Math.random() * 2 - 1) * k;
    this.flashes.push({ pos: at, t: 0.3, life: 0.3, color: [1, 0.72, 0.4], radius: r * 2.5, size: r * 0.22, glow: 5 });
    for (let i = 0; i < 8; i++) {
      const life = 0.4 + Math.random() * 0.25;
      this.flashes.push({ pos: [at[0] + rnd(r * 0.28), at[1] + Math.random() * r * 0.25, at[2] + rnd(r * 0.28)], t: life, life, color: [1, 0.36 + Math.random() * 0.2, 0.06], radius: 0, size: r * (0.11 + Math.random() * 0.07), glow: 2.6, rise: 0.8 });
    }
    for (let i = 0; i < 7; i++) {
      const life = 1.3 + Math.random() * 0.6;
      const g = 0.1 + Math.random() * 0.06;
      this.flashes.push({ pos: [at[0] + rnd(r * 0.3), at[1] + Math.random() * r * 0.2, at[2] + rnd(r * 0.3)], t: life, life, color: [g, g, g * 1.05], radius: 0, size: r * (0.16 + Math.random() * 0.08), glow: 0, rise: 1.6 });
    }
    for (let i = 0; i < 10; i++) {
      const life = 0.35 + Math.random() * 0.3;
      this.flashes.push({ pos: at.slice(), t: life, life, color: [1, 0.8, 0.45], radius: 0, size: 0.05, glow: 6, vel: [rnd(9), 3 + Math.random() * 7, rnd(9)] });
    }
  }
  /** Where a world point was on screen last frame (0..1 across and down), or null behind the camera. */
  project(p: ArrayLike<number>): [number, number] | null {
    const m = this.prevViewProj;
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0.05) return null;
    const x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
    const y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
    return [x * 0.5 + 0.5, 0.5 - y * 0.5];
  }

  private tracerColor(weapon: number): RGB {
    const slug = this.sim.catalog.weapons[weapon]?.slug;
    return slug === 'arc' ? [0.3, 0.8, 1] : slug === 'stormlance' ? [0.7, 0.4, 1] : slug === 'verdict' ? [1, 0.5, 0.1] : [1, 0.85, 0.55];
  }

  /**
   * Draws a glTF model. `camo` (a material layer, or -1) replaces the polymer furniture of a gun;
   * the gilded finish covers the metal too.
   */
  private drawModel(groups: Map<string, { mesh: number; shadow: boolean; batch: Batch }>, name: string, matrix: Float32Array, flags: number, shadow: boolean, camo = -1): Model | null {
    const model = this.models.get(name);
    if (!model) return null;
    for (const part of model.parts) {
      const key = `${part.mesh}:${shadow}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mesh: part.mesh, shadow, batch: new Batch() }));
      let layer = part.layer;
      if (camo >= 0 && (layer === MAT.polymer || (camo === MAT.gilded && layer === MAT.gunmetal))) layer = camo;
      g.batch.mat(matrix, layer === part.layer ? part.color : [1, 1, 1], layer, part.metallic, layer >= 0 ? 1 : part.roughness, part.emissive, flags);
    }
    return model;
  }

  /**
   * An undead body: hunched, arms reaching, a dragging gait whose speed and violence grow with its
   * kind (0 walker, 1 runner, 2 sprinter). Built from stretched spheres so the silhouette is round.
   */
  /**
   * One of the dead. Each keeps a little animation state so it moves like a body rather than a
   * puppet: the stride advances with the ground actually covered (feet do not slide), turning,
   * speed and the attack ease in and out, hits make it flinch, and every one has its own height,
   * build, slouch, complexion and wounds. `fall` (0..1) tips it over backwards for a death.
   */
  private zombie(out: Batch, glow: Batch, z: { id: number; x: number; y: number; z: number; yaw: number; rec: Float32Array }, state: number, kind: number, t: number, dt = 0, fall = 0): void {
    const turned = state === 4;
    // Stable per-zombie variation.
    const hsh = (n: number) => { let h = Math.imul(z.id * 2654435761 + n * 40503, 2246822519) >>> 0; h ^= h >>> 13; return (h % 1000) / 1000; };
    const tall = 0.93 + hsh(1) * 0.15, broad = 0.9 + hsh(2) * 0.25, slouch = hsh(3), limp = hsh(4) < 0.35 ? (hsh(5) < 0.5 ? -1 : 1) : 0;
    const oneArm = hsh(6) < 0.18 ? (hsh(7) < 0.5 ? -1 : 1) : 0;
    const rag = RAGS[z.id % RAGS.length];
    const trouser: RGB = [rag[2] * 0.7, rag[1] * 0.7, rag[0] * 0.75];
    const pall = 0.85 + hsh(8) * 0.35;
    // Dead skin: grey with a little green or blue in it, never healthy.
    const hue = hsh(15);
    const skinTint: RGB = turned ? [1.0, 1.2, 1.8] : [(0.78 + hue * 0.12) * pall, (0.86 + hue * 0.06) * pall, (0.78 + (1 - hue) * 0.1) * pall];
    const gore: RGB = [0.5, 0.05, 0.04];

    let a = this.zanim.get(z.id);
    const hp = z.rec[this.sim.L.Z.hp] ?? 1;
    if (!a) { a = { phase: hsh(9) * 6.28, yaw: z.yaw, speed: 0, attack: 0, flinch: 0, x: z.x, z: z.z, hp, kind, seen: t }; this.zanim.set(z.id, a); }
    if (fall === 0) {
      const moved = Math.hypot(z.x - a.x, z.z - a.z);
      const speed = dt > 0 ? Math.min(moved / dt, 9) : 0;
      a.speed += (speed - a.speed) * Math.min(1, dt * 8);
      // About 1.25 m per full stride cycle, shorter for shamblers.
      a.phase += (moved / ([0.95, 1.25, 1.45][kind] ?? 1.1)) * Math.PI * 2 * 0.5;
      let dy = z.yaw - a.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      a.yaw += dy * Math.min(1, dt * 7);
      a.attack += ((state === 2 ? 1 : 0) - a.attack) * Math.min(1, dt * 10);
      if (hp < a.hp - 0.001) a.flinch = 1;
      a.flinch = Math.max(0, a.flinch - dt * 4.5);
      a.x = z.x; a.z = z.z; a.hp = hp; a.kind = kind; a.seen = t;
    }
    const ph = a.phase;
    const go = Math.min(1, a.speed / 1.2); // 0 standing, 1 moving
    const rise = state === 0 ? -1.15 * tall + Math.min(1, Math.max(0, 1 - hp)) * tall : 0;
    const amp = ([0.36, 0.55, 0.72][kind] ?? 0.4) * go;
    const lean = ([0.34, 0.5, 0.68][kind] ?? 0.4) + slouch * 0.16 - a.flinch * 0.5 + a.attack * 0.2;
    const sway = Math.sin(ph) * 0.05 * go + Math.sin(t * 0.9 + z.id) * 0.02;
    const bob = Math.abs(Math.cos(ph)) * 0.045 * go * (1 + kind * 0.5);
    const base = frame(z.x, z.y + rise, z.z, a.yaw + sway * 0.6);
    // Falling: the whole body tips backwards about the feet and the limbs go slack.
    const fa = fall * fall * (3 - 2 * fall) * 1.52;
    const cf = Math.cos(fa), sf = Math.sin(fa);
    const at = (lx: number, ly: number, lz: number): V3 => base.at(lx * broad, (ly * cf + lz * sf) * tall + fall * 0.06, (lz * cf - ly * sf) * tall);
    const right = base.right;
    const live = 1 - fall;

    const hip = 0.93 + bob - a.attack * 0.03;
    const chestL: [number, number, number] = [sway * 0.5, hip + Math.cos(lean) * 0.5, Math.sin(lean) * 0.5];
    void chestL;
    const nod = Math.sin(t * 1.1 + z.id) * 0.03 * live;
    const headL: [number, number, number] = [chestL[0] + (limp ? limp * 0.03 : 0) + nod, chestL[1] + 0.25, chestL[2] + 0.1 + lean * 0.14];
    const headP = at(...headL);

    // Legs: the limping leg takes a short, stiff step and drags.
    for (const side of [-1, 1]) {
      const sp = ph + (side > 0 ? Math.PI : 0);
      const lame = limp === side ? 0.45 : 1;
      const swing = Math.sin(sp) * amp * lame * live;
      const bend = (Math.max(0, -Math.cos(sp)) * amp * 1.5 * lame + 0.1) * live + fall * 0.5 * (side > 0 ? 1 : 0.3);
      const [knee, ankle] = chain(at, [side * 0.1, hip - 0.04, 0], 0.46, 0.44, swing, bend);
      this.seg('thigh', at(side * 0.1, hip, 0), knee, 0.085, trouser, MAT.fabric, 0.09, right);
      this.seg('shin', knee, ankle, 0.062, trouser, MAT.fabric, 0.066, right);
      // Foot: a shoe pointing the way it walks, kept above the ground.
      const fwd = base.fwd;
      const sole = Math.max(ankle[1] - 0.04, z.y + rise + 0.04);
      this.seg('boot', [ankle[0] - fwd[0] * 0.06, sole, ankle[2] - fwd[2] * 0.06], [ankle[0] + fwd[0] * 0.19 * cf, sole + sf * 0.12, ankle[2] + fwd[2] * 0.19 * cf], 0.055, [0.45, 0.38, 0.32], MAT.fabric, 0.06, right);
    }
    const jawDropEarly = (0.035 + a.attack * 0.04) * live;
    // Torso: pelvis, a hunched rib cage wider at the shoulders, and the belly between.
    this.seg('torsoGaunt', at(0, hip - 0.1, 0), at(chestL[0], chestL[1] + 0.12, chestL[2] + 0.03), 0.2, rag, MAT.fabric, 0.14, right);
    const ribs = at(chestL[0], chestL[1] - 0.09, chestL[2] - 0.01);
    this.seg('torsoGaunt', at(0, hip - 0.1, 0), at(0, hip + 0.16, 0.02), 0.19, trouser, MAT.fabric, 0.14, right);
    // Torn shirt: bare, wounded skin showing through on one side.
    const wound = at(chestL[0] + (hsh(10) - 0.5) * 0.2, chestL[1] - 0.16 - hsh(11) * 0.1, chestL[2] + 0.1);
    out.limb(wound, [wound[0] + right[0] * 0.07, wound[1] - 0.06, wound[2] + right[2] * 0.07], 0.05, gore, MAT.skin, 0, 0.03);
    void ribs;
    // Ripped clothing: strips of shirt hanging and swinging, a torn trouser leg, dried blood.
    for (let k = 0; k < 4; k++) {
      const sx = (hsh(20 + k) - 0.5) * 0.36, len = 0.12 + hsh(24 + k) * 0.2;
      const top = at(chestL[0] + sx, chestL[1] - 0.24 - hsh(28 + k) * 0.08, chestL[2] + (k % 2 ? 0.11 : -0.1));
      const swing = Math.sin(ph * 2 + k * 1.7) * 0.05 * go + Math.sin(t * 1.4 + k) * 0.012;
      out.limb(top, [top[0] + right[0] * swing, top[1] - len, top[2] + right[2] * swing - base.fwd[2] * 0.02 * go], 0.028, [rag[0] * 0.8, rag[1] * 0.8, rag[2] * 0.8], MAT.fabric, 0, 0.008);
    }
    // Bare, grey shin where one trouser leg has gone, and stains down the front.
    const tornSide = hsh(32) < 0.5 ? -1 : 1;
    const [tk, ta] = chain(at, [tornSide * 0.1, hip - 0.04, 0], 0.46, 0.44, Math.sin(ph + (tornSide > 0 ? Math.PI : 0)) * amp * (limp === tornSide ? 0.45 : 1) * live, (Math.max(0, -Math.cos(ph + (tornSide > 0 ? Math.PI : 0))) * amp * 1.5 * (limp === tornSide ? 0.45 : 1) + 0.1) * live + fall * 0.5 * (tornSide > 0 ? 1 : 0.3));
    this.seg('shin', [(tk[0] + ta[0]) / 2, (tk[1] + ta[1]) / 2, (tk[2] + ta[2]) / 2], ta, 0.062, skinTint, MAT.skin, 0.066, right);
    const stain = at(chestL[0] + (hsh(33) - 0.5) * 0.12, chestL[1] - 0.02, chestL[2] + 0.115);
    this.put('gear', stain[0], stain[1], stain[2], 0.16, 0.2, 0.04, [0.28, 0.04, 0.03], MAT.fabric, 0, 0, a.yaw, -lean);
    const chin = at(headL[0], headL[1] - 0.07 - jawDropEarly, headL[2] + 0.09);
    this.put('gear', chin[0], chin[1], chin[2], 0.07, 0.04, 0.04, gore, MAT.skin, 0, 0, a.yaw);
    // Neck and head: skull, brow, sunken cheeks, a slack jaw that works as it moans.
    this.seg('neck', at(chestL[0], chestL[1] + 0.08, chestL[2] + 0.02), headP, 0.05, skinTint, MAT.skin, 0.05, right);
    const tilt = (limp * 0.25 + Math.sin(t * 0.8 + z.id) * 0.08) * live;
    const skull = at(headL[0], headL[1] + 0.06, headL[2] + 0.01);
    this.put('headDead', skull[0], skull[1], skull[2], 0.2 * broad ** 0.3, 0.25 * tall, 0.235, skinTint, MAT.skin, 0, 0, a.yaw, -lean * 0.45 + fa, tilt);
    const jawDrop = (0.035 + Math.abs(Math.sin(t * 2.1 + z.id)) * 0.035 + a.attack * 0.04) * live + fall * 0.05;
    const jp = at(headL[0], headL[1] - 0.045 - jawDrop, headL[2] + 0.075);
    this.put('gear', jp[0], jp[1], jp[2], 0.11, 0.045, 0.1, skinTint, MAT.skin, 0, 0, a.yaw, 0.35 + fa, tilt);
    const mouth = at(headL[0], headL[1] - 0.02 - jawDrop * 0.5, headL[2] + 0.1);
    out.box(mouth[0], mouth[1], mouth[2], 0.09, 0.02 + jawDrop, 0.03, [0.12, 0.02, 0.02], MAT.skin, 0, 0, a.yaw, fa, tilt);
    if (hsh(12) < 0.6) {
      // Matted hair.
      const hair = at(headL[0], headL[1] + 0.15, headL[2] - 0.04);
      this.put('helmet', hair[0], hair[1] - 0.03, hair[2], 0.215, 0.17, 0.235, [0.25, 0.22, 0.2], MAT.fabric, 0, 0, a.yaw, -lean * 0.45 + fa, tilt);
    }
    // Arms: shamblers grope ahead, runners pump, an attack lunges and claws. A missing arm is a stump.
    for (const side of [-1, 1]) {
      const sh = at(chestL[0] + side * 0.21, chestL[1] - 0.04, chestL[2]);
      if (oneArm === side) {
        const stump = at(chestL[0] + side * 0.27, chestL[1] - 0.2, chestL[2] + 0.02);
        this.seg('upperArm', sh, stump, 0.055, rag, MAT.fabric, 0.055, right);
        out.limb(stump, [stump[0], stump[1] - 0.04, stump[2]], 0.045, gore, MAT.skin, 0, 0.045);
        continue;
      }
      const pump = Math.sin(ph + (side > 0 ? 0 : Math.PI)) * go;
      const grope = kind === 0 ? 0.62 + Math.sin(ph * 0.5 + side) * 0.1 : 0.3 + pump * 0.45;
      const claw = 0.95 + Math.sin(t * 13 + side * 1.7) * 0.35;
      const raise = (grope * (1 - a.attack) + claw * a.attack) * live - fall * 0.3;
      const el = at(chestL[0] + side * (0.27 + fall * 0.12), chestL[1] - 0.3 + raise * 0.24, chestL[2] + 0.1 + raise * 0.15);
      const hand = at(chestL[0] + side * (0.2 + fall * 0.25), chestL[1] - 0.34 + raise * 0.47, chestL[2] + 0.36 * live + raise * 0.13 + a.attack * 0.12);
      this.seg('upperArm', sh, el, 0.055, hsh(13 + side) < 0.5 ? rag : skinTint, hsh(13 + side) < 0.5 ? MAT.fabric : MAT.skin, 0.053, right);
      this.seg('forearm', el, hand, 0.045, skinTint, MAT.skin, 0.04, right);
      const hd = [hand[0] - el[0], hand[1] - el[1], hand[2] - el[2]], hl = Math.hypot(hd[0], hd[1], hd[2]) || 1;
      this.seg('hand', hand, [hand[0] + (hd[0] / hl) * 0.12, hand[1] + (hd[1] / hl) * 0.12, hand[2] + (hd[2] / hl) * 0.12], 0.045, skinTint, MAT.skin, 0.025, right);
      // Hand: a palm and three hooked fingers.
      const fwd = base.fwd;
      const curl = 0.3 + a.attack * 0.5;
      for (let f = -1; f <= 1; f++) {
        const k: V3 = [hand[0] + right[0] * f * 0.022, hand[1], hand[2] + right[2] * f * 0.022];
        out.limb(k, [k[0] + fwd[0] * 0.075, k[1] - 0.075 * curl + raise * 0.03, k[2] + fwd[2] * 0.075], 0.012, skinTint, MAT.skin, 0, 0.012);
      }
    }
    // Eyes: a dull glow that dies with them.
    const eye: RGB = turned ? [0.4, 0.8, 1] : [1, 0.62, 0.12];
    for (const side of [-1, 1]) {
      const e = at(headL[0] + side * 0.05, headL[1] + 0.075, headL[2] + 0.115);
      glow.box(e[0], e[1], e[2], 0.032, 0.02, 0.02, eye, -1, 7 * live, FLAG_NOSHADOW, a.yaw);
    }
  }

  /** A survivor: helmet, team-coloured vest over fatigues, boots, rifle held at the ready. */
  /**
   * A soldier. Built from rounded forms: boots, trousers with cargo pockets and knee pads, a belt
   * with holster and pouches, a plate carrier with magazines, a pack, sleeves or bare forearms,
   * gloved hands on the weapon, and a head with the chosen face, eyewear and headgear. The stride
   * follows the ground covered, the spine leans into a run and bends with the aim, and reloading
   * or swapping weapons moves the hands and the gun.
   */
  private survivor(out: Batch, glow: Batch, groups: Map<string, { mesh: number; shadow: boolean; batch: Batch }>, p: { id: number; x: number; y: number; z: number; yaw: number; rec: Float32Array }, t: number, dt = 0): void {
    const { P } = this.sim.L;
    const look = this.lookOf(p.id);
    // In team modes the vest always shows the side, so friend and foe are easy to tell apart.
    const sideTint = MODES[this.session.start.mode]?.teams ? TEAM_COLORS[p.rec[P.team]] : undefined;
    const vest: RGB = sideTint ?? (look.vest ? VESTS[look.vest - 1].rgb : [0.3, 0.34, 0.26]);
    const fatigues: RGB = FATIGUES[look.fatigues]?.rgb ?? FATIGUES[0].rgb;
    const skin: RGB = SKINS[look.skin]?.rgb ?? SKINS[1].rgb;
    const glove: RGB = look.gloves === 4 ? skin : GLOVES[look.gloves]?.rgb ?? GLOVES[0].rgb;
    const gloveMat = look.gloves === 4 ? MAT.skin : MAT.fabric;
    const boot: RGB = BOOTS[look.boots]?.rgb ?? BOOTS[0].rgb;
    const helm: RGB = HELMETS[look.helmet]?.rgb ?? HELMETS[0].rgb;
    const web: RGB = [vest[0] * 0.8, vest[1] * 0.8, vest[2] * 0.8];
    const bulk = [0.92, 1, 1.12][look.build] ?? 1;
    const life = p.rec[P.life];
    const pitch = p.rec[P['ctl.pitch']];
    const crouch = p.rec[P['ctl.crouched']] ? 1 : 0;
    const slide = p.rec[P['ctl.mode']] === 1;

    let a = this.panim.get(p.id);
    if (!a) { a = { phase: 0, x: p.x, z: p.z, speed: 0, crouch: 0, reload: 0, swap: 0, lean: 0, seen: t }; this.panim.set(p.id, a); }
    const moved = Math.hypot(p.x - a.x, p.z - a.z);
    const speed = dt > 0 ? Math.min(moved / dt, 12) : a.speed;
    const k = Math.min(1, dt * 9);
    a.speed += (speed - a.speed) * k;
    a.phase += (moved / 1.5) * Math.PI;
    a.crouch += (crouch - a.crouch) * k;
    a.reload += ((p.rec[P['arms.reload_t']] > 0 ? 1 : 0) - a.reload) * k;
    a.swap += ((p.rec[P['arms.switch_t']] > 0 ? 1 : 0) - a.swap) * Math.min(1, dt * 12);
    a.lean += (Math.min(1, a.speed / 7) - a.lean) * k;
    a.x = p.x; a.z = p.z; a.seen = t;

    const base = frame(p.x, p.y, p.z, p.yaw);
    const { right, fwd } = base;
    const at = (lx: number, ly: number, lz: number): V3 => base.at(lx * bulk, ly, lz);
    if (life === 1) {
      // Downed: on one side, an arm up for help.
      this.seg('torso', at(0, 0.2, -0.55), at(0, 0.24, 0.2), 0.2, fatigues, MAT.fabric, 0.14);
      this.seg('thigh', at(0, 0.2, -0.55), at(0.12, 0.14, -1.0), 0.1, fatigues, MAT.fabric, 0.1);
      this.seg('shin', at(0.12, 0.14, -1.0), at(0.1, 0.1, -1.4), 0.07, fatigues, MAT.fabric, 0.07);
      this.put('gear', ...at(0, 0.27, 0.02), 0.44, 0.2, 0.4, vest, MAT.fabric, 0, 0, p.yaw);
      this.put('head', ...at(0, 0.3, 0.45), 0.2, 0.25, 0.23, skin, MAT.skin, 0, 0, p.yaw, Math.PI / 2);
      const wave = Math.sin(t * 5) * 0.12;
      out.limb(at(0.2, 0.3, 0.2), at(0.3 + wave, 0.7, 0.3), 0.05, fatigues, MAT.fabric);
      glow.box(p.x, 1.4 + Math.sin(t * 4) * 0.1, p.z, 0.2, 0.2, 0.2, [0.3, 0.6, 1], -1, 4, FLAG_NOSHADOW, t * 2, 0.6);
      return;
    }
    const ph = a.phase;
    const go = Math.min(1, a.speed / 2);
    const amp = Math.min(0.62, a.speed * 0.085) * (1 - a.crouch * 0.3);
    const bounce = Math.abs(Math.cos(ph)) * 0.05 * go;
    const hip = 0.96 - a.crouch * 0.42 - (slide ? 0.45 : 0) + bounce;
    // Legs.
    for (const sd of [-1, 1]) {
      const sp = ph + (sd > 0 ? Math.PI : 0);
      const [knee, ankle] = slide
        ? [at(sd * 0.12, 0.35, 0.35 + (sd > 0 ? 0.25 : 0)), at(sd * 0.12, 0.1, 0.75 + (sd > 0 ? 0.2 : 0))]
        : chain(at, [sd * 0.105, hip - 0.04, 0], 0.46, 0.45, Math.sin(sp) * amp + a.crouch * 0.85, Math.max(0, -Math.cos(sp)) * amp * 1.5 + a.crouch * 1.7 + 0.06);
      const hipJ = at(sd * 0.105, hip, 0);
      this.seg('thigh', hipJ, knee, 0.1 * bulk, fatigues, MAT.fabric, 0.105 * bulk, right);
      this.seg('shin', knee, ankle, 0.07, fatigues, MAT.fabric, 0.074, right);
      // Cargo pocket on the thigh.
      const pk: V3 = [(hipJ[0] + knee[0]) / 2 + right[0] * sd * 0.1, (hipJ[1] + knee[1]) / 2, (hipJ[2] + knee[2]) / 2 + right[2] * sd * 0.1];
      this.put('gear', pk[0], pk[1], pk[2], 0.05, 0.16, 0.13, fatigues, MAT.fabric, 0, 0, p.yaw);
      if (look.pads > 0) this.put('gear', knee[0] + fwd[0] * 0.055, knee[1], knee[2] + fwd[2] * 0.055, 0.12, 0.15, 0.07, [0.5, 0.5, 0.5], MAT.polymer, 0, 0, p.yaw);
      // Boot: ankle, toe and a dark sole.
      const sole = Math.max(ankle[1] - 0.05, p.y + 0.045);
      this.seg('shin', [ankle[0], ankle[1] + 0.06, ankle[2]], [ankle[0], sole + 0.04, ankle[2]], 0.062, boot, MAT.fabric, 0.066, right);
      this.seg('boot', [ankle[0] - fwd[0] * 0.07, sole + 0.02, ankle[2] - fwd[2] * 0.07], [ankle[0] + fwd[0] * 0.19, sole + 0.02, ankle[2] + fwd[2] * 0.19], 0.058, boot, MAT.fabric, 0.07, right);
      this.put('gear', ankle[0] + fwd[0] * 0.065, sole - 0.03, ankle[2] + fwd[2] * 0.065, 0.1, 0.03, 0.29, [0.25, 0.25, 0.25], MAT.polymer, 0, 0, p.yaw);
    }
    // Spine: leans into a run and bends with the aim.
    const bend = a.lean * 0.22 + a.crouch * 0.2 - pitch * 0.25;
    const up = (h: number, fwdOff = 0): [number, number, number] => [0, hip + Math.cos(bend) * h, Math.sin(bend) * h + fwdOff];
    const sway = Math.sin(ph) * 0.03 * go;
    const pelvis = at(0, hip, 0);
    const waist = at(sway * 0.3, ...up(0.2).slice(1) as [number, number]);
    const chestL = up(0.48, 0.02);
    void chestL;
    // One sculpted torso from the hips to the base of the neck, leaning with the spine.
    this.seg('torso', at(0, hip - 0.1, 0), at(sway, chestL[1] + 0.13, chestL[2] + 0.01), 0.205 * bulk, fatigues, MAT.fabric, 0.14 * bulk, right);
    void pelvis; void waist;
    // Belt, holster and pouches.
    this.put('gear', ...at(0, hip + 0.06, 0), 0.36 * bulk, 0.055, 0.27, [0.35, 0.33, 0.3], MAT.fabric, 0, 0, p.yaw);
    this.put('gear', ...at(0.2, hip - 0.06, 0.02), 0.06, 0.2, 0.11, [0.2, 0.2, 0.2], MAT.polymer, 0, 0, p.yaw);
    this.put('gear', ...at(-0.2, hip + 0.02, 0.0), 0.07, 0.12, 0.12, web, MAT.fabric, 0, 0, p.yaw);
    // Plate carrier: front and back plates, cummerbund, shoulder straps, three magazine pouches, a radio.
    const plate = (lz: number, th: number) => this.put('gear', ...at(sway * 0.8, chestL[1] - 0.1, chestL[2] + lz), 0.33 * bulk, 0.36, th, vest, MAT.fabric, 0, 0, p.yaw, -bend);
    plate(0.125, 0.07); plate(-0.125, 0.07);
    this.put('gear', ...at(sway * 0.6, chestL[1] - 0.2, chestL[2]), 0.41 * bulk, 0.15, 0.3, web, MAT.fabric, 0, 0, p.yaw, -bend);
    for (const sx of [-0.11, 0.11]) this.put('gear', ...at(sx, chestL[1] + 0.1, chestL[2]), 0.06, 0.05, 0.3, web, MAT.fabric, 0, 0, p.yaw, -bend);
    for (const lx of [-0.11, 0, 0.11]) {
      this.put('gear', ...at(lx + sway * 0.7, chestL[1] - 0.2, chestL[2] + 0.185), 0.085, 0.16, 0.06, web, MAT.fabric, 0, 0, p.yaw, -bend);
      this.put('gear', ...at(lx + sway * 0.7, chestL[1] - 0.105, chestL[2] + 0.185), 0.06, 0.04, 0.035, [0.15, 0.15, 0.15], MAT.polymer, 0, 0, p.yaw, -bend);
    }
    this.put('gear', ...at(-0.15, chestL[1] + 0.02, chestL[2] + 0.15), 0.06, 0.13, 0.045, [0.12, 0.12, 0.12], MAT.polymer, 0, 0, p.yaw, -bend);
    out.box(...at(-0.15, chestL[1] + 0.14, chestL[2] + 0.15), 0.012, 0.16, 0.012, [0.1, 0.1, 0.1], MAT.polymer); // aerial
    // Pack.
    if (look.pack > 0) {
      const size = [0, 0.34, 0.3, 0.2, 0.46][look.pack] ?? 0.3, depth = [0, 0.16, 0.14, 0.07, 0.22][look.pack] ?? 0.15;
      const packTint: RGB = look.pack === 2 ? [0.2, 0.22, 0.2] : web;
      this.put('gear', ...at(0, chestL[1] - 0.12 - (look.pack === 4 ? 0.06 : 0), chestL[2] - 0.17 - depth / 2), 0.3 * bulk, size, depth, packTint, look.pack === 2 ? MAT.polymer : MAT.fabric, 0, 0, p.yaw, -bend);
      if (look.pack === 2) out.box(...at(0.1, chestL[1] + 0.35, chestL[2] - 0.22), 0.014, 0.6, 0.014, [0.1, 0.1, 0.1], MAT.polymer);
      if (look.pack === 4) this.put('gear', ...at(0, chestL[1] + 0.12, chestL[2] - 0.26), 0.34 * bulk, 0.14, 0.2, fatigues, MAT.fabric, 0, 0, p.yaw, -bend);
    }
    // Neck and head (the head turns with the aim).
    const hp = pitch * 0.55;
    const neck = at(sway, chestL[1] + 0.13, chestL[2] + 0.02);
    const headL: [number, number, number] = [sway, chestL[1] + 0.27, chestL[2] + 0.04 + Math.sin(-hp) * 0.02];
    const head = at(...headL);
    this.seg('neck', neck, at(headL[0], headL[1] - 0.09, headL[2] - 0.01), 0.055, skin, MAT.skin, 0.055, right);
    const masked = look.face === 3;
    const faceTint: RGB = masked ? [0.35, 0.35, 0.36] : skin;
    this.put('head', head[0], head[1], head[2], 0.205, 0.255, 0.235, faceTint, masked ? MAT.fabric : MAT.skin, 0, 0, p.yaw, hp);
    const onHead = (lx: number, ly: number, lz: number): V3 => at(headL[0] + lx / bulk, headL[1] + ly * Math.cos(hp) + lz * Math.sin(hp), headL[2] + lz * Math.cos(hp) - ly * Math.sin(hp));
    if (!masked) {
      for (const ex of [-0.04, 0.04]) out.box(...onHead(ex, 0.025, 0.098), 0.028, 0.014, 0.012, [0.08, 0.06, 0.05], MAT.skin, 0, 0, p.yaw, hp); // eyes
    }
    const hairTint: RGB = [0.16, 0.12, 0.09];
    if (look.face === 1 || look.face === 2) out.box(...onHead(0, -0.075, 0.05), look.face === 2 ? 0.17 : 0.165, look.face === 2 ? 0.13 : 0.09, 0.15, look.face === 2 ? hairTint : [skin[0] * 0.6, skin[1] * 0.6, skin[2] * 0.6], look.face === 2 ? MAT.fabric : MAT.skin, 0, 0, p.yaw, hp);
    if (look.face === 6) out.box(...onHead(0, -0.05, 0.1), 0.09, 0.02, 0.03, hairTint, MAT.fabric, 0, 0, p.yaw, hp);
    if (look.face === 4) for (const ex of [-0.05, 0.05]) out.box(...onHead(ex, -0.01, 0.092), 0.06, 0.035, 0.03, [0.1, 0.14, 0.08], MAT.skin, 0, 0, p.yaw, hp + 0.3); // face paint
    if (look.face === 5) out.box(...onHead(0, -0.06, 0.06), 0.185, 0.11, 0.16, [0.25, 0.27, 0.22], MAT.fabric, 0, 0, p.yaw, hp); // half mask
    // Eyewear.
    if (look.eyewear === 1) { out.box(...onHead(0, 0.03, 0.1), 0.17, 0.055, 0.05, [0.15, 0.15, 0.15], MAT.polymer, 0, 0, p.yaw, hp); out.box(...onHead(0, 0.03, 0.118), 0.14, 0.04, 0.02, [0.3, 0.2, 0.1], -1, 0, 0, p.yaw, hp, 0, 0.4, 0.1); }
    if (look.eyewear === 2) out.box(...onHead(0, 0.028, 0.108), 0.16, 0.035, 0.025, [0.03, 0.03, 0.03], -1, 0, 0, p.yaw, hp, 0, 0.3, 0.08);
    if (look.eyewear === 4) out.box(...onHead(0, 0.028, 0.108), 0.15, 0.035, 0.012, [0.6, 0.7, 0.8], -1, 0, 0, p.yaw, hp, 0, 0.2, 0.05);
    // Headgear.
    const hg = look.headgear;
    if (hg === 0 || hg === 5) {
      const high = hg === 5;
      this.put('helmet', ...onHead(0, high ? 0.075 : 0.055, -0.005), 0.265, high ? 0.22 : 0.27, 0.285, helm, MAT.painted, 0, 0, p.yaw, hp);
      this.put('gear', ...onHead(0, 0.1, 0.13), 0.06, 0.05, 0.02, [0.15, 0.15, 0.15], MAT.polymer, 0, 0, p.yaw, hp); // mount
      for (const ex of [-0.127, 0.127]) this.put('gear', ...onHead(ex, 0.07, 0), 0.012, 0.03, 0.14, [0.15, 0.15, 0.15], MAT.polymer, 0, 0, p.yaw, hp); // rails
      out.box(...onHead(0, -0.1, 0.03), 0.17, 0.02, 0.1, [0.2, 0.2, 0.2], MAT.fabric, 0, 0, p.yaw, hp); // chin strap
      if (high) { for (const ex of [-0.115, 0.115]) out.box(...onHead(ex, 0, 0), 0.05, 0.1, 0.09, [0.2, 0.22, 0.2], MAT.polymer, 0, 0, p.yaw, hp); out.limb(onHead(-0.115, -0.02, 0.03), onHead(-0.05, -0.06, 0.11), 0.008, [0.1, 0.1, 0.1], MAT.polymer); }
    } else if (hg === 1) {
      this.put('helmet', ...onHead(0, 0.06, 0), 0.22, 0.19, 0.24, fatigues, MAT.fabric, 0, 0, p.yaw, hp);
      this.put('gear', ...onHead(0, 0.075, 0.15), 0.17, 0.014, 0.1, fatigues, MAT.fabric, 0, 0, p.yaw, hp - 0.15);
    } else if (hg === 2) {
      this.put('helmet', ...onHead(0, 0.065, -0.005), 0.22, 0.24, 0.24, web, MAT.fabric, 0, 0, p.yaw, hp);
    } else if (hg === 3) {
      this.put('helmet', ...onHead(0, 0.0, -0.03), 0.28, 0.36, 0.29, fatigues, MAT.fabric, 0, 0, p.yaw, hp);
    } else if (hg === 4) {
      this.put('helmet', ...onHead(0, 0.065, -0.012), 0.212, 0.19, 0.24, hairTint, MAT.fabric, 0, 0, p.yaw, hp); // short hair
    } else if (hg === 6) {
      this.put('helmet', ...onHead(0, 0.07, 0), 0.22, 0.2, 0.235, fatigues, MAT.fabric, 0, 0, p.yaw, hp);
      out.box(...onHead(0, 0.075, 0), 0.4, 0.016, 0.42, fatigues, MAT.fabric, 0, 0, p.yaw, hp); // brim
    } else if (hg === 7) {
      this.put('helmet', ...onHead(0, 0.06, -0.005), 0.215, 0.19, 0.235, [0.45, 0.1, 0.08], MAT.fabric, 0, 0, p.yaw, hp);
      out.limb(onHead(0, 0.07, -0.11), onHead(0.03, 0.0, -0.19), 0.02, [0.45, 0.1, 0.08], MAT.fabric);
    } else if (hg === 8) {
      this.put('helmet', ...onHead(0.02, 0.1, 0), 0.25, 0.1, 0.25, [0.35, 0.1, 0.1], MAT.fabric, 0, 0, p.yaw, hp, 0.15);
    }
    if (look.eyewear === 3 && (hg === 0 || hg === 5)) {
      // Night-vision tubes flipped up on the helmet mount.
      for (const ex of [-0.035, 0.035]) out.limb(onHead(ex, 0.13, 0.13), onHead(ex, 0.2, 0.2), 0.022, [0.12, 0.12, 0.12], MAT.polymer);
    }
    // Weapon: held at the shoulder, following the aim; it dips for a reload and drops for a swap.
    const lower = a.swap * 0.9 + a.reload * 0.35;
    const gunAt = at(0.13, chestL[1] - 0.04 - lower * 0.16, chestL[2] + 0.3 - a.swap * 0.06);
    const gm = mat4();
    compose(gm, 0, gunAt[0], gunAt[1], gunAt[2], 1, 1, 1, p.yaw + a.reload * 0.25, pitch - lower * 0.7, a.reload * 0.5);
    const cur = p.rec[P['arms.cur']];
    const gun = p.rec[P[`arms.guns${cur}.id`]];
    const model = this.drawModel(groups, `weapons/${this.sim.catalog.weapons[gun]?.slug}`, gm, 0, true, CAMOS[look.camo]?.layer ?? -1);
    const grip = transformPoint(gm, [0, -0.02, 0.01]);
    const foreZ = Math.max(-0.35, (model?.min[2] ?? -0.4) * 0.55);
    // Reloading: the support hand leaves the handguard for the magazine well, down to a pouch and back.
    const cycle = Math.sin(Math.min(1, a.reload) * Math.PI * (p.rec[P['arms.reload_t']] > 0 ? 1 - (p.rec[P['arms.reload_t']] % 1) : 0));
    const magWell = transformPoint(gm, [0, -0.12, -0.12]);
    const pouch = at(-0.1, chestL[1] - 0.2, chestL[2] + 0.2);
    const foreRest = transformPoint(gm, [0, 0.0, foreZ]);
    const reloadHand: V3 = [magWell[0] + (pouch[0] - magWell[0]) * cycle, magWell[1] + (pouch[1] - magWell[1]) * cycle, magWell[2] + (pouch[2] - magWell[2]) * cycle];
    const fore = [0, 1, 2].map(i => foreRest[i] + (reloadHand[i] - foreRest[i]) * a.reload) as V3;
    const bare = look.sleeves === 2, rolled = look.sleeves === 1;
    for (const [sd, hand] of [[1, grip], [-1, fore]] as const) {
      const sh = at(sd * 0.215, chestL[1] + 0.02, chestL[2]);
      const el: V3 = [(sh[0] + hand[0]) / 2 + right[0] * sd * 0.09, (sh[1] + hand[1]) / 2 - 0.15, (sh[2] + hand[2]) / 2 + right[2] * sd * 0.09 - fwd[2] * 0.03];
      this.seg('upperArm', sh, el, 0.065 * bulk, bare ? skin : fatigues, bare ? MAT.skin : MAT.fabric, 0.063 * bulk, right);
      if (bare) this.seg('upperArm', sh, [(sh[0] * 2 + el[0]) / 3, (sh[1] * 2 + el[1]) / 3, (sh[2] * 2 + el[2]) / 3], 0.072 * bulk, fatigues, MAT.fabric, 0.07 * bulk, right);
      this.seg('forearm', el, hand as V3, 0.052 * bulk, bare || rolled ? skin : fatigues, bare || rolled ? MAT.skin : MAT.fabric, 0.048 * bulk, right);
      if (look.pads === 2) this.put('gear', el[0], el[1], el[2], 0.11, 0.12, 0.11, [0.5, 0.5, 0.5], MAT.polymer);
      // Hand: palm, thumb and fingers wrapped round the weapon.
      const hd = [hand[0] - el[0], hand[1] - el[1], hand[2] - el[2]], hl = Math.hypot(hd[0], hd[1], hd[2]) || 1;
      this.seg('hand', [hand[0] - (hd[0] / hl) * 0.04, hand[1] - (hd[1] / hl) * 0.04, hand[2] - (hd[2] / hl) * 0.04], [hand[0] + (hd[0] / hl) * 0.1, hand[1] + (hd[1] / hl) * 0.1, hand[2] + (hd[2] / hl) * 0.1], 0.048, glove, gloveMat, 0.03, right);
    }
    if (p.rec[P.shield] > 0) this.put('gear', ...at(0, chestL[1] - 0.1, chestL[2] - 0.3), 0.6, 0.8, 0.06, [0.8, 0.8, 0.8], MAT.rust, 0, 0, p.yaw);
    void neck;
  }

  build(view: View, dt: number, aspect: number, settings: SceneSettings): Frame {
    const { sim, session: s } = this;
    const { P, H, Z, E } = sim.L;
    this.time += dt;
    const t = this.time;
    const hdr = s.snap?.hdr;
    const me = s.local();
    const power = !!hdr?.[H.power];
    const { casters, round, glows, groups } = this;
    casters.n = round.n = glows.n = this.vm.n = 0;
    for (const part of Object.values(this.parts)) part.batch.n = part.vm.n = 0;
    for (const g of groups.values()) g.batch.n = 0;
    const lights: LightSrc[] = [];
    const tmp = mat4();

    // Doors still shut: rusted shutter with a frame.
    const b = s.boxes;
    for (let o = 0; o < b.length; o += 8) {
      const flags = b[o + 7] & 0xff, door = (b[o + 7] >> 8) - 1;
      if (!(flags & 4) || (hdr?.[H.doors] ?? 0) & (1 << door)) continue;
      this.addBox(casters, b, o);
      const [x0, , z0, x1, , z1] = b.subarray(o, o + 6);
      for (let y = 0.4; y < 6.5; y += 0.5) casters.box((x0 + x1) / 2, y, (z0 + z1) / 2, x1 - x0 + 0.06, 0.05, z1 - z0 + 0.06, [0.8, 0.75, 0.7], MAT.rust);
      glows.box((x0 + x1) / 2, 2.4, (z0 + z1) / 2, x1 - x0 + 0.1, 0.06, z1 - z0 + 0.1, [1, 0.25, 0.1], -1, 2.5, FLAG_NOSHADOW);
    }

    // Interactables: status lights and the weapons on display.
    const it = s.inter;
    for (let k = 0, o = 0; o < it.length; k++, o += 8) {
      const [kind, x, y, z, , param] = it.subarray(o, o + 6);
      if (kind === I.perk) {
        const c = PERK_COLORS[param] ?? [1, 1, 1];
        casters.box(x, 1.15, z, 1.2, 2.3, 1.2, c, MAT.painted);
        glows.box(x, 1.55, z, 0.9, 0.5, 1.24, c, -1, power ? 3 : 0.08, FLAG_NOSHADOW); // lit sign panel
        glows.box(x, 2.38, z, 1.25, 0.12, 1.25, c, -1, power ? 2 : 0.05, FLAG_NOSHADOW);
        if (power) lights.push({ pos: [x, 2.7, z], radius: 7, color: c, intensity: 6 });
      } else if (kind === I.wallbuy) {
        compose(tmp, 0, x, 1.25, z, 1.6, 1.6, 1.6, t * 0.6, 0, 0.25);
        this.drawModel(groups, `weapons/${sim.catalog.weapons[param]?.slug}`, tmp.slice(), 0, true);
        glows.box(x, 0.92, z, 0.62, 0.04, 0.62, [1, 0.85, 0.5], -1, 1.6, FLAG_NOSHADOW);
        lights.push({ pos: [x, 1.6, z], radius: 3.5, color: [1, 0.85, 0.5], intensity: 2 });
      } else if (kind === I.crate && hdr && k === hdr[H.crate_at]) {
        const state = hdr[H.crate_state];
        glows.box(x, 0.93, z, 1.5, 0.05, 0.9, [0.35, 0.65, 1], -1, state === 3 ? 0.2 : 3, FLAG_NOSHADOW);
        // A beam of light marks where the crate is.
        glows.box(x, 12, z, 0.25, 22, 0.25, [0.35, 0.6, 1], -1, state === 3 ? 0 : 0.8, FLAG_NOSHADOW);
        lights.push({ pos: [x, 1.6, z], radius: 6, color: [0.35, 0.6, 1], intensity: 5 });
        const cycle = this.crateWeapons;
        const shown = state === 2 ? hdr[H.crate_weapon] : state === 1 && cycle.length ? cycle[Math.floor(t * 9) % cycle.length] : -1;
        if (shown >= 0) {
          compose(tmp, 0, x, 1.5 + Math.sin(t * 3) * 0.05, z, 1.8, 1.8, 1.8, Math.PI / 2, 0, 0);
          this.drawModel(groups, `weapons/${sim.catalog.weapons[shown]?.slug}`, tmp.slice(), 0, true);
        }
      } else if (kind === I.bench) {
        glows.box(x, 2.35, z, 1.0, 0.1, 1.0, [0.8, 0.3, 1], -1, power ? 3 : 0.05, FLAG_NOSHADOW);
        if (power) lights.push({ pos: [x, 2.9, z], radius: 7, color: [0.8, 0.3, 1], intensity: 6 });
      } else if (kind === I.tonic) {
        glows.box(x, 2.35, z, 0.7, 0.1, 0.7, [0.2, 1, 0.9], -1, 2.5, FLAG_NOSHADOW);
        lights.push({ pos: [x, 2.6, z], radius: 4, color: [0.2, 1, 0.9], intensity: 3 });
      } else if (kind === I.power && this.switchAt) {
        // The lever swings from up (off) to down (on) with a little overshoot.
        const sw = this.switchAt;
        this.leverVel += ((power ? 1 : 0) - this.lever) * 90 * dt - this.leverVel * 9 * dt;
        this.lever = Math.max(-0.05, Math.min(1.12, this.lever + this.leverVel * dt));
        const ang = 1.05 - this.lever * 2.1; // radians above the horizontal
        const reach = 0.52;
        const tip = (side: number): V3 => [sw.x + sw.nx * (0.4 + Math.cos(ang) * reach) + sw.nz * side, 1.2 + Math.sin(ang) * reach, sw.z + sw.nz * (0.4 + Math.cos(ang) * reach) + sw.nx * side];
        const hinge = (side: number): V3 => [sw.x + sw.nx * 0.4 + sw.nz * side, 1.2, sw.z + sw.nz * 0.4 + sw.nx * side];
        for (const side of [-0.13, 0.13]) round.limb(hinge(side), tip(side), 0.022, [0.75, 0.6, 0.4], MAT.gunmetal);
        round.limb(tip(-0.17), tip(0.17), 0.035, [0.75, 0.1, 0.08], MAT.painted); // red grip
        // Indicator lamps: red while dead, green once live.
        const lamp: RGB = power ? [0.2, 1, 0.3] : [1, 0.15, 0.08];
        glows.box(sw.x + sw.nx * 0.34 + sw.nz * (power ? 0.12 : -0.12), 1.44, sw.z + sw.nz * 0.34 + sw.nx * (power ? 0.12 : -0.12), 0.07, 0.07, 0.07, lamp, -1, 5, FLAG_NOSHADOW);
        lights.push({ pos: [sw.x + sw.nx * 0.7, 1.6, sw.z + sw.nz * 0.7], radius: 5, color: lamp, intensity: 3 });
      } else if (kind === I.part && hdr && !(hdr[H.parts] & (1 << param))) {
        const fuse = param < 8;
        glows.box(x, y + Math.sin(t * 2 + k) * 0.08, z, fuse ? 0.14 : 0.4, fuse ? 0.34 : 0.4, fuse ? 0.14 : 0.08, fuse ? [1, 0.8, 0.2] : [0.5, 0.7, 0.9], -1, 1.6, FLAG_NOSHADOW, t * 1.5);
      } else if (kind === I.console) {
        glows.box(x, 1.25, z, 0.8, 0.08, 0.5, [0.2, 0.9, 1], -1, power ? 2 : 0.1, FLAG_NOSHADOW);
      }
    }
    // Quest relays glow while they can be shot.
    if (hdr && hdr[H.targets] & (1 << 16)) {
      s.mapInfo.targets.forEach((p, k) => {
        if (hdr[H.targets] & (1 << k)) return;
        glows.box(p[0], p[1], p[2], 0.8, 0.8, 0.8, [1, 0.15, 0.1], -1, 3 + Math.sin(t * 6) * 1.5, FLAG_NOSHADOW, t);
        lights.push({ pos: p, radius: 8, color: [1, 0.2, 0.1], intensity: 6 });
      });
    }
    s.mapInfo.props.forEach((p, k) => {
      compose(tmp, 0, p[0], p[1], p[2], 1, 1, 1, p[3]);
      this.drawModel(groups, `props/${sim.catalog.maps[s.start.map].props[k]}`, tmp.slice(), 0, true);
    });
    // Barricade boards, each one a little crooked.
    s.mapInfo.barricades.forEach((p, k) => {
      const boards = s.snap?.barrs[k] ?? 6;
      const alongX = this.barrAxis[k];
      for (let i = 0; i < boards; i++) {
        const tilt = ((i * 7 + k * 3) % 5 - 2) * 0.06;
        casters.box(p[0], 0.45 + i * 0.36, p[2], alongX ? 2.2 : 0.07, 0.22, alongX ? 0.07 : 2.2, [1, 1, 1], MAT.wood, 0, 0, 0, alongX ? 0 : tilt, alongX ? tilt : 0);
      }
    });

    for (const z of s.zombies()) {
      const state = z.rec[Z.state];
      if (state === 5) continue;
      this.zombie(round, glows, z, state, z.rec[Z.kind], t, dt);
    }
    // The newly dead fall backwards, lie for a few seconds, then sink away.
    for (const c of this.corpses) {
      c.t += dt;
      const sink = Math.max(0, c.t - 5) * 0.5;
      this.zombie(round, glows, { id: c.id, x: c.x, y: c.y - sink, z: c.z, yaw: c.yaw, rec: c.rec }, 1, c.kind, t, 0, Math.min(1, c.t / 0.55));
    }
    this.corpses = this.corpses.filter(c => c.t < 6.5);
    if (this.zanim.size > 200) for (const [id, a] of this.zanim) if (t - a.seen > 10) this.zanim.delete(id);
    for (const p of s.players()) if (p.rec[P.life] !== 2) this.survivor(round, glows, groups, p, t, dt);
    // Third person: our own body is drawn like anyone else's, where our feet are.
    const third = (settings.third ?? 0) > 0.25;
    if (third && me.length && me[P.life] !== 2) {
      const f = s.feet();
      this.survivor(round, glows, groups, { id: s.selfId, x: f[0], y: f[1], z: f[2], yaw: settings.bodyYaw ?? view.yaw, rec: me }, t, dt);
    }

    // Power-ups, grenades and lingering effects.
    const puff = t - this.smokeAt >= 0.025 || t < this.smokeAt;
    if (puff) this.smokeAt = t;
    for (const e of s.snap?.ents ?? []) {
      const kind = e[E.kind], x = e[E.pos], y = e[E.pos + 1], z = e[E.pos + 2];
      if (kind >= 10 && kind < 15) {
        const c = POWERUP_COLORS[kind - 10];
        const blink = e[E.a] < 6 && Math.sin(t * 14) > 0 ? 0.3 : 1;
        glows.box(x, y + Math.sin(t * 2.5) * 0.1, z, 0.4, 0.4, 0.4, c, -1, 3.5 * blink, FLAG_NOSHADOW, t * 2, 0.6);
        lights.push({ pos: [x, y, z], radius: 6, color: c, intensity: 4 * blink });
      } else if (kind < 4) {
        round.box(x, y, z, 0.1, 0.13, 0.1, kind === 3 ? [0.6, 0.8, 1.2] : [0.8, 1, 0.7], MAT.painted, 0, 0, t * 9, t * 7);
      } else if (kind === 20 || kind === 21) {
        const c: RGB = kind === 20 ? [1, 0.45, 0.1] : [0.6, 0.8, 1];
        for (let i = 0; i < 6; i++) glows.box(x + Math.cos(t * 3 + i) * 1.4, y + 0.3 + ((t * 2 + i * 0.4) % 1.5), z + Math.sin(t * 3 + i) * 1.4, 0.18, 0.18, 0.18, c, -1, 4, FLAG_NOSHADOW, t + i);
        lights.push({ pos: [x, y + 1, z], radius: 8, color: c, intensity: 7 });
      } else if (kind === 4) {
        // Rocket: the model along its flight direction, a hot exhaust and a smoke trail.
        const a = e[E.a], yq = Math.floor(a / 512), pq = a - yq * 512;
        const yaw = (yq / 511) * Math.PI * 2 - Math.PI, pitch = (pq / 511) * Math.PI - Math.PI / 2;
        compose(tmp, 0, x, y, z, 1.6, 1.6, 1.6, yaw, pitch, t * 12);
        this.drawModel(groups, 'props/rocket', tmp.slice(), 0, true);
        const back = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
        glows.box(x + back[0] * 0.3, y + back[1] * 0.3, z + back[2] * 0.3, 0.09, 0.09, 0.09, [1, 0.6, 0.2], -1, 12, FLAG_NOSHADOW, t * 40, t * 30);
        lights.push({ pos: [x + back[0] * 0.4, y + back[1] * 0.4, z + back[2] * 0.4], radius: 7, color: [1, 0.55, 0.2], intensity: 12 });
        if (puff) this.flashes.push({ pos: [x + back[0] * 0.45, y + back[1] * 0.45, z + back[2] * 0.45], t: 0.6, life: 0.6, color: [0.16, 0.16, 0.17], radius: 0, size: 0.2 });
      } else if (kind >= 40 && kind <= 45) {
        // Capture zone (40-42) or the hill (45): a glowing ring on the ground in the holder's
        // colour, filling with the capturing team's colour as progress builds.
        const q = Math.floor(e[E.a] / 4), owner = Math.floor(q / 2) - 1, contested = q % 2 === 1, prog = e[E.a] - q * 4 - 1;
        const hill = kind === 45, r = hill ? 4.5 : 3.5, segs = hill ? 28 : 22;
        const neutral: RGB = [0.85, 0.85, 0.85];
        const held: RGB = owner >= 0 ? TEAM_COLORS[owner] : neutral;
        const filling: RGB = prog < 0 ? TEAM_COLORS[0] : TEAM_COLORS[1];
        const filled = Math.round(Math.abs(prog) * segs);
        const flash = contested && Math.sin(t * 10) > 0 ? 0.35 : 1;
        for (let k = 0; k < segs; k++) {
          const a = (k / segs) * Math.PI * 2;
          const c = hill ? held : k < filled && owner < 0 ? filling : held;
          glows.box(x + Math.cos(a) * r, 0.05, z + Math.sin(a) * r, 0.5, 0.06, 0.16, c, -1, 2.2 * flash, FLAG_NOSHADOW, -a);
        }
        glows.box(x, 3, z, 0.08, 6, 0.08, held, -1, 1.2 * flash, FLAG_NOSHADOW); // beacon
        lights.push({ pos: [x, 1.2, z], radius: r * 1.8, color: held, intensity: 3 });
      } else if (kind === 50 || kind === 51) {
        // A dropped tag, in the colour of the fallen player's team.
        const c = TEAM_COLORS[kind - 50];
        const blink = e[E.a] < 5 && Math.sin(t * 12) > 0 ? 0.3 : 1;
        glows.box(x, y + Math.sin(t * 3 + x) * 0.08, z, 0.18, 0.26, 0.04, c, -1, 3 * blink, FLAG_NOSHADOW, t * 2.5);
        lights.push({ pos: [x, y, z], radius: 3, color: c, intensity: 2 * blink });
      } else if (kind === 30) {
        glows.box(x, 0.05, z, 1.2, 0.05, 1.2, [1, 0.2, 0.1], -1, 3 + Math.sin(t * 20) * 2, FLAG_NOSHADOW, t * 3);
      }
    }

    // Tracers and flashes.
    for (const tr of this.tracers) {
      const d = [tr.b[0] - tr.a[0], tr.b[1] - tr.a[1], tr.b[2] - tr.a[2]];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      glows.box((tr.a[0] + tr.b[0]) / 2, (tr.a[1] + tr.b[1]) / 2, (tr.a[2] + tr.b[2]) / 2, 0.018, 0.018, len, tr.color, -1, 7, FLAG_NOSHADOW, Math.atan2(-d[0], -d[2]), Math.asin(d[1] / len));
      tr.t -= dt;
    }
    this.tracers = this.tracers.filter(tr => tr.t > 0);
    for (const f of this.flashes) {
      const k = f.t / f.life;
      const size = f.vel ? f.size : f.size * (1.6 - k);
      const glow = f.glow ?? (f.radius ? 6 : 0.6);
      if (f.vel) {
        f.vel[1] -= 12 * dt;
        f.pos[0] += f.vel[0] * dt; f.pos[1] += f.vel[1] * dt; f.pos[2] += f.vel[2] * dt;
      }
      const y = f.pos[1] + (f.rise ?? 0) * (1 - k);
      (glow > 1 ? glows : round).box(f.pos[0], y, f.pos[2], size, size, size, f.color, -1, glow * k, FLAG_NOSHADOW, t * 5 + f.life * 9, t * 3 + f.life * 7);
      if (f.radius) lights.push({ pos: f.pos, radius: f.radius, color: f.color, intensity: 25 * k });
      f.t -= dt;
    }
    this.flashes = this.flashes.filter(f => f.t > 0);

    // Camera.
    const camWorld = mat4();
    compose(camWorld, 0, view.pos[0], view.pos[1], view.pos[2], 1, 1, 1, view.yaw, view.pitch, view.roll);
    const viewMat = invert(mat4(), camWorld);
    const cur = me[P['arms.cur']] ?? 0;
    const gunId = me[P[`arms.guns${cur}.id`]] ?? -1;
    const ads = me[P['arms.ads']] ?? 0;
    const stats = gunId >= 0 ? sim.gunStats(gunId, me[P[`arms.guns${cur}.att`]], me[P[`arms.guns${cur}.tier`]]) : null;
    const zoom = 1 + ((stats?.zoom ?? 1) - 1) * ads;
    const fov = 2 * Math.atan(Math.tan((view.fov * Math.PI) / 360) / zoom);
    const viewProj = mul(mat4(), perspective(mat4(), fov, aspect, 0.08, 400), viewMat);
    const viewmodelProj = mul(mat4(), perspective(mat4(), (54 * Math.PI) / 180 / (1 + (zoom - 1) * 0.25), aspect, 0.02, 20), viewMat);

    // First-person weapon and arms: sway lags the look, bob follows the stride, kick decays after each shot.
    const alive = me[P.life] === 0;
    const vm = this.vm;
    if (alive && gunId >= 0 && !third) {
      const dyaw = view.yaw - this.lastAngles[0], dpitch = view.pitch - this.lastAngles[1];
      this.sway[0] += (Math.max(-0.06, Math.min(0.06, dyaw * 0.6)) - this.sway[0]) * Math.min(1, dt * 10);
      this.sway[1] += (Math.max(-0.06, Math.min(0.06, dpitch * 0.6)) - this.sway[1]) * Math.min(1, dt * 10);
      this.kick *= Math.exp(-dt * 14);
      const bob = me[P['ctl.bob_amp']], ph = me[P['ctl.bob_ph']];
      const hip = 1 - ads;
      // Every pose change eases in and out instead of snapping: values chase their targets
      // with a critically damped spring, so the weapon has weight when you start to sprint,
      // reload, swap, land or strike.
      const a = this.anim;
      const ease = (key: keyof typeof a, target: number, speed: number) => {
        const v = this.animVel;
        // Spring toward the target (stiffness speed^2, damping 2*speed).
        // Small fixed steps keep it stable when a frame is long.
        const steps = Math.max(1, Math.ceil(dt * 240));
        const h = dt / steps;
        for (let k = 0; k < steps; k++) {
          v[key] += ((target - a[key]) * speed * speed - 2 * speed * v[key]) * h;
          a[key] += v[key] * h;
        }
        return a[key];
      };
      const reloading = me[P['arms.reload_t']] > 0;
      const swapping = me[P['arms.switch_t']] > 0 ? Math.sin((me[P['arms.switch_t']] / Math.max(me[P['arms.switch_d']], 0.01)) * Math.PI) : 0;
      const sprint = ease('sprint', me[P['ctl.sprinting']] ? 1 : 0, 11);
      const reload = ease('reload', reloading ? 1 : 0, 9);
      const lower = ease('lower', Math.max(swapping, me[P['ctl.mode']] === 3 ? 1 : 0), 14);
      const melee = ease('melee', me[P['arms.melee_t']] > 0.3 ? 1 : 0, 20);
      const crouch = ease('crouch', me[P['ctl.crouched']] ? 1 : 0, 10);
      // Vertical speed pushes the weapon the other way: it lifts as you drop and dips on landing.
      const fall = ease('fall', Math.max(-1, Math.min(1, me[P['ctl.vel'] + 1] / 9)), 12);
      // Sideways speed rolls it slightly into the strafe.
      const side = me[P['ctl.vel']] * Math.cos(view.yaw) - me[P['ctl.vel'] + 2] * Math.sin(view.yaw);
      const strafe = ease('strafe', Math.max(-1, Math.min(1, side / 6)), 9);
      // The reload has a rhythm: tilt out, a dip as the magazine goes in, and back.
      const rphase = reloading ? 1 - me[P['arms.reload_t']] / Math.max(sim.catalog.weapons[gunId]?.reload ?? 2, 0.1) : 0;
      const magDip = reloading ? Math.sin(Math.min(1, Math.max(0, (rphase - 0.35) / 0.3)) * Math.PI) : 0;
      // Sprinting swings the weapon with each stride.
      const stride = Math.sin(ph) * sprint;
      const idle = Math.sin(t * 1.3) * 0.004;
      const local = mat4();
      compose(local, 0,
        0.15 * hip + Math.cos(ph) * bob * 0.5 * hip + this.sway[0] * 0.6 - sprint * 0.05 * hip + stride * 0.018 - reload * 0.03 - strafe * 0.012,
        -0.16 * hip - 0.075 * ads + Math.sin(ph * 2) * bob * 0.4 * hip + idle - lower * 0.22 - this.sway[1] * 0.5 - sprint * 0.035 * hip + Math.abs(stride) * 0.012 - reload * 0.07 - magDip * 0.035 - fall * 0.03 * hip - crouch * 0.012 * hip,
        -0.42 + this.kick * 0.05 + 0.08 * ads + sprint * 0.03 * hip - melee * 0.12,
        1, 1, 1,
        this.sway[0] * 1.5 + sprint * 0.5 * hip + reload * 0.22 + melee * 0.5,
        this.kick * 0.07 - lower * 0.7 - this.sway[1] - sprint * 0.25 * hip - reload * 0.3 - magDip * 0.12 + fall * 0.08 * hip,
        this.sway[0] * -2 + melee * 0.9 + reload * 0.35 - strafe * 0.06 + stride * 0.04 + crouch * 0.06 * hip);
      const world = mul(mat4(), camWorld, local);
      const slug = sim.catalog.weapons[gunId]?.slug;
      const myLook = this.lookOf(s.selfId);
      const model = this.drawModel(groups, `weapons/${slug}`, world, FLAG_VIEWMODEL | FLAG_NOSHADOW, false, CAMOS[myLook.camo]?.layer ?? -1);
      // Arms: sleeves from below the screen edge to gloved hands on the grip and the handguard.
      const cam = (x: number, y: number, z: number) => transformPoint(camWorld, [x, y, z]) as V3;
      const foreRest = transformPoint(world, [0, -0.005, Math.max(-0.3, (model?.min[2] ?? -0.35) * 0.62)]) as V3;
      // Reload: the support hand drops to the magazine, pulls it down and out of view, and seats a
      // fresh one; on a swap both hands come off as the weapon goes down.
      const magAt = transformPoint(world, [0, -0.1, -0.14]) as V3;
      const pull = reloading ? Math.sin(Math.min(1, Math.max(0, (rphase - 0.12) / 0.5)) * Math.PI) : 0;
      const away = cam(-0.12, -0.5, -0.25);
      const magHand = [0, 1, 2].map(i => magAt[i] + (away[i] - magAt[i]) * pull) as V3;
      const fore = [0, 1, 2].map(i => foreRest[i] + (magHand[i] - foreRest[i]) * reload) as V3;
      const sleeve: RGB = FATIGUES[myLook.fatigues]?.rgb ?? FATIGUES[0].rgb;
      const vf = FLAG_VIEWMODEL | FLAG_NOSHADOW;
      // Arms and hands follow the operator's customization.
      const mySkin: RGB = SKINS[myLook.skin]?.rgb ?? SKINS[1].rgb;
      const bareArm = myLook.sleeves > 0;
      const armTint = bareArm ? mySkin : sleeve, armMat = bareArm ? MAT.skin : MAT.fabric;
      const bareHands = myLook.gloves === 4;
      const gloveTint: RGB = bareHands ? mySkin : GLOVES[myLook.gloves]?.rgb ?? [0.8, 0.8, 0.8];
      const gloveMat = bareHands ? MAT.skin : MAT.fabric;
      const gl = (x: number, y: number, z: number) => transformPoint(world, [x, y, z]) as V3;
      const gunRight = (() => { const o = gl(0, 0, 0), r = gl(1, 0, 0); return [r[0] - o[0], r[1] - o[1], r[2] - o[2]] as V3; })();
      const lerp3 = (p: V3, q: V3, k: number): V3 => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
      const finger = (pts: V3[], r: number) => { for (let i = 0; i < pts.length - 1; i++) vm.limb(pts[i], pts[i + 1], r * (1 - i * 0.12), gloveTint, gloveMat, vf); };
      // A forearm from an elbow below the screen edge to the wrist, with a cuff where the sleeve or
      // glove ends; then the hand itself.
      const arm = (elbow: V3, wrist: V3, r: number) => {
        this.seg('forearm', elbow, wrist, r, armTint, armMat, r * 0.92, gunRight, vf);
        if (myLook.sleeves === 0) this.seg('forearm', lerp3(wrist, elbow, 0.08), lerp3(wrist, elbow, 0.2), r * 1.12, sleeve, MAT.fabric, r * 1.05, gunRight, vf); // sleeve cuff
        if (myLook.sleeves === 1) this.seg('upperArm', lerp3(wrist, elbow, 0.8), lerp3(wrist, elbow, 1.05), r * 1.25, sleeve, MAT.fabric, r * 1.2, gunRight, vf); // rolled sleeve
        if (!bareHands) this.seg('forearm', lerp3(wrist, elbow, -0.02), lerp3(wrist, elbow, 0.1), r * 0.92, gloveTint, gloveMat, r * 0.85, gunRight, vf); // glove cuff
      };

      // Right hand on the pistol grip. Grip space: y up the grip, z toward the back, x right.
      const ga = -0.28, gca = Math.cos(ga), gsa = Math.sin(ga);
      const gp = (x: number, y: number, z: number) => gl(x, y * gca - z * gsa - 0.045, y * gsa + z * gca + 0.012);
      const rWrist = gl(0.012, 0.012, 0.095);
      const rElbow = cam(0.2 - ads * 0.08, -0.36, 0.03);
      arm(rElbow, rWrist, 0.05);
      this.seg('hand', rWrist, gp(0.012, -0.02, 0.026), 0.044, gloveTint, gloveMat, 0.026, gunRight, vf); // back of the hand along the grip
      for (let k = 0; k < 3; k++) {
        const y = 0.0 - k * 0.022;
        finger([gp(0.025, y, 0.012), gp(0.022, y, -0.016), gp(0.004, y - 0.004, -0.026), gp(-0.014, y - 0.006, -0.016)], 0.0092);
      }
      // Index finger: along the trigger guard, curling onto the trigger while firing.
      const squeeze = this.muzzle > 0 ? 1 : 0;
      finger([gl(0.024, -0.004, 0.012), gl(0.022, -0.008, -0.016), lerp3(gl(0.012, -0.004, -0.04), gl(0.004, -0.016, -0.026), 0.4 + squeeze * 0.6)], 0.0088);
      finger([gl(-0.016, 0.004, 0.035), gl(-0.022, -0.006, 0.008), gl(-0.016, -0.004, -0.012)], 0.0105); // thumb round the far side

      // Left hand under the handguard (or carrying the magazine during a reload).
      const shift = [fore[0] - foreRest[0], fore[1] - foreRest[1], fore[2] - foreRest[2]];
      const fz = Math.max(-0.3, (model?.min[2] ?? -0.35) * 0.62);
      const lp = (x: number, y: number, z: number): V3 => { const q = gl(x, y, z + fz); return [q[0] + shift[0], q[1] + shift[1], q[2] + shift[2]]; };
      const lWrist = lp(-0.03, -0.05, 0.06);
      const lElbow = cam(-0.17 + ads * 0.07, -0.36, -0.06);
      arm(lElbow, lWrist, 0.047);
      this.seg('hand', lWrist, lp(-0.006, -0.018, -0.02), 0.044, gloveTint, gloveMat, 0.026, gunRight, vf); // palm under the handguard
      for (let k = 0; k < 4; k++) {
        const z = -0.03 + k * 0.019;
        finger([lp(0.004, -0.016, z), lp(0.026, 0.006, z), lp(0.03, 0.038, z - 0.004)], 0.0088);
      }
      finger([lp(-0.03, -0.01, 0.025), lp(-0.03, 0.02, 0.0), lp(-0.024, 0.045, -0.02)], 0.0105); // thumb along the near side
      // The magazine travels with the hand while it is out of the weapon.
      if (reload > 0.5 && pull > 0.15) this.put('gear', fore[0], fore[1] - 0.04, fore[2], 0.03, 0.13, 0.055, [0.18, 0.18, 0.19], MAT.polymer, 0, vf, view.yaw, view.pitch + 0.2);
      if (this.muzzle > 0) {
        this.muzzle -= dt;
        const tip = mat4();
        compose(tip, 0, 0, 0.035, (model?.min[2] ?? -0.6) - 0.05, 0.08, 0.08, 0.13, 0, 0, t * 40);
        glows.mat(mul(mat4(), world, tip), [1, 0.75, 0.4], -1, 0, 0.5, 9, vf);
        // The flash lights the world for a couple of frames.
        lights.push({ pos: [view.pos[0] - Math.sin(view.yaw) * 0.8, view.pos[1] - 0.1, view.pos[2] - Math.cos(view.yaw) * 0.8], radius: 11, color: [1, 0.7, 0.35], intensity: 30 });
      }
    }
    this.lastAngles = [view.yaw, view.pitch];

    // Nearest lights win the 16 slots. Some lamps flicker.
    for (const l of this.staticLights) {
      if (l.flicker === undefined) { lights.push(l); continue; }
      const f = Math.sin(t * 23 + l.flicker) * Math.sin(t * 7.3 + l.flicker * 2) > 0.55 ? 0.15 : 1;
      lights.push({ ...l, intensity: l.intensity * f });
    }
    const d2 = (l: LightSrc) => (l.pos[0] - view.pos[0]) ** 2 + (l.pos[1] - view.pos[1]) ** 2 + (l.pos[2] - view.pos[2]) ** 2;
    lights.sort((a, c) => d2(a) - d2(c));
    const lightCount = Math.min(lights.length, MAX_LIGHTS);
    for (let i = 0; i < lightCount; i++) {
      const l = lights[i];
      this.lights.set([l.pos[0], l.pos[1], l.pos[2], l.radius, l.color[0], l.color[1], l.color[2], l.intensity, 0, -1, 0, 0], i * LIGHT_FLOATS);
    }

    // Sun shadow: an orthographic box that follows the camera, snapped to texels to stop shimmer.
    const sun = s.mapInfo.sun;
    const sl = Math.hypot(sun[0], sun[1], sun[2]) || 1;
    const sunDir = [sun[0] / sl, sun[1] / sl, sun[2] / sl];
    const R = 34;
    const cx = Math.round(view.pos[0] / 2) * 2, cz = Math.round(view.pos[2] / 2) * 2;
    const shadowView = lookAt(mat4(), [cx + sunDir[0] * 70, sunDir[1] * 70, cz + sunDir[2] * 70], [cx, 0, cz], [0, 1, 0]);
    const shadowViewProj = mul(mat4(), ortho(mat4(), -R, R, -R, R, 1, 160), shadowView);

    // Assemble the instance buffer. Cube casters, sphere casters, then everything without shadows.
    const out = this.frameData;
    out.n = 0;
    const draws: Draw[] = [];
    const add = (mesh: number, batch: Batch, shadow: boolean) => {
      if (!batch.n) return;
      draws.push({ mesh, first: out.n, count: batch.n, shadow });
      out.append(batch);
    };
    add(this.cube, this.world, true);
    add(this.cube, casters, true);
    add(this.cylinder, this.worldRound, true);
    this.scenery.draws(add);
    add(this.sphere, round, true);
    add(this.cube, this.worldGlow, false);
    add(this.cube, glows, false);
    add(this.sphere, vm, false);
    for (const part of Object.values(this.parts)) { add(part.mesh, part.batch, true); add(part.mesh, part.vm, false); }
    for (const g of groups.values()) add(g.mesh, g.batch, g.shadow);

    this.hurt = Math.max(0, this.hurt - dt * 1.5);
    const health = me[P.max_health] ? me[P.health] / me[P.max_health] : 1;
    const downed = me.length > 0 && me[P.life] !== 0;
    const speed = Math.hypot(me[P['ctl.vel']] ?? 0, me[P['ctl.vel'] + 2] ?? 0);
    const prev = this.prevViewProj;
    this.prevViewProj = viewProj;
    return {
      viewProj,
      invViewProj: invert(mat4(), viewProj),
      prevViewProj: prev,
      viewmodelProj,
      shadowViewProj,
      camPos: view.pos,
      sunDir,
      sunColor: s.mapInfo.sunColor,
      sky: s.mapInfo.sky,
      fog: s.mapInfo.fog,
      lights: this.lights,
      lightCount,
      instances: out.data,
      instanceCount: out.n,
      draws,
      post: {
        exposure: 1.0,
        bloom: 0.5,
        motionBlur: settings.motionBlur ? 0.5 + Math.min(speed / 12, 1) * 0.4 : 0,
        dofFocus: downed ? 1.5 : 30,
        dofAmount: settings.dof ? (downed ? 0.9 : ads * 0.45) : 0,
        vignette: 0.4 + (1 - Math.max(health, 0)) * 0.35,
        damage: Math.max(this.hurt * 0.6, downed ? 0.45 : (1 - health) * 0.5),
        grain: 0.045,
        saturation: downed ? 0.35 : 0.8,
        contrast: 0.4,
        time: t,
      },
    };
  }
}
