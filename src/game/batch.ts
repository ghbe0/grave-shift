// A growable run of instances that share a mesh: the scene fills batches, the renderer draws them.
import { compose } from '../gfx/mat';
import { INSTANCE_FLOATS } from '../gfx/renderer';

export type V3 = [number, number, number];

/** A growable run of instances that share a mesh. */
export class Batch {
  data = new Float32Array(INSTANCE_FLOATS * 256);
  n = 0;
  private grow(count = 1): number {
    while ((this.n + count) * INSTANCE_FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const o = this.n * INSTANCE_FLOATS;
    this.n += count;
    return o;
  }
  private tail(o: number, c: ArrayLike<number>, layer: number, metallic: number, roughness: number, emissive: number, flags: number): void {
    const d = this.data;
    d[o + 16] = c[0]; d[o + 17] = c[1]; d[o + 18] = c[2]; d[o + 19] = layer + 1;
    d[o + 20] = metallic; d[o + 21] = roughness; d[o + 22] = emissive; d[o + 23] = flags;
  }
  /** Box (or any unit mesh) with translation, scale and yaw/pitch/roll. `layer` -1 = untextured. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: ArrayLike<number>, layer = -1, emissive = 0, flags = 0, yaw = 0, pitch = 0, roll = 0, metallic = 0, roughness = 1): void {
    const o = this.grow();
    compose(this.data, o, x, y, z, sx, sy, sz, yaw, pitch, roll);
    this.tail(o, c, layer, metallic, roughness, emissive, flags);
  }
  /** Instance with an explicit matrix. */
  mat(matrix: ArrayLike<number>, c: ArrayLike<number>, layer: number, metallic: number, roughness: number, emissive: number, flags: number): void {
    const o = this.grow();
    this.data.set(matrix, o);
    this.tail(o, c, layer, metallic, roughness, emissive, flags);
  }
  /** Unit sphere stretched between two points into a limb of radius r (rz for the depth axis). */
  limb(a: V3, b: V3, r: number, c: ArrayLike<number>, layer: number, flags = 0, rz = r, side?: V3, cap = 1.6): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1e-4;
    const y: V3 = [d[0] / len, d[1] / len, d[2] / len];
    // X axis: the given side direction made perpendicular to the limb.
    let ref = side ?? (Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    let x: V3 = [ref[1] * y[2] - ref[2] * y[1], ref[2] * y[0] - ref[0] * y[2], ref[0] * y[1] - ref[1] * y[0]];
    if (side) { const dot = side[0] * y[0] + side[1] * y[1] + side[2] * y[2]; x = [side[0] - y[0] * dot, side[1] - y[1] * dot, side[2] - y[2] * dot]; }
    let xl = Math.hypot(x[0], x[1], x[2]);
    if (xl < 1e-4) { ref = [1, 0, 0]; x = [ref[1] * y[2] - ref[2] * y[1], ref[2] * y[0] - ref[0] * y[2], ref[0] * y[1] - ref[1] * y[0]]; xl = Math.hypot(x[0], x[1], x[2]) || 1; }
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const z: V3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const sy = len + r * cap, sx = r * 2, sz = rz * 2;
    const o = this.grow();
    const m = this.data;
    m[o] = x[0] * sx; m[o + 1] = x[1] * sx; m[o + 2] = x[2] * sx; m[o + 3] = 0;
    m[o + 4] = y[0] * sy; m[o + 5] = y[1] * sy; m[o + 6] = y[2] * sy; m[o + 7] = 0;
    m[o + 8] = z[0] * sz; m[o + 9] = z[1] * sz; m[o + 10] = z[2] * sz; m[o + 11] = 0;
    m[o + 12] = (a[0] + b[0]) / 2; m[o + 13] = (a[1] + b[1]) / 2; m[o + 14] = (a[2] + b[2]) / 2; m[o + 15] = 1;
    this.tail(o, c, layer, 0, 1, 0, flags);
  }
  /** Copies instance `i` of `src`. */
  copy(src: Batch, i: number): void {
    const o = this.grow();
    this.data.set(src.data.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS), o);
  }
  append(other: Batch): void {
    const o = this.grow(other.n);
    this.data.set(other.data.subarray(0, other.n * INSTANCE_FLOATS), o);
  }
}
