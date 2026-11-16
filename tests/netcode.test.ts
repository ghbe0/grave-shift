import { describe, expect, it } from 'vitest';
import { decodeSnap, type Layout } from '../src/core/sim';
import { lerpAngle, SnapshotBuffer } from '../src/netcode/interp';
import { DEFAULT_LOOK } from '../src/game/look';
import { GuestLobby, HostLobby } from '../src/netcode/lobby';
import { codeFromUrl, generateCode, normalizeCode, partyLink } from '../src/netcode/party';
import { LocalTransport } from '../src/netcode/transport';

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

describe('party codes', () => {
  it('generates 6 unambiguous characters', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(new Set(Array.from({ length: 500 }, () => generateCode())).size).toBeGreaterThan(495);
  });
  it('normalises typed codes and rejects junk', () => {
    expect(normalizeCode(' abc-234 ')).toBe('ABC234');
    expect(normalizeCode('ABC12')).toBeNull();
    expect(normalizeCode('ABCO23')).toBeNull(); // O is not in the alphabet
    expect(normalizeCode(null)).toBeNull();
  });
  it('round-trips through the share link', () => {
    const link = partyLink('QWERTY', 'https://example.github.io/grave-shift/?foo=1#x');
    expect(link).toBe('https://example.github.io/grave-shift/?party=QWERTY');
    expect(codeFromUrl(link)).toBe('QWERTY');
    expect(codeFromUrl('https://example.github.io/grave-shift/')).toBeNull();
  });
});

describe('lobby', () => {
  const loadout = [3, 0, 4];
  it('lets guests join, sync, start a match and exchange frames', async () => {
    const t = new LocalTransport();
    const host = await HostLobby.create(t, 'Host', loadout, 2);
    const guest = await GuestLobby.join(t, host.code, 'Ann', 'tok-a', loadout);
    expect(guest.selfId).toBe(1);
    expect(guest.state.players.map(p => p.name)).toEqual(['Host', 'Ann']);

    host.setMap(1);
    guest.setReady(true);
    await tick();
    expect(guest.state.map).toBe(1);
    expect(host.state.players[1].ready).toBe(true);
    host.setMap(9); // out of range: ignored
    expect(host.state.map).toBe(1);

    let started: unknown, frame: Float32Array | undefined, cmd: [number, Float32Array] | undefined;
    guest.onStart = m => (started = m);
    guest.onFrame = f => (frame = f);
    host.onCmd = (id, c) => (cmd = [id, c]);
    const msg = host.start(7);
    host.broadcastRt(new Float32Array([1, 2, 3]));
    await tick();
    guest.sendCmd(new Float32Array([9, 8]));
    await tick();
    expect(started).toEqual(msg);
    expect(msg.players.map(p => p.id)).toEqual([0, 1]);
    expect(Array.from(frame!)).toEqual([1, 2, 3]);
    expect(cmd![0]).toBe(1);
    expect(Array.from(cmd![1])).toEqual([9, 8]);
    host.close();
  });

  it('kicks, bans by token and enforces the party size', async () => {
    const t = new LocalTransport();
    const host = await HostLobby.create(t, 'Host', loadout, 2);
    const a = await GuestLobby.join(t, host.code, 'Ann', 'tok-a', loadout);
    let gone = '';
    a.onGone = r => (gone = r);
    const left: number[] = [];
    host.onLeave = id => left.push(id);
    host.ban(a.selfId);
    await tick(300);
    expect(gone).toBe('banned');
    expect(left).toEqual([1]);
    expect(host.state.players.length).toBe(1);
    await expect(GuestLobby.join(t, host.code, 'Ann again', 'tok-a', loadout)).rejects.toThrow('banned');

    // Survival holds four: the fifth is turned away.
    for (const n of ['B', 'C', 'D']) await GuestLobby.join(t, host.code, n, `tok-${n}`, loadout);
    await expect(GuestLobby.join(t, host.code, 'E', 'tok-e', loadout)).rejects.toThrow('full');
    // Duplicate names are disambiguated; a guest leaving is noticed.
    host.kick(2);
    await tick(300);
    const dup = await GuestLobby.join(t, host.code, 'Host', 'tok-f', loadout);
    expect(dup.state.players.at(-1)!.name).toBe('Host 2');
    dup.close();
    await tick();
    expect(host.state.players.some(p => p.name === 'Host 2')).toBe(false);
    host.close();
  });
});

