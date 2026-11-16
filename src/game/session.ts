// One running match. The same class drives three roles:
//   solo  - an authoritative simulation with nobody connected
//   host  - authoritative simulation that also applies guests' commands and broadcasts snapshots
//   guest - predicts its own player locally, interpolates everything else from host snapshots
import { Btn, CMD_LEN, decodeSnap, type Game, type MapInfo, type Sim, type Snap } from '../core/sim';
import { SnapshotBuffer, type Pose } from '../netcode/interp';
import type { GuestLobby, HostLobby, StartMsg } from '../netcode/lobby';
import { MODES, rulesToFloats } from './rules';
import { Predictor } from '../netcode/predict';
import type { Input } from '../engine/input';

export const TICK = 1 / 60;
/** Snapshots go out every third tick (20 Hz). */
const SNAP_EVERY = 3;
// Half a second of input; anything beyond that is a stalled or misbehaving client.
const MAX_QUEUED_CMDS = 30;

export interface View { pos: [number, number, number]; yaw: number; pitch: number; roll: number; fov: number }

export class Session {
  readonly game: Game;
  readonly mapInfo: MapInfo;
  readonly boxes: Float32Array;
  readonly inter: Float32Array;
  readonly isGuest: boolean;
  /** Latest world state (host: this tick's; guest: newest received). */
  snap: Snap | null = null;
  /** Called for every simulation event (8 floats, see `EV_*` in game.rs). */
  onEvent: (e: Float32Array) => void = () => {};
  yaw = 0;
  pitch = 0;
  /** Recoil still to be recovered when the trigger is released. */
  private recoil = 0;
  private acc = 0;
  private seq = 0;
  private tickCount = 0;
  private prevPos: number[] = [0, 0, 0];
  private curPos: number[] = [0, 0, 0];
  private buffer: SnapshotBuffer;
  private predictor: Predictor | null = null;
  private queues = new Map<number, Float32Array[]>();
  private outEvents: number[] = [];
  private spawned = false;
  private fovBase = 90;

  constructor(private sim: Sim, readonly start: StartMsg, readonly selfId: number, private host: HostLobby | null, private guest: GuestLobby | null) {
    this.isGuest = !!guest;
    this.game = sim.newGame(start.map, start.mode, start.seed, !this.isGuest);
    this.game.setRules(rulesToFloats(start.rules));
    this.game.setLocal(selfId);
    this.mapInfo = this.game.mapInfo();
    this.boxes = this.game.boxes();
    this.inter = this.game.interactables();
    this.buffer = new SnapshotBuffer(sim.L);
    if (!this.isGuest) {
      for (const p of start.players) this.game.addPlayer(p.id, p.team, this.loadout(p.loadout));
      this.faceSpawn();
    }
    if (host) {
      host.onCmd = (id, cmd) => {
        if (cmd.length !== CMD_LEN) return;
        const q = this.queues.get(id) ?? [];
        if (q.length < MAX_QUEUED_CMDS) q.push(cmd);
        this.queues.set(id, q);
      };
      host.onLeave = id => { this.game.removePlayer(id); this.queues.delete(id); };
      host.onTeam = (id, team) => this.game.setTeam(id, team);
      host.onLateJoin = (id, loadout, look) => {
        // Late joiners in team modes go to the smaller team (the core picks it).
        this.game.addPlayer(id, MODES[start.mode]?.teams ? -1 : id, this.loadout(loadout));
        const team = this.game.playerState(id)[sim.L.P.team] ?? id;
        host.sendStart(id, { ...this.start, players: [...this.start.players, { id, team, loadout, look }] });
      };
    }
    if (guest) guest.onFrame = f => this.receive(f);
  }

  /** Asks to change sides mid-match. Guests ask the host; the host and solo players switch at once. */
  switchTeam(team: number): void {
    if (this.guest) this.guest.setTeam(team);
    else if (this.game.setTeam(this.selfId, team)) this.host?.recordTeam(this.selfId, team);
  }

