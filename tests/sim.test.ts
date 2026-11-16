import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Btn, CMD_LEN, decodeSnap, Sim } from '../src/core/sim';

let sim: Sim;
beforeAll(async () => { sim = await Sim.load(readFileSync('src/core/sim.wasm')); });

const cmd = (seq: number, mz: number, yaw: number, buttons: number) => { const c = new Float32Array(CMD_LEN); c.set([seq, 1 / 60, 0, mz, yaw, 0, buttons, -1, 0]); return c; };

describe('wasm core', () => {
  it('exposes the catalog and layout', () => {
    expect(sim.catalog.weapons.length).toBeGreaterThan(8);
    expect(sim.catalog.weapons[0].name).toBe('P-9 Sidearm');
    expect(sim.catalog.maps.map(m => m.name)).toEqual(['Foundry 9', 'Dry Dock']);
    expect(sim.catalog.maps[0].quests[0].steps.length).toBe(7);
    expect(sim.L.P.id).toBe(0);
    expect(sim.L.P['ctl.pos']).toBeGreaterThan(0);
    expect(sim.L.V.shot).toBe(1);
  });

  it('uses the two-stage zombie health curve', () => {
    expect(sim.zombieHealth(1)).toBe(150);
    expect(sim.zombieHealth(9)).toBe(950);
    expect(sim.zombieHealth(10)).toBeCloseTo(1045, 1);
    expect(sim.hordeCap(1)).toBe(24);
  });

  it('validates loadouts against the 10-point budget', () => {
    const l = sim.defaultLoadout();
    expect(sim.validateLoadout(l)).toBe(9);
    l[15] = 0; l[16] = 1; // two wildcards: 11 points
    expect(sim.validateLoadout(l)).toBeLessThan(0);
  });

  it('simulates, snapshots and decodes a match', () => {
    const g = sim.newGame(1, 0, 42, true);
    g.setLocal(0);
    g.addPlayer(0, 0, sim.defaultLoadout());
    for (let s = 0; s < 120; s++) { g.cmd(0, cmd(s, 1, Math.PI, Btn.sprint)); g.step(1 / 60); }
    const snap = decodeSnap(sim.L, g.snapshot())!;
    const { P, H } = sim.L;
    expect(snap.players.length).toBe(1);
    expect(snap.players[0][P.health]).toBe(100);
    expect(snap.players[0][P.ack]).toBe(119);
    expect(snap.hdr[H.mode]).toBe(0);
    expect(Math.hypot(snap.players[0][P['ctl.vel']], snap.players[0][P['ctl.vel'] + 2])).toBeGreaterThan(6);
    expect(g.boxes().length % 8).toBe(0);
    expect(g.mapInfo().barricades.length).toBe(6);
    g.free();
  });

  it('reconciles a predicted client to the host', () => {
    const host = sim.newGame(1, 1, 1, true);
    const client = sim.newGame(1, 1, 1, false);
    host.addPlayer(5, 0, sim.defaultLoadout());
    client.setPlayerState(host.playerState(5));
    client.setLocal(5);
    const pending: Float32Array[] = [];
    for (let s = 1; s <= 90; s++) {
      const c = cmd(s, 1, 0.5, Btn.sprint | (s === 30 ? Btn.jump : 0));
      client.cmd(5, c); pending.push(c);
      host.step(1 / 60);
      if (s <= 60) host.cmd(5, c); // host is 30 commands behind
    }
    const pos = sim.L.P['ctl.pos'];
    const predicted = client.playerState(5).slice(pos, pos + 3);
    // Rewind to the host's state, then replay what it has not seen yet.
    const auth = host.playerState(5);
    client.setPlayerState(auth);
    for (const c of pending) if (c[0] > auth[sim.L.P.ack]) client.cmd(5, c);
    const replayed = client.playerState(5).slice(pos, pos + 3);
    for (let i = 0; i < 3; i++) expect(replayed[i]).toBeCloseTo(predicted[i], 4);
    host.free(); client.free();
  });
});
