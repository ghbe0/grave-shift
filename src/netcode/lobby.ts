// Party lobby. The host owns the lobby state and is the only one who can change the map or mode,
// start the match, or remove players; guests receive the state and send their name, loadout and
// ready flag. The same two classes also relay match traffic (commands up, snapshots down).
import { generateCode } from './party';
import { NetError, type HostEndpoint, type Link, type Transport } from './transport';

export const PROTOCOL = 2;
export const MODES = [
  { id: 0, name: 'Survival', max: 4, desc: 'Co-op against endless rounds' },
  { id: 1, name: 'Skirmish', max: 8, desc: 'Free-for-all, first to 25' },
];

export interface LobbyPlayer { id: number; name: string; host: boolean; ready: boolean }
export interface LobbyState { code: string; players: LobbyPlayer[]; map: number; mode: number; inMatch: boolean }
export interface StartMsg { t: 'start'; map: number; mode: number; seed: number; players: { id: number; team: number; loadout: number[] }[] }
export type KickReason = 'kicked' | 'banned' | 'full' | 'version' | 'host-left';

interface Member { id: number; name: string; token: string; ready: boolean; loadout: number[]; link: Link | null }

const cleanName = (n: unknown) => (typeof n === 'string' ? n.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) : '') || 'Player';

export class HostLobby {
  onChange: (state: LobbyState) => void = () => {};
  /** A guest sent an input command during a match. */
  onCmd: (id: number, cmd: Float32Array) => void = () => {};
  /** A player left or was removed (also fires mid-match). */
  onLeave: (id: number) => void = () => {};
  /** A guest connected while a match is running. */
  onLateJoin: (id: number, loadout: number[]) => void = () => {};

  readonly selfId = 0;
  private members = new Map<number, Member>();
  private banned = new Set<string>();
  private nextId = 1;
  private map = 0;
  private mode = 0;
  private inMatch = false;

  private constructor(readonly code: string, private endpoint: HostEndpoint, name: string, loadout: number[], private mapCount: number) {
    this.members.set(0, { id: 0, name: cleanName(name), token: '', ready: true, loadout, link: null });
    endpoint.onLink = link => this.accept(link);
  }

  /** Creates a party, retrying with a fresh code if the generated one is already in use. */
  static async create(transport: Transport, name: string, loadout: number[], mapCount: number): Promise<HostLobby> {
    for (let attempt = 0; ; attempt++) {
      const code = generateCode();
      try {
        return new HostLobby(code, await transport.host(code), name, loadout, mapCount);
      } catch (e) {
        if (!(e instanceof NetError && e.kind === 'code-taken') || attempt >= 4) throw e;
      }
    }
  }

  get state(): LobbyState {
    return {
      code: this.code,
      players: [...this.members.values()].map(m => ({ id: m.id, name: m.name, host: m.id === 0, ready: m.ready })),
      map: this.map,
      mode: this.mode,
      inMatch: this.inMatch,
    };
  }
  get maxPlayers(): number { return MODES[this.mode].max; }

  private accept(link: Link) {
    let member: Member | null = null;
    const reject = (reason: KickReason) => { link.sendCtl({ t: 'kick', reason }); setTimeout(() => link.close(), 200); };
    link.onCtl = msg => {
      if (!msg || typeof msg !== 'object') return;
      if (!member) {
        if (msg.t !== 'hello') return;
        if (msg.v !== PROTOCOL) return reject('version');
        const token = String(msg.token ?? '').slice(0, 64);
        if (this.banned.has(token)) return reject('banned');
        if (this.members.size >= this.maxPlayers) return reject('full');
        member = { id: this.nextId++, name: this.uniqueName(cleanName(msg.name)), token, ready: false, loadout: this.loadoutOf(msg.loadout), link };
        this.members.set(member.id, member);
        link.sendCtl({ t: 'welcome', id: member.id, lobby: this.state });
        if (this.inMatch) this.onLateJoin(member.id, member.loadout);
        this.sync();
        return;
      }
      if (msg.t === 'ready') member.ready = !!msg.ready;
      else if (msg.t === 'loadout') member.loadout = this.loadoutOf(msg.loadout);
      else return;
      this.sync();
    };
    link.onRt = data => { if (member && this.inMatch) this.onCmd(member.id, data); };
    link.onClose = () => { if (member && this.members.get(member.id) === member) this.drop(member.id); };
  }

  private loadoutOf(l: unknown): number[] {
    return Array.isArray(l) ? l.slice(0, 32).map(v => (Number.isFinite(v) ? Math.trunc(v) : -1)) : [];
  }
  private uniqueName(name: string): string {
    const taken = new Set([...this.members.values()].map(m => m.name));
    let out = name;
    for (let n = 2; taken.has(out); n++) out = `${name} ${n}`;
    return out;
  }
  private drop(id: number) {
    if (!this.members.delete(id)) return;
    this.onLeave(id);
    this.sync();
  }
  private sync() {
    const state = this.state;
    this.broadcastCtl({ t: 'lobby', lobby: state });
    this.onChange(state);
  }
  private broadcastCtl(msg: unknown) { for (const m of this.members.values()) m.link?.sendCtl(msg); }

