// Client-side prediction. The guest runs the same Wasm controller locally so its own movement and
// weapon handling respond instantly, keeps every command the host has not acknowledged yet, and
// on each snapshot rewinds to the host's state and replays those commands.
import type { Game, Layout } from '../core/sim';

const MAX_PENDING = 240;

export class Predictor {
  private pending: Float32Array[] = [];
  /** Visual offset that hides a correction and decays to zero. */
  readonly error = new Float32Array(3);

  constructor(private game: Game, private L: Layout, private id: number) {}

  /** Runs one command locally and remembers it for replay. */
  predict(cmd: Float32Array): void {
    this.game.cmd(this.id, cmd);
    this.pending.push(cmd);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /** Adopts the host's state for our player and replays unacknowledged commands. */
  reconcile(authoritative: Float32Array): void {
    const pos = this.L.P['ctl.pos'];
    const before = this.game.playerState(this.id).slice(pos, pos + 3);
    const ack = authoritative[this.L.P.ack];
    this.pending = this.pending.filter(c => c[0] > ack);
    this.game.setPlayerState(authoritative);
    for (const c of this.pending) this.game.cmd(this.id, c);
    this.game.events(); // effects for these commands already played when they were first predicted
    if (!before.length) return;
    const after = this.game.playerState(this.id);
    for (let i = 0; i < 3; i++) {
      const d = before[i] - after[pos + i];
      // Small mispredictions are smoothed over a few frames; large ones (teleports) snap.
      this.error[i] = Math.abs(d) > 3 ? 0 : this.error[i] + d;
    }
  }

  /** Call once per rendered frame. */
  decay(dt: number): void {
    const k = Math.exp(-12 * dt);
    for (let i = 0; i < 3; i++) this.error[i] *= k;
  }

  get pendingCount(): number { return this.pending.length; }
}
