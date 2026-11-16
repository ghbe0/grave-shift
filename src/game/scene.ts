// Turns match state into a renderer `Frame`: the textured level with trim and lamps,
// interactables, jointed animated characters, the first-person weapon and arms, tracers, muzzle
// flashes and lights, plus camera and post-processing settings.
import { WF, type Sim } from '../core/sim';
import { loadModel, type Model } from '../gfx/loader';
import { compose, invert, lookAt, mat4, mul, ortho, perspective, transformPoint } from '../gfx/mat';
import { cubeMesh, cylinderMesh, FLAG_NOSHADOW, FLAG_VIEWMODEL, INSTANCE_FLOATS, LIGHT_FLOATS, MAT, MAX_LIGHTS, sphereMesh, type Draw, type Frame, type Renderer } from '../gfx/renderer';
import { CAMOS, FATIGUES, VESTS, type Look } from './look';
import type { Session, View } from './session';

type RGB = [number, number, number];
type V3 = [number, number, number];

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
const RAGS: RGB[] = [[2.0, 1.8, 1.5], [1.4, 1.6, 2.1], [2.3, 1.9, 1.3], [1.6, 1.9, 1.5], [2.1, 1.4, 1.3]];
const LAMP: RGB = [1.0, 0.72, 0.42];

const I = { door: 1, wallbuy: 2, perk: 3, crate: 4, bench: 5, tonic: 6, power: 7, workbench: 8, part: 9, console: 10 };

/** A growable run of instances that share a mesh. */
class Batch {
  data = new Float32Array(INSTANCE_FLOATS * 256);
  n = 0;
  private grow(count = 1): number {
    while ((this.n + count) * INSTANCE_FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const o = this.n * INSTANCE_FLOATS;
    this.n += count;
    return o;
  }
  private tail(o: number, c: ArrayLike<number>, layer: number, metallic: number, roughness: number, emissive: number, flags: number): void {
    this.data.set([c[0], c[1], c[2], layer + 1, metallic, roughness, emissive, flags], o + 16);
  }
  /** Box (or any unit mesh) with translation, scale and yaw/pitch/roll. `layer` -1 = untextured. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: ArrayLike<number>, layer = -1, emissive = 0, flags = 0, yaw = 0, pitch = 0, roll = 0, metallic = 0, roughness = 1): void {
    const o = this.grow();
    compose(this.data, o, x, y, z, sx, sy, sz, yaw, pitch, roll);
    this.tail(o, c, layer, metallic, roughness, emissive, flags);
  }
  /** Instance with an explicit matrix. */
  mat(matrix: ArrayLike<number>, c: ArrayLike<number>, layer: number, metallic: number, roughness: number, emissive: number, flags: number): void {
    const o = this.grow();
    this.data.set(matrix, o);
    this.tail(o, c, layer, metallic, roughness, emissive, flags);
  }
  /** Unit sphere stretched between two points into a limb of radius r (rz for the depth axis). */
  limb(a: V3, b: V3, r: number, c: ArrayLike<number>, layer: number, flags = 0, rz = r, side?: V3): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1e-4;
    const y: V3 = [d[0] / len, d[1] / len, d[2] / len];
    // X axis: the given side direction made perpendicular to the limb.
    let ref = side ?? (Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    let x: V3 = [ref[1] * y[2] - ref[2] * y[1], ref[2] * y[0] - ref[0] * y[2], ref[0] * y[1] - ref[1] * y[0]];
    if (side) { const dot = side[0] * y[0] + side[1] * y[1] + side[2] * y[2]; x = [side[0] - y[0] * dot, side[1] - y[1] * dot, side[2] - y[2] * dot]; }
    let xl = Math.hypot(x[0], x[1], x[2]);
    if (xl < 1e-4) { ref = [1, 0, 0]; x = [ref[1] * y[2] - ref[2] * y[1], ref[2] * y[0] - ref[0] * y[2], ref[0] * y[1] - ref[1] * y[0]]; xl = Math.hypot(x[0], x[1], x[2]) || 1; }
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const z: V3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const sy = len + r * 1.6, sx = r * 2, sz = rz * 2;
    const o = this.grow();
    this.data.set([x[0] * sx, x[1] * sx, x[2] * sx, 0, y[0] * sy, y[1] * sy, y[2] * sy, 0, z[0] * sz, z[1] * sz, z[2] * sz, 0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 1], o);
    this.tail(o, c, layer, 0, 1, 0, flags);
  }
  append(other: Batch): void {
    const o = this.grow(other.n);
    this.data.set(other.data.subarray(0, other.n * INSTANCE_FLOATS), o);
  }
}

interface Tracer { a: number[]; b: number[]; t: number; color: RGB }
/**
 * A short-lived effect box. `radius` > 0 also lights the world. `glow` overrides the brightness
 * (above 1 draws it unlit and glowing, otherwise lit like smoke); `vel` moves it (debris) and
 * `rise` lifts it over its life (fire and smoke).
 */
interface Flash { pos: number[]; t: number; life: number; color: RGB; radius: number; size: number; glow?: number; vel?: number[]; rise?: number }
interface LightSrc { pos: number[]; radius: number; color: RGB; intensity: number; flicker?: number }

export interface SceneSettings { fov: number; motionBlur: boolean; dof: boolean }

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
  private barrAxis: boolean[];
  private staticLights: LightSrc[] = [];
  /** Per-frame batches, reused so a 360 fps loop does not churn the garbage collector. */
  private casters = new Batch();
  private round = new Batch();
  private glows = new Batch();
  private vm = new Batch();
  private groups = new Map<string, { mesh: number; shadow: boolean; batch: Batch }>();
  /** Red screen-edge flash, 0..1. */
  hurt = 0;

