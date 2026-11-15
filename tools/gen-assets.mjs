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

/** Rotates a point/normal about the X axis (pitch) then Y (yaw). */
const rot = (p, rx = 0, ry = 0) => {
  const [x, y, z] = p;
  const y1 = y * Math.cos(rx) - z * Math.sin(rx), z1 = y * Math.sin(rx) + z * Math.cos(rx);
  return [x * Math.cos(ry) + z1 * Math.sin(ry), y1, -x * Math.sin(ry) + z1 * Math.cos(ry)];
};

/** Appends a part's triangles. Parts: { box: [w, h, d] } or { cyl: [radius, length], seg? } along Z, with c (centre), rx/ry (radians), m (material). */
function emit(part, mesh) {
  const { c, rx = 0, ry = 0 } = part;
  const add = (p, n, u, v) => {
    const q = rot(p, rx, ry), nn = rot(n, rx, ry);
    mesh.pos.push(q[0] + c[0], q[1] + c[1], q[2] + c[2]);
    mesh.nrm.push(...nn);
    mesh.uv.push(u, v);
    return mesh.pos.length / 3 - 1;
  };
  if (part.box) {
    const s = part.box;
    for (const [n, u, w] of FACES) {
      const ids = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
        add([0, 1, 2].map(k => ((n[k] + u[k] * a + w[k] * b) / 2) * s[k]), n, (a + 1) / 2, (1 - b) / 2));
      mesh.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
  } else {
    const [r, len] = part.cyl, seg = part.seg ?? 14;
    const ring = [];
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * Math.PI * 2, x = Math.cos(t), y = Math.sin(t);
      ring.push([add([x * r, y * r, len / 2], [x, y, 0], j / seg, 0), add([x * r, y * r, -len / 2], [x, y, 0], j / seg, 1)]);
    }
    for (let j = 0; j < seg; j++) mesh.idx.push(ring[j][0], ring[j][1], ring[j + 1][0], ring[j + 1][0], ring[j][1], ring[j + 1][1]);
    for (const [z, nz] of [[len / 2, 1], [-len / 2, -1]]) {
      const centre = add([0, 0, z], [0, 0, nz], 0.5, 0.5);
      const rim = [];
      for (let j = 0; j <= seg; j++) { const t = (j / seg) * Math.PI * 2; rim.push(add([Math.cos(t) * r, Math.sin(t) * r, z], [0, 0, nz], 0.5, 0.5)); }
      for (let j = 0; j < seg; j++) mesh.idx.push(...(nz > 0 ? [centre, rim[j], rim[j + 1]] : [centre, rim[j + 1], rim[j]]));
    }
  }
}

/** parts: see `emit`. materials: [{ name?, color, metallic, roughness, emissive?, textured? }] */
function glb(parts, materials) {
  const chunks = [];
  const views = [], accessors = [], primitives = [];
  let offset = 0;
  const push = (buf, target) => { views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) }); chunks.push(buf); offset += buf.length; const pad = (4 - (offset % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; } return views.length - 1; };
  materials.forEach((_, mi) => {
    const mesh = { pos: [], nrm: [], uv: [], idx: [] };
    for (const p of parts.filter(p => p.m === mi)) emit(p, mesh);
    if (!mesh.idx.length) return;
    const f32 = a => Buffer.from(new Float32Array(a).buffer);
    const count = mesh.pos.length / 3;
    const axis = k => mesh.pos.filter((_, i) => i % 3 === k);
    const mins = [0, 1, 2].map(k => Math.min(...axis(k))), maxs = [0, 1, 2].map(k => Math.max(...axis(k)));
    const acc = (view, type, componentType, n, extra = {}) => { accessors.push({ bufferView: view, componentType, count: n, type, ...extra }); return accessors.length - 1; };
    primitives.push({
      attributes: {
        POSITION: acc(push(f32(mesh.pos), 34962), 'VEC3', 5126, count, { min: mins, max: maxs }),
        NORMAL: acc(push(f32(mesh.nrm), 34962), 'VEC3', 5126, count),
        TEXCOORD_0: acc(push(f32(mesh.uv), 34962), 'VEC2', 5126, count),
      },
      indices: acc(push(Buffer.from(new Uint16Array(mesh.idx).buffer), 34963), 'SCALAR', 5123, mesh.idx.length),
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
      ...(m.name ? { name: m.name } : {}),
      pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: m.metallic, roughnessFactor: m.roughness, ...(m.textured ? { baseColorTexture: { index: 0 } } : {}) },
      ...(m.emissive ? { emissiveFactor: [m.emissive, m.emissive, m.emissive] } : {}),
    })),
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
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

