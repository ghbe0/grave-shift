// Client: rendering, input, local movement/shooting, HUD and audio. The host also runs the Sim in this page.
import * as THREE from 'three';
import { parseMap, CELL, WALL_H, DOORS, INTERACT, WEAPONS, PERKS, CRATE_COST, interactPos, useRange, collide, isSolid, cellCenter } from './rules.js';
import { Sim } from './sim.js';
import { hostRoom, joinRoom } from './net.js';

const $ = id => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const map = parseMap();
const COLORS = ['#e9e4da', '#5dade2', '#f4d03f', '#58d68d'];
let open = new Set();

// ---------- renderer, scenes ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x06080d);
scene.fog = new THREE.FogExp2(0x06080d, 0.035);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
scene.add(camera);

// The gun renders in its own pass so it never clips into walls.
const viewScene = new THREE.Scene();
const viewCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 10);
const viewKey = new THREE.DirectionalLight(0xffd8b0, 0.7);
viewKey.position.set(0.5, 1, 0.3);
viewScene.add(viewCam, viewKey, new THREE.HemisphereLight(0x6a7a99, 0x1a140f, 0.5));
const view = new THREE.Group();
view.scale.setScalar(0.75);
viewCam.add(view);

addEventListener('resize', () => {
  for (const c of [camera, viewCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- procedural textures ----------
function canvasTex(w, h, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function grime(g, w, h, n, a) {
  for (let i = 0; i < n; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * a})`; g.fillRect(Math.random() * w, Math.random() * h, rand(1, 7), rand(1, 7)); }
}
const brickTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#231e1b'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < 8; y++) for (let x = -1; x < 5; x++) {
    const v = rand(55, 90);
    g.fillStyle = `rgb(${v + 28 | 0},${v * 0.5 | 0},${v * 0.4 | 0})`;
    g.fillRect(x * 64 + (y % 2) * 32 + 2, y * 32 + 2, 60, 28);
  }
  grime(g, w, h, 900, 0.35);
}, 1.5, 2);
const floorTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#3a3935'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 4000; i++) { const v = rand(38, 72) | 0; g.fillStyle = `rgb(${v},${v},${v - 4})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 3; g.strokeRect(0, 0, w, h);
  grime(g, w, h, 300, 0.35);
}, map.w, map.h);
const plankTex = canvasTex(128, 128, (g, w, h) => {
  for (let i = 0; i < 4; i++) { const v = rand(70, 110) | 0; g.fillStyle = `rgb(${v},${v * 0.65 | 0},${v * 0.4 | 0})`; g.fillRect(0, i * 32, w, 30); }
  g.fillStyle = '#1a120c';
  for (let i = 0; i < 4; i++) g.fillRect(0, i * 32 + 30, w, 2);
  grime(g, w, h, 200, 0.4);
});
const flashTex = canvasTex(64, 64, (g) => {
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,230,1)'); r.addColorStop(0.3, 'rgba(255,190,90,0.8)'); r.addColorStop(1, 'rgba(255,120,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
});

const mat = o => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
function part(parent, m, sx, sy, sz, x, y, z) {
  const p = new THREE.Mesh(boxGeo, m);
  p.scale.set(sx, sy, sz); p.position.set(x, y, z);
  parent.add(p);
  return p;
}

// ---------- level ----------
const solids = []; // what bullets stop on
const floor = new THREE.Mesh(new THREE.PlaneGeometry(map.w * CELL, map.h * CELL), mat({ map: floorTex }));
floor.rotation.x = -Math.PI / 2;
floor.position.set(map.w * CELL / 2, 0, map.h * CELL / 2);
scene.add(floor); solids.push(floor);

const wallCells = [];
map.rows.forEach((row, cy) => [...row].forEach((ch, cx) => ch === '#' && wallCells.push([cx, cy])));
const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL, WALL_H, CELL), mat({ map: brickTex }), wallCells.length);
wallCells.forEach(([cx, cy], i) => walls.setMatrixAt(i, new THREE.Matrix4().makeTranslation((cx + 0.5) * CELL, WALL_H / 2, (cy + 0.5) * CELL)));
scene.add(walls); solids.push(walls);

// Debris piles block each door until bought.
const plankMat = mat({ map: plankTex });
const debris = {};
for (const [d, [cx, cy]] of Object.entries(map.doorCells)) {
  const g = new THREE.Group(), c = cellCenter(cx, cy);
  g.position.set(c.x, 0, c.z);
  for (let i = 0; i < 10; i++) {
    const b = part(g, plankMat, rand(0.9, 1.9), rand(0.45, 0.9), rand(0.7, 1.5), rand(-0.8, 0.8), 0.35 + Math.floor(i / 3) * 0.75, rand(-0.8, 0.8));
    b.rotation.set(rand(-0.25, 0.25), rand(0, 3), rand(-0.25, 0.25));
  }
  scene.add(g);
  debris[d] = g;
}

// Machines face away from the wall they stand against.
function faceAngle(cx, cy) {
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]])
    if (!isSolid(map, cx + dx, cy + dy, open) && isSolid(map, cx - dx, cy - dy, open)) return Math.atan2(dx, dy);
  return 0;
}
function signTex(top, bottom, color) {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#0d0d0f'; g.fillRect(0, 0, w, h);
    g.strokeStyle = color; g.lineWidth = 10; g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = color; g.textAlign = 'center';
    g.font = '900 96px Impact, sans-serif'; g.fillText(top, w / 2, 130);
    g.font = '700 30px sans-serif'; g.fillStyle = '#eee'; g.fillText(bottom, w / 2, 200);
  });
}
const machines = [];
for (const it of INTERACT) {
  if (it.type !== 'perk' && it.type !== 'crate') continue;
  const g = new THREE.Group(), c = cellCenter(it.cx, it.cy);
  g.position.set(c.x, 0, c.z);
  g.rotation.y = faceAngle(it.cx, it.cy);
  if (it.type === 'perk') {
    const pk = PERKS[it.perk];
    part(g, mat({ color: pk.color, roughness: 0.45, metalness: 0.3 }), 1.3, 2.3, 0.9, 0, 1.15, 0);
    part(g, mat({ color: 0x111111, metalness: 0.6, roughness: 0.4 }), 1.4, 0.15, 1.0, 0, 2.35, 0);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.05), new THREE.MeshBasicMaterial({ map: signTex(pk.icon, pk.name, pk.color) }));
    sign.position.set(0, 1.55, 0.451);
    g.add(sign);
    const glow = new THREE.PointLight(pk.color, 5, 6, 1.5);
    glow.position.set(0, 2.2, 1.0);
    g.add(glow);
  } else {
    part(g, mat({ color: 0x2b3a2e, roughness: 0.6, metalness: 0.5 }), 1.9, 0.85, 0.95, 0, 0.43, 0);
    part(g, new THREE.MeshBasicMaterial({ color: 0x7fe0ff }), 1.92, 0.05, 0.97, 0, 0.8, 0);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.75), new THREE.MeshBasicMaterial({ map: signTex('?', 'LUCKY CRATE', '#7fe0ff') }));
    sign.position.set(0, 0.45, 0.48);
    g.add(sign);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.5, 40, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 20;
    beam.raycast = () => {}; // bullets pass through the light beam
    g.add(beam);
  }
  scene.add(g);
  machines.push(g);
  solids.push(g);
}

