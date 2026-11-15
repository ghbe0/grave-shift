// Transports carry two logical channels between a party host and each guest:
//   ctl - reliable, ordered JSON (lobby, match start, kicks)
//   rt  - binary Float32 frames (input commands up, snapshots down)
// `PeerTransport` is the real one (WebRTC DataChannels brokered by the public PeerJS server).
// `LocalTransport` uses BroadcastChannel between tabs of one browser, for development and tests.
import type { DataConnection, Peer as PeerType } from 'peerjs';
import { peerIdFor } from './party';

export interface Link {
  /** Stable id of the remote end for this connection. */
  readonly remote: string;
  sendCtl(msg: unknown): void;
  sendRt(data: Float32Array): void;
  close(): void;
  onCtl: (msg: any) => void;
  onRt: (data: Float32Array) => void;
  onClose: () => void;
}

export interface HostEndpoint {
  onLink: (link: Link) => void;
  close(): void;
}

export interface Transport {
  /** Claims a party code. Rejects with `code-taken` if someone already hosts it. */
  host(code: string): Promise<HostEndpoint>;
  /** Connects to the party's host. Rejects with `not-found` or `timeout`. */
  join(code: string): Promise<Link>;
}

export class NetError extends Error {
  constructor(readonly kind: 'code-taken' | 'not-found' | 'timeout' | 'network', message: string) { super(message); }
}

const noop = () => {};
const JOIN_TIMEOUT = 15000;

class PeerLink implements Link {
  onCtl: (msg: any) => void = noop;
  onRt: (data: Float32Array) => void = noop;
  onClose: () => void = noop;
  private closed = false;
  constructor(readonly remote: string, private ctl: DataConnection, private rt: DataConnection) {
    ctl.on('data', d => this.onCtl(d));
    rt.on('data', d => { if (d instanceof ArrayBuffer && d.byteLength % 4 === 0) this.onRt(new Float32Array(d)); });
    for (const c of [ctl, rt]) { c.on('close', () => this.drop()); c.on('error', () => this.drop()); }
  }
  private drop() { if (!this.closed) { this.closed = true; this.ctl.close(); this.rt.close(); this.onClose(); } }
  sendCtl(msg: unknown) { if (this.ctl.open) this.ctl.send(msg); }
  sendRt(data: Float32Array) {
    // Skip frames rather than queue behind a congested channel: newer state supersedes older.
    if (this.rt.open && (this.rt.dataChannel?.bufferedAmount ?? 0) < 256 * 1024) this.rt.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  close() { this.drop(); }
}

/** WebRTC via PeerJS. The broker only introduces peers; game traffic flows directly between browsers. */
export class PeerTransport implements Transport {
  private async peer(id?: string): Promise<PeerType> {
    const { Peer } = await import('peerjs');
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id) : new Peer();
      peer.on('open', () => resolve(peer));
      peer.on('error', e => {
        peer.destroy();
        reject(new NetError(e.type === 'unavailable-id' ? 'code-taken' : 'network', e.message));
      });
    });
  }

  async host(code: string): Promise<HostEndpoint> {
    const peer = await this.peer(peerIdFor(code));
    const pending = new Map<string, DataConnection>();
    const endpoint: HostEndpoint = { onLink: noop, close: () => peer.destroy() };
    peer.on('connection', conn => {
      conn.on('open', () => {
        // Each guest opens a ctl and an rt connection; pair them up by peer id.
        const other = pending.get(conn.peer);
        if (!other || other.label === conn.label) { pending.set(conn.peer, conn); return; }
        pending.delete(conn.peer);
        const [ctl, rt] = conn.label === 'ctl' ? [conn, other] : [other, conn];
        endpoint.onLink(new PeerLink(conn.peer, ctl, rt));
      });
    });
    // If the broker connection drops mid-session, existing links keep working; try to get it back
    // so new guests can still find the party.
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    return endpoint;
  }

  async join(code: string): Promise<Link> {
    const peer = await this.peer();
    return new Promise((resolve, reject) => {
      const fail = (e: NetError) => { clearTimeout(timer); peer.destroy(); reject(e); };
      const timer = setTimeout(() => fail(new NetError('timeout', 'Timed out reaching the host')), JOIN_TIMEOUT);
      peer.on('error', e => fail(new NetError(e.type === 'peer-unavailable' ? 'not-found' : 'network', e.message)));
      const target = peerIdFor(code);
      const ctl = peer.connect(target, { label: 'ctl', reliable: true, serialization: 'json' });
      const rt = peer.connect(target, { label: 'rt', reliable: false, serialization: 'raw' });
      let open = 0;
      const ready = () => {
        if (++open < 2) return;
        clearTimeout(timer);
        const link = new PeerLink(target, ctl, rt);
        ctl.on('close', () => peer.destroy());
        resolve(link);
      };
      ctl.on('open', ready);
      rt.on('open', ready);
    });
  }
}