// Material slots. "layer:N" names map to the game's procedural materials (6 gun metal, 9 polymer,
// 2 painted steel); the rest are plain factors (and the embedded texture, for authored-model parity).
const M = { metal: 0, polymer: 1, accent: 2, dark: 3, glass: 4 };
const mats = accent => [
  { name: 'layer:6', color: [1, 1, 1], metallic: 1, roughness: 1 },
  { name: 'layer:9', color: [1, 1, 1], metallic: 0, roughness: 1 },
  accent,
  { color: [0.02, 0.02, 0.022], metallic: 0.2, roughness: 0.6, textured: true },
  { color: [0.05, 0.12, 0.16], metallic: 0.9, roughness: 0.08 },
];
const paint = c => ({ name: 'layer:2', color: c, metallic: 0.5, roughness: 1 });
const glow = c => ({ color: c, metallic: 0.0, roughness: 0.4, emissive: 2.5 });

/** A picatinny-style rail: a strip with evenly spaced cross slots. */
const rail = (z0, z1, y, m = M.metal) => {
  const out = [{ box: [0.022, 0.006, z1 - z0], c: [0, y, (z0 + z1) / 2], m }];
  for (let z = z0 + 0.008; z < z1; z += 0.01) out.push({ box: [0.024, 0.006, 0.005], c: [0, y + 0.005, z], m });
  return out;
};

/**
 * Generic firearm. Points down -Z with the pistol grip at the origin. All sizes in metres.
 * len: receiver length, barrel: exposed barrel, mag: magazine height (0 none), stock: stock length,
 * guard: handguard length, scope, drum, pump, bulk (receiver height).
 */
