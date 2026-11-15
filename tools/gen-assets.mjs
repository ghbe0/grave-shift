// Generates the placeholder models in public/assets as binary glTF (.glb) with an embedded PNG
// texture, so the loader has real files to exercise. Replace any of them with authored models of
// the same name; nothing else needs to change.
//   node tools/gen-assets.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Encodes RGBA pixels as a PNG. */
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Brushed-metal style texture: horizontal streaks with panel lines.
const texture = png(32, 32, (x, y) => {
  const streak = 205 + ((y * 37 + (x >> 2) * 11) % 23) * 2;
  const v = x % 16 === 0 || y % 16 === 0 ? 150 : streak;
  return [v, v, v, 255];
});

const FACES = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];

/** boxes: [{ c: [x, y, z], s: [w, h, d], m: materialIndex }], materials: [{ color, metallic, roughness, emissive? }] */
function glb(boxes, materials) {
  const chunks = [];
  const views = [], accessors = [], primitives = [];
  let offset = 0;
  const push = (buf, target) => { views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) }); chunks.push(buf); offset += buf.length; const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; } return views.length - 1; };
  materials.forEach((_, mi) => {
    const pos = [], nrm = [], uv = [], idx = [];
    for (const b of boxes.filter(b => b.m === mi)) {
      for (const [n, u, w] of FACES) {
        const base = pos.length / 3;
        for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          for (let k = 0; k < 3; k++) pos.push(b.c[k] + ((n[k] + u[k] * a + w[k] * c) / 2) * b.s[k]);
          nrm.push(...n);
          // Texel density follows size so the pattern does not stretch.
          const su = Math.abs(u[0] * b.s[0] + u[1] * b.s[1] + u[2] * b.s[2]), sw = Math.abs(w[0] * b.s[0] + w[1] * b.s[1] + w[2] * b.s[2]);
          uv.push(((a + 1) / 2) * su * 6, ((1 - c) / 2) * sw * 6);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    if (!idx.length) return;
    const f32 = a => Buffer.from(new Float32Array(a).buffer);
    const count = pos.length / 3;
    const mins = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), maxs = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
    const acc = (view, type, componentType, n, extra = {}) => { accessors.push({ bufferView: view, componentType, count: n, type, ...extra }); return accessors.length - 1; };
    primitives.push({
      attributes: {
        POSITION: acc(push(f32(pos), 34962), 'VEC3', 5126, count, { min: mins, max: maxs }),
        NORMAL: acc(push(f32(nrm), 34962), 'VEC3', 5126, count),
        TEXCOORD_0: acc(push(f32(uv), 34962), 'VEC2', 5126, count),
      },
      indices: acc(push(Buffer.from(new Uint16Array(idx).buffer), 34963), 'SCALAR', 5123, idx.length),
      material: mi,
    });
  });
  const imageView = push(texture);
  const json = {
    asset: { version: '2.0', generator: 'grave-shift gen-assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials: materials.map(m => ({
      pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: m.metallic, roughnessFactor: m.roughness, baseColorTexture: { index: 0 } },
      ...(m.emissive ? { emissiveFactor: [m.emissive, m.emissive, m.emissive] } : {}),
    })),
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 10497, wrapT: 10497 }],
    images: [{ bufferView: imageView, mimeType: 'image/png' }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const chunkHeader = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(bin.length, 0x004e4942), bin]);
}

const steel = { color: [0.2, 0.21, 0.23], metallic: 0.9, roughness: 0.38 };
const polymer = { color: [0.09, 0.09, 0.1], metallic: 0.0, roughness: 0.7 };
const accent = c => ({ color: c, metallic: 0.3, roughness: 0.5 });
const glow = c => ({ color: c, metallic: 0.0, roughness: 0.4, emissive: 2.5 });

