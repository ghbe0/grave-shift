// Forward PBR: Cook-Torrance GGX, one shadowed directional light, up to 16 point/spot lights,
// hemisphere ambient and distance fog. Writes linear HDR.
//
// Surfaces either use their mesh's own base-colour texture (glTF models with UVs), or one of the
// procedural material layers (concrete, steel, skin...) projected triplanar in the instance's local
// space, which needs no UVs and does not swim on animated parts. Material layers carry albedo,
// roughness, a normal map, metalness and ambient occlusion.
struct Light {
  posRadius: vec4f,
  color: vec4f,   // rgb, intensity
  dirCone: vec4f, // spot direction, cos(outer angle); w = 0 for point lights
}
struct Globals {
  viewProj: mat4x4f,
  viewmodelProj: mat4x4f,
  shadowViewProj: mat4x4f,
  camPos: vec4f,
  sunDir: vec4f,
  sunColor: vec4f, // rgb, intensity
  sky: vec4f,      // rgb horizon colour, fog density
  params: vec4f,   // light count, time, shadow texel size, viewmodel depth split
  tiles: array<vec4f, 5>, // metres per repeat for each material layer
  lights: array<Light, 16>,
}
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var matSurface: texture_2d_array<f32>;
@group(0) @binding(4) var matDetail: texture_2d_array<f32>;
@group(0) @binding(5) var matSampler: sampler;
@group(1) @binding(0) var baseTex: texture_2d<f32>;
@group(1) @binding(1) var baseSampler: sampler;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) m0: vec4f,
  @location(4) m1: vec4f,
  @location(5) m2: vec4f,
  @location(6) m3: vec4f,
  @location(7) color: vec4f,  // rgb tint, a = material layer + 1 (0: use the mesh texture)
  @location(8) params: vec4f, // metallic, roughness, emissive, flags
}
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
  @location(4) @interpolate(flat) params: vec4f,
  @location(5) local: vec3f,
  @location(6) localNormal: vec3f,
  @location(7) @interpolate(flat) n0: vec3f,
  @location(8) @interpolate(flat) n1: vec3f,
  @location(9) @interpolate(flat) n2: vec3f,
}

// Wind. Gusts roll across the map along the wind direction. Flags: 8 foliage (leans with
// height and flutters), 16 grass (bends from the root, more at the tip), 32 cloth (pinned along
// local x = -0.5, waves run to the free edge), 128 cable (swings most at mid-span).
const WIND = vec2f(0.8, 0.6);
fn gustAt(p: vec2f, t: f32) -> f32 {
  let along = dot(p, WIND);
  return 0.55 + 0.45 * sin(along * 0.12 - t * 1.1) * sin(along * 0.05 + p.y * 0.03 - t * 0.37 + 1.3);
}
fn displace(v: VIn) -> vec3f {
  var world = v.m0.xyz * v.pos.x + v.m1.xyz * v.pos.y + v.m2.xyz * v.pos.z + v.m3.xyz;
  let flags = u32(v.params.w);
  if ((flags & 184u) == 0u) { return world; }
  let t = G.params.y;
  let base = v.m3.xz;
  let gust = gustAt(base, t);
  if ((flags & 16u) != 0u) {
    let h = max(v.pos.y, 0.0);
    let flutter = sin(t * 3.1 + base.x * 1.7 + base.y * 1.3 + v.pos.x * 4.0) * 0.08;
    let bend = h * h * length(v.m1.xyz) * (0.38 * gust + flutter);
    world += vec3f(WIND.x, 0.0, WIND.y) * bend;
    world.y -= bend * bend * 0.6;
  } else if ((flags & 8u) != 0u) {
    let lean = clamp(world.y * 0.22, 0.0, 1.4) * (0.025 + 0.06 * gust);
    let slow = vec2f(sin(t * 1.3 + world.x * 0.7 + world.z * 0.5), cos(t * 1.05 + world.z * 0.6 - world.x * 0.4));
    let quick = vec2f(sin(t * 4.3 + world.y * 3.1 + world.x * 2.3), cos(t * 3.7 + world.y * 2.7 + world.z * 2.9)) * (0.004 + 0.012 * gust);
    world = world + vec3f(WIND.x * lean + slow.x * lean * 0.5 + quick.x, quick.x * 0.5, WIND.y * lean + slow.y * lean * 0.5 + quick.y);
  }
  if ((flags & 32u) != 0u) {
    let f = v.pos.x + 0.5;
    let wave = sin(v.pos.x * 7.0 - t * 6.0 + base.x) * 0.6 + sin(v.pos.x * 13.0 + v.pos.y * 5.0 - t * 9.0) * 0.25;
    world += normalize(v.m2.xyz) * wave * f * length(v.m0.xyz) * 0.09 * (0.5 + gust);
  }
  if ((flags & 128u) != 0u) {
    // Hangs in a curve (sag about 5% of the span) and swings sideways.
    let sag = 1.0 - 4.0 * v.pos.y * v.pos.y;
    let span = length(v.m1.xyz);
    world.y -= sag * span * 0.05;
    world += normalize(v.m2.xyz) * sin(t * 1.6 + base.x * 0.3) * (0.03 + 0.012 * span) * sag * (0.4 + gust);
  }
  return world;
}