describe('snapshot interpolation', () => {
  // A minimal layout: header [time, n_players, n_zombies, n_ents, n_barrs], zombie [id, x, y, z, yaw].
  const L = { H: { time: 0, n_players: 1, n_zombies: 2, n_ents: 3, n_barrs: 4, _len: 5 }, P: { id: 0, 'ctl.pos': 1, 'ctl.yaw': 4, _len: 5 }, Z: { id: 0, pos: 1, yaw: 4, _len: 5 }, E: { _len: 1 }, V: {} } as unknown as Layout;
  const snap = (time: number, x: number, yaw: number) => decodeSnap(L, new Float32Array([time, 0, 1, 0, 0, 7, x, 0, 0, yaw]))!;

  it('blends between snapshots at the delayed render time', () => {
    const buf = new SnapshotBuffer(L);
    buf.push(snap(10.0, 0, 3.0), 100.0);
    buf.push(snap(10.05, 1, -3.0), 100.05);
    const rt = buf.renderTime(100.125); // host 10.125 minus the 0.1 delay
    expect(rt).toBeCloseTo(10.025, 5);
    const z = buf.zombies(rt)[0];
    expect(z.id).toBe(7);
    expect(z.x).toBeCloseTo(0.5, 4);
    expect(Math.abs(z.yaw)).toBeGreaterThan(3.0); // took the short way across +-pi
  });
  it('drops stale snapshots and holds the last pose', () => {
    const buf = new SnapshotBuffer(L);
    expect(buf.push(snap(5, 0, 0), 0)).toBe(true);
    expect(buf.push(snap(4, 9, 0), 0.1)).toBe(false);
    expect(buf.zombies(99)[0].x).toBe(0);
    expect(lerpAngle(0, Math.PI * 2 + 0.2, 0.5)).toBeCloseTo(0.1, 5);
  });
});

describe('hostile peers', () => {
  const loadout = [3, 0, 4];

  it('a guest cleans whatever a hostile host sends', async () => {
    const t = new LocalTransport();
    const code = 'EVIL23';
    const ep = await t.host(code);
    let sendStart: (m: unknown) => void = () => {};
    ep.onLink = link => {
      link.onCtl = msg => {
        if (msg?.t !== 'hello') return;
        link.sendCtl({
          t: 'welcome',
          id: 4,
          lobby: { code: '<b>x</b>', players: [{ id: '1" onclick="x', name: '<img src=x onerror=alert(1)>', host: 'yes', ready: 1, look: { camo: 99, vest: -1, card: '<x>', emblem: 2 } }], map: 1e9, mode: -5, inMatch: 'true' },
        });
        sendStart = m => link.sendCtl(m);
      };
    };
    const guest = await GuestLobby.join(t, code, 'Ann', 'tok', loadout);
    expect(guest.selfId).toBe(4);
    expect(guest.state).toEqual({ code: 'BXB', players: [{ id: 0, name: 'img srcx onerror', host: false, ready: false, look: { ...DEFAULT_LOOK, emblem: 2 } }], map: 0, mode: 0, inMatch: false });
    let started: unknown;
    guest.onStart = m => (started = m);
    sendStart({ t: 'start', map: 'x', mode: 99, seed: NaN, players: [{ id: -1, team: 'a', loadout: ['x', 1e9, 3] }, ...Array(50).fill({})] });
    await tick();
    expect(started).toMatchObject({ t: 'start', map: 0, mode: 0, seed: 1 });
    const s = started as { players: { id: number; team: number; loadout: number[] }[] };
    expect(s.players.length).toBe(16);
    expect(s.players[0]).toEqual({ id: 0, team: 0, loadout: [-1, -1, 3], look: DEFAULT_LOOK });
    guest.close();
    ep.close();
  });

  it('a guest who floods the host with messages is dropped, then kicked', async () => {
    const t = new LocalTransport();
    const host = await HostLobby.create(t, 'Host', loadout, 2);
    const flooder = await GuestLobby.join(t, host.code, 'Spam', 'tok-s', loadout);
    const calm = await GuestLobby.join(t, host.code, 'Calm', 'tok-c', loadout);
    let syncs = 0;
    host.onChange = () => syncs++;
    let gone = '';
    flooder.onGone = r => (gone = r);
    for (let i = 0; i < 500; i++) flooder.setReady(i % 2 === 0);
    await tick(400);
    expect(gone).toBe('kicked');
    expect(syncs).toBeLessThan(40); // the burst allowance, then nothing until the kick
    expect(host.state.players.map(p => p.name)).toEqual(['Host', 'Calm']);
    calm.setReady(true);
    await tick();
    expect(host.state.players[1].ready).toBe(true);
    host.close();
  });

  it('a snapshot whose counts do not fit its size is rejected', () => {
    const L = { H: { time: 0, n_players: 1, n_zombies: 2, n_ents: 3, n_barrs: 4, _len: 5 }, P: { _len: 5 }, Z: { _len: 5 }, E: { _len: 1 }, V: {} } as unknown as Layout;
    expect(decodeSnap(L, new Float32Array([1, 0, 1e9, 0, 0]))).toBeNull();
    expect(decodeSnap(L, new Float32Array([1, 0, 1, 0, 0]))).toBeNull(); // claims a zombie it does not carry
    expect(decodeSnap(L, new Float32Array([1, 0, 0.5, 0, 0]))).toBeNull();
    expect(decodeSnap(L, new Float32Array([1, -1, 0, 0, 0]))).toBeNull();
    expect(decodeSnap(L, new Float32Array([1]))).toBeNull();
    expect(decodeSnap(L, new Float32Array([1, 0, 1, 0, 0, 7, 0, 0, 0, 0]))?.zombies.length).toBe(1);
  });
});