  private loadout(l: number[]): number[] {
    const out = this.sim.defaultLoadout();
    return l.length === out.length ? l : out;
  }
  private now(): number { return performance.now() / 1000; }

  /** Our player's state: predicted on guests, authoritative on the host. */
  local(): Float32Array { return this.game.playerState(this.selfId); }

  private faceSpawn(): void {
    const s = this.local();
    if (!s.length) return;
    const { P } = this.sim.L;
    this.yaw = s[P['ctl.yaw']];
    this.pitch = 0;
    this.prevPos = this.curPos = Array.from(s.subarray(P['ctl.pos'], P['ctl.pos'] + 3));
  }

  /** Guest: a snapshot frame arrived from the host. Layout: [snapshot length, snapshot, events]. */
  private receive(frame: Float32Array): void {
    const n = frame[0];
    if (!(n > 0) || n + 1 > frame.length) return;
    const { P, V, H } = this.sim.L;
    const snap = decodeSnap(this.sim.L, frame.slice(1, 1 + n));
    if (!snap) return;
    if (this.buffer.push(snap, this.now())) {
      this.snap = snap;
      this.game.setDoors(snap.hdr[H.doors]);
      const mine = snap.players.find(p => p[P.id] === this.selfId);
      if (mine) {
        this.predictor ??= new Predictor(this.game, this.sim.L, this.selfId);
        this.predictor.reconcile(mine);
        if (!this.spawned) { this.spawned = true; this.faceSpawn(); }
      }
    }
    // Events are applied exactly once even if their snapshot arrived out of order.
    for (let o = 1 + n; o + V._len <= frame.length; o += V._len) this.dispatch(frame.subarray(o, o + V._len));
  }

  private dispatch(e: Float32Array): void {
    const { V } = this.sim.L;
    if (e[0] === V.spawn && e[1] === this.selfId) this.faceSpawn();
    this.onEvent(e);
  }

  private drainLocal(forward: boolean): void {
    const { V } = this.sim.L;
    const ev = this.game.events();
    for (let o = 0; o + V._len <= ev.length; o += V._len) {
      const e = ev.subarray(o, o + V._len);
      if (e[0] === V.local) this.applyLocal(e);
      else if (forward) this.outEvents.push(...e);
      this.dispatch(e);
    }
  }

  /** Camera kick for our own shots. Recoil is client-side: commands carry the resulting angles. */
  private applyLocal(e: Float32Array): void {
    if (e[1] !== 1) return;
    const s = this.local();
    const { P } = this.sim.L;
    const cur = s[P['arms.cur']];
    const [p, y] = this.sim.recoil(e[2], e[3] - 1, s[P['arms.ads']], s[P[`arms.guns${cur}.att`]]);
    this.pitch = Math.min(this.pitch + p, 1.55);
    this.yaw += y;
    this.recoil += p;
  }

