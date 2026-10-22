// Authoritative game state, run only on the host. Players report position/hits/purchases; the sim decides
// points, health, zombies and rounds. Outgoing messages queue in `out` as [playerId | '*', msg].
import {
  parseMap, CELL, DOORS, INTERACT, PERKS, WEAPONS, POINTS, CRATE_COST, ZOMBIE_SPEEDS,
  interactPos, useRange, flowField, stepToward, lineOfSight, collide, toCell, cellCenter,
  zombieHealth, zombieCount, zombieSpeed, rollCrate,
} from './rules.js';

const MAX_ALIVE = 24, MAX_PLAYERS = 4, BREAK = 10, BLEED = 45, SELF_REVIVE = 8, REGEN_DELAY = 3, HIT = 50;

export class Sim {
  constructor(hostId, rnd = Math.random) {
    this.hostId = hostId;
    this.rnd = rnd;
    this.map = parseMap();
    this.players = new Map();
    this.out = [];
    this.time = 0;
    this.reset();
  }

  emit(to, msg) { this.out.push([to, msg]); }

  reset() {
    Object.assign(this, { open: new Set(), zombies: new Map(), nextZ: 1, round: 0, phase: 'break', timer: 3, toSpawn: 0, spawnCd: 0, fieldCd: 0, fields: new Map() });
    this.emit('*', { t: 'reset' });
    for (const p of this.players.values()) this.respawn(p, true);
  }

  respawn(p, fresh) {
    const i = [...this.players.keys()].indexOf(p.id);
    Object.assign(p, { x: this.map.start.x + (i % 2) * 1.2, y: 0, z: this.map.start.z + (i >> 1) * 1.2, hp: 100, maxHp: 100, perks: [], down: false, dead: false, bleed: 0, rev: 0, selfRev: 0, lastHurt: -99 });
    if (fresh) Object.assign(p, { points: POINTS.start, kills: 0, heads: 0, downs: 0 });
    this.emit(p.id, { t: 'respawn', x: p.x, z: p.z });
  }

  addPlayer(id, name) {
    if (this.players.size >= MAX_PLAYERS || this.players.has(id)) return false;
    const p = { id, name: String(name || 'Survivor').slice(0, 16), yaw: 0, pitch: 0, use: false, w: 'pistol' };
    this.players.set(id, p);
    this.respawn(p, true);
    return true;
  }

  removePlayer(id) { this.players.delete(id); this.fields.delete(id); }

  handle(id, m) {
    const p = this.players.get(id);
    if (!p || !m || typeof m !== 'object') return;
    if (m.t === 'state') {
      if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return;
      if (!p.down && !p.dead) Object.assign(p, { x: m.x, y: m.y, z: m.z });
      Object.assign(p, { yaw: m.yaw, pitch: m.pitch, use: !!m.use, w: WEAPONS[m.w] ? m.w : 'pistol' });
    } else if (m.t === 'hit') this.hit(p, m);
    else if (m.t === 'buy') this.buy(p, m);
    else if (m.t === 'restart' && id === this.hostId && this.phase === 'over') this.reset();
  }

  hit(p, m) {
    const z = this.zombies.get(m.z);
    if (!z || p.down || p.dead) return;
    z.hp -= Math.min(Math.max(+m.dmg || 0, 0), 5000); // shortcut: trusts the client's hit test; fine among friends
    if (z.hp > 0) { p.points += POINTS.hit; return; }
    p.points += m.melee ? POINTS.melee : m.head ? POINTS.head : POINTS.kill;
    p.kills++;
    if (m.head) p.heads++;
    this.zombies.delete(z.id);
    this.emit('*', { t: 'zdie', id: z.id, head: !!m.head });
  }