// Gun looks, shared by the viewmodel and the chalk outlines on walls.
const LOOK = {
  pistol:  { len: 0.22, col: 0x2a2a2a, stock: 0, mag: 0.1 },
  carbine: { len: 0.75, col: 0x5b3b22, stock: 0.25, mag: 0.1 },
  smg:     { len: 0.42, col: 0x1f1f22, stock: 0.15, mag: 0.18 },
  shotgun: { len: 0.7, col: 0x3e2a1a, stock: 0.25, mag: 0 },
  ar:      { len: 0.6, col: 0x2c3326, stock: 0.22, mag: 0.16 },
  lmg:     { len: 0.75, col: 0x222222, stock: 0.25, mag: 0.14, box: true },
  sniper:  { len: 0.9, col: 0x353029, stock: 0.25, mag: 0.08, scope: true },
  arc:     { len: 0.5, col: 0x163d2e, stock: 0.1, mag: 0, glow: 0x3dff9a },
};
for (const it of INTERACT) {
  if (it.type !== 'wall') continue;
  const w = WEAPONS[it.weapon], L = LOOK[it.weapon], pos = interactPos(map, it);
  const tex = canvasTex(512, 256, (g, cw) => {
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, cw, 256);
    g.strokeStyle = '#e8e2d0'; g.lineWidth = 4; g.lineJoin = 'round';
    const len = L.len * 330, x0 = cw / 2 - len / 2, y = 90;
    g.strokeRect(x0, y - 14, len * 0.55, 28);
    g.beginPath(); g.moveTo(x0 + len * 0.55, y - 6); g.lineTo(x0 + len, y - 6); g.stroke();
    if (L.stock) g.strokeRect(x0 - L.stock * 220, y - 10, L.stock * 220, 24);
    if (L.mag) g.strokeRect(x0 + len * 0.3, y + 14, 18, L.mag * 200);
    g.strokeRect(x0 + 16, y + 14, 16, 30);
    g.fillStyle = '#e8e2d0'; g.textAlign = 'center';
    g.font = '700 34px sans-serif'; g.fillText(w.name, cw / 2, 200);
    g.font = '600 28px sans-serif'; g.fillText(String(w.cost), cw / 2, 236);
  });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  panel.position.set(pos.x, 1.6, pos.z);
  panel.rotation.y = { W: Math.PI / 2, E: -Math.PI / 2, N: 0, S: Math.PI }[it.side];
  scene.add(panel);
}

// Dirt patches where zombies climb out.
const dirtMat = new THREE.MeshStandardMaterial({ color: 0x2a1e14, roughness: 1 });
for (const [cx, cy] of map.spawns) {
  const d = new THREE.Mesh(new THREE.CircleGeometry(0.9, 12), dirtMat), c = cellCenter(cx, cy);
  d.rotation.x = -Math.PI / 2; d.position.set(c.x, 0.01, c.z);
  scene.add(d);
}

// ---------- lights ----------
scene.add(new THREE.HemisphereLight(0x50607e, 0x15110d, 0.6));
const moon = new THREE.DirectionalLight(0x8090c0, 0.4);
moon.position.set(-30, 50, 10);
scene.add(moon);
const lamps = [[4, 3], [11, 3], [16.5, 3], [23, 3.5], [5, 9.5], [14, 9.5], [22, 9.5]].map(([cx, cy]) => {
  const l = new THREE.PointLight(0xffa860, 28, 24, 1.5), c = cellCenter(cx, cy);
  l.position.set(c.x, 3.5, c.z);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
  bulb.position.copy(l.position);
  scene.add(l, bulb);
  return l;
});
const flashlight = new THREE.SpotLight(0xfff0d8, 16, 32, 0.5, 0.6, 1.3);
flashlight.position.set(0.25, -0.15, 0);
flashlight.target.position.set(0, -0.4, -5);
camera.add(flashlight, flashlight.target);
const worldFlash = new THREE.PointLight(0xffb060, 0, 10, 2);
scene.add(worldFlash);

// ---------- particles & tracers ----------
const MAXP = 500, pPos = new Float32Array(MAXP * 3).fill(-100), pCol = new Float32Array(MAXP * 3), pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP);
let pNext = 0;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.07, vertexColors: true }));
particles.frustumCulled = false;
scene.add(particles);
const BLOOD = new THREE.Color(0x6e0505), SPARK = new THREE.Color(0xffcc66), DUST = new THREE.Color(0x5a4a3a);
function burst(p, n, color, speed = 3, life = 0.6) {
  for (let i = 0; i < n; i++) {
    const k = pNext++ % MAXP, j = k * 3;
    pPos[j] = p.x; pPos[j + 1] = p.y; pPos[j + 2] = p.z;
    pVel[j] = rand(-1, 1) * speed; pVel[j + 1] = rand(0, 1.2) * speed; pVel[j + 2] = rand(-1, 1) * speed;
    pCol[j] = color.r; pCol[j + 1] = color.g; pCol[j + 2] = color.b;
    pLife[k] = life * rand(0.6, 1);
  }
}
const tracers = [];
function tracer(a, b, color) {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
  scene.add(line);
  tracers.push({ line, t: 0.06 });
}
function updateFx(dt) {
  for (let k = 0; k < MAXP; k++) {
    if (pLife[k] <= 0) continue;
    const j = k * 3;
    pLife[k] -= dt;
    pVel[j + 1] -= 9.8 * dt;
    pPos[j] += pVel[j] * dt; pPos[j + 1] = Math.max(0.02, pPos[j + 1] + pVel[j + 1] * dt); pPos[j + 2] += pVel[j + 2] * dt;
    if (pLife[k] <= 0) pPos[j + 1] = -100;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    if ((tr.t -= dt) > 0) continue;
    scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose();
    tracers.splice(i, 1);
  }
  worldFlash.intensity = Math.max(0, worldFlash.intensity - dt * 400);
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 80);
  if ((flashT -= dt) <= 0) flashSprite.visible = false;
}

