// Typed wrapper over the Rust simulation core's C ABI. All data crosses through one shared
// Float32Array (`io`); field offsets come from the module itself (`gs_layout`), so nothing here
// duplicates a struct layout.
type X = Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };

export const Kind = {
  weapon: 0, attachment: 1, perk: 2, kitPerk: 3, lethal: 4, tactical: 5, wildcard: 6, streak: 7,
  ability: 8, tonic: 9, mod: 10, powerup: 11, map: 12, zone: 13, quest: 14, questStep: 15, door: 16, prop: 17,
} as const;

export const Btn = {
  jump: 1, sprint: 2, crouch: 4, fire: 8, ads: 16, reload: 32, use: 64, melee: 128, ability: 256,
  swap: 512, tonic: 1024, lethal: 2048, tactical: 4096, streak1: 8192, streak2: 16384, streak3: 32768,
} as const;

export const CMD_LEN = 9;
export const LOADOUT_LEN = 27;
export type Offsets = Record<string, number>;
export interface Layout { P: Offsets; H: Offsets; Z: Offsets; E: Offsets; V: Offsets }

export interface Item { id: number; name: string; desc: string }
export interface WeaponInfo extends Item { slug: string; cls: number; damage: number; rpm: number; mag: number; reserve: number; reload: number; zoom: number; cost: number; flags: number; auto: boolean; range: number }
export interface Catalog {
  weapons: WeaponInfo[];
  attachments: (Item & { classMask: number })[];
  perks: (Item & { cost: number })[];
  kitPerks: Item[];
  lethals: Item[];
  tacticals: Item[];
  wildcards: Item[];
  streaks: (Item & { score: number })[];
  abilities: (Item & { kind: number })[];
  tonics: (Item & { kind: number; amount: number; rare: boolean })[];
  mods: string[];
  powerups: string[];
  maps: { id: number; name: string; zones: string[]; doors: string[]; props: string[]; quests: { name: string; steps: string[] }[] }[];
}

export class Sim {
  private x: X;
  private ioPtr: number;
  private strPtr: number;
  private view!: Float32Array;
  readonly L: Layout;
  readonly catalog: Catalog;

  constructor(instance: WebAssembly.Instance) {
    this.x = instance.exports as unknown as X;
    this.ioPtr = this.x.gs_io();
    this.strPtr = this.x.gs_str_buf();
    this.L = this.parseLayout();
    this.catalog = this.readCatalog();
  }

  static async load(source: Response | BufferSource): Promise<Sim> {
    const result = source instanceof Response
      ? await WebAssembly.instantiateStreaming(source, {})
      : await WebAssembly.instantiate(source as BufferSource, {});
    return new Sim(result.instance);
  }