  buy(p, m) {
    const it = INTERACT.find(i => i.id === m.id);
    if (!it || p.down || p.dead) return;
    const pos = interactPos(this.map, it);
    if (Math.hypot(p.x - pos.x, p.z - pos.z) > useRange(it) + 1) return;
    const have = Array.isArray(m.have) ? m.have : [];
    let cost, done;
    if (it.type === 'door') {
      if (this.open.has(it.door)) return;
      cost = DOORS[it.door].cost;
      done = () => { this.open.add(it.door); this.fieldCd = 0; this.emit('*', { t: 'door', door: it.door }); };
    } else if (it.type === 'wall') {
      cost = have.includes(it.weapon) ? Math.floor(WEAPONS[it.weapon].cost / 2) : WEAPONS[it.weapon].cost;
      done = () => this.emit(p.id, { t: 'give', w: it.weapon });
    } else if (it.type === 'perk') {
      if (p.perks.includes(it.perk)) return;
      const pk = PERKS[it.perk];
      cost = this.players.size > 1 && pk.coopCost ? pk.coopCost : pk.cost;
      done = () => {
        p.perks.push(it.perk);
        if (it.perk === 'ironhide') p.hp = p.maxHp = 250;
        this.emit(p.id, { t: 'perk', perk: it.perk });
      };
    } else {
      cost = CRATE_COST;
      done = () => this.emit(p.id, { t: 'crate', w: rollCrate(have, this.rnd()) });
    }
    if (p.points < cost) return this.emit(p.id, { t: 'deny' });
    p.points -= cost;
    done();
  }

  tick(dt) {
    this.time += dt;
    if (this.phase === 'over' || !this.players.size) return;
    if (this.phase === 'break') { if ((this.timer -= dt) <= 0) this.startRound(); }
    else this.spawnTick(dt);
    this.zombieTick(dt);
    this.playerTick(dt);
    if ([...this.players.values()].every(p => p.dead || (p.down && !(p.selfRev > 0)))) {
      this.phase = 'over';
      this.emit('*', { t: 'over', round: this.round });
    }
  }

  startRound() {
    this.round++;
    Object.assign(this, { phase: 'round', toSpawn: zombieCount(this.round, this.players.size), spawnCd: 1, zhp: zombieHealth(this.round) });
    for (const p of this.players.values()) if (p.dead) this.respawn(p, false);
    this.emit('*', { t: 'round', round: this.round });
  }

  spawnTick(dt) {
    if (this.toSpawn > 0 && this.zombies.size < MAX_ALIVE && (this.spawnCd -= dt) <= 0) {
      this.spawnZombie();
      this.toSpawn--;
      this.spawnCd = Math.max(0.5, 2 - this.round * 0.1);
    }
    if (this.toSpawn === 0 && this.zombies.size === 0) {
      Object.assign(this, { phase: 'break', timer: BREAK });
      this.emit('*', { t: 'roundEnd', round: this.round });
    }
  }

  // Spawn in an unlocked area, at one of the spawns nearest a random living player.
  spawnZombie() {
    const reach = flowField(this.map, this.open, this.map.start.x, this.map.start.z);
    const live = [...this.players.values()].filter(p => !p.down && !p.dead);
    const t = live.length ? live[Math.floor(this.rnd() * live.length)] : this.map.start;
    const spots = this.map.spawns
      .filter(([cx, cy]) => reach[cy * this.map.w + cx] >= 0)
      .map(s => [s, Math.hypot(cellCenter(...s).x - t.x, cellCenter(...s).z - t.z)])
      .sort((a, b) => a[1] - b[1]);
    const [cx, cy] = spots[Math.floor(this.rnd() * Math.min(3, spots.length))][0];
    const c = cellCenter(cx, cy), id = this.nextZ++;
    this.zombies.set(id, { id, x: c.x + this.rnd() - 0.5, z: c.z + this.rnd() - 0.5, yaw: 0, hp: this.zhp, kind: zombieSpeed(this.round, this.rnd()), atk: 0, rise: 1.2 });
  }