// ---------- characters ----------
const skinMats = [0x6f7d5c, 0x7a7466, 0x5d6b55, 0x80786a].map(c => mat({ color: c }));
const clothMats = [0x3b3428, 0x2c3440, 0x4a2e2a, 0x30302c, 0x3d3d33].map(c => mat({ color: c }));
const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffa21a });
const pick = a => a[Math.floor(Math.random() * a.length)];
function limb(parent, m, hand, x, y, len, w) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, 0);
  part(pivot, m, w, len, w, 0, -len / 2, 0);
  if (hand) part(pivot, hand, w * 0.9, 0.12, w * 0.9, 0, -len - 0.05, 0);
  parent.add(pivot);
  return pivot;
}
function makeHuman(skin, shirt, pants, eyes) {
  const g = new THREE.Group(), body = new THREE.Group();
  g.add(body);
  part(body, shirt, 0.52, 0.68, 0.28, 0, 1.16, 0);
  const head = part(body, skin, 0.3, 0.32, 0.3, 0, 1.68, 0);
  if (eyes) { part(body, eyes, 0.07, 0.04, 0.02, -0.07, 1.71, 0.155); part(body, eyes, 0.07, 0.04, 0.02, 0.07, 1.71, 0.155); }
  const arms = [limb(body, shirt, skin, -0.34, 1.46, 0.6, 0.15), limb(body, shirt, skin, 0.34, 1.46, 0.6, 0.15)];
  const legs = [limb(body, pants, null, -0.13, 0.82, 0.82, 0.19), limb(body, pants, null, 0.13, 0.82, 0.82, 0.19)];
  g.userData = { body, head, arms, legs, phase: Math.random() * 6 };
  return g;
}

const zMeshes = new Map(), pMeshes = new Map(), corpses = [];
function killZombie(id, head) {
  const o = zMeshes.get(id);
  if (!o) return;
  zMeshes.delete(id);
  burst(o.position.clone().setY(1.2), 16, BLOOD, 2.5);
  if (head) { o.userData.head.visible = false; burst(o.position.clone().setY(1.7), 18, BLOOD, 3.5); }
  corpses.push({ o, t: 0 });
}
const lerpAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

function animateZombies(dt) {
  const k = isHost ? 1 : Math.min(1, dt * 14);
  for (const o of zMeshes.values()) {
    const u = o.userData, ox = o.position.x, oz = o.position.z;
    o.position.x += (u.tx - ox) * k;
    o.position.z += (u.tz - oz) * k;
    const sp = Math.hypot(o.position.x - ox, o.position.z - oz) / Math.max(dt, 1e-4);
    const rising = clock - u.born < 1.2;
    o.position.y = Math.min(0, -1.9 + (clock - u.born) * 1.6);
    if (rising && Math.random() < dt * 20) burst(new THREE.Vector3(o.position.x, 0.1, o.position.z), 2, DUST, 1.5, 0.5);
    o.rotation.y = lerpAngle(o.rotation.y, u.tyaw, Math.min(1, dt * 10));
    u.phase += dt * sp * 2.6;
    const sw = Math.sin(u.phase) * Math.min(0.7, sp * 0.18);
    u.legs[0].rotation.x = sw; u.legs[1].rotation.x = -sw;
    const reach = u.swing ? -2.3 + Math.sin(clock * 22) * 0.35 : -1.45;
    u.arms[0].rotation.x = reach + Math.sin(u.phase + 1) * 0.12;
    u.arms[1].rotation.x = reach - Math.sin(u.phase) * 0.12;
    u.body.rotation.x = u.kind === 2 ? 0.28 : 0.08;
  }
  for (let i = corpses.length - 1; i >= 0; i--) {
    const c = corpses[i];
    c.t += dt;
    c.o.userData.body.rotation.x = -Math.min(1.55, c.t * 4);
    if (c.t > 1.5) c.o.position.y -= dt * 0.8;
    if (c.t > 2.5) { scene.remove(c.o); corpses.splice(i, 1); }
  }
}

function nameTag(text, color) {
  const tex = canvasTex(256, 64, (g, w, h) => {
    g.font = '700 30px sans-serif'; g.textAlign = 'center';
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 10, w, 44);
    g.fillStyle = color; g.fillText(text, w / 2, 43);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(1.4, 0.35, 1);
  s.position.y = 2.15;
  return s;
}
function syncPlayers(snap) {
  const seen = new Set();
  snap.p.forEach((p, i) => {
    if (p.id === myId) return;
    seen.add(p.id);
    let o = pMeshes.get(p.id);
    if (!o) {
      o = makeHuman(skinMats[1], mat({ color: new THREE.Color(COLORS[i]).multiplyScalar(0.5) }), mat({ color: 0x222222 }), null);
      part(o.userData.body, mat({ color: 0x1a1a1a }), 0.08, 0.1, 0.6, 0.2, 1.3, 0.45);
      o.position.set(p.x, p.y, p.z);
      scene.add(o);
      pMeshes.set(p.id, o);
    }
    const label = (p.dn ? '▼ ' : '') + p.n, color = p.dn ? '#ff5544' : COLORS[i];
    if (o.userData.label !== label + color) {
      if (o.userData.tag) { o.remove(o.userData.tag); o.userData.tag.material.map.dispose(); o.userData.tag.material.dispose(); }
      o.userData.tag = nameTag(label, color);
      o.userData.label = label + color;
      o.add(o.userData.tag);
    }
    Object.assign(o.userData, { tx: p.x, ty: p.y, tz: p.z, tyaw: p.yaw + Math.PI, dn: p.dn, dd: p.dd });
  });
  for (const [id, o] of pMeshes) if (!seen.has(id)) { scene.remove(o); pMeshes.delete(id); }
}
function animatePlayers(dt) {
  const k = Math.min(1, dt * 12);
  for (const o of pMeshes.values()) {
    const u = o.userData, ox = o.position.x, oz = o.position.z;
    o.position.x += (u.tx - ox) * k; o.position.y += (u.ty - o.position.y) * k; o.position.z += (u.tz - oz) * k;
    o.rotation.y = lerpAngle(o.rotation.y, u.tyaw, k);
    o.visible = !u.dd;
    const sp = Math.hypot(o.position.x - ox, o.position.z - oz) / Math.max(dt, 1e-4);
    u.phase += dt * sp * 2.2;
    const sw = Math.sin(u.phase) * Math.min(0.6, sp * 0.12);
    u.legs[0].rotation.x = sw; u.legs[1].rotation.x = -sw;
    u.arms[0].rotation.x = u.arms[1].rotation.x = -1.4;
    u.body.rotation.x = u.dn ? -1.45 : 0;
    u.body.position.y = u.dn ? 0.2 : 0;
  }
}

// ---------- viewmodel ----------
const muzzleLight = new THREE.PointLight(0xffb060, 0, 3, 2);
const flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
flashSprite.scale.set(0.25, 0.25, 1);
flashSprite.visible = false;
const gloveMat = mat({ color: 0x2b2620 });
let flashT = 0;
function buildGun(id) {
  view.clear();
  const L = LOOK[id], body = mat({ color: L.col, roughness: 0.6, metalness: 0.35 }), metal = mat({ color: 0x18181a, roughness: 0.4, metalness: 0.7 });
  part(view, body, 0.07, 0.09, L.len * 0.55, 0, 0, -L.len * 0.25);
  part(view, metal, 0.03, 0.03, L.len * 0.5, 0, 0.02, -L.len * 0.65);
  part(view, metal, 0.05, 0.12, 0.05, 0, -0.08, 0);
  if (L.stock) part(view, body, 0.06, 0.1, L.stock, 0, -0.02, L.stock / 2 + 0.02);
  if (L.mag) part(view, metal, 0.05, L.mag, 0.07, 0, -0.05 - L.mag / 2, -L.len * 0.2);
  if (L.scope) part(view, metal, 0.05, 0.05, 0.28, 0, 0.08, -0.28);
  if (L.box) part(view, metal, 0.11, 0.11, 0.12, 0.06, -0.09, -0.25);
  if (L.glow) for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 12), new THREE.MeshBasicMaterial({ color: L.glow }));
    r.position.set(0, 0.02, -L.len * (0.45 + i * 0.12));
    view.add(r);
  }
  part(view, gloveMat, 0.08, 0.08, 0.14, 0.01, -0.09, 0.04);
  part(view, gloveMat, 0.08, 0.07, 0.15, -0.02, -0.05, -L.len * 0.42);
  const mz = new THREE.Vector3(0, 0.02, -L.len * 0.92);
  flashSprite.position.copy(mz); muzzleLight.position.copy(mz);
  view.add(flashSprite, muzzleLight);
}