  /** The shared buffer. Re-created if Wasm memory grew, which detaches old views. */
  get io(): Float32Array {
    if (!this.view || this.view.buffer !== this.x.memory.buffer) this.view = new Float32Array(this.x.memory.buffer, this.ioPtr, 16384);
    return this.view;
  }
  take(n: number): Float32Array { return this.io.slice(0, n); }
  private text(n: number): string { return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.strPtr, n)); }

  private parseLayout(): Layout {
    const out: Record<string, Offsets> = {};
    for (const section of this.text(this.x.gs_layout()).split(';')) {
      const [tag, body] = section.split('|');
      if (!body) continue;
      out[tag] = Object.fromEntries(body.split(',').filter(Boolean).map(p => { const [k, v] = p.split(':'); return [k, +v]; }));
    }
    return out as unknown as Layout;
  }

  count(kind: number, a = 0): number { return this.x.gs_count(kind, a); }
  str(kind: number, a: number, b = 0, which = 0): string { return this.text(this.x.gs_str(kind, a, b, which)); }
  stat(kind: number, id: number, field = 0): number { return this.x.gs_stat(kind, id, field); }

  private readCatalog(): Catalog {
    const list = <T>(kind: number, extra: (id: number) => T) =>
      Array.from({ length: this.count(kind) }, (_, id) => ({ id, name: this.str(kind, id), desc: this.str(kind, id, 0, 1), ...extra(id) }));
    const names = (kind: number, map: number) => Array.from({ length: this.count(kind, map) }, (_, i) => this.str(kind, map, i));
    return {
      weapons: list(Kind.weapon, id => {
        const s = (f: number) => this.stat(Kind.weapon, id, f);
        return { slug: this.str(Kind.weapon, id, 0, 1), cls: s(0), damage: s(1), rpm: s(2), mag: s(3), reserve: s(4), reload: s(5), zoom: s(6), cost: s(7), flags: s(8), auto: s(9) > 0, range: s(10) };
      }),
      attachments: list(Kind.attachment, id => ({ classMask: this.stat(Kind.attachment, id) })),
      perks: list(Kind.perk, id => ({ cost: this.stat(Kind.perk, id) })),
      kitPerks: list(Kind.kitPerk, () => ({})),
      lethals: list(Kind.lethal, () => ({})),
      tacticals: list(Kind.tactical, () => ({})),
      wildcards: list(Kind.wildcard, () => ({})),
      streaks: list(Kind.streak, id => ({ score: this.stat(Kind.streak, id) })),
      abilities: list(Kind.ability, id => ({ kind: this.stat(Kind.ability, id) })),
      tonics: list(Kind.tonic, id => ({ kind: this.stat(Kind.tonic, id, 0), amount: this.stat(Kind.tonic, id, 1), rare: this.stat(Kind.tonic, id, 2) > 0 })),
      mods: Array.from({ length: this.count(Kind.mod) }, (_, i) => this.str(Kind.mod, i)),
      powerups: Array.from({ length: this.count(Kind.powerup) }, (_, i) => this.str(Kind.powerup, i)),
      maps: Array.from({ length: this.count(Kind.map) }, (_, id) => ({
        id,
        name: this.str(Kind.map, id),
        zones: names(Kind.zone, id),
        doors: names(Kind.door, id),
        props: names(Kind.prop, id),
        quests: Array.from({ length: this.count(Kind.quest, id) }, (_, q) => {
          const steps: string[] = [];
          for (let s = 0; s < 16; s++) { const t = this.str(Kind.questStep, id, q * 16 + s); if (!t) break; steps.push(t); }
          return { name: this.str(Kind.quest, id, q), steps };
        }),
      })),
    };
  }

  /** Points used by a loadout, or a negative error code (see `loadout.rs`). */
  validateLoadout(l: ArrayLike<number>): number { this.io.set(l as ArrayLike<number>); return this.x.gs_loadout_validate() | 0; }
  defaultLoadout(): number[] { return Array.from(this.take(this.x.gs_loadout_default())); }
  recoil(weapon: number, shot: number, ads: number, att: number): [number, number] {
    this.x.gs_recoil(weapon, shot, ads, att);
    return [this.io[0], this.io[1]];
  }
  /** Effective stats of a gun: mag, zoom, auto, flags, reserve. */
  gunStats(id: number, att: number, tier: number): { mag: number; zoom: number; auto: boolean; flags: number; reserve: number } | null {
    if (!this.x.gs_gun_stats(id, att, tier)) return null;
    const io = this.io;
    return { mag: io[0], zoom: io[1], auto: io[2] > 0, flags: io[3], reserve: io[4] };
  }
  zombieHealth(round: number): number { return this.x.gs_zombie_health(round); }
  zombieCount(round: number, players: number): number { return this.x.gs_zombie_count(round, players); }
  hordeCap(players: number): number { return this.x.gs_horde_cap(players); }

  newGame(map: number, mode: number, seed: number, authority: boolean): Game {
    return new Game(this, this.x, this.x.gs_new(map, mode, seed >>> 0, authority ? 1 : 0), map, mode);
  }
}

