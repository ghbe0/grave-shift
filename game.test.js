import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMap, flowField, collide, zombieHealth, zombieCount, rollCrate, stepGrenade, INTERACT, interactPos, toCell, CELL } from './rules.js';
import { Sim } from './sim.js';

const map = parseMap();
const reach = open => flowField(map, open, map.start.x, map.start.z);
const reachable = (dist, x, z) => dist[toCell(z) * map.w + toCell(x)] >= 0;

test('round formulas match the classic tables', () => {
  assert.deepEqual([1, 2, 9, 10, 11].map(zombieHealth), [150, 250, 950, 1045, 1149]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(r => zombieCount(r, 1)), [6, 8, 13, 18, 24, 27]);
  assert.equal(zombieCount(1, 4), Math.floor((24 + 18) * 0.25));
});

test('map: doors gate areas, every spawn and buyable is reachable once all doors open', () => {
  assert.ok(map.start);
  assert.deepEqual(Object.keys(map.doorCells).sort(), ['A', 'B', 'C']);
  const bunker = { x: 1.5 * CELL, z: 9.5 * CELL };
  assert.equal(reachable(reach(new Set()), bunker.x, bunker.z), false);
  assert.equal(reachable(reach(new Set(['C'])), bunker.x, bunker.z), true);
  const all = reach(new Set(['A', 'B', 'C']));
  for (const [cx, cy] of map.spawns) assert.ok(all[cy * map.w + cx] >= 0, `spawn ${cx},${cy}`);
  for (const it of INTERACT.filter(i => i.type !== 'door')) {
    const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => all[(it.cy + dy) * map.w + it.cx + dx] >= 0);
    assert.ok(near, `${it.id} has a reachable neighbour`);
    assert.ok(interactPos(map, it));
  }
});

test('collide pushes a circle out of walls', () => {
  const [x, z] = collide(map, new Set(), 0.2 + CELL, 1.0 * CELL + 0.1, 0.4); // hugging the north wall of row 1
  assert.ok(z >= CELL + 0.4 - 1e-9);
  assert.ok(x > 0);
});

test('crate never hands out a weapon you already carry', () => {
  for (let i = 0; i < 50; i++) assert.notEqual(rollCrate(['smg'], i / 50), 'smg');
});

test('sim: solo round flow, points, doors, game over', () => {
  const sim = new Sim('host', () => 0.5);
  sim.addPlayer('host', 'Tester');
  const p = sim.players.get('host');
  const drain = () => sim.out.splice(0);
  drain();
  for (let i = 0; i < 40; i++) sim.tick(0.1);
  assert.equal(sim.round, 1);
  assert.ok(drain().some(([, m]) => m.t === 'round'));

  // Buying with too few points is refused, then works once we can afford it.
  sim.handle('host', { t: 'state', x: 7.5 * CELL, y: 0, z: 3.5 * CELL, yaw: 0, pitch: 0 }); // next to door A
  sim.handle('host', { t: 'buy', id: 'dB' }); // too far away: ignored
  assert.equal(drain().length, 0);
  sim.handle('host', { t: 'buy', id: 'dA' });
  assert.ok(drain().some(([, m]) => m.t === 'deny'));
  p.points = 800;
  sim.handle('host', { t: 'buy', id: 'dA' });
  assert.ok(sim.open.has('A'));
  assert.equal(p.points, 50);

  // The crate rolls a real weapon (not always the same one) and charges 950.
  p.points = 950;
  sim.handle('host', { t: 'state', x: 25.5 * CELL, y: 0, z: 3.5 * CELL, yaw: 0, pitch: 0 }); // cell next to the crate
  sim.handle('host', { t: 'buy', id: 'crate', have: ['pistol'] });
  const crate = drain().find(([, m]) => m.t === 'crate');
  assert.ok(crate && crate[1].w !== 'arc', `rnd 0.5 should land mid-pool, got ${crate?.[1].w}`);
  assert.equal(p.points, 0);

  // Kill every zombie in round 1 with headshots; the round ends and points add up.
  sim.handle('host', { t: 'state', x: map.start.x, y: 0, z: map.start.z, yaw: 0, pitch: 0 });
  p.points = 0;
  let kills = 0;
  const kinds = [];
  for (let i = 0; i < 2000 && sim.phase === 'round'; i++) {
    sim.tick(0.05);
    p.hp = p.maxHp; // keep the tester alive
    for (const z of sim.zombies.values()) { kinds.push(z.kind); sim.handle('host', { t: 'hit', z: z.id, dmg: 9999, head: true }); kills++; }
  }
  assert.equal(sim.phase, 'break');
  assert.equal(kills, 6);
  assert.deepEqual(kinds, [0, 0, 0, 0, 0, 0], 'round 1 zombies all walk');
  assert.equal(p.points, 600);

  // Going down solo without Second Wind ends the game.
  for (let i = 0; i < 2; i++) sim.hurt(p);
  sim.tick(0.01);
  assert.equal(sim.phase, 'over');
});

// A solo sim mid-round with zombies placed by hand.
function arena(rnd = () => 0.5) {
  const sim = new Sim('host', rnd);
  sim.addPlayer('host', 'T');
  const p = sim.players.get('host');
  Object.assign(sim, { phase: 'round', round: 1, toSpawn: 99 });
  const add = (x, z, hp = 150) => { const id = sim.nextZ++; sim.zombies.set(id, { id, x, z, yaw: 0, hp, kind: 0, atk: 0, rise: 99 }); return id; };
  sim.out.length = 0;
  return { sim, p, add };
}