  zombieTick(dt) {
    const targets = [...this.players.values()].filter(p => !p.down && !p.dead);
    if ((this.fieldCd -= dt) <= 0) {
      this.fieldCd = 0.3;
      this.fields = new Map(targets.map(p => [p.id, flowField(this.map, this.open, p.x, p.z)]));
    }
    const zs = [...this.zombies.values()];
    for (const z of zs) {
      z.atk = Math.max(0, z.atk - dt);
      if (z.rise > 0) { z.rise -= dt; continue; }
      const cell = toCell(z.z) * this.map.w + toCell(z.x);
      let tgt = null, best = Infinity;
      for (const p of targets) {
        const d = this.fields.get(p.id)?.[cell] ?? -1;
        if (d >= 0 && d < best) { best = d; tgt = p; }
      }
      if (!tgt) continue; // nobody reachable (everyone down): zombies wait
      const dist = Math.hypot(tgt.x - z.x, tgt.z - z.z);
      let gx = tgt.x, gz = tgt.z;
      if (!(dist < CELL * 2 && lineOfSight(this.map, this.open, z.x, z.z, tgt.x, tgt.z))) {
        const s = stepToward(this.map, this.open, this.fields.get(tgt.id), z.x, z.z);
        if (s) { gx = s.x; gz = s.z; }
      }
      const mx = gx - z.x, mz = gz - z.z, ml = Math.hypot(mx, mz);
      if (ml > 0.01) z.yaw = Math.atan2(mx, mz);
      if (dist > 0.9 && ml > 0.01) {
        const step = Math.min(ZOMBIE_SPEEDS[z.kind] * dt, ml);
        z.x += mx / ml * step; z.z += mz / ml * step;
      }
      if (dist < 1.25 && z.atk === 0) { z.atk = 1; this.hurt(tgt); }
    }
    for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
      const a = zs[i], b = zs[j], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d > 0.001 && d < 0.7 && !(a.rise > 0) && !(b.rise > 0)) {
        const push = (0.7 - d) / 2 / d;
        a.x -= dx * push; a.z -= dz * push; b.x += dx * push; b.z += dz * push;
      }
    }
    for (const z of zs) [z.x, z.z] = collide(this.map, this.open, z.x, z.z, 0.35);
  }

  hurt(p) {
    p.hp -= HIT;
    p.lastHurt = this.time;
    this.emit(p.id, { t: 'hurt' });
    if (p.hp > 0) return;
    Object.assign(p, { down: true, hp: 0, bleed: BLEED, rev: 0, downs: p.downs + 1, maxHp: 100, points: p.points - Math.floor(p.points * 0.05) });
    p.selfRev = this.players.size === 1 && p.perks.includes('secondwind') ? SELF_REVIVE : 0;
    p.perks = [];
    this.emit('*', { t: 'down', id: p.id, name: p.name });
  }

  revive(p) {
    Object.assign(p, { down: false, selfRev: 0, rev: 0, hp: p.maxHp, lastHurt: this.time });
    this.emit('*', { t: 'revived', id: p.id, name: p.name });
  }

  playerTick(dt) {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (!p.down) {
        if (this.time - p.lastHurt > REGEN_DELAY) p.hp = Math.min(p.maxHp, p.hp + 100 * dt);
        continue;
      }
      if (p.selfRev > 0) { if ((p.selfRev -= dt) <= 0) this.revive(p); continue; }
      const helper = [...this.players.values()].find(q => q !== p && !q.down && !q.dead && q.use && Math.hypot(q.x - p.x, q.z - p.z) < 2.2);
      p.rev = helper ? p.rev + dt / (helper.perks.includes('secondwind') ? 1.5 : 3) : 0;
      if (p.rev >= 1) { this.revive(p); continue; }
      if (!helper && (p.bleed -= dt) <= 0) {
        Object.assign(p, { dead: true, down: false });
        this.emit('*', { t: 'dead', id: p.id, name: p.name });
      }
    }
  }

  snapshot() {
    const r2 = v => Math.round(v * 100) / 100;
    return {
      t: 'snap', r: this.round, ph: this.phase, d: [...this.open].join(''),
      z: [...this.zombies.values()].map(z => [z.id, r2(z.x), r2(z.z), r2(z.yaw), z.kind, z.atk > 0.7 ? 1 : 0]),
      p: [...this.players.values()].map(p => ({
        id: p.id, n: p.name, x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw), pitch: r2(p.pitch),
        hp: Math.ceil(p.hp), mhp: p.maxHp, pk: p.perks, pts: p.points, dn: p.down, dd: p.dead,
        rev: r2(p.rev), bl: Math.ceil(p.bleed), sr: p.selfRev > 0, w: p.w, k: p.kills, hs: p.heads, ds: p.downs,
      })),
    };
  }
}
