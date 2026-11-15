// Turns match state into a renderer `Frame`: greybox world, interactables, zombies, players, the
// first-person weapon, tracers, muzzle flashes and lights, plus camera and post-processing settings.
import type { Sim } from '../core/sim';
import { loadModel, type Model } from '../gfx/loader';
import { compose, invert, lookAt, mat4, mul, ortho, perspective } from '../gfx/mat';
import { cubeMesh, FLAG_GRID, FLAG_NOSHADOW, FLAG_VIEWMODEL, INSTANCE_FLOATS, LIGHT_FLOATS, MAX_LIGHTS, type Draw, type Frame, type Renderer } from '../gfx/renderer';
import type { Session, View } from './session';

type RGB = [number, number, number];
interface Material { color: RGB; metallic: number; roughness: number; grid: boolean }
const m = (color: RGB, metallic = 0, roughness = 0.85, grid = false): Material => ({ color, metallic, roughness, grid });
const MATERIALS: Material[] = [
  m([0.4, 0.41, 0.43], 0, 0.92, true), // floor
  m([0.56, 0.57, 0.6], 0, 0.88, true), // wall
  m([0.72, 0.48, 0.24], 0, 0.8, true), // crate block
  m([0.3, 0.42, 0.58], 0, 0.8, true), // platform / stairs
  m([0.62, 0.16, 0.12], 0.6, 0.45), // door
  m([0.3, 0.3, 0.33], 0.7, 0.4), // perk machine
  m([0.16, 0.2, 0.42], 0.5, 0.5), // mystery crate
  m([0.42, 0.18, 0.52], 0.7, 0.35), // upgrade bench
  m([0.75, 0.62, 0.1], 0.4, 0.5), // power switch
  m([0.1, 0.5, 0.46], 0.5, 0.4), // tonic dispenser
  m([0.4, 0.3, 0.18], 0, 0.8), // workbench
  m([0.14, 0.18, 0.24], 0.6, 0.4), // console
  m([0.24, 0.24, 0.27], 0.3, 0.6), // wall-buy pedestal
];
const PERK_COLORS: RGB[] = [[0.9, 0.2, 0.15], [0.2, 0.85, 0.3], [1, 0.65, 0.1], [0.2, 0.5, 1], [1, 0.9, 0.2], [0.7, 0.3, 1]];
const POWERUP_COLORS: RGB[] = [[0.2, 1, 0.3], [1, 0.2, 0.2], [1, 0.85, 0.1], [0.9, 0.9, 1], [0.3, 0.6, 1]];
export const PLAYER_COLORS: RGB[] = [[0.2, 0.55, 1], [1, 0.45, 0.15], [0.3, 0.85, 0.35], [0.9, 0.3, 0.8], [1, 0.85, 0.2], [0.3, 0.9, 0.9], [0.9, 0.25, 0.25], [0.75, 0.75, 0.8]];
const ZOMBIE_COLORS: RGB[] = [[0.4, 0.48, 0.36], [0.5, 0.42, 0.33], [0.55, 0.28, 0.26]];

const I = { door: 1, wallbuy: 2, perk: 3, crate: 4, bench: 5, tonic: 6, power: 7, workbench: 8, part: 9, console: 10 };

/** A growable run of instances that share a mesh. */
class Batch {
  data = new Float32Array(INSTANCE_FLOATS * 256);
  n = 0;
  private grow(): number {
    if ((this.n + 1) * INSTANCE_FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    return this.n++ * INSTANCE_FLOATS;
  }
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: RGB, metallic: number, roughness: number, emissive = 0, flags = 0, yaw = 0, pitch = 0, roll = 0): void {
    const o = this.grow();
    compose(this.data, o, x, y, z, sx, sy, sz, yaw, pitch, roll);
    this.data.set([c[0], c[1], c[2], 1, metallic, roughness, emissive, flags], o + 16);
  }
  /** Instance with an explicit matrix (glTF parts). */
  mat(matrix: Float32Array, c: ArrayLike<number>, metallic: number, roughness: number, emissive: number, flags: number): void {
    const o = this.grow();
    this.data.set(matrix, o);
    this.data.set([c[0], c[1], c[2], 1, metallic, roughness, emissive, flags], o + 16);
  }
  append(other: Batch): void {
    while ((this.n + other.n) * INSTANCE_FLOATS > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    this.data.set(other.data.subarray(0, other.n * INSTANCE_FLOATS), this.n * INSTANCE_FLOATS);
    this.n += other.n;
  }
}

interface Tracer { a: number[]; b: number[]; t: number; color: RGB }
interface Flash { pos: number[]; t: number; life: number; color: RGB; radius: number; size: number }
interface LightSrc { pos: number[]; radius: number; color: RGB; intensity: number }

export interface SceneSettings { fov: number; motionBlur: boolean; dof: boolean }

export class Scene {
  private cube: number;
  private world = new Batch();
  private models = new Map<string, Model | null>();
  private tracers: Tracer[] = [];
  private flashes: Flash[] = [];
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
  /** Red screen-edge flash, 0..1. */
  hurt = 0;