function gun({ len, barrel, mag = 0, stock = 0, guard = 0, scope = false, drum = false, pump = false, bulk = 0.06, muzzle = 'brake', accent }) {
  const top = 0.03 + bulk / 2;
  const front = -len;
  const p = [
    { box: [0.036, bulk * 0.55, len * 0.62], c: [0, 0.03 - bulk * 0.12, -len * 0.42], m: M.metal }, // lower receiver
    { box: [0.032, bulk * 0.5, len], c: [0, 0.03 + bulk * 0.25, -len / 2 + 0.03], m: M.metal }, // upper receiver
    { box: [0.008, 0.016, 0.05], c: [0.019, 0.04 + bulk * 0.2, -len * 0.35], m: M.dark }, // ejection port
    { box: [0.014, 0.01, 0.03], c: [0.01, top + 0.003, 0.03], m: M.metal }, // charging handle
    { box: [0.03, 0.1, 0.038], c: [0, -0.045, 0.012], rx: -0.28, m: M.polymer }, // grip
    { box: [0.006, 0.006, 0.05], c: [0, -0.03, -0.035], m: M.metal }, // trigger guard
    { box: [0.004, 0.022, 0.006], c: [0, -0.012, -0.022], rx: 0.3, m: M.metal }, // trigger
    ...rail(-len + 0.02, 0.0, top + 0.004),
    { box: [0.006, 0.022, 0.012], c: [0, top + 0.016, -0.0], m: M.metal }, // rear sight
  ];
  const gl = guard || len * 0.5;
  if (pump) p.push({ cyl: [0.024, gl * 0.6], c: [0, 0.012, front - gl * 0.25], m: M.polymer });
  else if (guard) {
    p.push({ cyl: [0.024, gl], c: [0, 0.035, front - gl / 2 + 0.03], seg: 8, m: M.polymer });
    for (let i = 0; i < 4; i++) p.push({ box: [0.05, 0.008, 0.016], c: [0, 0.035, front - 0.02 - i * (gl / 4)], m: M.dark });
    p.push(...rail(front - gl + 0.04, front + 0.02, 0.064));
  }
  const bz = front - (guard || 0) + 0.03;
  p.push({ cyl: [0.0085, barrel + (guard || 0)], c: [0, 0.035, bz - barrel / 2 + (guard || 0) / 2], m: M.metal }); // barrel
  if (pump) p.push({ cyl: [0.012, barrel * 0.85], c: [0, 0.01, bz - barrel * 0.42], m: M.metal }); // magazine tube
  const tip = bz - barrel;
  if (muzzle === 'brake') {
    p.push({ cyl: [0.0135, 0.05], c: [0, 0.035, tip - 0.02], seg: 10, m: M.metal });
    for (const z of [-0.008, -0.022, -0.036]) p.push({ box: [0.03, 0.006, 0.004], c: [0, 0.035, tip + z], m: M.dark });
  } else if (muzzle === 'suppressor') {
    p.push({ cyl: [0.018, 0.16], c: [0, 0.035, tip - 0.07], m: M.polymer });
  }
  p.push({ box: [0.006, 0.026, 0.008], c: [0, 0.06, tip + 0.03], m: M.metal }); // front sight
  if (mag) {
    if (drum) p.push({ cyl: [0.06, 0.05], c: [0, -0.06, -len * 0.42], ry: Math.PI / 2, m: M.polymer });
    else p.push({ box: [0.026, mag, 0.05], c: [0, -mag / 2 + 0.005, -len * 0.42], rx: 0.18, m: M.polymer });
  }
  if (stock) {
    p.push({ cyl: [0.016, stock * 0.6], c: [0, 0.035, 0.03 + stock * 0.3], m: M.metal }); // buffer tube
    p.push({ box: [0.036, 0.075, stock * 0.55], c: [0, 0.02, 0.03 + stock * 0.68], m: M.polymer }); // stock
    p.push({ box: [0.04, 0.09, 0.016], c: [0, 0.015, 0.03 + stock], m: M.polymer }); // butt pad
    p.push({ box: [0.03, 0.016, stock * 0.4], c: [0, 0.065, 0.03 + stock * 0.68], m: M.polymer }); // cheek riser
  }
  if (scope) {
    p.push({ cyl: [0.017, 0.24], c: [0, top + 0.05, -len * 0.4], m: M.metal });
    p.push({ cyl: [0.024, 0.05], c: [0, top + 0.05, -len * 0.4 - 0.13], m: M.metal });
    p.push({ cyl: [0.021, 0.04], c: [0, top + 0.05, -len * 0.4 + 0.12], m: M.metal });
    p.push({ cyl: [0.02, 0.002], c: [0, top + 0.05, -len * 0.4 - 0.156], m: M.glass });
    for (const z of [-0.06, 0.06]) p.push({ box: [0.03, 0.03, 0.014], c: [0, top + 0.02, -len * 0.4 + z], m: M.metal });
  } else {
    // Small reflex sight on the rail.
    p.push({ box: [0.03, 0.03, 0.04], c: [0, top + 0.022, -len * 0.3], m: M.metal });
    p.push({ box: [0.02, 0.018, 0.002], c: [0, top + 0.03, -len * 0.3 - 0.021], m: M.glass });
  }
  p.push({ box: [0.04, 0.006, len * 0.3], c: [0, 0.03 + bulk * 0.25, -len * 0.55], m: M.accent }); // accent stripe
  return glb(p, mats(accent));
}