// ---------- audio (all procedural) ----------
let ac = null, master = null, noiseBuf = null;
function audio() {
  if (!ac) {
    ac = new AudioContext();
    master = ac.createGain(); master.gain.value = 0.45; master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
function noise(dur, vol, type, freq, q = 1) {
  const a = audio(), t = a.currentTime, s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5); s.stop(t + dur);
}
function tone(freq, dur, vol, type = 'sine', delay = 0, to = null) {
  const a = audio(), t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
const sfx = {
  shot(id) {
    if (id === 'arc') { tone(1400, 0.25, 0.25, 'sawtooth', 0, 180); noise(0.2, 0.3, 'highpass', 3000); return; }
    const big = id === 'shotgun' || id === 'sniper';
    noise(big ? 0.35 : 0.14, big ? 0.9 : 0.6, 'lowpass', big ? 1600 : 2800);
    tone(big ? 70 : 110, 0.12, 0.6, 'sine', 0, 40);
  },
  hit: () => tone(2400, 0.03, 0.08, 'square'),
  head: () => { tone(1800, 0.05, 0.12, 'square'); tone(2600, 0.05, 0.1, 'square', 0.04); },
  click: () => tone(900, 0.02, 0.1, 'square'),
  reload: () => { tone(600, 0.03, 0.15, 'square'); tone(400, 0.04, 0.15, 'square', 0.25); },
  knife: () => noise(0.15, 0.4, 'bandpass', 1800, 2),
  buy: () => { tone(880, 0.1, 0.2); tone(1320, 0.18, 0.2, 'sine', 0.09); },
  deny: () => tone(110, 0.3, 0.25, 'sawtooth'),
  perk: () => [392, 494, 587, 784].forEach((f, i) => tone(f, 0.25, 0.18, 'triangle', i * 0.12)),
  door: () => { noise(0.8, 0.6, 'lowpass', 400); tone(60, 0.6, 0.4, 'sine', 0, 30); },
  hurt: () => noise(0.25, 0.7, 'lowpass', 500),
  down: () => tone(200, 1.2, 0.3, 'sawtooth', 0, 60),
  round: () => { tone(55, 3.5, 0.25, 'sawtooth', 0, 52); tone(82.4, 3.5, 0.15, 'sawtooth', 0.2, 80); tone(110, 3, 0.1, 'triangle', 0.4); },
  roundEnd: () => [330, 262, 220, 165].forEach((f, i) => tone(f, 0.6, 0.15, 'triangle', i * 0.25)),
  groan(x, z, pitch) {
    const a = audio(), t = a.currentTime;
    const pan = new PannerNode(a, { positionX: x, positionY: 1.6, positionZ: z, distanceModel: 'inverse', refDistance: 2, rolloffFactor: 1.3 });
    const o = a.createOscillator(), lfo = a.createOscillator(), lg = a.createGain(), f = a.createBiquadFilter(), g = a.createGain();
    const base = rand(70, 120) * pitch;
    o.type = 'sawtooth'; o.frequency.setValueAtTime(base, t); o.frequency.linearRampToValueAtTime(base * 0.7, t + 0.9);
    lfo.frequency.value = rand(5, 9); lg.gain.value = 12; lfo.connect(lg).connect(o.frequency);
    f.type = 'lowpass'; f.frequency.value = 700;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.25, t + 0.15); g.gain.exponentialRampToValueAtTime(0.0001, t + 1);
    o.connect(f).connect(g).connect(pan).connect(master);
    o.start(t); lfo.start(t); o.stop(t + 1.05); lfo.stop(t + 1.05);
  },
};
function updateListener() {
  if (!ac) return;
  const L = ac.listener, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
  if (L.positionX) {
    L.positionX.value = P.x; L.positionY.value = 1.6; L.positionZ.value = P.z;
    L.forwardX.value = fx; L.forwardY.value = 0; L.forwardZ.value = fz;
  } else { L.setPosition(P.x, 1.6, P.z); L.setOrientation(fx, 0, fz, 0, 1, 0); }
}

// ---------- game state ----------
let isHost = false, myId = null, sim = null, roomCode = null, netError = '', peerRef = null, hostConn = null;
const conns = new Map();
let playing = false, paused = false, locked = false, overShown = false;
let lastSnap = null, me = null, prevPts = null, clock = 0;
const P = { x: map.start.x, y: 0, z: map.start.z, vy: 0, yaw: -Math.PI / 2, pitch: 0, slide: 0, sdx: 0, sdz: 0, eye: 1.65 };
let guns = [], cur = 0, fireCd = 0, reloadT = 0, reloadTotal = 1, switchT = 0, meleeT = 0, recoil = 0, crateT = 0, crateW = null;
let sprinting = false, moving = false, ads = false, adsK = 0, sprintK = 0, bobPhase = 0, hurtFlash = 0, groanCd = 1, netT = 0, stateT = 0;
let use = null, firedPress = false;
const keys = {};
let mouseL = false, mouseR = false;

const hasPerk = k => !!me?.pk.includes(k);
const alive = () => !me || (!me.dn && !me.dd);
const canAct = () => !!me && alive() && !paused;

function toHost(msg) {
  if (isHost) sim.handle(myId, msg);
  else if (hostConn?.open) hostConn.send(msg);
}
function route(to, msg) {
  if (to === '*') { onMsg(msg); for (const c of conns.values()) if (c.open) c.send(msg); }
  else if (to === myId) onMsg(msg);
  else conns.get(to)?.send(msg);
}
function flush() { for (const [to, msg] of sim.out.splice(0)) route(to, msg); }

function onMsg(m) {
  switch (m?.t) {
    case 'snap': return applySnap(m);
    case 'welcome': myId = m.id; return enterGame();
    case 'full': return setMenuMsg('That room is full (4 players max).');
    case 'respawn':
      Object.assign(P, { x: m.x, y: 0, z: m.z, vy: 0, yaw: -Math.PI / 2, pitch: 0, slide: 0 });
      guns = [{ id: 'pistol', mag: WEAPONS.pistol.mag, res: WEAPONS.pistol.res }];
      cur = 0; reloadT = 0; crateT = 0;
      return buildGun('pistol');
    case 'reset':
      for (const o of zMeshes.values()) scene.remove(o);
      zMeshes.clear();
      open = new Set();
      for (const d of Object.values(debris)) d.visible = true;
      if (overShown) { overShown = false; $('over').hidden = true; if (!locked) showPause(); }
      return;
    case 'round': banner(`ROUND ${m.round}`, 3500); return sfx.round();
    case 'roundEnd': return sfx.roundEnd();
    case 'door': return openDoor(m.door, true);
    case 'give': giveWeapon(m.w); return sfx.buy();
    case 'crate': crateT = 2.2; crateW = m.w; sfx.buy(); return toast('The crate rattles...');
    case 'perk': sfx.perk(); return toast(`${PERKS[m.perk].name}: ${PERKS[m.perk].desc}`);
    case 'deny': sfx.deny(); return toast('Not enough points');
    case 'hurt': hurtFlash = 0.6; return sfx.hurt();
    case 'zdie': return killZombie(m.id, m.head);
    case 'down': if (m.id === myId) sfx.down(); return toast(m.id === myId ? 'You are down!' : `${m.name} is down! Hold F near them to revive.`);
    case 'revived': return toast(m.id === myId ? "You're back up" : `${m.name} is back up`);
    case 'dead': return toast(m.id === myId ? 'You bled out. Back next round.' : `${m.name} bled out`);
    case 'over': return showOver(`You survived ${m.round} round${m.round === 1 ? '' : 's'}.`);
  }
}

function openDoor(d, fx) {
  if (open.has(d)) return;
  open.add(d);
  debris[d].visible = false;
  if (fx) { sfx.door(); burst(debris[d].position.clone().setY(1), 40, DUST, 3, 1); }
}

function applySnap(m) {
  lastSnap = m;
  me = m.p.find(p => p.id === myId) || null;
  for (const d of m.d) openDoor(d, false);
  if (me) { if (prevPts != null && me.pts > prevPts) pop(me.pts - prevPts); prevPts = me.pts; }
  const seen = new Set();
  for (const [id, x, z, yaw, kind, swing] of m.z) {
    seen.add(id);
    let o = zMeshes.get(id);
    if (!o) {
      o = makeHuman(pick(skinMats), pick(clothMats), pick(clothMats), eyeMat);
      Object.assign(o.userData, { zid: id, born: clock, kind });
      o.position.set(x, -1.9, z); o.rotation.y = yaw;
      scene.add(o);
      zMeshes.set(id, o);
    }
    Object.assign(o.userData, { tx: x, tz: z, tyaw: yaw, swing });
  }
  for (const [id, o] of zMeshes) if (!seen.has(id)) { scene.remove(o); zMeshes.delete(id); }
  syncPlayers(m);
}

// ---------- weapons ----------
function giveWeapon(id) {
  const w = WEAPONS[id], have = guns.find(g => g.id === id);
  if (have) { have.mag = w.mag; have.res = w.res; return; }
  const g = { id, mag: w.mag, res: w.res };
  if (guns.length < 2) guns.push(g); else guns[cur] = g;
  cur = guns.indexOf(g);
  reloadT = 0; switchT = 0.4;
  buildGun(id);
}
function switchGun(i) {
  if (guns.length < 2) return;
  const n = i ?? (cur + 1) % guns.length;
  if (n === cur || !guns[n]) return;
  cur = n; reloadT = 0; switchT = 0.35;
  buildGun(guns[cur].id);
}
function startReload() {
  const g = guns[cur], w = WEAPONS[g.id];
  if (reloadT > 0 || g.mag >= w.mag || g.res <= 0) return;
  reloadT = reloadTotal = w.reload * (hasPerk('quickhands') ? 0.5 : 1);
  sfx.reload();
}
const zombieOf = o => { while (o) { if (o.userData.zid != null) return o; o = o.parent; } return null; };
const ray = new THREE.Raycaster();
ray.far = 120;
function shoot(w) {
  recoil = Math.min(1.5, recoil + (w.pellets > 1 ? 1.2 : 0.5));
  P.pitch = Math.min(1.5, P.pitch + w.kick * (ads ? 0.6 : 1));
  sfx.shot(guns[cur].id);
  flashSprite.visible = true; flashSprite.material.rotation = Math.random() * 6; flashT = 0.05;
  muzzleLight.intensity = 4;
  worldFlash.position.copy(camera.position); worldFlash.intensity = 20;
  const dmgMul = hasPerk('hairtrigger') ? 2 : 1;
  const spread = w.spread * (ads ? (w.ads ?? 0.35) : 1) * (moving ? 1.4 : 1) * (P.y > 0 ? 2 : 1);
  const targets = [...solids, ...Object.values(debris).filter(d => d.visible), ...zMeshes.values()];
  const origin = camera.position.clone(), fwd = camera.getWorldDirection(new THREE.Vector3());
  const start = origin.clone().add(new THREE.Vector3(0.15 * (1 - adsK), -0.1, -0.6).applyQuaternion(camera.quaternion));
  let hitAny = false, headAny = false;
  for (let i = 0; i < w.pellets; i++) {
    const dir = fwd.clone().add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(spread)).normalize();
    ray.set(origin, dir);
    let end = origin.clone().addScaledVector(dir, 60);
    const struck = new Set();
    for (const h of ray.intersectObjects(targets, true)) {
      const z = zombieOf(h.object);
      if (!z) { burst(h.point, 4, SPARK, 2, 0.25); end = h.point; break; }
      if (struck.has(z)) continue;
      struck.add(z);
      const head = h.object === z.userData.head;
      toHost({ t: 'hit', z: z.userData.zid, dmg: w.dmg * dmgMul * (head ? w.hs : 1), head });
      burst(h.point, head ? 12 : 6, BLOOD, 2.5);
      hitAny = true; headAny ||= head;
      if (!w.pierce) { end = h.point; break; }
    }
    tracer(start, end, w.pierce ? 0x3dff9a : 0xffd27a);
  }
  if (hitAny) { hitmarker(); headAny ? sfx.head() : sfx.hit(); }
}
function melee() {
  if (meleeT > 0 || !canAct()) return;
  meleeT = 0.55;
  sfx.knife();
  const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
  let best = null, bd = 2.0;
  for (const [id, o] of zMeshes) {
    const dx = o.position.x - P.x, dz = o.position.z - P.z, d = Math.hypot(dx, dz);
    if (d < bd && (dx * fx + dz * fz) / d > 0.5) { best = id; bd = d; }
  }
  if (best == null) return;
  toHost({ t: 'hit', z: best, dmg: 150, melee: true });
  burst(zMeshes.get(best).position.clone().setY(1.2), 8, BLOOD, 2);
  hitmarker(); sfx.hit();
}