  constructor(private renderer: Renderer, private sim: Sim, private session: Session) {
    this.cube = renderer.createMesh(cubeMesh());
    const b = session.boxes;
    for (let o = 0; o < b.length; o += 8) {
      const flags = b[o + 7] & 0xff;
      if (flags & (2 | 4)) continue; // hidden or door (doors are drawn while closed)
      this.addBox(this.world, b, o);
    }
    // A barricade's boards span whichever way its opening is walled in.
    this.barrAxis = session.mapInfo.barricades.map(p => this.wallAt(p[0] - 2, p[2]) && this.wallAt(p[0] + 2, p[2]));
    for (const w of sim.catalog.weapons) this.load(`weapons/${w.slug}`);
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
  private addBox(batch: Batch, b: Float32Array, o: number, tint?: RGB, emissive = 0): void {
    const mat = MATERIALS[b[o + 6]] ?? MATERIALS[1];
    batch.box((b[o] + b[o + 3]) / 2, (b[o + 1] + b[o + 4]) / 2, (b[o + 2] + b[o + 5]) / 2, b[o + 3] - b[o], b[o + 4] - b[o + 1], b[o + 5] - b[o + 2], tint ?? mat.color, mat.metallic, mat.roughness, emissive, mat.grid ? FLAG_GRID : 0);
  }

  /** Visual reactions to simulation events. */
  handleEvent(e: Float32Array, view: View): void {
    const { V } = this.sim.L;
    const s = this.session;
    if (e[0] === V.local && e[1] === 1) {
      // Our own shot: draw the tracer immediately from a local trace instead of waiting for the host.
      const dir = [-Math.sin(view.yaw) * Math.cos(view.pitch), Math.sin(view.pitch), -Math.cos(view.yaw) * Math.cos(view.pitch)];
      const dist = s.game.raycast(view.pos, dir, 120);
      const right = [Math.cos(view.yaw), 0, -Math.sin(view.yaw)];
      const from = [view.pos[0] + dir[0] * 0.7 + right[0] * 0.12, view.pos[1] + dir[1] * 0.7 - 0.1, view.pos[2] + dir[2] * 0.7 + right[2] * 0.12];
      this.tracers.push({ a: from, b: [view.pos[0] + dir[0] * dist, view.pos[1] + dir[1] * dist, view.pos[2] + dir[2] * dist], t: 0.07, color: this.tracerColor(e[2]) });
      this.kick = 1;
      this.muzzle = 0.05;
    } else if (e[0] === V.shot && e[1] !== s.selfId) {
      const shooter = s.players().find(p => p.id === e[1]);
      const from = shooter ? [shooter.x - Math.sin(shooter.yaw) * 0.6, shooter.y + 1.35, shooter.z - Math.cos(shooter.yaw) * 0.6] : [e[3], e[4] + 4, e[5]];
      this.tracers.push({ a: from, b: [e[3], e[4], e[5]], t: 0.07, color: this.tracerColor(e[2]) });
      if (shooter) this.flashes.push({ pos: from, t: 0.05, life: 0.05, color: [1, 0.8, 0.4], radius: 7, size: 0.18 });
    } else if (e[0] === V.explode) {
      const stun = e[5] === 1;
      this.flashes.push({ pos: [e[1], e[2] + 0.5, e[3]], t: 0.35, life: 0.35, color: stun ? [0.5, 0.7, 1] : e[5] === 2 ? [1, 0.2, 0.2] : [1, 0.6, 0.2], radius: e[4] * 2.5, size: e[4] * 0.5 });
    } else if (e[0] === V.zdeath) {
      this.flashes.push({ pos: [e[2], e[3] + 1, e[4]], t: 0.15, life: 0.15, color: [0.7, 0.1, 0.1], radius: 0, size: 0.5 });
    } else if (e[0] === V.powerup && e[5] === 1) {
      this.flashes.push({ pos: [e[2], e[3], e[4]], t: 0.4, life: 0.4, color: POWERUP_COLORS[e[1]] ?? [1, 1, 1], radius: 12, size: 0.8 });
    } else if ((e[0] === V.pdown || e[0] === V.zattack) && e[e[0] === V.pdown ? 1 : 2] === s.selfId) {
      this.hurt = 1;
    } else if (e[0] === V.hit) {
      this.flashes.push({ pos: [e[5], e[6], e[7]], t: 0.1, life: 0.1, color: [0.8, 0.1, 0.1], radius: 0, size: 0.14 });
    }
  }
  private tracerColor(weapon: number): RGB {
    const slug = this.sim.catalog.weapons[weapon]?.slug;
    return slug === 'arc' ? [0.3, 0.8, 1] : slug === 'stormlance' ? [0.7, 0.4, 1] : slug === 'verdict' ? [1, 0.5, 0.1] : [1, 0.9, 0.6];
  }

  private drawModel(groups: Map<string, { mesh: number; shadow: boolean; batch: Batch }>, name: string, matrix: Float32Array, flags: number, shadow: boolean): void {
    const model = this.models.get(name);
    if (!model) return;
    for (const part of model.parts) {
      const key = `${part.mesh}:${shadow}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mesh: part.mesh, shadow, batch: new Batch() }));
      g.batch.mat(matrix, part.color, part.metallic, part.roughness, part.emissive, flags);
    }
  }

  build(view: View, dt: number, aspect: number, settings: SceneSettings): Frame {
    const { sim, session: s } = this;
    const { P, H, Z, E } = sim.L;
    this.time += dt;
    const t = this.time;
    const hdr = s.snap?.hdr;
    const me = s.local();
    const power = !!hdr?.[H.power];
    const casters = new Batch();
    const glows = new Batch();
    const groups = new Map<string, { mesh: number; shadow: boolean; batch: Batch }>();
    const lights: LightSrc[] = [];
    const tmp = mat4();

    // Doors still shut.
    const b = s.boxes;
    for (let o = 0; o < b.length; o += 8) {
      const flags = b[o + 7] & 0xff, door = (b[o + 7] >> 8) - 1;
      if (flags & 4 && !((hdr?.[H.doors] ?? 0) & (1 << door))) this.addBox(casters, b, o);
    }

    // Interactables: status lights and the weapons on display.
    const it = s.inter;
    for (let k = 0, o = 0; o < it.length; k++, o += 8) {
      const [kind, x, y, z, , param] = it.subarray(o, o + 6);
      if (kind === I.perk) {
        const c = PERK_COLORS[param] ?? [1, 1, 1];
        glows.box(x, 2.0, z, 1.25, 0.25, 1.25, c, 0, 0.5, power ? 2.5 : 0.05, FLAG_NOSHADOW);
        if (power) lights.push({ pos: [x, 2.7, z], radius: 7, color: c, intensity: 5 });
      } else if (kind === I.wallbuy) {
        compose(tmp, 0, x, 1.15, z, 1.6, 1.6, 1.6, t * 0.8, 0, 0.3);
        this.drawModel(groups, `weapons/${sim.catalog.weapons[param]?.slug}`, tmp.slice(), 0, true);
        glows.box(x, 0.92, z, 0.62, 0.04, 0.62, [1, 0.9, 0.5], 0, 0.5, 1.2, FLAG_NOSHADOW);
      } else if (kind === I.crate && hdr && k === hdr[H.crate_at]) {
        const state = hdr[H.crate_state];
        glows.box(x, 0.93, z, 1.5, 0.06, 0.9, [0.3, 0.6, 1], 0, 0.5, state === 3 ? 0.2 : 2.5, FLAG_NOSHADOW);
        lights.push({ pos: [x, 1.6, z], radius: 6, color: [0.3, 0.6, 1], intensity: 4 });
        const shown = state === 2 ? hdr[H.crate_weapon] : state === 1 ? Math.floor(t * 9) % 8 : -1;
        if (shown >= 0) {
          compose(tmp, 0, x, 1.5 + Math.sin(t * 3) * 0.05, z, 1.8, 1.8, 1.8, Math.PI / 2, 0, 0);
          this.drawModel(groups, `weapons/${sim.catalog.weapons[shown]?.slug}`, tmp.slice(), 0, true);
        }
      } else if (kind === I.bench) {
        glows.box(x, 2.35, z, 1.0, 0.1, 1.0, [0.8, 0.3, 1], 0, 0.5, power ? 3 : 0.05, FLAG_NOSHADOW);
        if (power) lights.push({ pos: [x, 2.9, z], radius: 7, color: [0.8, 0.3, 1], intensity: 5 });
      } else if (kind === I.tonic) {
        glows.box(x, 2.35, z, 0.7, 0.1, 0.7, [0.2, 1, 0.9], 0, 0.5, 2.5, FLAG_NOSHADOW);
      } else if (kind === I.power) {
        glows.box(x, 1.45, z, 0.2, 0.12, 0.2, power ? [0.2, 1, 0.3] : [1, 0.2, 0.1], 0, 0.5, 3, FLAG_NOSHADOW);
        lights.push({ pos: [x, 1.9, z], radius: 5, color: power ? [0.2, 1, 0.3] : [1, 0.2, 0.1], intensity: 3 });
      } else if (kind === I.part && hdr && !(hdr[H.parts] & (1 << param))) {
        const fuse = param < 8;
        glows.box(x, y + Math.sin(t * 2 + k) * 0.08, z, fuse ? 0.14 : 0.4, fuse ? 0.34 : 0.4, fuse ? 0.14 : 0.08, fuse ? [1, 0.8, 0.2] : [0.5, 0.7, 0.9], 0.6, 0.3, 1.6, FLAG_NOSHADOW, t * 1.5);
      } else if (kind === I.console) {
        glows.box(x, 1.25, z, 0.8, 0.08, 0.5, [0.2, 0.9, 1], 0, 0.5, power ? 2 : 0.1, FLAG_NOSHADOW);
      }
    }
    // Quest relays glow while they can be shot.
    if (hdr && hdr[H.targets] & (1 << 16)) {
      s.mapInfo.targets.forEach((p, k) => {
        if (hdr[H.targets] & (1 << k)) return;
        glows.box(p[0], p[1], p[2], 0.8, 0.8, 0.8, [1, 0.15, 0.1], 0, 0.5, 3 + Math.sin(t * 6) * 1.5, FLAG_NOSHADOW, t);
        lights.push({ pos: p, radius: 8, color: [1, 0.2, 0.1], intensity: 6 });
      });
    }
    s.mapInfo.props.forEach((p, k) => {
      compose(tmp, 0, p[0], p[1], p[2], 1, 1, 1, p[3]);
      this.drawModel(groups, `props/${sim.catalog.maps[s.start.map].props[k]}`, tmp.slice(), 0, true);
    });
    // Barricade boards.
    s.mapInfo.barricades.forEach((p, k) => {
      const boards = s.snap?.barrs[k] ?? 6;
      const alongX = this.barrAxis[k];
      for (let i = 0; i < boards; i++) casters.box(p[0], 0.45 + i * 0.36, p[2], alongX ? 2.1 : 0.1, 0.24, alongX ? 0.1 : 2.1, [0.45, 0.3, 0.16], 0, 0.9, 0, 0, 0, 0, alongX ? ((i * 7) % 5 - 2) * 0.03 : 0);
    });

    // Zombies: six boxes each, animated procedurally.
    for (const z of s.zombies()) {
      const state = z.rec[Z.state], kind = z.rec[Z.kind];
      if (state === 5) continue;
      const turned = state === 4;
      const c = turned ? ([0.3, 0.5, 0.95] as RGB) : ZOMBIE_COLORS[kind] ?? ZOMBIE_COLORS[0];
      const rise = state === 0 ? -0.7 : 0;
      const cy = Math.cos(z.yaw), sy = Math.sin(z.yaw);
      const stride = Math.sin(t * (3 + kind * 3) + z.id * 1.7);
      const part = (lx: number, ly: number, lz: number, sx: number, sy_: number, sz: number, color: RGB, pitch = 0, emissive = 0) =>
        (emissive ? glows : casters).box(z.x + lx * cy + lz * sy, z.y + ly + rise, z.z - lx * sy + lz * cy, sx, sy_, sz, color, 0, 0.9, emissive, emissive ? FLAG_NOSHADOW : 0, z.yaw, pitch);
      const lean = kind * 0.12;
      part(0, 1.05, -lean * 0.4, 0.5, 0.62, 0.28, c, -lean, turned ? 0.4 : 0);
      part(0, 1.55, -lean * 0.8 - 0.02, 0.27, 0.27, 0.27, [c[0] * 1.15, c[1] * 1.15, c[2] * 1.1], -lean);
      const reach = state === 2 ? 0.5 : 0;
      part(-0.33, 1.28 + reach * 0.3, -0.3, 0.12, 0.12, 0.6, c, 0.15 + reach + stride * 0.1);
      part(0.33, 1.28 + reach * 0.3, -0.3, 0.12, 0.12, 0.6, c, 0.15 + reach - stride * 0.1);
      part(-0.13, 0.4, stride * 0.12, 0.17, 0.8, 0.18, [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7], stride * 0.45);
      part(0.13, 0.4, -stride * 0.12, 0.17, 0.8, 0.18, [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7], -stride * 0.45);
      const eye: RGB = turned ? [0.4, 0.8, 1] : [1, 0.75, 0.1];
      part(-0.07, 1.58, -0.15 - lean * 0.8, 0.05, 0.04, 0.03, eye, 0, 4);
      part(0.07, 1.58, -0.15 - lean * 0.8, 0.05, 0.04, 0.03, eye, 0, 4);
    }

    // Other players.
    for (const p of s.players()) {
      const life = p.rec[P.life];
      if (life === 2) continue;
      const c = PLAYER_COLORS[p.id % PLAYER_COLORS.length];
      const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
      const low = p.rec[P['ctl.crouched']] ? 0.6 : 0;
      const at = (lx: number, ly: number, lz: number): [number, number, number] => [p.x + lx * cy + lz * sy, p.y + ly, p.z - lx * sy + lz * cy];
      if (life === 1) {
        casters.box(...at(0, 0.25, 0.3), 0.5, 0.3, 1.5, c, 0, 0.8, 0, 0, p.yaw);
        glows.box(p.x, 1.2 + Math.sin(t * 4) * 0.1, p.z, 0.25, 0.25, 0.25, [0.3, 0.6, 1], 0, 0.5, 3, FLAG_NOSHADOW, t * 2);
        continue;
      }
      casters.box(...at(0, 1.1 - low, 0), 0.5, 0.65, 0.3, c, 0.1, 0.7, 0, 0, p.yaw);
      casters.box(...at(0, 1.62 - low, 0), 0.26, 0.26, 0.26, [0.85, 0.7, 0.6], 0, 0.8, 0, 0, p.yaw, p.rec[P['ctl.pitch']]);
      casters.box(...at(-0.13, 0.4 - low * 0.4, 0), 0.18, 0.8 - low, 0.2, [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5], 0, 0.8, 0, 0, p.yaw);
      casters.box(...at(0.13, 0.4 - low * 0.4, 0), 0.18, 0.8 - low, 0.2, [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5], 0, 0.8, 0, 0, p.yaw);
      const gun = p.rec[P[`arms.guns${p.rec[P['arms.cur']]}.id`]];
      compose(tmp, 0, ...at(0.2, 1.25 - low, -0.35), 1, 1, 1, p.yaw, p.rec[P['ctl.pitch']]);
      this.drawModel(groups, `weapons/${sim.catalog.weapons[gun]?.slug}`, tmp.slice(), 0, true);
      if (p.rec[P.shield] > 0) casters.box(...at(0, 1.1 - low, 0.22), 0.55, 0.75, 0.06, [0.5, 0.55, 0.6], 0.9, 0.3, 0, 0, p.yaw);
    }

    // Power-ups, grenades and lingering effects.
    for (const e of s.snap?.ents ?? []) {
      const kind = e[E.kind], x = e[E.pos], y = e[E.pos + 1], z = e[E.pos + 2];
      if (kind >= 10 && kind < 15) {
        const c = POWERUP_COLORS[kind - 10];
        const blink = e[E.a] < 6 && Math.sin(t * 14) > 0 ? 0.3 : 1;
        glows.box(x, y + Math.sin(t * 2.5) * 0.1, z, 0.4, 0.4, 0.4, c, 0, 0.3, 3.5 * blink, FLAG_NOSHADOW, t * 2, 0.6);
        lights.push({ pos: [x, y, z], radius: 6, color: c, intensity: 4 * blink });
      } else if (kind < 4) {
        casters.box(x, y, z, 0.12, 0.12, 0.12, kind === 3 ? [0.3, 0.5, 0.9] : [0.15, 0.2, 0.12], 0.5, 0.5, 0, 0, t * 9, t * 7);
      } else if (kind === 20 || kind === 21) {
        const c: RGB = kind === 20 ? [1, 0.45, 0.1] : [0.6, 0.8, 1];
        for (let i = 0; i < 6; i++) glows.box(x + Math.cos(t * 3 + i) * 1.4, y + 0.3 + ((t * 2 + i * 0.4) % 1.5), z + Math.sin(t * 3 + i) * 1.4, 0.18, 0.18, 0.18, c, 0, 0.5, 4, FLAG_NOSHADOW, t + i);
        lights.push({ pos: [x, y + 1, z], radius: 8, color: c, intensity: 7 });
      } else if (kind === 30) {
        glows.box(x, 0.05, z, 1.2, 0.05, 1.2, [1, 0.2, 0.1], 0, 0.5, 3 + Math.sin(t * 20) * 2, FLAG_NOSHADOW, t * 3);
      }
    }

    // Tracers and flashes.
    for (const tr of this.tracers) {
      const d = [tr.b[0] - tr.a[0], tr.b[1] - tr.a[1], tr.b[2] - tr.a[2]];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      glows.box((tr.a[0] + tr.b[0]) / 2, (tr.a[1] + tr.b[1]) / 2, (tr.a[2] + tr.b[2]) / 2, 0.025, 0.025, len, tr.color, 0, 0.5, 6, FLAG_NOSHADOW, Math.atan2(-d[0], -d[2]), Math.asin(d[1] / len));
      tr.t -= dt;
    }
    this.tracers = this.tracers.filter(tr => tr.t > 0);
    for (const f of this.flashes) {
      const k = f.t / f.life;
      const size = f.size * (1.6 - k);
      glows.box(f.pos[0], f.pos[1], f.pos[2], size, size, size, f.color, 0, 0.5, 6 * k, FLAG_NOSHADOW, t * 5, t * 3);
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
    const fov = (2 * Math.atan(Math.tan((view.fov * Math.PI) / 360) / zoom));
    const viewProj = mul(mat4(), perspective(mat4(), fov, aspect, 0.08, 400), viewMat);
    const viewmodelProj = mul(mat4(), perspective(mat4(), (54 * Math.PI) / 180 / (1 + (zoom - 1) * 0.25), aspect, 0.02, 20), viewMat);

    // First-person weapon: sway lags the look, bob follows the stride, kick decays after each shot.
    const alive = me[P.life] === 0;
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
      this.drawModel(groups, `weapons/${slug}`, world, FLAG_VIEWMODEL | FLAG_NOSHADOW, false);
      if (this.muzzle > 0) {
        this.muzzle -= dt;
        const model = this.models.get(`weapons/${slug}`);
        const tip = mat4();
        compose(tip, 0, 0, 0.06, (model?.min[2] ?? -0.6) - 0.06, 0.09, 0.09, 0.14, 0, 0, t * 40);
        glows.mat(mul(mat4(), world, tip), [1, 0.8, 0.4], 0, 0.5, 9, FLAG_VIEWMODEL | FLAG_NOSHADOW);
        // The flash lights the world for a couple of frames.
        lights.push({ pos: [view.pos[0] - Math.sin(view.yaw) * 0.8, view.pos[1] - 0.1, view.pos[2] - Math.cos(view.yaw) * 0.8], radius: 11, color: [1, 0.75, 0.4], intensity: 30 });
      }
    }
    this.lastAngles = [view.yaw, view.pitch];

    // Nearest lights win the 16 slots.
    for (const l of this.staticLights) lights.push(l);
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

    // Assemble the instance buffer: shadow casters first, then everything that casts none.
    const out = this.frameData;
    out.n = 0;
    out.append(this.world);
    out.append(casters);
    const casterCount = out.n;
    out.append(glows);
    const draws: Draw[] = [
      { mesh: this.cube, first: 0, count: casterCount, shadow: true },
      { mesh: this.cube, first: casterCount, count: out.n - casterCount, shadow: false },
    ];
    for (const g of groups.values()) {
      draws.push({ mesh: g.mesh, first: out.n, count: g.batch.n, shadow: g.shadow });
      out.append(g.batch);
    }

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
        bloom: 0.55,
        motionBlur: settings.motionBlur ? 0.5 + Math.min(speed / 12, 1) * 0.4 : 0,
        dofFocus: downed ? 1.5 : 30,
        dofAmount: settings.dof ? (downed ? 0.9 : ads * 0.45) : 0,
        vignette: 0.35 + (1 - Math.max(health, 0)) * 0.35,
        damage: Math.max(this.hurt * 0.6, downed ? 0.45 : (1 - health) * 0.5),
        time: t,
      },
    };
  }
}