  constructor(private renderer: Renderer, private sim: Sim, private session: Session, private lookOf: (id: number) => Look) {
    this.cube = renderer.createMesh(cubeMesh());
    this.sphere = renderer.createMesh(sphereMesh());
    this.cylinder = renderer.createMesh(cylinderMesh());
    const b = session.boxes;
    for (let o = 0; o < b.length; o += 8) {
      const flags = b[o + 7] & 0xff;
      if (flags & (2 | 4)) continue; // hidden, or a door (doors are drawn while closed)
      this.addBox(this.world, b, o);
      if (b[o + 6] === 1) this.trimWall(b, o);
      if (b[o + 6] === 2) this.crateDetail(b, o);
    }
    this.placeLamps();
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
    const s = SURFACES[b[o + 6]] ?? SURFACES[1];
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
  private zombie(out: Batch, glow: Batch, z: { id: number; x: number; y: number; z: number; yaw: number; rec: Float32Array }, state: number, kind: number, t: number): void {
    const turned = state === 4;
    const rag = RAGS[z.id % RAGS.length];
    const skinTint: RGB = turned ? [1.0, 1.2, 1.8] : [1.5, 1.5, 1.45];
    const rise = state === 0 ? -1.1 + Math.min(1, Math.max(0, 1 - (z.rec[this.sim.L.Z.hp] ?? 1))) : 0;
    const rate = [3.2, 6.5, 9.0][kind] ?? 3.2;
    const ph = t * rate + z.id * 1.7;
    const amp = [0.38, 0.6, 0.75][kind] ?? 0.4;
    const lean = [0.5, 0.62, 0.78][kind] ?? 0.5;
    const lurch = Math.sin(ph * 0.5 + z.id) * 0.06;
    const bob = Math.abs(Math.sin(ph)) * 0.05 * (1 + kind * 0.5);
    const { at, right } = frame(z.x, z.y + rise, z.z, z.yaw + lurch);
    const hip = 0.93 + bob;
    const chestL: [number, number, number] = [lurch * 0.3, hip + Math.cos(lean) * 0.5, Math.sin(lean) * 0.5];
    const pelvis = at(0, hip, 0), chest = at(...chestL);
    const headP = at(chestL[0] + Math.sin(t * 1.3 + z.id) * 0.03, chestL[1] + 0.24, chestL[2] + 0.12 + lean * 0.12);
    // Legs: walkers drag one foot, runners stride.
    for (const side of [-1, 1]) {
      const sp = ph + (side > 0 ? Math.PI : 0);
      const swing = Math.sin(sp) * amp * (kind === 0 && side > 0 ? 0.6 : 1);
      const bend = Math.max(0, -Math.cos(sp)) * amp * 1.4 + 0.12;
      const [knee, ankle] = chain(at, [side * 0.11, hip - 0.04, 0], 0.46, 0.44, swing, bend);
      out.limb(at(side * 0.11, hip, 0), knee, 0.085, rag, MAT.fabric, 0, 0.09, right);
      out.limb(knee, ankle, 0.062, rag, MAT.fabric, 0, 0.065, right);
      const toe = at(side * 0.12 + 0, 0, 0);
      out.limb(ankle, [ankle[0] + (toe[0] - z.x) * 0 + (ankle[0] - knee[0]) * 0 + Math.sin(-z.yaw) * 0.16, Math.max(ankle[1] - 0.05, z.y + rise + 0.04), ankle[2] - Math.cos(z.yaw) * 0.16], 0.05, [0.9, 0.9, 0.9], MAT.polymer, 0, 0.06);
    }
    // Torso, belly and torn shirt.
    out.limb(pelvis, chest, 0.16, rag, MAT.fabric, 0, 0.12, right);
    // Rib cage and shoulders, wider than the waist.
    const ribs = at(chestL[0], chestL[1] - 0.1, chestL[2] - 0.02);
    out.box(ribs[0], ribs[1], ribs[2], 0.46, 0.36, 0.28, rag, MAT.fabric, 0, 0, z.yaw + lurch, -lean * 0.8);
    out.limb(at(0, hip + 0.02, 0.02), at(0, hip + 0.14, 0.05), 0.15, skinTint, MAT.skin, 0, 0.11, right);
    out.limb(chest, headP, 0.055, skinTint, MAT.skin);
    // Head: skull, jaw hanging open.
    const jaw = 0.04 + Math.abs(Math.sin(t * 2.3 + z.id)) * 0.04;
    out.box(headP[0], headP[1] + 0.05, headP[2], 0.21, 0.25, 0.23, skinTint, MAT.skin, 0, 0, z.yaw, -lean * 0.4, Math.sin(t + z.id) * 0.15);
    const jp = at(chestL[0], chestL[1] + 0.2 - jaw, chestL[2] + 0.2 + lean * 0.12);
    out.box(jp[0], jp[1], jp[2], 0.15, 0.06, 0.13, skinTint, MAT.skin, 0, 0, z.yaw, 0.3);
    // Arms reach for whoever they are chasing; attacks swipe down.
    const attack = state === 2 ? 1 : 0;
    for (const side of [-1, 1]) {
      const sp = ph * 0.5 + (side > 0 ? 1.4 : 0);
      const sh = at(chestL[0] + side * 0.22, chestL[1] - 0.04, chestL[2]);
      const reach = kind === 0 ? 0.6 + Math.sin(sp) * 0.1 : 0.3 + Math.sin(ph + (side > 0 ? Math.PI : 0)) * 0.5;
      const raise = attack ? 0.9 + Math.sin(t * 14 + side) * 0.4 : reach;
      const el = at(chestL[0] + side * 0.27, chestL[1] - 0.3 + raise * 0.24, chestL[2] + 0.12 + raise * 0.14);
      const hand = at(chestL[0] + side * 0.2, chestL[1] - 0.32 + raise * 0.45, chestL[2] + 0.38 + raise * 0.12);
      out.limb(sh, el, 0.055, rag, MAT.fabric, 0, 0.055);
      out.limb(el, hand, 0.045, skinTint, MAT.skin, 0, 0.042);
      out.box(hand[0], hand[1], hand[2], 0.08, 0.05, 0.11, skinTint, MAT.skin, 0, 0, z.yaw, -raise);
    }
    // Eyes glow through the fog.
    const eye: RGB = turned ? [0.4, 0.8, 1] : [1, 0.62, 0.12];
    for (const side of [-1, 1]) {
      const e = at(chestL[0] + side * 0.05, chestL[1] + 0.32, chestL[2] + 0.24 + lean * 0.12);
      glow.box(e[0], e[1], e[2], 0.035, 0.022, 0.02, eye, -1, 8, FLAG_NOSHADOW, z.yaw);
    }
  }

  /** A survivor: helmet, team-coloured vest over fatigues, boots, rifle held at the ready. */
  private survivor(out: Batch, glow: Batch, groups: Map<string, { mesh: number; shadow: boolean; batch: Batch }>, p: { id: number; x: number; y: number; z: number; yaw: number; rec: Float32Array }, t: number): void {
    const { P } = this.sim.L;
    const look = this.lookOf(p.id);
    const team: RGB = look.vest ? VESTS[look.vest - 1].rgb : PLAYER_COLORS[p.id % PLAYER_COLORS.length];
    const fatigues: RGB = FATIGUES[look.fatigues]?.rgb ?? FATIGUES[0].rgb;
    const life = p.rec[P.life];
    const pitch = p.rec[P['ctl.pitch']];
    const speed = Math.hypot(p.rec[P['ctl.vel']], p.rec[P['ctl.vel'] + 2]);
    const crouch = p.rec[P['ctl.crouched']] ? 0.4 : 0;
    const slide = p.rec[P['ctl.mode']] === 1;
    const { at, right } = frame(p.x, p.y, p.z, p.yaw);
    if (life === 1) {
      // Downed: on the ground, waving for help.
      const torso = at(0, 0.25, 0.1), head = at(0, 0.32, 0.6);
      out.limb(at(0, 0.2, -0.5), torso, 0.16, team, MAT.fabric, 0, 0.11);
      out.box(head[0], head[1], head[2], 0.22, 0.24, 0.24, [0.8, 0.8, 0.8], MAT.painted, 0, 0, p.yaw);
      glow.box(p.x, 1.4 + Math.sin(t * 4) * 0.1, p.z, 0.2, 0.2, 0.2, [0.3, 0.6, 1], -1, 4, FLAG_NOSHADOW, t * 2, 0.6);
      return;
    }
    const ph = t * Math.max(2, speed * 1.4);
    const amp = Math.min(0.55, speed * 0.07);
    const hip = 0.95 - crouch * 0.45 - (slide ? 0.45 : 0);
    for (const side of [-1, 1]) {
      const sp = ph + (side > 0 ? Math.PI : 0);
      const [knee, ankle] = slide
        ? [at(side * 0.12, 0.35, 0.35 + (side > 0 ? 0.25 : 0)), at(side * 0.12, 0.1, 0.75 + (side > 0 ? 0.2 : 0))]
        : chain(at, [side * 0.11, hip - 0.04, 0], 0.46, 0.44, Math.sin(sp) * amp + crouch * 0.9, Math.max(0, -Math.cos(sp)) * amp * 1.4 + crouch * 1.8 + 0.05);
      out.limb(at(side * 0.11, hip, 0), knee, 0.09, fatigues, MAT.fabric, 0, 0.095, right);
      out.limb(knee, ankle, 0.068, fatigues, MAT.fabric, 0, 0.07, right);
      out.box(ankle[0] + Math.sin(-p.yaw) * 0.06, Math.max(ankle[1] - 0.04, p.y + 0.05), ankle[2] - Math.cos(p.yaw) * 0.06, 0.11, 0.1, 0.26, [0.9, 0.9, 0.9], MAT.polymer, 0, 0, p.yaw);
    }
    const chestL: [number, number, number] = [0, hip + 0.5, 0.05 + crouch * 0.1];
    const pelvis = at(0, hip, 0), chest = at(...chestL);
    out.limb(pelvis, chest, 0.17, fatigues, MAT.fabric, 0, 0.12, right);
    // Plate carrier with pouches in the team colour.
    out.box(chest[0], chest[1] - 0.12, chest[2], 0.42, 0.42, 0.3, team, MAT.fabric, 0, 0, p.yaw);
    for (const lx of [-0.12, 0, 0.12]) { const q = at(lx, chestL[1] - 0.26, chestL[2] + 0.17); out.box(q[0], q[1], q[2], 0.1, 0.12, 0.06, team, MAT.fabric, 0, 0, p.yaw); }
    // Head and the chosen headgear.
    const head = at(0, chestL[1] + 0.27, chestL[2] + 0.02);
    const hp = pitch * 0.5;
    out.box(head[0], head[1], head[2], 0.2, 0.24, 0.22, [1, 0.95, 0.9], MAT.skin, 0, 0, p.yaw, hp);
    switch (look.headgear) {
      case 0: { // combat helmet and goggles
        out.box(head[0], head[1] + 0.09, head[2], 0.27, 0.15, 0.29, [0.6, 0.65, 0.55], MAT.painted, 0, 0, p.yaw, hp);
        const goggle = at(0, chestL[1] + 0.3, chestL[2] + 0.13);
        out.box(goggle[0], goggle[1], goggle[2], 0.2, 0.05, 0.03, [0.3, 0.3, 0.3], MAT.polymer, 0, 0, p.yaw, hp);
        break;
      }
      case 1: { // field cap with a brim
        out.box(head[0], head[1] + 0.1, head[2], 0.23, 0.1, 0.24, fatigues, MAT.fabric, 0, 0, p.yaw, hp);
        const brim = at(0, chestL[1] + 0.36, chestL[2] + 0.16);
        out.box(brim[0], brim[1], brim[2], 0.2, 0.02, 0.12, fatigues, MAT.fabric, 0, 0, p.yaw, hp - 0.15);
        break;
      }
      case 2: // beanie
        out.box(head[0], head[1] + 0.08, head[2], 0.23, 0.17, 0.24, team, MAT.fabric, 0, 0, p.yaw, hp);
        break;
      case 3: // hood
        out.box(head[0], head[1] + 0.03, head[2] - 0.02, 0.3, 0.33, 0.3, fatigues, MAT.fabric, 0, 0, p.yaw, hp);
        break;
    }
    // Arms meet on the gun, which follows the aim pitch.
    const gunAt = at(0.12, chestL[1] - 0.05, chestL[2] + 0.3);
    const gm = mat4();
    compose(gm, 0, gunAt[0], gunAt[1], gunAt[2], 1, 1, 1, p.yaw, pitch);
    const cur = p.rec[P['arms.cur']];
    const gun = p.rec[P[`arms.guns${cur}.id`]];
    const model = this.drawModel(groups, `weapons/${this.sim.catalog.weapons[gun]?.slug}`, gm, 0, true, CAMOS[look.camo]?.layer ?? -1);
    const grip = transformPoint(gm, [0, -0.02, 0.01]);
    const fore = transformPoint(gm, [0, 0.0, Math.max(-0.35, (model?.min[2] ?? -0.4) * 0.55)]);
    for (const [side, hand] of [[1, grip], [-1, fore]] as const) {
      const sh = at(side * 0.22, chestL[1] - 0.02, chestL[2]);
      const el: V3 = [(sh[0] + hand[0]) / 2 + right[0] * side * 0.08, (sh[1] + hand[1]) / 2 - 0.14, (sh[2] + hand[2]) / 2 + right[2] * side * 0.08];
      out.limb(sh, el, 0.06, fatigues, MAT.fabric, 0, 0.06);
      out.limb(el, hand as V3, 0.05, fatigues, MAT.fabric, 0, 0.05);
      out.box(hand[0], hand[1], hand[2], 0.08, 0.07, 0.09, [0.9, 0.9, 0.9], MAT.polymer, 0, 0, p.yaw, pitch);
    }
    if (p.rec[P.shield] > 0) { const q = at(0, chestL[1] - 0.1, chestL[2] - 0.22); out.box(q[0], q[1], q[2], 0.6, 0.8, 0.06, [0.8, 0.8, 0.8], MAT.rust, 0, 0, p.yaw); }
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
      } else if (kind === I.power) {
        glows.box(x, 1.45, z, 0.2, 0.12, 0.2, power ? [0.2, 1, 0.3] : [1, 0.2, 0.1], -1, 4, FLAG_NOSHADOW);
        lights.push({ pos: [x, 1.9, z], radius: 5, color: power ? [0.2, 1, 0.3] : [1, 0.2, 0.1], intensity: 3 });
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
      this.zombie(round, glows, z, state, z.rec[Z.kind], t);
    }
    for (const p of s.players()) if (p.rec[P.life] !== 2) this.survivor(round, glows, groups, p, t);

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
    if (alive && gunId >= 0) {
      const dyaw = view.yaw - this.lastAngles[0], dpitch = view.pitch - this.lastAngles[1];
      this.sway[0] += (Math.max(-0.06, Math.min(0.06, dyaw * 0.6)) - this.sway[0]) * Math.min(1, dt * 10);
      this.sway[1] += (Math.max(-0.06, Math.min(0.06, dpitch * 0.6)) - this.sway[1]) * Math.min(1, dt * 10);
      this.kick *= Math.exp(-dt * 14);
      const bob = me[P['ctl.bob_amp']], ph = me[P['ctl.bob_ph']];
      const hip = 1 - ads;
      const lower = Math.max(me[P['arms.reload_t']] > 0 ? 1 : 0, me[P['arms.switch_t']] > 0 ? Math.sin((me[P['arms.switch_t']] / Math.max(me[P['arms.switch_d']], 0.01)) * Math.PI) : 0, me[P['ctl.mode']] === 3 ? 1 : 0);
      const sprint = me[P['ctl.sprinting']] ? 1 : 0;
      const idle = Math.sin(t * 1.3) * 0.004;
      const local = mat4();
      compose(local, 0,
        0.15 * hip + Math.cos(ph) * bob * 0.5 * hip + this.sway[0] * 0.6,
        -0.16 * hip - 0.075 * ads + Math.sin(ph * 2) * bob * 0.4 * hip + idle - lower * 0.22 - this.sway[1] * 0.5,
        -0.42 + this.kick * 0.05 + 0.08 * ads,
        1, 1, 1,
        this.sway[0] * 1.5 + sprint * 0.5 * hip,
        this.kick * 0.07 - lower * 0.7 - this.sway[1] - sprint * 0.25 * hip,
        this.sway[0] * -2 + (me[P['arms.melee_t']] > 0.3 ? 0.9 : 0));
      const world = mul(mat4(), camWorld, local);
      const slug = sim.catalog.weapons[gunId]?.slug;
      const myLook = this.lookOf(s.selfId);
      const model = this.drawModel(groups, `weapons/${slug}`, world, FLAG_VIEWMODEL | FLAG_NOSHADOW, false, CAMOS[myLook.camo]?.layer ?? -1);
      // Arms: sleeves from below the screen edge to gloved hands on the grip and the handguard.
      const cam = (x: number, y: number, z: number) => transformPoint(camWorld, [x, y, z]) as V3;
      const grip = transformPoint(world, [0, -0.035, 0.015]) as V3;
      const fore = transformPoint(world, [0, -0.005, Math.max(-0.3, (model?.min[2] ?? -0.35) * 0.62)]) as V3;
      const sleeve: RGB = FATIGUES[myLook.fatigues]?.rgb ?? FATIGUES[0].rgb;
      const vf = FLAG_VIEWMODEL | FLAG_NOSHADOW;
      // Only forearms are visible: they enter from below the screen edge, like a real first-person view.
      const rElbow = cam(0.24 - ads * 0.1, -0.42, -0.2), lElbow = cam(-0.1 + ads * 0.04, -0.4, -0.32);
      vm.limb(rElbow, grip, 0.034, sleeve, MAT.fabric, vf);
      vm.limb(lElbow, fore, 0.032, sleeve, MAT.fabric, vf);
      // Gloved hands wrapped around the grip and the handguard.
      for (const [h, from] of [[grip, rElbow], [fore, lElbow]] as const) {
        const d = [h[0] - from[0], h[1] - from[1], h[2] - from[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
        vm.limb([h[0] - d[0] / l * 0.04, h[1] - d[1] / l * 0.04, h[2] - d[2] / l * 0.04], [h[0] + d[0] / l * 0.03, h[1] + d[1] / l * 0.03, h[2] + d[2] / l * 0.03], 0.03, [0.8, 0.8, 0.8], MAT.polymer, vf, 0.036);
      }
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
    add(this.sphere, round, true);
    add(this.cube, this.worldGlow, false);
    add(this.cube, glows, false);
    add(this.sphere, vm, false);
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
        saturation: downed ? 0.35 : 0.86,
        contrast: 0.35,
        time: t,
      },
    };
  }
}