/** Handgun: slide, frame and grip. */
function pistol({ len = 0.19, accent, auto = false }) {
  const p = [
    { box: [0.028, 0.032, len], c: [0, 0.045, -len / 2 + 0.03], m: M.metal }, // slide
    { box: [0.006, 0.02, 0.05], c: [0.0145, 0.05, -0.02], m: M.dark }, // serrations
    { box: [0.026, 0.02, len * 0.85], c: [0, 0.018, -len * 0.42 + 0.02], m: M.polymer }, // frame
    { box: [0.028, 0.11, 0.045], c: [0, -0.04, 0.012], rx: -0.22, m: M.polymer },
    { box: [0.005, 0.005, 0.045], c: [0, -0.005, -0.03], m: M.polymer }, // trigger guard
    { cyl: [0.0055, 0.01], c: [0, 0.048, -len + 0.025], m: M.dark }, // muzzle
    { box: [0.004, 0.008, 0.006], c: [0, 0.065, -len + 0.04], m: M.metal },
    { box: [0.02, 0.008, 0.006], c: [0, 0.065, 0.025], m: M.metal },
    { box: [0.03, 0.004, len * 0.3], c: [0, 0.062, -len * 0.4], m: M.accent },
  ];
  if (auto) p.push({ box: [0.022, 0.13, 0.04], c: [0, -0.1, 0.0], rx: -0.22, m: M.polymer }, { cyl: [0.016, 0.1], c: [0, 0.045, -len - 0.02], m: M.polymer });
  return glb(p, mats(accent));
}

const models = {
  'weapons/p9': pistol({ accent: paint([0.6, 0.6, 0.62]) }),
  'weapons/hornet': pistol({ len: 0.22, auto: true, accent: paint([0.85, 0.65, 0.15]) }),
  'weapons/vespa': gun({ len: 0.3, barrel: 0.04, mag: 0.2, stock: 0.18, guard: 0.14, muzzle: 'suppressor', accent: paint([0.85, 0.4, 0.12]) }),
  'weapons/kestrel': gun({ len: 0.4, barrel: 0.1, mag: 0.17, stock: 0.24, guard: 0.26, accent: paint([0.25, 0.45, 0.3]) }),
  'weapons/carbine': gun({ len: 0.42, barrel: 0.16, mag: 0.1, stock: 0.26, guard: 0.22, accent: paint([0.5, 0.35, 0.2]) }),
  'weapons/breacher': gun({ len: 0.36, barrel: 0.32, mag: 0, stock: 0.26, pump: true, bulk: 0.07, muzzle: 'none', accent: paint([0.45, 0.15, 0.12]) }),
  'weapons/anvil': gun({ len: 0.5, barrel: 0.22, mag: 0.12, stock: 0.26, guard: 0.28, drum: true, bulk: 0.08, accent: paint([0.3, 0.33, 0.36]) }),
  'weapons/longshot': gun({ len: 0.48, barrel: 0.4, mag: 0.08, stock: 0.3, guard: 0.2, scope: true, accent: paint([0.2, 0.28, 0.38]) }),
  'weapons/arc': gun({ len: 0.44, barrel: 0.12, mag: 0.12, stock: 0.2, guard: 0.26, bulk: 0.085, muzzle: 'none', accent: glow([0.25, 0.75, 1.0]) }),
  'weapons/stormlance': gun({ len: 0.48, barrel: 0.24, mag: 0, stock: 0.22, guard: 0.3, bulk: 0.09, muzzle: 'none', accent: glow([0.7, 0.4, 1.0]) }),
  'weapons/verdict': pistol({ len: 0.26, accent: glow([1.0, 0.6, 0.15]) }),
  'props/generator': glb([
    { box: [1.6, 1.1, 1.0], c: [0, 0.65, 0], m: M.accent },
    { box: [1.7, 0.1, 1.1], c: [0, 0.05, 0], m: M.metal },
    { box: [1.2, 0.2, 0.7], c: [0, 1.3, 0], m: M.metal },
    { cyl: [0.09, 0.8], c: [-0.5, 1.75, 0], rx: Math.PI / 2, m: M.metal },
    { cyl: [0.12, 0.08], c: [-0.5, 2.18, 0], rx: Math.PI / 2, m: M.dark },
    { box: [0.4, 0.3, 0.03], c: [0.45, 0.75, 0.51], m: 4 },
    ...[-0.6, -0.3, 0, 0.3, 0.6].map(x => ({ box: [0.04, 0.8, 0.02], c: [x, 0.65, -0.51], m: M.dark })),
  ], [mats(null)[0], mats(null)[1], paint([0.55, 0.45, 0.12]), mats(null)[3], glow([0.2, 1.0, 0.4])]),
};

for (const [name, buf] of Object.entries(models)) {
  const path = `public/assets/${name}.glb`;
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, buf);
  console.log(`${path} ${buf.length} bytes`);
}
