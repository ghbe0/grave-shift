// glTF 2.0 loader for weapon, character and environment models. Handles binary .glb and JSON
// .gltf (embedded base64 or external buffers), node hierarchies, indexed or non-indexed triangle
// primitives, PBR metallic-roughness factors and embedded base-colour textures.
// Not handled: skinning, animation, morph targets, normal/occlusion maps, KHR extensions.
import { mat4, mul, type Mat4 } from './mat';
import { VERTEX_FLOATS, type MeshData, type Renderer } from './renderer';

export interface ModelPart {
  mesh: number;
  color: [number, number, number, number];
  metallic: number;
  roughness: number;
  emissive: number;
}
export interface Model { parts: ModelPart[]; min: number[]; max: number[] }

/** A primitive baked into model space, before upload. Exposed for tests and tools. */
export interface ParsedPart extends Omit<ModelPart, 'mesh'> { data: MeshData; image: number }
export interface ParsedModel { parts: ParsedPart[]; images: { bytes: Uint8Array; mime: string }[]; min: number[]; max: number[] }

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
type Typed = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array;
const ARRAYS: Record<number, { new(b: ArrayBuffer, o: number, n: number): Typed; BYTES_PER_ELEMENT: number }> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};

function dataUri(uri: string): Uint8Array {
  const bin = atob(uri.slice(uri.indexOf(',') + 1));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function nodeMatrix(n: any): Mat4 {
  if (n.matrix) return new Float32Array(n.matrix);
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return new Float32Array([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/** Parses glTF JSON plus its buffers into baked, interleaved meshes. */
export function parseGltf(json: any, buffers: Uint8Array[]): ParsedModel {
  const view = (i: number): Uint8Array => {
    const v = json.bufferViews[i];
    const b = buffers[v.buffer];
    return b.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  };
  // Reads an accessor into a tightly packed array, honouring byteStride and alignment.
  const accessor = (i: number): { data: Typed; size: number } => {
    const a = json.accessors[i];
    const size = COMPONENTS[a.type];
    const Arr = ARRAYS[a.componentType];
    const out = new Arr(new ArrayBuffer(a.count * size * Arr.BYTES_PER_ELEMENT), 0, a.count * size);
    if (a.bufferView === undefined) return { data: out, size };
    const bv = json.bufferViews[a.bufferView];
    const bytes = view(a.bufferView);
    const stride = bv.byteStride ?? size * Arr.BYTES_PER_ELEMENT;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset ?? 0));
    const read: (o: number) => number = {
      5120: (o: number) => dv.getInt8(o), 5121: (o: number) => dv.getUint8(o), 5122: (o: number) => dv.getInt16(o, true),
      5123: (o: number) => dv.getUint16(o, true), 5125: (o: number) => dv.getUint32(o, true), 5126: (o: number) => dv.getFloat32(o, true),
    }[a.componentType as 5120]!;
    for (let e = 0; e < a.count; e++) for (let c = 0; c < size; c++) out[e * size + c] = read(e * stride + c * Arr.BYTES_PER_ELEMENT);
    return { data: out, size };
  };

  const images = (json.images ?? []).map((img: any) => ({
    bytes: img.bufferView !== undefined ? view(img.bufferView) : img.uri?.startsWith('data:') ? dataUri(img.uri) : new Uint8Array(),
    mime: img.mimeType ?? 'image/png',
  }));
  const parts: ParsedPart[] = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

  const visit = (index: number, parent: Mat4) => {
    const node = json.nodes[index];
    const world = mul(mat4(), parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
        const pos = accessor(prim.attributes.POSITION).data;
        const count = pos.length / 3;
        const nrm = prim.attributes.NORMAL !== undefined ? accessor(prim.attributes.NORMAL).data : null;
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0).data : null;
        const indices = prim.indices !== undefined ? accessor(prim.indices).data : Uint32Array.from({ length: count }, (_, k) => k);
        const v = new Float32Array(count * VERTEX_FLOATS);
        const m = world;
        for (let k = 0; k < count; k++) {
          const [x, y, z] = [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
          const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
          v.set(p, k * VERTEX_FLOATS);
          for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], p[c]); max[c] = Math.max(max[c], p[c]); }
          if (nrm) {
            const [a, b, c] = [nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]];
            const n = [m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c];
            const l = Math.hypot(n[0], n[1], n[2]) || 1;
            v.set([n[0] / l, n[1] / l, n[2] / l], k * VERTEX_FLOATS + 3);
          }
          if (uv) v.set([uv[k * 2], uv[k * 2 + 1]], k * VERTEX_FLOATS + 6);
        }
        if (!nrm) {
          // Flat normals from triangle faces when the file has none.
          for (let t = 0; t + 2 < indices.length; t += 3) {
            const [a, b, c] = [indices[t] * VERTEX_FLOATS, indices[t + 1] * VERTEX_FLOATS, indices[t + 2] * VERTEX_FLOATS];
            const e1 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]], e2 = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const l = Math.hypot(n[0], n[1], n[2]) || 1;
            for (const o of [a, b, c]) v.set([n[0] / l, n[1] / l, n[2] / l], o + 3);
          }
        }
        const mat = json.materials?.[prim.material] ?? {};
        const pbr = mat.pbrMetallicRoughness ?? {};
        const tex = pbr.baseColorTexture ? json.textures?.[pbr.baseColorTexture.index]?.source ?? -1 : -1;
        const e = mat.emissiveFactor ?? [0, 0, 0];
        parts.push({
          data: { vertices: v, indices: count > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices) },
          image: tex,
          color: pbr.baseColorFactor ?? [1, 1, 1, 1],
          metallic: pbr.metallicFactor ?? 1,
          roughness: pbr.roughnessFactor ?? 1,
          emissive: Math.max(e[0], e[1], e[2]),
        });
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i)) visit(root, mat4());
  return { parts, images, min, max };
}