// Cheap smooth noise for large-scale colour variation.
fn vhash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vhash(i), vhash(i + vec2f(1.0, 0.0)), u.x), mix(vhash(i + vec2f(0.0, 1.0)), vhash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  let world = displace(v);
  // Inverse-transpose columns for rotation + non-uniform scale.
  o.n0 = v.m0.xyz / dot(v.m0.xyz, v.m0.xyz);
  o.n1 = v.m1.xyz / dot(v.m1.xyz, v.m1.xyz);
  o.n2 = v.m2.xyz / dot(v.m2.xyz, v.m2.xyz);
  let split = G.params.w;
  let flags = u32(v.params.w);
  var clip: vec4f;
  if ((flags & 2u) != 0u) {
    clip = G.viewmodelProj * vec4f(world, 1.0);
    clip.z = clip.z * split;
  } else {
    clip = G.viewProj * vec4f(world, 1.0);
    clip.z = clip.z * (1.0 - split) + split * clip.w;
  }
  o.clip = clip;
  o.world = world;
  o.normal = o.n0 * v.normal.x + o.n1 * v.normal.y + o.n2 * v.normal.z;
  o.uv = v.uv;
  o.color = v.color;
  o.params = v.params;
  // Local position in metres (scale applied, rotation not), so texture density is constant.
  o.local = v.pos * vec3f(length(v.m0.xyz), length(v.m1.xyz), length(v.m2.xyz));
  o.localNormal = v.normal;
  return o;
}

@vertex
fn vs_shadow(v: VIn) -> @builtin(position) vec4f {
  let world = displace(v);
  return G.shadowViewProj * vec4f(world, 1.0);
}

const PI = 3.14159265;

