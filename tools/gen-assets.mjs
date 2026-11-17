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

/** Rotates a point/normal about the Z axis (roll), then X (pitch), then Y (yaw). */
const rot = (p, rx = 0, ry = 0, rz = 0) => {
  const [x, y, z] = [p[0] * Math.cos(rz) - p[1] * Math.sin(rz), p[0] * Math.sin(rz) + p[1] * Math.cos(rz), p[2]];
  const y1 = y * Math.cos(rx) - z * Math.sin(rx), z1 = y * Math.sin(rx) + z * Math.cos(rx);
  return [x * Math.cos(ry) + z1 * Math.sin(ry), y1, -x * Math.sin(ry) + z1 * Math.cos(ry)];
};

/** Appends a part's triangles. Parts: { box: [w, h, d] } or { cyl: [radius, length], seg? } along Z, with c (centre), rx/ry/rz (radians), m (material). */
function emit(part, mesh) {
  const { c, rx = 0, ry = 0, rz = 0 } = part;
  const add = (p, n, u, v) => {
    const q = rot(p, rx, ry, rz), nn = rot(n, rx, ry, rz);
    mesh.pos.push(q[0] + c[0], q[1] + c[1], q[2] + c[2]);
    mesh.nrm.push(...nn);
    mesh.uv.push(u, v);
    return mesh.pos.length / 3 - 1;
  };
  if (part.box) {
    // A bevelled block: each face is inset by the bevel, and the gaps along the edges and at the
    // corners are bridged with faces that blend the neighbouring normals, so edges catch the light
    // like machined or moulded parts instead of being knife-sharp.
    const h = part.box.map(v => v / 2);
    const bev = Math.min(Math.min(...part.box) * 0.22, 0.0035);
    const vid = new Map();
    const fv = (k, sk, sa, sb) => {
      const key = `${k}${sk}${sa}${sb}`;
      if (vid.has(key)) return vid.get(key);
      const [a1, a2] = [0, 1, 2].filter(q => q !== k);
      const pos = [0, 0, 0], n = [0, 0, 0];
      pos[k] = sk * h[k]; n[k] = sk;
      pos[a1] = sa * (h[a1] - bev); pos[a2] = sb * (h[a2] - bev);
      const id = add(pos, n, (sa + 1) / 2, (sb + 1) / 2);
      vid.set(key, id);
      return id;
    };
    const P = id => [mesh.pos[id * 3], mesh.pos[id * 3 + 1], mesh.pos[id * 3 + 2]];
    const N = id => [mesh.nrm[id * 3], mesh.nrm[id * 3 + 1], mesh.nrm[id * 3 + 2]];
    // Emits a triangle, flipped if needed so it faces the way its vertex normals point.
    const tri = (i, j, k) => {
      const [a, b, c] = [P(i), P(j), P(k)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const n = [N(i), N(j), N(k)].reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0]);
      if (f[0] * n[0] + f[1] * n[1] + f[2] * n[2] < 0) mesh.idx.push(i, k, j); else mesh.idx.push(i, j, k);
    };
    const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
    for (let k = 0; k < 3; k++) for (const sk of [-1, 1]) quad(fv(k, sk, -1, -1), fv(k, sk, 1, -1), fv(k, sk, 1, 1), fv(k, sk, -1, 1));
    // Edges: faces k and m meet; l is the third axis.
    const other = (k, m) => [0, 1, 2].find(q => q !== k && q !== m);
    const corner = (k, sk, signs) => { const [a1, a2] = [0, 1, 2].filter(q => q !== k); return fv(k, sk, signs[a1], signs[a2]); };
    for (let k = 0; k < 3; k++) for (let m = k + 1; m < 3; m++) for (const sk of [-1, 1]) for (const sm of [-1, 1]) {
      const l = other(k, m);
      const sg = l2 => { const s3 = [0, 0, 0]; s3[k] = sk; s3[m] = sm; s3[l] = l2; return s3; };
      quad(corner(k, sk, sg(-1)), corner(k, sk, sg(1)), corner(m, sm, sg(1)), corner(m, sm, sg(-1)));
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const sg = [sx, sy, sz];
      tri(corner(0, sx, sg), corner(1, sy, sg), corner(2, sz, sg));
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
  const built = glbBuffer(parts, materials);
  built.parts = parts;
  built.materials = materials;
  return built;
}
function glbBuffer(parts, materials) {
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
function gun({ len, barrel, mag = 0, stock = 0, guard = 0, scope = false, drum = false, pump = false, bulk = 0.06, muzzle = 'brake', bipod = false, bolt = false, ammoBox = false, accent }) {
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
  } else if (muzzle === 'flash') {
    // Pronged flash hider.
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      p.push({ box: [0.005, 0.005, 0.04], c: [Math.cos(a) * 0.009, 0.035 + Math.sin(a) * 0.009, tip - 0.018], m: M.metal });
    }
  }
  if (bipod) {
    // Folded bipod legs under the handguard.
    for (const x of [-0.014, 0.014]) p.push({ box: [0.007, 0.007, 0.16], c: [x, 0.012, front - 0.04], m: M.metal });
    p.push({ box: [0.036, 0.014, 0.02], c: [0, 0.018, front + 0.03], m: M.metal });
  }
  if (bolt) {
    // Bolt handle with a round knob on the right side.
    p.push({ box: [0.04, 0.008, 0.008], c: [0.03, top - 0.008, 0.0], m: M.metal });
    p.push({ cyl: [0.009, 0.014], c: [0.052, top - 0.008, 0.0], ry: Math.PI / 2, m: M.metal });
  }
  if (ammoBox) {
    // Belt box hanging under the receiver.
    p.push({ box: [0.07, 0.1, 0.11], c: [0, -0.07, -len * 0.42], m: M.polymer });
    p.push({ box: [0.072, 0.01, 0.112], c: [0, -0.02, -len * 0.42], m: M.metal });
    p.push({ box: [0.03, 0.012, 0.03], c: [0.04, -0.055, -len * 0.42], m: M.dark });
  }
  p.push({ box: [0.006, 0.026, 0.008], c: [0, 0.06, tip + 0.03], m: M.metal }); // front sight
  if (mag && !ammoBox) {
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
function pistol({ len = 0.19, accent, auto = false, comp = false }) {
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
  if (comp) {
    // Compensator with top ports, and an extended magazine for the burst.
    p.push({ box: [0.03, 0.034, 0.04], c: [0, 0.045, -len + 0.01], m: M.metal });
    for (const z of [-0.004, -0.016]) p.push({ box: [0.014, 0.006, 0.006], c: [0, 0.062, -len + 0.01 + z], m: M.dark });
    p.push({ box: [0.022, 0.05, 0.035], c: [0, -0.115, 0.03], rx: -0.22, m: M.polymer });
  }
  return glb(p, mats(accent));
}

/** Bullpup rifle: the magazine sits behind the grip and the receiver runs back to the shoulder. */
function bullpup({ len = 0.6, barrel = 0.1, accent }) {
  const back = 0.17, front = back - len;
  const p = [
    { box: [0.046, 0.085, len], c: [0, 0.035, back - len / 2], m: M.polymer }, // shell
    { box: [0.04, 0.026, len * 0.5], c: [0, 0.09, front + len * 0.42], m: M.polymer }, // top housing
    ...rail(front + 0.04, back - 0.12, 0.105),
    { box: [0.03, 0.1, 0.038], c: [0, -0.045, 0.012], rx: -0.28, m: M.polymer }, // grip
    { box: [0.032, 0.012, 0.09], c: [0, -0.1, -0.02], m: M.polymer }, // full-hand trigger guard
    { box: [0.012, 0.06, 0.012], c: [0, -0.06, -0.065], m: M.polymer },
    { box: [0.004, 0.022, 0.006], c: [0, -0.012, -0.022], rx: 0.3, m: M.metal }, // trigger
    { box: [0.026, 0.15, 0.05], c: [0, -0.07, 0.13], rx: 0.12, m: M.polymer }, // magazine behind the grip
    { box: [0.008, 0.02, 0.06], c: [0.024, 0.05, 0.1], m: M.dark }, // ejection port
    { box: [0.05, 0.095, 0.018], c: [0, 0.035, back + 0.008], m: M.dark }, // butt pad
    { box: [0.048, 0.03, 0.16], c: [0, -0.015, front + 0.1], m: M.polymer }, // fore-end
    { cyl: [0.0085, barrel + 0.04], c: [0, 0.04, front - barrel / 2 + 0.02], m: M.metal }, // barrel
    { cyl: [0.013, 0.045], c: [0, 0.04, front - barrel - 0.01], seg: 10, m: M.metal }, // muzzle
    { box: [0.03, 0.03, 0.04], c: [0, 0.128, front + 0.2], m: M.metal }, // reflex sight
    { box: [0.02, 0.018, 0.002], c: [0, 0.135, front + 0.179], m: M.glass },
    { box: [0.048, 0.006, len * 0.35], c: [0, 0.062, back - len * 0.3], m: M.accent }, // accent stripe
  ];
  return glb(p, mats(accent));
}

/** Break-action double-barrel shotgun. */
function doubleBarrel({ accent }) {
  const p = [
    { box: [0.04, 0.05, 0.12], c: [0, 0.03, -0.04], m: M.metal }, // action
    { box: [0.03, 0.1, 0.038], c: [0, -0.045, 0.012], rx: -0.28, m: M.polymer }, // grip
    { box: [0.036, 0.07, 0.24], c: [0, 0.0, 0.17], rx: 0.12, m: M.polymer }, // stock
    { box: [0.04, 0.09, 0.016], c: [0, -0.016, 0.29], rx: 0.12, m: M.dark }, // butt pad
    { box: [0.006, 0.006, 0.05], c: [0, -0.03, -0.035], m: M.metal }, // trigger guard
    { box: [0.004, 0.022, 0.006], c: [0, -0.012, -0.022], rx: 0.3, m: M.metal }, // triggers
    { box: [0.004, 0.022, 0.006], c: [0, -0.012, -0.034], rx: 0.3, m: M.metal },
    { box: [0.036, 0.03, 0.2], c: [0, 0.012, -0.22], m: M.polymer }, // fore-end
    { box: [0.012, 0.012, 0.02], c: [0, 0.064, 0.01], m: M.metal }, // top lever
    { box: [0.042, 0.012, 0.03], c: [0, 0.03, -0.1], m: M.dark }, // hinge
    { box: [0.04, 0.004, 0.36], c: [0, 0.058, -0.29], m: M.metal }, // sighting rib
    { box: [0.006, 0.006, 0.006], c: [0, 0.063, -0.47], m: M.accent }, // bead
    { box: [0.038, 0.012, 0.1], c: [0, -0.008, 0.12], rx: 0.12, m: M.accent }, // stock inlay
  ];
  for (const x of [-0.0105, 0.0105]) {
    p.push({ cyl: [0.0105, 0.4], c: [x, 0.04, -0.29], seg: 12, m: M.metal });
    p.push({ cyl: [0.0075, 0.002], c: [x, 0.04, -0.491], m: M.dark }); // bore
  }
  return glb(p, mats(accent));
}

/** Six-shot revolver with a long barrel. */
function revolver({ accent }) {
  const p = [
    { box: [0.026, 0.05, 0.08], c: [0, 0.04, -0.02], m: M.metal }, // frame
    { cyl: [0.022, 0.045], c: [0, 0.042, -0.035], seg: 6, m: M.metal }, // cylinder
    { cyl: [0.0085, 0.16], c: [0, 0.055, -0.135], m: M.metal }, // barrel
    { box: [0.012, 0.016, 0.16], c: [0, 0.042, -0.135], m: M.metal }, // ejector shroud
    { box: [0.008, 0.008, 0.15], c: [0, 0.067, -0.13], m: M.metal }, // top rib
    { box: [0.004, 0.012, 0.008], c: [0, 0.075, -0.205], m: M.accent }, // front sight
    { box: [0.012, 0.018, 0.016], c: [0, 0.068, 0.022], rx: -0.4, m: M.metal }, // hammer
    { box: [0.028, 0.1, 0.04], c: [0, -0.035, 0.022], rx: -0.32, m: M.polymer }, // grip
    { box: [0.005, 0.005, 0.04], c: [0, -0.002, -0.02], m: M.metal }, // trigger guard
    { box: [0.004, 0.02, 0.006], c: [0, 0.008, -0.012], rx: 0.3, m: M.metal }, // trigger
    { box: [0.03, 0.02, 0.03], c: [0, -0.02, 0.018], rx: -0.32, m: M.accent }, // grip medallion band
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    p.push({ box: [0.004, 0.004, 0.046], c: [Math.cos(a) * 0.021, 0.042 + Math.sin(a) * 0.021, -0.035], m: M.dark }); // flutes
  }
  return glb(p, mats(accent));
}

/** Shoulder-fired rocket launcher: a long tube with a sight, grips and a loaded rocket nose. */
function launcher({ accent }) {
  // The tube mostly runs forward of the grip so it does not fill the screen in first person.
  const p = [
    { cyl: [0.036, 0.84], c: [0, 0.06, -0.33], seg: 16, m: M.polymer }, // tube
    { cyl: [0.043, 0.05], c: [0, 0.06, -0.74], seg: 16, m: M.metal }, // front ring
    { cyl: [0.045, 0.06], c: [0, 0.06, 0.1], seg: 16, m: M.metal }, // rear venturi
    { cyl: [0.026, 0.002], c: [0, 0.06, 0.131], seg: 16, m: M.dark },
    { cyl: [0.041, 0.03], c: [0, 0.06, -0.3], seg: 16, m: M.accent }, // bands
    { cyl: [0.041, 0.03], c: [0, 0.06, -0.05], seg: 16, m: M.accent },
    { box: [0.03, 0.1, 0.038], c: [0, -0.045, 0.012], rx: -0.28, m: M.polymer }, // grip
    { box: [0.03, 0.09, 0.034], c: [0, -0.035, -0.32], rx: -0.15, m: M.polymer }, // front grip
    { box: [0.006, 0.006, 0.05], c: [0, -0.03, -0.035], m: M.metal }, // trigger guard
    { box: [0.004, 0.022, 0.006], c: [0, -0.012, -0.022], rx: 0.3, m: M.metal }, // trigger
    { box: [0.036, 0.03, 0.12], c: [0, 0.02, -0.02], m: M.metal }, // grip mount
    { box: [0.02, 0.05, 0.07], c: [-0.055, 0.1, -0.24], m: M.metal }, // side sight
    { box: [0.016, 0.016, 0.002], c: [-0.055, 0.11, -0.276], m: M.glass },
    { box: [0.024, 0.014, 0.05], c: [-0.032, 0.085, -0.24], m: M.metal }, // sight bracket
    { box: [0.046, 0.026, 0.09], c: [0, 0.095, 0.03], m: M.polymer }, // shoulder rest
  ];
  return glb(p, mats(accent));
}

/** The rocket in flight (and loaded in the launcher): points down -Z. */
function rocket() {
  const p = [
    { cyl: [0.03, 0.26], c: [0, 0, 0], seg: 12, m: M.accent },
    { cyl: [0.022, 0.05], c: [0, 0, -0.155], seg: 12, m: M.accent },
    { cyl: [0.012, 0.04], c: [0, 0, -0.2], seg: 12, m: M.metal },
    { cyl: [0.024, 0.04], c: [0, 0, 0.15], seg: 12, m: M.metal },
  ];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    p.push({ box: [0.004, 0.05, 0.06], c: [Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0.13], rz: a, m: M.metal });
  }
  return glb(p, mats(paint([0.42, 0.48, 0.3])));
}

/**
 * Side view of a model as an SVG picture (muzzle to the right), drawn from the same parts as the
 * 3D model so loadout pictures always match what is in the player's hands.
 */
function sideView(parts, materials) {
  const css = m => {
    const mat = materials[m] ?? {};
    if (mat.name === 'layer:6') return '#7c838d';
    if (mat.name === 'layer:9') return '#2f333a';
    if (m === M.dark) return '#16181c';
    if (m === M.glass) return '#58c3ea';
    const c = mat.color ?? [0.5, 0.5, 0.5];
    const k = mat.emissive ? 1.25 : 1.0;
    return '#' + c.map(v => Math.round(Math.min(1, Math.pow(v, 1 / 2.2) * k) * 255).toString(16).padStart(2, '0')).join('');
  };
  const shapes = [];
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  // Far side first, so parts nearer the viewer are painted over it.
  for (const part of [...parts].sort((a, b) => a.c[0] - b.c[0])) {
    const { c, rx = 0, ry = 0 } = part;
    let pts;
    if (part.cyl && Math.abs(Math.abs(ry) - Math.PI / 2) < 0.01) {
      // A cylinder seen end-on: a disc.
      const r = part.cyl[0];
      pts = Array.from({ length: 16 }, (_, k) => [c[2] + Math.cos(k / 16 * 6.2832) * r, c[1] + Math.sin(k / 16 * 6.2832) * r]);
    } else {
      const [h, d] = part.box ? [part.box[1], part.box[2]] : [part.cyl[0] * 2, part.cyl[1]];
      pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sy, sz]) => {
        const y = sy * h / 2, z = sz * d / 2;
        return [c[2] + y * Math.sin(rx) + z * Math.cos(rx), c[1] + y * Math.cos(rx) - z * Math.sin(rx)];
      });
    }
    const out = pts.map(([z, y]) => [-z * 1000, -y * 1000]);
    for (const [x, y] of out) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    shapes.push(`<polygon points="${out.map(q => q.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="${css(part.m)}"/>`);
  }
  const pad = 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(x0 - pad).toFixed(0)} ${(y0 - pad).toFixed(0)} ${(x1 - x0 + pad * 2).toFixed(0)} ${(y1 - y0 + pad * 2).toFixed(0)}" stroke="#0b0d10" stroke-width="1.6" stroke-linejoin="round">${shapes.join('')}</svg>\n`;
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
  'weapons/talon': gun({ len: 0.44, barrel: 0.14, mag: 0.16, stock: 0.25, guard: 0.24, muzzle: 'flash', accent: paint([0.62, 0.55, 0.42]) }),
  'weapons/mako': bullpup({ len: 0.6, barrel: 0.1, accent: paint([0.2, 0.35, 0.5]) }),
  'weapons/wasp': gun({ len: 0.26, barrel: 0.05, mag: 0.24, stock: 0.15, guard: 0.1, bulk: 0.07, muzzle: 'flash', accent: paint([0.9, 0.75, 0.1]) }),
  'weapons/bastion': gun({ len: 0.32, barrel: 0.06, mag: 0.16, stock: 0.2, guard: 0.12, bulk: 0.085, muzzle: 'suppressor', accent: paint([0.3, 0.32, 0.28]) }),
  'weapons/reaper': gun({ len: 0.4, barrel: 0.2, mag: 0.1, drum: true, stock: 0.26, guard: 0.22, bulk: 0.08, accent: paint([0.55, 0.12, 0.1]) }),
  'weapons/twinfang': doubleBarrel({ accent: paint([0.4, 0.25, 0.15]) }),
  'weapons/torrent': gun({ len: 0.56, barrel: 0.28, mag: 0.1, ammoBox: true, stock: 0.28, guard: 0.3, bulk: 0.09, bipod: true, accent: paint([0.35, 0.4, 0.25]) }),
  'weapons/hawkeye': gun({ len: 0.46, barrel: 0.3, mag: 0.09, stock: 0.28, guard: 0.28, scope: true, muzzle: 'flash', accent: paint([0.45, 0.42, 0.35]) }),
  'weapons/monolith': gun({ len: 0.56, barrel: 0.46, mag: 0.1, stock: 0.32, guard: 0.22, scope: true, bulk: 0.08, bipod: true, bolt: true, accent: paint([0.15, 0.17, 0.2]) }),
  'weapons/mamba': revolver({ accent: paint([0.7, 0.55, 0.2]) }),
  'weapons/rattler': pistol({ len: 0.21, accent: paint([0.2, 0.55, 0.45]), comp: true }),
  'weapons/comet': launcher({ accent: paint([0.35, 0.45, 0.2]) }),
  'props/rocket': rocket(),
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
  if (name.startsWith('weapons/')) writeFileSync(`public/assets/${name}.svg`, sideView(buf.parts, buf.materials));
}