interface LocalFrame { to: string; from: string; kind: 'join' | 'accept' | 'ctl' | 'rt' | 'bye'; data?: unknown }

class LocalLink implements Link {
  onCtl: (msg: any) => void = noop;
  onRt: (data: Float32Array) => void = noop;
  onClose: () => void = noop;
  private closed = false;
  constructor(private ch: BroadcastChannel, private self: string, readonly remote: string) {}
  receive(f: LocalFrame) {
    if (this.closed) return;
    if (f.kind === 'ctl') this.onCtl(f.data);
    else if (f.kind === 'rt') this.onRt(f.data as Float32Array);
    else if (f.kind === 'bye') { this.closed = true; this.onClose(); }
  }
  private post(kind: LocalFrame['kind'], data?: unknown) { if (!this.closed) this.ch.postMessage({ to: this.remote, from: this.self, kind, data } satisfies LocalFrame); }
  sendCtl(msg: unknown) { this.post('ctl', msg); }
  sendRt(data: Float32Array) { this.post('rt', data.slice()); }
  close() { if (this.closed) return; this.post('bye'); this.closed = true; this.onClose(); }
}

/** Same-browser transport over BroadcastChannel. Select it with `?net=local`. */
export class LocalTransport implements Transport {
  private channel(code: string) { return new BroadcastChannel(`graveshift-party-${code}`); }

  async host(code: string): Promise<HostEndpoint> {
    const ch = this.channel(code);
    const links = new Map<string, LocalLink>();
    const endpoint: HostEndpoint = {
      onLink: noop,
      close: () => { links.forEach(l => l.close()); ch.close(); },
    };
    ch.onmessage = e => {
      const f = e.data as LocalFrame;
      if (f.to !== 'host') return;
      if (f.kind === 'join') {
        const link = new LocalLink(ch, 'host', f.from);
        links.set(f.from, link);
        ch.postMessage({ to: f.from, from: 'host', kind: 'accept' } satisfies LocalFrame);
        endpoint.onLink(link);
      } else {
        links.get(f.from)?.receive(f);
        if (f.kind === 'bye') links.delete(f.from);
      }
    };
    return endpoint;
  }

  join(code: string): Promise<Link> {
    const ch = this.channel(code);
    const self = `guest-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const link = new LocalLink(ch, self, 'host');
      const timer = setTimeout(() => { ch.close(); reject(new NetError('not-found', 'No party with that code')); }, 1500);
      ch.onmessage = e => {
        const f = e.data as LocalFrame;
        if (f.to !== self) return;
        if (f.kind === 'accept') { clearTimeout(timer); resolve(link); } else link.receive(f);
      };
      ch.postMessage({ to: 'host', from: self, kind: 'join' } satisfies LocalFrame);
    });
  }
}

export function createTransport(kind: string | null): Transport {
  return kind === 'local' ? new LocalTransport() : new PeerTransport();
}
