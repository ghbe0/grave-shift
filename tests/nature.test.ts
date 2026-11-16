import { describe, expect, it } from 'vitest';
import { coneMesh, lumpMesh, rng, tuftMesh } from '../src/gfx/nature';
import type { MeshData } from '../src/gfx/renderer';

function check(name: string, m: MeshData): void {
  const n = m.vertices.length / 8;
  expect(Number.isInteger(n), name).toBe(true);
  expect(m.indices.length % 3, name).toBe(0);
  expect(Math.max(...m.indices), name).toBeLessThan(n);
  for (let i = 0; i < n; i++) {
    const v = m.vertices.subarray(i * 8, i * 8 + 8);
    expect(v.every(Number.isFinite), `${name} vertex ${i}`).toBe(true);
    // Unit-sized, with unit normals.
    expect(Math.max(Math.abs(v[0]), Math.abs(v[1] - (name === 'tuft' ? 0.5 : 0)), Math.abs(v[2])), `${name} vertex ${i}`).toBeLessThanOrEqual(0.76);
    expect(Math.hypot(v[3], v[4], v[5]), `${name} normal ${i}`).toBeCloseTo(1, 1);
  }
}

describe('scenery meshes', () => {
  it('are well formed', () => {
    check('lump', lumpMesh(11, 0.5, 2.2));
    check('rock', lumpMesh(23, 0.42, 1.3, 0.55, 9, 12));
    check('cone', coneMesh());
    check('tuft', tuftMesh(5));
  });
  it('lump normals point outward', () => {
    const m = lumpMesh(11, 0.5, 2.2);
    let outward = 0;
    const n = m.vertices.length / 8;
    for (let i = 0; i < n; i++) { const v = m.vertices.subarray(i * 8, i * 8 + 6); if (v[0] * v[3] + v[1] * v[4] + v[2] * v[5] > 0) outward++; }
    expect(outward / n).toBeGreaterThan(0.97);
  });
  it('are identical for every player (seeded)', () => {
    expect(Array.from(tuftMesh(5).vertices)).toEqual(Array.from(tuftMesh(5).vertices));
    const a = rng(42), b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rng(1)()).not.toBe(rng(2)());
  });
});