  setLoadout(loadout: number[]) { this.members.get(0)!.loadout = loadout; }
  setMap(map: number) { if (!this.inMatch && map >= 0 && map < this.mapCount) { this.map = map; this.sync(); } }
  setMode(mode: number) {
    if (this.inMatch || !MODES[mode]) return;
    this.mode = mode;
    // Shrinking the party size removes the most recent joiners.
    for (const m of [...this.members.values()].slice(MODES[mode].max)) this.remove(m.id, 'full');
    this.sync();
  }

  private remove(id: number, reason: KickReason) {
    const m = this.members.get(id);
    if (!m || id === 0) return;
    m.link?.sendCtl({ t: 'kick', reason });
    const link = m.link;
    setTimeout(() => link?.close(), 200);
    this.drop(id);
  }
  kick(id: number) { this.remove(id, 'kicked'); }
  /** Kicks and refuses the same browser from rejoining this party. */
  ban(id: number) {
    const m = this.members.get(id);
    if (m && id !== 0) { this.banned.add(m.token); this.remove(id, 'banned'); }
  }

  /** Starts the match for everyone in the lobby. */
  start(seed: number = (Math.random() * 2 ** 31) | 0): StartMsg {
    this.inMatch = true;
    const msg: StartMsg = { t: 'start', map: this.map, mode: this.mode, seed, players: [...this.members.values()].map(m => ({ id: m.id, team: m.id, loadout: m.loadout })) };
    this.broadcastCtl(msg);
    this.sync();
    return msg;
  }
  /** Sends a late joiner straight into the running match. */
  sendStart(id: number, msg: StartMsg) { this.members.get(id)?.link?.sendCtl(msg); }
  endMatch() {
    this.inMatch = false;
    for (const m of this.members.values()) if (m.id !== 0) m.ready = false;
    this.broadcastCtl({ t: 'end' });
    this.sync();
  }
  /** Snapshot + events frame to every guest. */
  broadcastRt(frame: Float32Array) { for (const m of this.members.values()) m.link?.sendRt(frame); }

  close() {
    this.broadcastCtl({ t: 'kick', reason: 'host-left' satisfies KickReason });
    setTimeout(() => this.endpoint.close(), 200);
  }
}

export class GuestLobby {
  onChange: (state: LobbyState) => void = () => {};
  onStart: (msg: StartMsg) => void = () => {};
  onEnd: () => void = () => {};
  onFrame: (frame: Float32Array) => void = () => {};
  /** The connection ended: kicked, banned, party full, or the host went away. */
  onGone: (reason: KickReason) => void = () => {};

  state!: LobbyState;
  selfId = -1;
  private gone = false;

  private constructor(private link: Link) {}

  static async join(transport: Transport, code: string, name: string, token: string, loadout: number[]): Promise<GuestLobby> {
    const link = await transport.join(code);
    const lobby = new GuestLobby(link);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { link.close(); reject(new NetError('timeout', 'The host did not answer')); }, 8000);
      const leave = (reason: KickReason) => {
        if (lobby.gone) return;
        lobby.gone = true;
        clearTimeout(timer);
        if (lobby.selfId < 0) reject(new NetError('network', reason)); else lobby.onGone(reason);
      };
      link.onCtl = msg => {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.t) {
          case 'welcome': lobby.selfId = msg.id; lobby.state = msg.lobby; clearTimeout(timer); resolve(lobby); break;
          case 'lobby': lobby.state = msg.lobby; lobby.onChange(msg.lobby); break;
          case 'start': lobby.onStart(msg); break;
          case 'end': lobby.onEnd(); break;
          case 'kick': leave(msg.reason); link.close(); break;
        }
      };
      link.onRt = data => lobby.onFrame(data);
      link.onClose = () => leave('host-left');
      link.sendCtl({ t: 'hello', v: PROTOCOL, name, token, loadout });
    });
  }

  setReady(ready: boolean) { this.link.sendCtl({ t: 'ready', ready }); }
  setLoadout(loadout: number[]) { this.link.sendCtl({ t: 'loadout', loadout }); }
  sendCmd(cmd: Float32Array) { this.link.sendRt(cmd); }
  close() { this.gone = true; this.link.close(); }
}

/** A per-browser id so a host's ban survives a page reload. Clearing site data resets it. */
export function clientToken(): string {
  try {
    let t = localStorage.getItem('gs.token');
    if (!t) { t = crypto.randomUUID(); localStorage.setItem('gs.token', t); }
    return t;
  } catch {
    return crypto.randomUUID();
  }
}