function updateGun(dt) {
  const g = guns[cur], w = WEAPONS[g.id];
  fireCd -= dt; meleeT -= dt; switchT -= dt;
  if (crateT > 0 && (crateT -= dt) <= 0) { giveWeapon(crateW); toast(`You got the ${WEAPONS[crateW].name}`); }
  if (reloadT > 0 && (reloadT -= dt) <= 0) { const n = Math.min(w.mag - g.mag, g.res); g.mag += n; g.res -= n; }
  ads = mouseR && canAct() && P.slide <= 0;
  if (mouseL && locked && canAct() && fireCd <= 0 && reloadT <= 0 && switchT <= 0 && meleeT <= 0 && (w.auto || !firedPress)) {
    firedPress = true;
    if (g.mag <= 0) { if (g.res > 0) startReload(); else sfx.click(); }
    else { g.mag--; fireCd = 60 / (w.rpm * (hasPerk('hairtrigger') ? 1.33 : 1)); shoot(w); }
  }
  // viewmodel pose
  adsK += ((ads ? 1 : 0) - adsK) * Math.min(1, dt * 14);
  sprintK += ((sprinting ? 1 : 0) - sprintK) * Math.min(1, dt * 10);
  bobPhase += dt * (moving ? (sprinting ? 13 : 9) : 2);
  const bob = (moving ? (sprinting ? 0.025 : 0.012) : 0.003) * (1 - adsK * 0.85);
  const dip = reloadT > 0 ? Math.sin(Math.PI * (1 - reloadT / reloadTotal)) : switchT > 0 ? switchT / 0.4 : 0;
  const stab = meleeT > 0.3 ? Math.sin((0.55 - meleeT) / 0.25 * Math.PI) : 0;
  view.position.set(0.17 - 0.17 * adsK + Math.cos(bobPhase * 0.5) * bob, -0.14 + 0.055 * adsK + Math.abs(Math.sin(bobPhase * 0.5)) * bob - sprintK * 0.06 - dip * 0.15, -0.36 + 0.08 * adsK + recoil * 0.05 - stab * 0.25);
  view.rotation.set(recoil * 0.08 - dip * 0.7 - sprintK * 0.35, sprintK * 0.7 + stab * 0.5, sprintK * 0.15);
  view.visible = !(w.zoom && adsK > 0.9) && alive();
  recoil = Math.max(0, recoil - dt * 8);
  const fov = 75 + ((w.zoom || 55) - 75) * adsK;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  $('cross').style.opacity = ads || sprinting ? 0 : 1;
}

