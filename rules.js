// Shared game data and pure logic (no DOM, no three.js): used by the host sim, the client and the tests.
export const CELL = 3;      // metres per map cell
export const WALL_H = 4;

// # wall · . floor · P player start · z zombie spawn · A/B/C debris you pay to clear
const ROWS = [
  '############################',
  '#z......#z........z#......z#',
  '#.......#..........#.......#',
  '#.......A..........B.......#',
  '#...P...#....##....#.......#',
  '#.......#....##....#.......#',
  '#z......#..........#......z#',
  '####C#######################',
  '#..........................#',
  '#z.......####..####.......z#',
  '#..........................#',
  '############################',
];

export const DOORS = {
  A: { cost: 750, name: 'the Yard' },
  B: { cost: 1000, name: 'the Lab' },
  C: { cost: 1250, name: 'the Bunker' },
};

export const WEAPONS = {
  pistol:  { name: 'P-9 Sidearm',   cost: 0,    dmg: 60,   hs: 2,   rpm: 400, auto: false, mag: 8,  res: 80,  reload: 1.5, spread: 0.012, pellets: 1, kick: 0.006 },
  carbine: { name: 'Field Carbine', cost: 500,  dmg: 120,  hs: 2,   rpm: 360, auto: false, mag: 10, res: 120, reload: 2.0, spread: 0.008, pellets: 1, kick: 0.008 },
  smg:     { name: 'Vespa SMG',     cost: 1000, dmg: 55,   hs: 1.8, rpm: 850, auto: true,  mag: 30, res: 180, reload: 2.0, spread: 0.03,  pellets: 1, kick: 0.003 },
  shotgun: { name: 'Breacher 12',   cost: 1500, dmg: 45,   hs: 1.5, rpm: 75,  auto: false, mag: 6,  res: 48,  reload: 2.8, spread: 0.09,  pellets: 8, kick: 0.03, ads: 0.7 },
  ar:      { name: 'Kestrel AR',    cost: 1400, dmg: 85,   hs: 2.2, rpm: 620, auto: true,  mag: 30, res: 210, reload: 2.2, spread: 0.018, pellets: 1, kick: 0.004 },
  lmg:     { name: 'Anvil LMG',     cost: 2500, dmg: 95,   hs: 2,   rpm: 650, auto: true,  mag: 75, res: 300, reload: 4.2, spread: 0.035, pellets: 1, kick: 0.004 },
  sniper:  { name: 'Longshot',      cost: 0,    dmg: 600,  hs: 3,   rpm: 50,  auto: false, mag: 5,  res: 40,  reload: 3.0, spread: 0.05,  pellets: 1, kick: 0.04, ads: 0.02, zoom: 25 },
  arc:     { name: 'Arc Caster',    cost: 0,    dmg: 2000, hs: 1,   rpm: 200, auto: false, mag: 12, res: 96,  reload: 2.5, spread: 0.004, pellets: 1, kick: 0.01, pierce: true },
};

export const PERKS = {
  ironhide:    { name: 'Ironhide',     cost: 2500, color: '#c0392b', icon: 'IH', desc: 'Take more hits before going down' },
  secondwind:  { name: 'Second Wind',  cost: 500, coopCost: 1500, color: '#2e86de', icon: 'SW', desc: 'Self-revive solo, faster revives in co-op' },
  quickhands:  { name: 'Quickhands',   cost: 3000, color: '#27ae60', icon: 'QH', desc: 'Reload twice as fast' },
  hairtrigger: { name: 'Hair Trigger', cost: 2000, color: '#f39c12', icon: 'HT', desc: 'Fire faster, hit harder' },
};

export const CRATE_COST = 950;
const CRATE_POOL = [['carbine', 1], ['smg', 1], ['shotgun', 1], ['ar', 1], ['lmg', 1], ['sniper', 1], ['arc', 0.4]];

