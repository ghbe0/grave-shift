// Snapshot interpolation. Remote entities are drawn slightly in the past, blended between the
// two snapshots that straddle the render time, so 20 Hz updates look smooth at any frame rate.
import type { Layout, Snap } from '../core/sim';

export const INTERP_DELAY = 0.1;
const MAX_BUFFER = 40;

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export interface Pose { id: number; x: number; y: number; z: number; yaw: number; rec: Float32Array }

export class SnapshotBuffer {
  private snaps: Snap[] = [];
  /** Estimated (host time - local time), tracking the freshest packets. */
  private offset = -Infinity;

  constructor(private L: Layout) {}

  get latest(): Snap | undefined { return this.snaps[this.snaps.length - 1]; }

  /** Adds a snapshot. Returns false if it is older than one already held (out-of-order arrival). */
  push(snap: Snap, localNow: number): boolean {
    const last = this.latest;
    if (last && snap.time <= last.time) return false;
    this.snaps.push(snap);
    if (this.snaps.length > MAX_BUFFER) this.snaps.shift();
    const sample = snap.time - localNow;
    // Jump forward immediately, drift back slowly: late packets must not drag the clock.
    this.offset = sample > this.offset ? sample : this.offset + (sample - this.offset) * 0.02;
    return true;
  }

  /** Host time to render remote entities at. Also sent with commands for lag compensation. */
  renderTime(localNow: number): number { return localNow + this.offset - INTERP_DELAY; }

  private bracket(t: number): [Snap, Snap, number] | null {
    const s = this.snaps;
    if (!s.length) return null;
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].time <= t) {
        const span = s[i].time - s[i - 1].time;
        // Past the newest snapshot we hold the last pose instead of extrapolating.
        return [s[i - 1], s[i], span > 0 ? Math.min(Math.max((t - s[i - 1].time) / span, 0), 1) : 1];
      }
    }
    return [s[0], s[0], 0];
  }

  private blend(a: Float32Array[], b: Float32Array[], t: number, idAt: number, posAt: number, yawAt: number): Pose[] {
    const prev = new Map(a.map(r => [r[idAt], r]));
    return b.map(rec => {
      const from = prev.get(rec[idAt]) ?? rec;
      const far = Math.hypot(rec[posAt] - from[posAt], rec[posAt + 2] - from[posAt + 2]) > 6; // teleport/respawn: snap
      const k = far ? 1 : t;
      return {
        id: rec[idAt],
        x: from[posAt] + (rec[posAt] - from[posAt]) * k,
        y: from[posAt + 1] + (rec[posAt + 1] - from[posAt + 1]) * k,
        z: from[posAt + 2] + (rec[posAt + 2] - from[posAt + 2]) * k,
        yaw: lerpAngle(from[yawAt], rec[yawAt], k),
        rec,
      };
    });
  }

  zombies(renderTime: number): Pose[] {
    const br = this.bracket(renderTime);
    const { Z } = this.L;
    return br ? this.blend(br[0].zombies, br[1].zombies, br[2], Z.id, Z.pos, Z.yaw) : [];
  }
  players(renderTime: number): Pose[] {
    const br = this.bracket(renderTime);
    const { P } = this.L;
    return br ? this.blend(br[0].players, br[1].players, br[2], P.id, P['ctl.pos'], P['ctl.yaw']) : [];
  }
}