// ---------- movement ----------
function updateMove(dt) {
  const ok = alive() && !paused;
  const f = ok ? (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) : 0, s = ok ? (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) : 0;
  const crouch = ok && keys.KeyC && P.slide <= 0;
  sprinting = ok && (keys.ShiftLeft || keys.ShiftRight) && f > 0 && !mouseR && !mouseL && !crouch;
  const sin = Math.sin(P.yaw), cos = Math.cos(P.yaw);
  let vx = -sin * f + cos * s, vz = -cos * f - sin * s;
  const l = Math.hypot(vx, vz);
  if (l > 0) { vx /= l; vz /= l; }
  let speed = (sprinting ? 6.6 : crouch ? 2.2 : 4.4) * (ads ? 0.6 : 1);
  if (P.slide > 0) {
    P.slide -= dt;
    vx = P.sdx; vz = P.sdz; speed = 8.5 * Math.max(0.25, P.slide / 0.8);
  }
  moving = l > 0 || P.slide > 0;
  let nx = P.x + vx * speed * dt, nz = P.z + vz * speed * dt;
  for (const o of zMeshes.values()) { // zombies body-block you
    const dx = nx - o.position.x, dz = nz - o.position.z, d = Math.hypot(dx, dz);
    if (d < 0.65 && d > 0.001) { nx = o.position.x + dx / d * 0.65; nz = o.position.z + dz / d * 0.65; }
  }
  [P.x, P.z] = collide(map, open, nx, nz, 0.4);
  P.vy -= 22 * dt;
  P.y += P.vy * dt;
  if (P.y <= 0) { P.y = 0; P.vy = 0; }
  const eye = !alive() ? 0.45 : P.slide > 0 ? 0.85 : crouch ? 1.05 : 1.65;
  P.eye += (eye - P.eye) * Math.min(1, dt * 12);
  const shake = hurtFlash > 0.3 ? rand(-0.02, 0.02) : 0;
  camera.position.set(P.x, P.y + P.eye, P.z);
  camera.rotation.set(P.pitch + shake, P.yaw, me?.dn ? 0.3 : P.slide > 0 ? 0.06 : 0);
}