  /** Advances the match by real time `dt`, running as many fixed ticks as fit. */
  update(dt: number, input: Input, zoom: number, paused: boolean): void {
    const [dyaw, dpitch] = input.look(zoom);
    if (!paused) {
      this.yaw += dyaw;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dpitch));
    }
    // Recoil settles back once the trigger is released.
    if (!(input.buttons & Btn.fire) && this.recoil > 0) {
      const back = Math.min(this.recoil, dt * 0.35);
      this.recoil -= back;
      this.pitch -= back;
    }
    this.predictor?.decay(dt);
    // Up to a second of catch-up after a stall, then drop time rather than spiral.
    this.acc = Math.min(this.acc + dt, 1);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick(input, paused);
    }
  }

  private tick(input: Input, paused: boolean): void {
    const [mx, mz] = paused ? [0, 0] : input.move();
    const cmd = new Float32Array(CMD_LEN);
    cmd.set([++this.seq, TICK, mx, mz, this.yaw, this.pitch, paused ? 0 : input.buttons, paused ? -1 : input.takeSlot(), this.buffer.renderTime(this.now())]);
    input.consumePresses();
    const { P } = this.sim.L;

    if (this.isGuest) {
      if (!this.predictor) return; // nothing to predict until the first snapshot
      this.predictor.predict(cmd);
      this.drainLocal(false);
      this.guest!.sendCmd(cmd);
    } else {
      this.game.cmd(this.selfId, cmd);
      for (const [id, q] of this.queues) {
        for (const c of q) this.game.cmd(id, c);
        q.length = 0;
      }
      this.game.step(TICK);
      this.drainLocal(true);
      const raw = this.game.snapshot();
      this.snap = decodeSnap(this.sim.L, raw) ?? this.snap;
      if (this.host && ++this.tickCount % SNAP_EVERY === 0) {
        const frame = new Float32Array(1 + raw.length + this.outEvents.length);
        frame[0] = raw.length;
        frame.set(raw, 1);
        frame.set(this.outEvents, 1 + raw.length);
        this.host.broadcastRt(frame);
        this.outEvents.length = 0;
      } else if (!this.host) {
        this.outEvents.length = 0;
      }
    }
    const s = this.local();
    this.prevPos = this.curPos;
    this.curPos = Array.from(s.subarray(P['ctl.pos'], P['ctl.pos'] + 3));
    if (Math.hypot(this.curPos[0] - this.prevPos[0], this.curPos[2] - this.prevPos[2]) > 3) this.prevPos = this.curPos;
  }

  /** Camera for this frame: eye position blended between ticks plus bob, dip and roll. */
  view(baseFov: number): View {
    this.fovBase = baseFov;
    const s = this.local();
    const { P } = this.sim.L;
    const a = this.acc / TICK;
    const err = this.predictor?.error ?? [0, 0, 0];
    const bob = s[P['ctl.bob_amp']] ?? 0, ph = s[P['ctl.bob_ph']] ?? 0;
    const eye = (s[P['ctl.eye']] ?? 1.6) + (s[P['ctl.dip']] ?? 0) + (s[P['ctl.step_off']] ?? 0) + Math.sin(ph * 2) * bob;
    const side = Math.cos(ph) * bob * 0.6;
    const pos: [number, number, number] = [
      this.prevPos[0] + (this.curPos[0] - this.prevPos[0]) * a + err[0] + Math.cos(this.yaw) * side,
      this.prevPos[1] + (this.curPos[1] - this.prevPos[1]) * a + err[1] + eye,
      this.prevPos[2] + (this.curPos[2] - this.prevPos[2]) * a + err[2] - Math.sin(this.yaw) * side,
    ];
    const downed = s[P.life] !== 0;
    if (downed) pos[1] -= 0.9;
    return { pos, yaw: this.yaw, pitch: this.pitch, roll: (s[P['ctl.roll']] ?? 0) + (downed ? 0.35 : 0), fov: this.fovBase + (s[P['ctl.fov']] ?? 0) };
  }

  /** Other players, interpolated on guests. */
  players(): Pose[] {
    const { P } = this.sim.L;
    if (this.isGuest) return this.buffer.players(this.buffer.renderTime(this.now())).filter(p => p.id !== this.selfId);
    return (this.snap?.players ?? []).filter(r => r[P.id] !== this.selfId).map(rec => ({ id: rec[P.id], x: rec[P['ctl.pos']], y: rec[P['ctl.pos'] + 1], z: rec[P['ctl.pos'] + 2], yaw: rec[P['ctl.yaw']], rec }));
  }
  zombies(): Pose[] {
    const { Z } = this.sim.L;
    if (this.isGuest) return this.buffer.zombies(this.buffer.renderTime(this.now()));
    return (this.snap?.zombies ?? []).map(rec => ({ id: rec[Z.id], x: rec[Z.pos], y: rec[Z.pos + 1], z: rec[Z.pos + 2], yaw: rec[Z.yaw], rec }));
  }

  dispose(): void {
    if (this.host) { this.host.onCmd = () => {}; this.host.onLeave = () => {}; this.host.onLateJoin = () => {}; }
    if (this.guest) this.guest.onFrame = () => {};
    this.game.free();
  }
}