// Guns point down -Z with the grip at the origin. Sizes in metres.
function gun({ len, barrel, mag, stock = 0, drum = false, scope = false, body = 0.06, color }) {
  const b = [
    { c: [0, 0.05, -len / 2 + 0.05], s: [0.045, body, len], m: 0 }, // receiver
    { c: [0, 0.06, -len - barrel / 2 + 0.05], s: [0.022, 0.022, barrel], m: 0 }, // barrel
    { c: [0, -0.05, 0.02], s: [0.036, 0.11, 0.045], m: 1 }, // grip
    { c: [0, 0.09, -len + 0.08], s: [0.01, 0.02, 0.012], m: 2 }, // front sight
    { c: [0, 0.055, -len * 0.55], s: [0.05, 0.02, len * 0.35], m: 2 }, // accent rail
  ];
  if (mag) b.push({ c: [0, -0.02 - mag / 2, -len * 0.4], s: drum ? [0.09, mag, 0.09] : [0.03, mag, 0.05], m: 1 });
  if (stock) b.push({ c: [0, 0.03, 0.05 + stock / 2], s: [0.035, 0.07, stock], m: 1 });
  if (scope) b.push({ c: [0, 0.12, -len * 0.4], s: [0.035, 0.035, 0.22], m: 0 }, { c: [0, 0.095, -len * 0.4], s: [0.015, 0.02, 0.05], m: 0 });
  return glb(b, [steel, polymer, color]);
}

const models = {
  'weapons/p9': gun({ len: 0.2, barrel: 0.03, mag: 0, color: accent([0.5, 0.5, 0.55]) }),
  'weapons/hornet': gun({ len: 0.24, barrel: 0.05, mag: 0.16, color: accent([0.85, 0.7, 0.1]) }),
  'weapons/vespa': gun({ len: 0.36, barrel: 0.08, mag: 0.2, stock: 0.14, color: accent([0.9, 0.45, 0.1]) }),
  'weapons/kestrel': gun({ len: 0.5, barrel: 0.2, mag: 0.16, stock: 0.24, color: accent([0.2, 0.5, 0.3]) }),
  'weapons/carbine': gun({ len: 0.52, barrel: 0.26, mag: 0.1, stock: 0.26, color: accent([0.45, 0.3, 0.18]) }),
  'weapons/breacher': gun({ len: 0.48, barrel: 0.3, mag: 0, stock: 0.24, body: 0.075, color: accent([0.5, 0.15, 0.12]) }),
  'weapons/anvil': gun({ len: 0.6, barrel: 0.3, mag: 0.12, stock: 0.26, drum: true, body: 0.08, color: accent([0.3, 0.33, 0.38]) }),
  'weapons/longshot': gun({ len: 0.62, barrel: 0.5, mag: 0.08, stock: 0.3, scope: true, color: accent([0.15, 0.25, 0.4]) }),
  'weapons/arc': gun({ len: 0.5, barrel: 0.22, mag: 0.12, stock: 0.2, body: 0.085, color: glow([0.25, 0.75, 1.0]) }),
  'weapons/stormlance': gun({ len: 0.56, barrel: 0.3, mag: 0, stock: 0.22, body: 0.09, color: glow([0.7, 0.4, 1.0]) }),
  'weapons/verdict': gun({ len: 0.26, barrel: 0.12, mag: 0, body: 0.075, color: glow([1.0, 0.6, 0.15]) }),
  'props/generator': glb([
    { c: [0, 0.6, 0], s: [1.6, 1.2, 1.0], m: 0 },
    { c: [0, 1.3, 0], s: [1.2, 0.2, 0.7], m: 1 },
    { c: [-0.5, 1.75, 0], s: [0.18, 0.7, 0.18], m: 0 },
    { c: [0.45, 0.7, 0.51], s: [0.4, 0.3, 0.03], m: 2 },
  ], [steel, polymer, glow([0.2, 1.0, 0.4])]),
};

for (const [name, buf] of Object.entries(models)) {
  const path = `public/assets/${name}.glb`;
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, buf);
  console.log(`${path} ${buf.length} bytes`);
}