// ---------- interaction ----------
function findUse() {
  if (!canAct()) return null;
  for (const o of lastSnap?.p ?? []) if (o.id !== myId && o.dn && Math.hypot(o.x - P.x, o.z - P.z) < 2.2) return { revive: o };
  let best = null, bd = Infinity;
  for (const it of INTERACT) {
    if (it.type === 'door' && open.has(it.door)) continue;
    const pos = interactPos(map, it), d = Math.hypot(pos.x - P.x, pos.z - P.z);
    if (d < useRange(it) && d < bd) { best = it; bd = d; }
  }
  return best && { it: best };
}
function promptFor(u) {
  if (u.revive) return `Hold F to revive ${u.revive.n}`;
  const it = u.it;
  if (it.type === 'door') return `Press F to clear debris to ${DOORS[it.door].name} [${DOORS[it.door].cost}]`;
  if (it.type === 'wall') {
    const w = WEAPONS[it.weapon];
    return guns.some(g => g.id === it.weapon) ? `Press F to buy ammo for ${w.name} [${Math.floor(w.cost / 2)}]` : `Press F to buy ${w.name} [${w.cost}]`;
  }
  if (it.type === 'perk') {
    const pk = PERKS[it.perk];
    if (me.pk.includes(it.perk)) return `${pk.name} (owned)`;
    return `Press F to drink ${pk.name} [${(lastSnap.p.length > 1 && pk.coopCost) || pk.cost}]: ${pk.desc}`;
  }
  return crateT > 0 ? 'The crate is deciding...' : `Press F for a random weapon [${CRATE_COST}]`;
}
function interact() {
  if (!use?.it || (use.it.type === 'crate' && crateT > 0)) return;
  if (use.it.type === 'perk' && me.pk.includes(use.it.perk)) return;
  toHost({ t: 'buy', id: use.it.id, have: guns.map(g => g.id) });
}

// ---------- HUD ----------
const hudCache = {};
function setHud(id, prop, v) { if (hudCache[id + prop] !== v) { hudCache[id + prop] = v; $(id)[prop] = v; } }
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
let bannerT, toastT, popT, hitT;
function banner(text, ms) { const b = $('banner'); b.textContent = text; b.style.opacity = 1; clearTimeout(bannerT); bannerT = setTimeout(() => (b.style.opacity = 0), ms); }
function toast(text) { $('toast').textContent = text; clearTimeout(toastT); toastT = setTimeout(() => ($('toast').textContent = ''), 2600); }
function pop(n) { const p = $('pop'); p.textContent = '+' + n; p.style.opacity = 1; p.style.transform = 'translateY(0)'; clearTimeout(popT); popT = setTimeout(() => { p.style.opacity = 0; p.style.transform = 'translateY(-20px)'; }, 350); }
function hitmarker() { $('hitm').style.opacity = 1; clearTimeout(hitT); hitT = setTimeout(() => ($('hitm').style.opacity = 0), 90); }
function updateHud(dt) {
  if (!lastSnap) return;
  setHud('round', 'textContent', String(lastSnap.r || ''));
  setHud('scores', 'innerHTML', lastSnap.p.map((p, i) => `<div style="color:${COLORS[i]}"><i>${esc(p.n)}${p.dn ? ' ▼' : p.dd ? ' ✝' : ''}</i>${p.pts}</div>`).join(''));
  const g = guns[cur];
  if (g) {
    setHud('wname', 'textContent', WEAPONS[g.id].name + (reloadT > 0 ? ' · reloading' : ''));
    setHud('mag', 'textContent', String(g.mag));
    setHud('res', 'textContent', String(g.res));
  }
  if (!me) return;
  setHud('perks', 'innerHTML', me.pk.map(k => `<span style="background:${PERKS[k].color}" title="${PERKS[k].name}">${PERKS[k].icon}</span>`).join(''));
  hurtFlash = Math.max(0, hurtFlash - dt);
  $('vignette').style.opacity = me.dn || me.dd ? 0 : Math.min(1, (1 - me.hp / me.mhp) * 0.9 + hurtFlash);
  setHud('downfx', 'hidden', !(me.dn || me.dd));
  setHud('status', 'textContent', me.dn ? (me.sr ? 'SECOND WIND: getting back up...' : `YOU ARE DOWN · ${me.bl}s`) : me.dd ? 'YOU BLED OUT · back next round' : '');
  const reviving = lastSnap.p.find(o => o.id !== myId && o.dn && o.rev > 0 && Math.hypot(o.x - P.x, o.z - P.z) < 2.5);
  const rev = me.dn ? me.rev : reviving ? reviving.rev : 0;
  setHud('revbar', 'hidden', !(rev > 0));
  $('revbar').firstElementChild.style.width = `${Math.min(100, rev * 100)}%`;
  setHud('prompt', 'textContent', use ? promptFor(use) : '');
}