test('grenades fly, bounce off walls, and blast zombies in the open but not behind walls', () => {
  const g = { x: 1.5 * CELL, y: 1, z: 2.5 * CELL, vx: -20, vy: 0, vz: 0 };
  for (let i = 0; i < 60; i++) stepGrenade(map, new Set(), g, 0.05);
  assert.ok(g.x > CELL, 'stayed inside the room');
  assert.equal(g.y, 0.08, 'came to rest on the floor');

  const { sim, p, add } = arena();
  Object.assign(p, { x: 4.5 * CELL, z: 5.5 * CELL });
  const near = add(4.5 * CELL + 1, 2.5 * CELL), far = add(4.5 * CELL, 2.5 * CELL + 4), walled = add(9.5 * CELL, 2.5 * CELL); // walled: other side of the barracks wall
  sim.handle('host', { t: 'nade', x: p.x, y: 1.5, z: p.z, vx: 0, vy: 0, vz: 0, fuse: 3 });
  assert.equal(p.nades, 1);
  sim.nades[0].x = 4.5 * CELL; sim.nades[0].z = 2.5 * CELL; // shortcut: drop it right between the zombies
  for (let i = 0; i < 70; i++) sim.tick(0.05);
  assert.ok(sim.out.some(([, m]) => m.t === 'boom'));
  assert.equal(sim.zombies.has(near), false);
  assert.equal(sim.zombies.get(far).hp, 150 - (75 + 225 * (1 - 4 / 5.5)));
  assert.equal(sim.zombies.get(walled).hp, 150);
  assert.equal(p.hp, 100, 'thrower was out of range');
  for (let i = 0; i < 5; i++) sim.handle('host', { t: 'nade', x: p.x, y: 1.5, z: p.z, vx: 0, vy: 0, vz: 0, fuse: 3 });
  assert.equal(sim.nades.length, 1, 'only the one grenade left could be thrown');

  const self = arena();
  self.sim.handle('host', { t: 'nade', x: self.p.x, y: 1.5, z: self.p.z, vx: 0, vy: 0, vz: 0, fuse: 0 });
  self.sim.tick(0.05);
  assert.equal(self.p.hp, 25, 'cooked in hand: 75 damage to yourself');
});

test('power-ups: drop by score, max 4 per round, and each effect works', () => {
  const { sim, p, add } = arena(() => 0.99); // never hit the 2% random roll
  for (let i = 0; i < 6; i++) { sim.score = sim.nextDrop; sim.handle('host', { t: 'hit', z: add(p.x + 10, p.z), dmg: 999 }); }
  assert.equal(sim.powerups.length, 4, 'capped at 4 drops per round');
  assert.deepEqual(new Set(sim.powerups.map(pu => pu.type)), new Set(['maxammo', 'instakill', 'double', 'nuke']));

  const grab = type => { const pu = sim.powerups.find(u => u.type === type); Object.assign(pu, { x: p.x, z: p.z }); sim.tick(0.01); };
  p.nades = 0;
  grab('maxammo');
  assert.equal(p.nades, 4);
  grab('double');
  p.points = 0;
  sim.handle('host', { t: 'hit', z: add(p.x + 10, p.z, 9999), dmg: 1 });
  assert.equal(p.points, 20, 'double points: 20 per hit');
  grab('instakill');
  const tough = add(p.x + 10, p.z, 99999);
  sim.handle('host', { t: 'hit', z: tough, dmg: 1, head: true });
  assert.equal(sim.zombies.has(tough), false, 'insta-kill: one hit kills');
  assert.equal(p.points, 20 + 200, 'headshot kill, doubled');
  add(p.x + 10, p.z); add(p.x + 12, p.z);
  p.points = 0;
  grab('nuke');
  assert.equal(sim.zombies.size, 0);
  assert.equal(p.points, 800, '400 nuke points, doubled');
  for (let i = 0; i < 31 * 20; i++) sim.effectsTick(0.05);
  assert.equal(sim.ik + sim.dp, 0, 'timed effects wear off after 30s');

  const { sim: s2, p: p2, add: add2 } = arena(() => 0.99);
  add2(p2.x + 10, p2.z);
  s2.handle('host', { t: 'hit', z: 1, dmg: 999 });
  assert.equal(s2.powerups.length, 0, 'no drop before the first score threshold');
});

test('sim: co-op revive and Second Wind self-revive', () => {
  const sim = new Sim('host', () => 0.5);
  sim.addPlayer('host', 'A');
  sim.addPlayer('g1', 'B');
  const [a, b] = [sim.players.get('host'), sim.players.get('g1')];
  sim.hurt(a); sim.hurt(a);
  assert.ok(a.down);
  sim.handle('g1', { t: 'state', x: a.x + 1, y: 0, z: a.z, yaw: 0, pitch: 0, use: true });
  for (let i = 0; i < 31; i++) sim.tick(0.1);
  assert.equal(a.down, false);
  assert.equal(b.down, false);

  const solo = new Sim('host', () => 0.5);
  solo.addPlayer('host', 'S');
  const s = solo.players.get('host');
  s.perks.push('secondwind');
  solo.hurt(s); solo.hurt(s);
  solo.tick(0.1);
  assert.notEqual(solo.phase, 'over');
  for (let i = 0; i < 90; i++) solo.tick(0.1);
  assert.equal(s.down, false);
  assert.deepEqual(s.perks, []);
});
