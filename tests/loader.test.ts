import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGlb, parseGltf } from '../src/gfx/loader';

describe('glTF loader', () => {
  it('parses a generated .glb with an embedded texture', () => {
    const { json, bin } = parseGlb(new Uint8Array(readFileSync('public/assets/weapons/kestrel.glb')));
    const model = parseGltf(json, [bin]);
    expect(model.parts.length).toBe(5);
    for (const part of model.parts) {
      expect(part.data.vertices.length % 8).toBe(0);
      expect(part.data.indices.length % 3).toBe(0);
      expect(Math.max(...part.data.indices)).toBeLessThan(part.data.vertices.length / 8);
    }
    // Named materials map to the procedural layers: gun metal and polymer.
    expect(model.parts.map(p => p.layer)).toEqual([6, 9, 2, -1, -1]);
    // The plain dark material keeps the embedded texture.
    expect(model.parts[3].image).toBe(0);
    // PNG signature of the embedded image
    expect(Array.from(model.images[0].bytes.subarray(0, 4))).toEqual([137, 80, 78, 71]);
    // The gun points down -Z and is longer than it is wide.
    expect(model.min[2]).toBeLessThan(-0.5);
    expect(model.max[0] - model.min[0]).toBeLessThan(0.1);
  });

  it('bakes node transforms and reads data-URI buffers with byteStride', () => {
    // One triangle, interleaved position+normal (stride 24), under a translated + scaled node.
    const f = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]);
    const json = {
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1], translation: [10, 0, 0] }, { mesh: 0, scale: [2, 2, 2] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], roughnessFactor: 0.3 }, emissiveFactor: [0, 2, 0] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteLength: 72, byteStride: 24 }],
      buffers: [{ byteLength: 72 }],
    };
    const model = parseGltf(json, [new Uint8Array(f.buffer)]);
    const v = model.parts[0].data.vertices;
    expect(Array.from(v.subarray(8, 11))).toEqual([12, 0, 0]); // (1,0,0) * 2 + 10
    expect(Array.from(v.subarray(3, 6))).toEqual([0, 0, 1]); // normal stays unit length
    expect(Array.from(model.parts[0].data.indices)).toEqual([0, 1, 2]);
    expect(model.parts[0].color).toEqual([1, 0, 0, 1]);
    expect(model.parts[0].emissive).toBe(2);
    expect(model.parts[0].metallic).toBe(1);
    expect(model.parts[0].image).toBe(-1);
    expect(model.parts[0].layer).toBe(-1);
  });
});