/** Splits a .glb container into its JSON and binary chunks. */
export function parseGlb(bytes: Uint8Array): { json: any; bin: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file');
  let json: any = null, bin: Uint8Array = new Uint8Array();
  for (let o = 12; o + 8 <= bytes.byteLength;) {
    const [len, type] = [dv.getUint32(o, true), dv.getUint32(o + 4, true)];
    const chunk = bytes.subarray(o + 8, o + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === CHUNK_BIN) bin = chunk;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

/** Fetches a .glb or .gltf, decodes its textures and uploads it to the renderer. */
export async function loadModel(renderer: Renderer, url: string): Promise<Model> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let json: any, buffers: Uint8Array[];
  if (new DataView(bytes.buffer).getUint32(0, true) === GLB_MAGIC) {
    const glb = parseGlb(bytes);
    json = glb.json;
    buffers = [glb.bin];
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
    buffers = [];
  }
  // External and data-URI buffers (index 0 of a .glb is its BIN chunk and has no uri).
  await Promise.all((json.buffers ?? []).map(async (b: any, i: number) => {
    if (!b.uri) return;
    buffers[i] = b.uri.startsWith('data:') ? dataUri(b.uri) : new Uint8Array(await (await fetch(new URL(b.uri, new URL(url, location.href)))).arrayBuffer());
  }));
  const parsed = parseGltf(json, buffers);
  const bitmaps = await Promise.all(parsed.images.map(img =>
    img.bytes.length ? createImageBitmap(new Blob([img.bytes as BlobPart], { type: img.mime })).catch(() => null) : null));
  return {
    min: parsed.min,
    max: parsed.max,
    parts: parsed.parts.map(p => ({
      mesh: renderer.createMesh({ ...p.data, texture: p.image >= 0 ? bitmaps[p.image] : null }),
      color: p.color, metallic: p.metallic, roughness: p.roughness, emissive: p.emissive,
    })),
  };
}