// ---------- menus ----------
function setMenuMsg(t) { $('menuMsg').textContent = t; $('hostBtn').disabled = $('joinBtn').disabled = false; }
function lock() {
  try { canvas.requestPointerLock()?.catch?.(() => showPause()); } catch { showPause(); }
}
function enterGame() {
  playing = true;
  $('menu').hidden = true;
  $('hud').hidden = false;
  lock();
}
function inviteLink() { return roomCode ? `${location.origin}${location.pathname}#join=${roomCode}` : ''; }
function showPause() {
  if (overShown || !playing) return;
  paused = true;
  $('pause').hidden = false;
  $('invite').value = inviteLink() || netError || 'Setting up the online room...';
  $('copyBtn').disabled = !roomCode;
  $('plist').textContent = (lastSnap?.p ?? []).map(p => p.n).join(', ');
  $('pauseMsg').textContent = '';
}
function showOver(text) {
  overShown = true;
  paused = false;
  document.exitPointerLock();
  $('pause').hidden = true;
  $('over').hidden = false;
  $('overText').textContent = text;
  $('overTable').replaceChildren(...(lastSnap?.p ?? []).map(p => {
    const tr = document.createElement('tr');
    for (const v of [p.n, p.k, p.hs, p.ds, p.pts]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    return tr;
  }));
  $('againBtn').hidden = !isHost || text.startsWith('The host');
}

async function startHost(name) {
  isHost = true; myId = 'host';
  sim = new Sim(myId);
  sim.addPlayer(myId, name);
  enterGame();
  flush();
  try {
    const { peer, code } = await hostRoom();
    peerRef = peer; roomCode = code;
    toast('Room ready. Press Esc to invite friends.');
    if (!$('pause').hidden) showPause();
    peer.on('disconnected', () => peer.reconnect());
    peer.on('connection', conn => {
      conn.on('data', m => {
        if (conns.has(conn.peer)) return sim.handle(conn.peer, m);
        if (m?.t !== 'hello') return;
        if (!sim.addPlayer(conn.peer, m.name)) return conn.send({ t: 'full' });
        conns.set(conn.peer, conn);
        conn.send({ t: 'welcome', id: conn.peer });
        flush();
        toast(`${sim.players.get(conn.peer).name} joined`);
      });
      conn.on('close', () => {
        const p = sim.players.get(conn.peer);
        conns.delete(conn.peer);
        sim.removePlayer(conn.peer);
        if (p) toast(`${p.name} left`);
      });
    });
  } catch (e) {
    netError = `Online play unavailable (${e.message || e.type}). Solo still works.`;
    if (!$('pause').hidden) showPause();
  }
}

async function startJoin(name, code) {
  $('hostBtn').disabled = $('joinBtn').disabled = true;
  $('menuMsg').textContent = 'Connecting...';
  const { peer, conn } = await joinRoom(code);
  peerRef = peer; hostConn = conn; roomCode = code.toLowerCase();
  conn.on('data', onMsg);
  conn.on('close', () => { if (playing && !overShown) showOver('The host left the game.'); });
  conn.send({ t: 'hello', name });
}

function playerName() {
  const n = $('name').value.trim() || 'Survivor';
  try { localStorage.setItem('gs-name', n); } catch {}
  return n;
}
try { $('name').value = localStorage.getItem('gs-name') || ''; } catch {}
const invited = new URLSearchParams(location.hash.slice(1)).get('join');
if (invited) {
  $('code').value = invited;
  $('invited').hidden = false;
  $('invited').textContent = `You've been invited to room ${invited}. Enter a name and press Join.`;
  $('joinBtn').classList.add('primary');
  $('hostBtn').classList.remove('primary');
}
$('hostBtn').onclick = () => { audio(); startHost(playerName()); };
$('joinBtn').onclick = () => {
  const code = $('code').value.trim();
  if (!/^[a-z0-9]{5}$/i.test(code)) return setMenuMsg('Enter the 5-character room code.');
  audio();
  startJoin(playerName(), code).catch(e => setMenuMsg(e.message || String(e.type || e)));
};
$('resumeBtn').onclick = () => { $('pause').hidden = true; paused = false; lock(); };
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(inviteLink()); $('pauseMsg').textContent = 'Link copied. Send it to your friends.'; }
  catch { $('invite').select(); $('pauseMsg').textContent = 'Press Ctrl+C to copy.'; }
};
$('leaveBtn').onclick = $('menuBtn').onclick = () => location.assign(location.pathname);
$('againBtn').onclick = () => toHost({ t: 'restart' });
addEventListener('pagehide', () => peerRef?.destroy());

// ---------- input ----------
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) { paused = false; $('pause').hidden = true; }
  else { mouseL = mouseR = false; for (const k in keys) keys[k] = false; showPause(); }
});
document.addEventListener('pointerlockerror', showPause);
addEventListener('keydown', e => {
  if (!locked) return;
  keys[e.code] = true;
  if (e.repeat) return;
  if (e.code === 'KeyR') startReload();
  else if (e.code === 'Digit1') switchGun(0);
  else if (e.code === 'Digit2') switchGun(1);
  else if (e.code === 'KeyV') melee();
  else if (e.code === 'KeyF') interact();
  else if (e.code === 'Space' && P.y === 0 && canAct()) P.vy = 7;
  else if (e.code === 'KeyC' && sprinting && P.y === 0 && P.slide <= 0) Object.assign(P, { slide: 0.8, sdx: -Math.sin(P.yaw), sdz: -Math.cos(P.yaw) });
});
addEventListener('keyup', e => { keys[e.code] = false; });
canvas.addEventListener('mousedown', e => {
  if (!playing || overShown) return;
  if (!locked) return lock();
  if (e.button === 0) mouseL = true;
  if (e.button === 2) mouseR = true;
});
addEventListener('mouseup', e => {
  if (e.button === 0) { mouseL = false; firedPress = false; }
  if (e.button === 2) mouseR = false;
});
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (!locked) return;
  const s = 0.0022 * (ads ? (WEAPONS[guns[cur]?.id]?.zoom ? 0.3 : 0.6) : 1);
  P.yaw -= e.movementX * s;
  P.pitch = Math.max(-1.5, Math.min(1.5, P.pitch - e.movementY * s));
});
addEventListener('wheel', () => locked && switchT <= 0 && switchGun());

// ---------- main loop ----------
let simLast = performance.now();
function hostTick() {
  const now = performance.now(), dt = Math.min(0.25, (now - simLast) / 1000);
  simLast = now;
  if (!(paused && conns.size === 0)) for (let t = dt; t > 0; t -= 0.05) sim.tick(Math.min(0.05, t)); // solo pauses; co-op keeps running
  flush();
  applySnap(sim.snapshot());
  if ((netT -= dt) <= 0 && conns.size) {
    netT = 0.05;
    const s = sim.snapshot();
    for (const c of conns.values()) if (c.open) c.send(s);
  }
}
// Browsers stop requestAnimationFrame in background tabs; keep the host's sim (and its guests) running anyway.
setInterval(() => { if (isHost && playing && performance.now() - simLast > 100) hostTick(); }, 50);

function update(dt) {
  if (isHost) hostTick();
  updateMove(dt);
  updateGun(dt);
  use = findUse();
  const state = { t: 'state', x: P.x, y: P.y, z: P.z, yaw: P.yaw, pitch: P.pitch, use: !!keys.KeyF && !!use?.revive, w: guns[cur].id };
  if (isHost) sim.handle(myId, state);
  else if ((stateT -= dt) <= 0 && hostConn?.open) { stateT = 0.05; hostConn.send(state); }
  animateZombies(dt);
  animatePlayers(dt);
  if ((groanCd -= dt) <= 0 && zMeshes.size) {
    groanCd = rand(0.6, 2.2);
    const o = pick([...zMeshes.values()]);
    sfx.groan(o.position.x, o.position.z, o.userData.kind === 2 ? 1.4 : 1);
  }
  for (const [i, l] of lamps.entries()) if (i % 3 === 1) l.intensity = 28 * (Math.random() < 0.03 ? 0.2 : 1);
  updateFx(dt);
  updateListener();
  updateHud(dt);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  if (playing && guns.length) update(dt);
  else { // menu backdrop: slow look around the starting room
    camera.position.set(map.start.x, 1.7, map.start.z);
    camera.rotation.set(-0.05, clock * 0.15, 0);
    updateFx(dt);
  }
  renderer.clear();
  renderer.render(scene, camera);
  if (playing) { renderer.clearDepth(); renderer.render(viewScene, viewCam); }
}
requestAnimationFrame(frame);

window.gs = { P, frame, view, zMeshes, camera, get paused() { return paused; }, get sim() { return sim; }, get me() { return me; }, get snap() { return lastSnap; } }; // debug handle