describe('renaming', () => {
  it('guests and the host can rename at any time; names stay clean and unique', async () => {
    const t = new LocalTransport();
    const host = await HostLobby.create(t, 'Host', [3], 2);
    const ann = await GuestLobby.join(t, host.code, 'Ann', 'tok-a', [3]);
    const bob = await GuestLobby.join(t, host.code, 'Bob', 'tok-b', [3]);
    ann.setName('  Annie <3  ');
    await tick();
    expect(host.state.players.map(p => p.name)).toEqual(['Host', 'Annie 3', 'Bob']);
    bob.setName('Annie 3');
    await tick();
    expect(bob.state.players.map(p => p.name)).toEqual(['Host', 'Annie 3', 'Annie 3 2']);
    // Renaming to your own current name keeps it as it is (no " 2" suffix).
    ann.setName('Annie 3');
    host.setName('Captain');
    await tick();
    expect(ann.state.players.map(p => p.name)).toEqual(['Captain', 'Annie 3', 'Annie 3 2']);
    // Renames work mid-match too.
    host.start(1);
    bob.setName('Robert');
    await tick();
    expect(ann.state.players[2].name).toBe('Robert');
    host.close();
  });
});

describe('customization over the network', () => {
  it('guests see each other\'s looks, and changes arrive mid-lobby', async () => {
    const t = new LocalTransport();
    const host = await HostLobby.create(t, 'Host', [3], 2, { ...DEFAULT_LOOK, camo: 7, card: 3 });
    const ann = await GuestLobby.join(t, host.code, 'Ann', 'tok-a', [3], { ...DEFAULT_LOOK, vest: 2, headgear: 3 });
    expect(ann.state.players[0].look).toMatchObject({ camo: 7, card: 3 });
    expect(host.state.players[1].look).toMatchObject({ vest: 2, headgear: 3 });
    ann.setLook({ ...DEFAULT_LOOK, camo: 4, emblem: 5 });
    await tick();
    expect(host.state.players[1].look).toMatchObject({ camo: 4, emblem: 5, vest: 0 });
    const msg = host.start(1);
    expect(msg.players.map(p => p.look.camo)).toEqual([7, 4]);
    host.close();
  });
});