// Everything a player can buy. Walls hang on the given side of a floor cell; perks and the crate occupy their cell.
export const INTERACT = [
  { id: 'dA', type: 'door', door: 'A' },
  { id: 'dB', type: 'door', door: 'B' },
  { id: 'dC', type: 'door', door: 'C' },
  { id: 'carbine', type: 'wall', weapon: 'carbine', cx: 1, cy: 3, side: 'W' },
  { id: 'smg', type: 'wall', weapon: 'smg', cx: 13, cy: 1, side: 'N' },
  { id: 'shotgun', type: 'wall', weapon: 'shotgun', cx: 11, cy: 6, side: 'S' },
  { id: 'ar', type: 'wall', weapon: 'ar', cx: 23, cy: 6, side: 'S' },
  { id: 'lmg', type: 'wall', weapon: 'lmg', cx: 8, cy: 10, side: 'S' },
  { id: 'secondwind', type: 'perk', perk: 'secondwind', cx: 7, cy: 1 },
  { id: 'quickhands', type: 'perk', perk: 'quickhands', cx: 18, cy: 6 },
  { id: 'hairtrigger', type: 'perk', perk: 'hairtrigger', cx: 20, cy: 1 },
  { id: 'ironhide', type: 'perk', perk: 'ironhide', cx: 26, cy: 10 },
  { id: 'crate', type: 'crate', cx: 26, cy: 3 },
];

export const POINTS = { start: 500, hit: 10, kill: 60, head: 100, melee: 130, nuke: 400 };

export const POWERUPS = {
  maxammo:   { name: 'MAX AMMO' },
  instakill: { name: 'INSTA-KILL' },
  double:    { name: 'DOUBLE POINTS' },
  nuke:      { name: 'NUKE' },
};
// Drops: 2% per kill, plus one each time the team's score passes a threshold that grows 14% per drop.
export const DROPS = { chance: 0.02, firstAt: 2000, growth: 1.14, perRound: 4, life: 30, effect: 30 };
export const NADE = { start: 2, perRound: 2, max: 4, fuse: 3, radius: 5.5 };

// Grenade flight: gravity, bounces off floor and walls (walls are treated as infinitely tall).
export function stepGrenade(map, open, g, dt) {
  g.vy -= 20 * dt;
  const nx = g.x + g.vx * dt;
  if (isSolid(map, toCell(nx), toCell(g.z), open)) g.vx *= -0.4; else g.x = nx;
  const nz = g.z + g.vz * dt;
  if (isSolid(map, toCell(g.x), toCell(nz), open)) g.vz *= -0.4; else g.z = nz;
  g.y += g.vy * dt;
  if (g.y > 0.08) return;
  g.y = 0.08;
  if (g.vy < -1.5) { g.vy *= -0.35; g.vx *= 0.6; g.vz *= 0.6; }
  else { g.vy = 0; const f = Math.max(0, 1 - 5 * dt); g.vx *= f; g.vz *= f; }
}
export const ZOMBIE_SPEEDS = [1.5, 3.4, 5.0]; // walk, run, sprint (m/s)

export const cellCenter = (cx, cy) => ({ x: (cx + 0.5) * CELL, z: (cy + 0.5) * CELL });
export const toCell = v => Math.floor(v / CELL);

export function parseMap(rows = ROWS) {
  const map = { w: rows[0].length, h: rows.length, rows, spawns: [], doorCells: {}, blockers: new Set(), start: null };
  rows.forEach((row, cy) => [...row].forEach((ch, cx) => {
    if (ch === 'P') map.start = cellCenter(cx, cy);
    else if (ch === 'z') map.spawns.push([cx, cy]);
    else if (DOORS[ch]) map.doorCells[ch] = [cx, cy];
  }));
  for (const it of INTERACT) if (it.type === 'perk' || it.type === 'crate') map.blockers.add(it.cy * map.w + it.cx);
  return map;
}

export function isSolid(map, cx, cy, open) {
  if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) return true;
  const ch = map.rows[cy][cx];
  if (ch === '#') return true;
  if (DOORS[ch]) return !open.has(ch);
  return map.blockers.has(cy * map.w + cx);
}

