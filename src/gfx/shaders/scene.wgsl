// Forward PBR: Cook-Torrance GGX, one shadowed directional light, up to 16 point/spot lights,
// hemisphere ambient and distance fog. Writes linear HDR.
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
  sunColor: vec4f,
  sky: vec4f,    // rgb, fog density
  params: vec4f, // light count, time, shadow texel size, viewmodel depth split
  lights: array<Light, 16>,
}
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
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
  @location(7) color: vec4f,
  @location(8) params: vec4f,
}
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
  @location(4) @interpolate(flat) params: vec4f,
  @location(5) local: vec3f,
}

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  let world = v.m0.xyz * v.pos.x + v.m1.xyz * v.pos.y + v.m2.xyz * v.pos.z + v.m3.xyz;
  // Inverse-transpose for rotation + non-uniform scale.
  let n = v.m0.xyz * (v.normal.x / dot(v.m0.xyz, v.m0.xyz)) + v.m1.xyz * (v.normal.y / dot(v.m1.xyz, v.m1.xyz)) + v.m2.xyz * (v.normal.z / dot(v.m2.xyz, v.m2.xyz));
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
  o.normal = n;
  o.uv = v.uv;
  o.color = v.color;
  o.params = v.params;
  o.local = v.pos * vec3f(length(v.m0.xyz), length(v.m1.xyz), length(v.m2.xyz));
  return o;
}

@vertex
fn vs_shadow(v: VIn) -> @builtin(position) vec4f {
  let world = v.m0.xyz * v.pos.x + v.m1.xyz * v.pos.y + v.m2.xyz * v.pos.z + v.m3.xyz;
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
  let p = G.shadowViewProj * vec4f(world + n * 0.06, 1.0);
  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  let texel = G.params.z;
  var lit = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      lit += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, p.z - 0.0015);
    }
  }
  let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * step(p.z, 1.0);
  return mix(1.0, lit / 9.0, inside);
}

// Anti-aliased line grid for greybox surfaces, picked on the two axes the face spans.
fn grid(local: vec3f, n: vec3f) -> f32 {
  let an = abs(n);
  var c = local.xz;
  if (an.x > an.y && an.x > an.z) { c = local.zy; } else if (an.z > an.y) { c = local.xy; }
  let w = fwidth(c);
  let g = abs(fract(c - 0.5) - 0.5) / max(w, vec2f(1e-4));
  return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let flags = u32(i.params.w);
  let n = normalize(i.normal);
  let v = normalize(G.camPos.xyz - i.world);
  var albedo = i.color.rgb * textureSample(baseTex, baseSampler, i.uv).rgb;
  // Derivatives must be taken in uniform control flow, so the grid is always computed.
  let lines = grid(i.local, n) * select(0.0, 1.0, (flags & 1u) != 0u);
  albedo = mix(albedo, albedo * 0.55, lines);
  let metallic = i.params.x;
  let rough = clamp(i.params.y, 0.06, 1.0);

  var shadow = 1.0;
  if ((flags & 4u) == 0u) { shadow = sunShadow(i.world, n); }
  var color = brdf(n, v, G.sunDir.xyz, albedo, metallic, rough) * G.sunColor.rgb * G.sunColor.w * shadow;

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

  // Hemisphere ambient: sky from above, darker bounce from below.
  let hemi = mix(G.sky.rgb * 0.25, G.sky.rgb, n.y * 0.5 + 0.5);
  color += albedo * hemi * (1.0 - metallic * 0.6) * 0.55;
  color += i.color.rgb * i.params.z;

  let dist = length(G.camPos.xyz - i.world);
  let fogAmount = 1.0 - exp(-dist * G.sky.w);
  if ((flags & 2u) == 0u) { color = mix(color, G.sky.rgb, fogAmount); }
  return vec4f(color, 1.0);
}