fn ggx(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
fn smith(nv: f32, nl: f32, rough: f32) -> f32 {
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  return (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
}
fn brdf(n: vec3f, v: vec3f, l: vec3f, albedo: vec3f, metallic: f32, rough: f32) -> vec3f {
  let h = normalize(v + l);
  let nl = max(dot(n, l), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let f = f0 + (1.0 - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  let spec = ggx(max(dot(n, h), 0.0), rough * rough) * smith(nv, nl, rough) * f / (4.0 * nv * nl + 1e-3);
  let diff = (1.0 - f) * (1.0 - metallic) * albedo / PI;
  return (diff + spec) * nl;
}

fn sunShadow(world: vec3f, n: vec3f) -> f32 {
  let p = G.shadowViewProj * vec4f(world + n * 0.05, 1.0);
  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  let texel = G.params.z;
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      lit += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel * 1.5, p.z - 0.0012);
    }
  }
  let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * step(p.z, 1.0);
  return mix(1.0, lit / 9.0, inside);
}

fn tileOf(layer: i32) -> f32 {
  let i = clamp(layer, 0, 19);
  return G.tiles[i / 4][i % 4];
}

// Tangent-space normal from a detail texel (xy stored, z rebuilt).
fn unpackNormal(d: vec4f) -> vec3f {
  let xy = d.xy * 2.0 - 1.0;
  return vec3f(xy, sqrt(max(1.0 - dot(xy, xy), 0.0)));
}

struct Surface { albedo: vec3f, rough: f32, metal: f32, ao: f32, normal: vec3f }

// Triplanar projection with "whiteout" normal blending, all in local space.
fn triplanar(layer: i32, p: vec3f, n: vec3f) -> Surface {
  let scale = 1.0 / tileOf(layer);
  var w = pow(abs(n), vec3f(4.0));
  w = w / (w.x + w.y + w.z);
  let uvX = p.zy * scale;
  let uvY = p.xz * scale;
  let uvZ = p.xy * scale;
  let sx = textureSample(matSurface, matSampler, uvX, layer);
  let sy = textureSample(matSurface, matSampler, uvY, layer);
  let sz = textureSample(matSurface, matSampler, uvZ, layer);
  let dx = textureSample(matDetail, matSampler, uvX, layer);
  let dy = textureSample(matDetail, matSampler, uvY, layer);
  let dz = textureSample(matDetail, matSampler, uvZ, layer);
  let s = sx * w.x + sy * w.y + sz * w.z;
  let d = dx * w.x + dy * w.y + dz * w.z;
  let tx = unpackNormal(dx);
  let ty = unpackNormal(dy);
  let tz = unpackNormal(dz);
  let nx = vec3f(tx.xy + n.zy, abs(tx.z) * n.x);
  let ny = vec3f(ty.xy + n.xz, abs(ty.z) * n.y);
  let nz = vec3f(tz.xy + n.xy, abs(tz.z) * n.z);
  var out: Surface;
  out.albedo = s.rgb;
  out.rough = s.a;
  out.metal = d.b;
  out.ao = d.a;
  out.normal = normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
  return out;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let flags = u32(i.params.w);
  let layer = i32(round(i.color.a)) - 1;
  let v = normalize(G.camPos.xyz - i.world);

  // Both paths are always evaluated: texture sampling must stay in uniform control flow.
  let mesh = textureSample(baseTex, baseSampler, i.uv);
  let ln = normalize(i.localNormal);
  let mat = triplanar(max(layer, 0), i.local, ln);
  let layered = layer >= 0;
  // Leaves: the gaps between them (marked by low occlusion in the leaf material) are cut away.
  let foliage = (flags & 8u) != 0u;
  if (foliage && layered && mat.ao < 0.3) { discard; }

  var albedo = i.color.rgb * mesh.rgb;
  var metallic = i.params.x;
  var rough = i.params.y;
  var ao = 1.0;
  var n = normalize(i.normal);
  if (layered) {
    albedo = i.color.rgb * mat.albedo;
    metallic = mat.metal;
    rough = mat.rough * i.params.y;
    ao = mat.ao;
    n = normalize(i.n0 * mat.normal.x + i.n1 * mat.normal.y + i.n2 * mat.normal.z);
  }
  // Grass: dark at the root, lighter and a touch yellower at the tip.
  if ((flags & 16u) != 0u) {
    let tip = 1.0 - i.uv.y;
    albedo *= mix(vec3f(0.35, 0.38, 0.32), vec3f(1.25, 1.22, 0.95), tip);
  }
  // Puddles: rippling, mirror-smooth water.
  if ((flags & 64u) != 0u) {
    let t = G.params.y;
    let q = i.world.xz;
    let rip = vec2f(sin(q.x * 9.0 + t * 2.3) + sin(q.x * 4.1 - q.y * 6.3 + t * 1.7), sin(q.y * 8.3 - t * 2.1) + sin(q.y * 3.7 + q.x * 5.9 + t * 1.3));
    n = normalize(vec3f(rip.x * 0.035, 1.0, rip.y * 0.035));
    albedo = vec3f(0.3, 0.34, 0.38);
    rough = 0.04;
    metallic = 0.85;
  }
  // Large-scale variation so floors and walls never look like one repeated tile.
  if ((flags & 74u) == 0u) {
    let big = vnoise(i.world.xz * 0.09 + i.world.y * 0.05) * 0.6 + vnoise(i.world.xz * 0.31) * 0.4;
    albedo *= 0.74 + 0.5 * big;
    // Ground: patches of dirt and damp, darker in the low spots.
    let upf = max(normalize(i.normal).y, 0.0);
    let dirt = smoothstep(0.45, 0.8, vnoise(i.world.xz * 0.21 + vec2f(13.0, 7.0))) * upf;
    albedo = mix(albedo, albedo * vec3f(0.62, 0.55, 0.45), dirt * 0.7);
    let damp = smoothstep(0.6, 0.85, vnoise(i.world.xz * 0.13 + vec2f(3.0, 41.0))) * upf;
    albedo *= 1.0 - damp * 0.35;
    rough *= 1.0 - damp * 0.55;
    // Grime where walls meet the ground.
    let vert = 1.0 - abs(normalize(i.normal).y);
    ao *= mix(1.0, 0.55 + 0.45 * smoothstep(0.0, 0.9, i.world.y), vert);
  }
  rough = clamp(rough, 0.05, 1.0);
  // Geometry facing away after normal mapping: keep it lit from the front side.
  if (dot(n, v) < 0.0) { n = normalize(n + v * (0.01 - dot(n, v))); }

  var shadow = 1.0;
  if ((flags & 4u) == 0u) { shadow = sunShadow(i.world, normalize(i.normal)); }
  var color = brdf(n, v, G.sunDir.xyz, albedo, metallic, rough) * G.sunColor.rgb * G.sunColor.w * shadow;
  // Thin leaves let sunlight through from behind.
  if (foliage) { color += albedo * G.sunColor.rgb * G.sunColor.w * shadow * (0.12 + 0.3 * max(dot(-n, G.sunDir.xyz), 0.0)) / PI; }

  let count = u32(G.params.x);
  for (var k = 0u; k < count; k++) {
    let L = G.lights[k];
    let to = L.posRadius.xyz - i.world;
    let d = length(to);
    if (d > L.posRadius.w) { continue; }
    let l = to / max(d, 1e-4);
    let x = d / L.posRadius.w;
    var atten = (1.0 - x * x) * (1.0 - x * x) / (1.0 + d * d);
    if (L.dirCone.w > 0.0) {
      atten *= smoothstep(L.dirCone.w, mix(L.dirCone.w, 1.0, 0.35), dot(-l, L.dirCone.xyz));
    }
    color += brdf(n, v, l, albedo, metallic, rough) * L.color.rgb * L.color.w * atten;
  }

  // Ambient: hemisphere irradiance plus a rough sky reflection, both darkened by occlusion.
  let up = n.y * 0.5 + 0.5;
  let hemi = mix(G.sky.rgb * vec3f(0.2, 0.18, 0.17), G.sky.rgb * 0.75, up);
  let f0 = mix(vec3f(0.04), albedo, metallic);
  let fres = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0) * (1.0 - rough);
  let r = reflect(-v, n);
  let env = mix(G.sky.rgb * 0.3, G.sky.rgb * 1.4, clamp(r.y * 0.5 + 0.5, 0.0, 1.0));
  color += (albedo * (1.0 - metallic) * hemi * 0.7 + env * fres * (1.0 - rough * 0.7)) * ao;
  color += i.color.rgb * i.params.z * select(mesh.rgb, mat.albedo * 2.0, layered);

  if ((flags & 2u) == 0u) {
    let dist = length(G.camPos.xyz - i.world);
    // Height fog: denser near the ground.
    let fogAmount = (1.0 - exp(-dist * G.sky.w)) * mix(1.0, 0.55, clamp(i.world.y / 8.0, 0.0, 1.0));
    color = mix(color, G.sky.rgb, fogAmount);
  }
  return vec4f(color, 1.0);
}