// Push a circle of radius r out of every solid cell around it.
export function collide(map, open, x, z, r) {
  for (let pass = 0; pass < 2; pass++) {
    const cx0 = toCell(x), cy0 = toCell(z);
    for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
      if (!isSolid(map, cx, cy, open)) continue;
      const x0 = cx * CELL, z0 = cy * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
      const px = Math.max(x0, Math.min(x, x1)), pz = Math.max(z0, Math.min(z, z1));
      const dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
      if (d >= r) continue;
      if (d > 1e-6) { x = px + dx / d * r; z = pz + dz / d * r; continue; }
      const m = Math.min(x - x0, x1 - x, z - z0, z1 - z); // centre inside the cell: leave by the nearest face
      if (m === x - x0) x = x0 - r; else if (m === x1 - x) x = x1 + r; else if (m === z - z0) z = z0 - r; else z = z1 + r;
    }
  }
  return [x, z];
}

const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIR8 = [...DIR4, [1, 1], [1, -1], [-1, 1], [-1, -1]];

// BFS distance (in cells) from the target's cell to every reachable cell; -1 = unreachable.
export function flowField(map, open, tx, tz) {
  const dist = new Int32Array(map.w * map.h).fill(-1);
  const sx = toCell(tx), sy = toCell(tz);
  if (sx < 0 || sy < 0 || sx >= map.w || sy >= map.h) return dist;
  const q = [sy * map.w + sx];
  dist[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i], cx = c % map.w, cy = (c / map.w) | 0;
    for (const [dx, dy] of DIR4) {
      if (isSolid(map, cx + dx, cy + dy, open)) continue;
      const n = (cy + dy) * map.w + cx + dx;
      if (dist[n] < 0) { dist[n] = dist[c] + 1; q.push(n); }
    }
  }
  return dist;
}

// Centre of the neighbouring cell that is closest to the target, or null when already there / unreachable.
export function stepToward(map, open, dist, x, z) {
  const cx = toCell(x), cy = toCell(z);
  if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) return null;
  const here = dist[cy * map.w + cx];
  let best = null, bd = here < 0 ? Infinity : here;
  for (const [dx, dy] of DIR8) {
    if (isSolid(map, cx + dx, cy + dy, open)) continue;
    if (dx && dy && (isSolid(map, cx + dx, cy, open) || isSolid(map, cx, cy + dy, open))) continue; // no corner cutting
    const d = dist[(cy + dy) * map.w + cx + dx];
    if (d >= 0 && d < bd) { bd = d; best = cellCenter(cx + dx, cy + dy); }
  }
  return best;
}

export function lineOfSight(map, open, x0, z0, x1, z1) {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.4);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (isSolid(map, toCell(x0 + (x1 - x0) * t), toCell(z0 + (z1 - z0) * t), open)) return false;
  }
  return true;
}

export function interactPos(map, it) {
  if (it.type === 'door') return cellCenter(...map.doorCells[it.door]);
  const c = cellCenter(it.cx, it.cy);
  if (it.type === 'wall') {
    const [dx, dz] = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] }[it.side];
    c.x += dx * (CELL / 2 - 0.02); c.z += dz * (CELL / 2 - 0.02);
  }
  return c;
}
export const useRange = it => ({ door: 3.2, wall: 2.2, perk: 2.6, crate: 2.6 })[it.type];

// Classic round-based rules: +100 health per round until round 10, then +10% per round.
export function zombieHealth(round) {
  let h = 150;
  for (let r = 2; r <= round; r++) h = r < 10 ? h + 100 : h + Math.floor(h * 0.1);
  return h;
}

export function zombieCount(round, players) {
  let mult = Math.max(1, round / 5);
  if (round >= 10) mult *= round * 0.15;
  const max = 24 + (players === 1 ? Math.floor(3 * mult) : Math.floor((players - 1) * 6 * mult));
  const early = [0.25, 0.3, 0.5, 0.7, 0.9][round - 1];
  return early ? Math.floor(max * early) : max;
}

// 0 walk, 1 run, 2 sprint — faster zombies show up as rounds climb.
export function zombieSpeed(round, rnd) {
  const rating = round * 8 + rnd * 20 - 10;
  return rating < 35 ? 0 : rating < 70 ? 1 : 2;
}

export function rollCrate(have, rnd) {
  const pool = CRATE_POOL.filter(([w]) => !have.includes(w));
  let pick = rnd * pool.reduce((s, [, wt]) => s + wt, 0);
  for (const [w, wt] of pool) if ((pick -= wt) < 0) return w;
  return pool[pool.length - 1][0];
}
