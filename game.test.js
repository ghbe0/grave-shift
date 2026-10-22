import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMap, flowField, collide, zombieHealth, zombieCount, rollCrate, INTERACT, interactPos, toCell, CELL } from './rules.js';
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