/** One match instance inside the Wasm module. */
export class Game {
  constructor(readonly sim: Sim, private x: X, private h: number, readonly map: number, readonly mode: number) {}
  free(): void { this.x.gs_free(this.h); }
  addPlayer(id: number, team: number, loadout: ArrayLike<number>): void { this.sim.io.set(loadout); this.x.gs_add_player(this.h, id, team); }
  removePlayer(id: number): void { this.x.gs_remove_player(this.h, id); }
  setLocal(id: number): void { this.x.gs_set_local(this.h, id); }
  cmd(id: number, c: ArrayLike<number>): void { this.sim.io.set(c); this.x.gs_cmd(this.h, id); }
  step(dt: number): void { this.x.gs_step(this.h, dt); }
  snapshot(): Float32Array { return this.sim.take(this.x.gs_snapshot(this.h)); }
  events(): Float32Array { return this.sim.take(this.x.gs_events(this.h)); }
  playerState(id: number): Float32Array { return this.sim.take(this.x.gs_player_state(this.h, id)); }
  setPlayerState(s: ArrayLike<number>): void { this.sim.io.set(s); this.x.gs_set_player_state(this.h, s.length); }
  setDoors(mask: number): void { this.x.gs_set_doors(this.h, mask); }
  /** 8 floats per box: min xyz, max xyz, material, flags | (tag + 1) << 8. */
  boxes(): Float32Array { return this.sim.take(this.x.gs_boxes(this.h) * 8); }
  /** 8 floats per interactable: kind, x, y, z, cost, param, needsPower, active. */
  interactables(): Float32Array { return this.sim.take(this.x.gs_interactables(this.h) * 8); }
  mapInfo(): MapInfo {
    const d = this.sim.take(this.x.gs_map_info(this.h));
    let i = 12;
    const vecs = (stride: number) => { const n = d[i++]; const out = Array.from({ length: n }, (_, k) => Array.from(d.subarray(i + k * stride, i + (k + 1) * stride))); i += n * stride; return out; };
    return { size: [d[0], d[1]], sun: [d[2], d[3], d[4]], sunColor: [d[5], d[6], d[7]], sky: [d[8], d[9], d[10]], fog: d[11], barricades: vecs(3), targets: vecs(3), props: vecs(4) };
  }
  /** Distance a bullet travels before hitting static geometry. */
  raycast(o: ArrayLike<number>, d: ArrayLike<number>, max: number): number {
    const io = this.sim.io;
    io[0] = o[0]; io[1] = o[1]; io[2] = o[2]; io[3] = d[0]; io[4] = d[1]; io[5] = d[2]; io[6] = max;
    return this.x.gs_raycast(this.h);
  }
}

export interface MapInfo { size: number[]; sun: number[]; sunColor: number[]; sky: number[]; fog: number; barricades: number[][]; targets: number[][]; props: number[][] }

/** A decoded world snapshot. Arrays are views into `raw`. */
export interface Snap {
  raw: Float32Array;
  time: number;
  hdr: Float32Array;
  players: Float32Array[];
  zombies: Float32Array[];
  ents: Float32Array[];
  barrs: Float32Array;
}

export function decodeSnap(L: Layout, raw: Float32Array): Snap {
  const hdr = raw.subarray(0, L.H._len);
  let o = L.H._len;
  const cut = (n: number, stride: number) => { const out: Float32Array[] = []; for (let i = 0; i < n; i++, o += stride) out.push(raw.subarray(o, o + stride)); return out; };
  const players = cut(hdr[L.H.n_players], L.P._len);
  const zombies = cut(hdr[L.H.n_zombies], L.Z._len);
  const ents = cut(hdr[L.H.n_ents], L.E._len);
  const barrs = raw.subarray(o, o + hdr[L.H.n_barrs]);
  return { raw, time: hdr[L.H.time], hdr, players, zombies, ents, barrs };
}
