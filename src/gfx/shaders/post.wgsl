// Post-processing: bloom (threshold, downsample, upsample) and a composite pass doing camera
// motion blur, depth of field, tone mapping and vignette.
struct Post {
  invViewProj: mat4x4f,
  prevViewProj: mat4x4f,
  camPos: vec4f,
  a: vec4f, // exposure, bloom, motion blur, dof focus
  b: vec4f, // dof amount, vignette, damage, time
  c: vec4f, // viewmodel depth split, grain, saturation, contrast
  sunDir: vec4f,
  sunColor: vec4f, // rgb, intensity
  sky: vec4f,      // horizon colour
}
@group(0) @binding(0) var<uniform> U: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_multisampled_2d;
@group(0) @binding(4) var bloomTex: texture_2d<f32>;

struct FsIn {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> FsIn {
  var o: FsIn;
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn box4(uv: vec2f, spread: f32) -> vec3f {
  let t = spread / vec2f(textureDimensions(src));
  return (textureSampleLevel(src, samp, uv + vec2f(-t.x, -t.y), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(t.x, -t.y), 0.0).rgb
        + textureSampleLevel(src, samp, uv + vec2f(-t.x, t.y), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(t.x, t.y), 0.0).rgb) * 0.25;
}

// Keeps only what is brighter than the threshold, with a soft knee.
@fragment
fn fs_bright(i: FsIn) -> @location(0) vec4f {
  let c = box4(i.uv, 1.0);
  let l = max(c.r, max(c.g, c.b));
  let w = smoothstep(0.9, 1.8, l);
  return vec4f(min(c * w, vec3f(12.0)), 1.0);
}
@fragment
fn fs_down(i: FsIn) -> @location(0) vec4f {
  return vec4f(box4(i.uv, 1.0), 1.0);
}
// Drawn with additive blending onto the next larger level.
@fragment
fn fs_up(i: FsIn) -> @location(0) vec4f {
  return vec4f(box4(i.uv, 0.75), 1.0);
}

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(443.897, 441.423));
  let r = q + dot(q, q.yx + 19.19);
  return fract((r.x + r.y) * r.x);
}

// Sky for pixels nothing was drawn on: horizon colour to a darker zenith, a sun disc with glow,
// and slow banded cloud wisps.
fn sky(dir: vec3f) -> vec3f {
  let up = clamp(dir.y, -1.0, 1.0);
  let zenith = U.sky.rgb * vec3f(0.35, 0.42, 0.62);
  let ground = U.sky.rgb * 0.45;
  var c = mix(U.sky.rgb, zenith, smoothstep(0.0, 0.6, up));
  c = mix(c, ground, smoothstep(0.0, -0.25, up));
  let sd = max(dot(dir, U.sunDir.xyz), 0.0);
  c += U.sunColor.rgb * (pow(sd, 6.0) * 0.35 + pow(sd, 64.0) * 1.2) ;
  c += U.sunColor.rgb * smoothstep(0.9993, 0.9997, sd) * 30.0;
  // Cloud wisps: cheap layered sine noise projected on a plane above the camera.
  if (up > 0.02) {
    let p = dir.xz / (up + 0.08) * 0.7 + vec2f(U.b.w * 0.004, 0.0);
    var n = 0.0;
    n += sin(p.x * 1.7 + sin(p.y * 1.3)) * 0.5;
    n += sin(p.y * 3.1 + sin(p.x * 2.3 + 1.7)) * 0.25;
    n += sin((p.x + p.y) * 6.3 + 0.5) * 0.125;
    let cloud = smoothstep(0.15, 0.7, n) * smoothstep(0.02, 0.25, up);
    c = mix(c, U.sky.rgb * 1.15 + U.sunColor.rgb * pow(sd, 3.0) * 0.4, cloud * 0.55);
  }
  return c;
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_composite(i: FsIn) -> @location(0) vec4f {
  let split = U.c.x;
  let raw = textureLoad(depthTex, vec2i(i.pos.xy), 0);
  let isWorld = raw > split && raw < 1.0;
  var color = textureSampleLevel(src, samp, i.uv, 0.0).rgb;
  if (raw >= 1.0) {
    let far = U.invViewProj * vec4f(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0, 1.0, 1.0);
    color = sky(normalize(far.xyz / far.w - U.camPos.xyz));
  }

  if (isWorld) {
    // Rebuild the world position, then find where it was on screen last frame.
    let ndc = vec4f(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0, (raw - split) / (1.0 - split), 1.0);
    let wp = U.invViewProj * ndc;
    let world = wp.xyz / wp.w;
    let dist = length(world - U.camPos.xyz);

    if (U.a.z > 0.0) {
      let prev = U.prevViewProj * vec4f(world, 1.0);
      let prevUv = vec2f(prev.x / prev.w * 0.5 + 0.5, 0.5 - prev.y / prev.w * 0.5);
      var vel = (i.uv - prevUv) * U.a.z;
      let len = length(vel);
      if (prev.w > 0.0 && len > 0.0005) {
        vel = vel * min(1.0, 0.035 / len);
        var acc = color;
        for (var k = 1; k < 7; k++) {
          acc += textureSampleLevel(src, samp, i.uv - vel * (f32(k) / 6.0), 0.0).rgb;
        }
        color = acc / 7.0;
      }
    }

    if (U.b.x > 0.0) {
      let coc = U.b.x * smoothstep(0.0, 1.0, abs(dist - U.a.w) / max(U.a.w, 1.0));
      if (coc > 0.01) {
        var acc = color;
        let r = coc * 7.0;
        for (var k = 0; k < 8; k++) {
          let a = f32(k) * 2.399963;
          let rad = sqrt((f32(k) + 0.5) / 8.0) * r;
          acc += textureSampleLevel(src, samp, i.uv + vec2f(cos(a), sin(a)) * rad / vec2f(textureDimensions(src)), 0.0).rgb;
        }
        color = acc / 9.0;
      }
    }
  }

  color += textureSampleLevel(bloomTex, samp, i.uv, 0.0).rgb * U.a.y;
  color = aces(color * U.a.x);
  // Grade: gentle contrast S-curve, slightly muted saturation, cool shadows and warm highlights.
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(vec3f(luma), color, U.c.z);
  color = mix(color, color * vec3f(0.92, 1.0, 1.08), (1.0 - smoothstep(0.0, 0.45, luma)) * 0.6);
  color = mix(color, color * vec3f(1.06, 1.0, 0.92), smoothstep(0.5, 1.0, luma) * 0.5);
  color = clamp(color, vec3f(0.0), vec3f(1.0));
  color = mix(color, color * color * (3.0 - 2.0 * color), U.c.w);
  let edge = length(i.uv - 0.5);
  color *= 1.0 - U.b.y * smoothstep(0.35, 0.85, edge);
  color = mix(color, vec3f(0.55, 0.02, 0.02), U.b.z * smoothstep(0.25, 0.75, edge));
  var out = pow(color, vec3f(1.0 / 2.2));
  // Film grain, strongest in the mid-tones, re-seeded every frame.
  let g = hash2(i.pos.xy + fract(U.b.w * 7.13) * 917.0) - 0.5;
  out += g * U.c.y * (1.0 - abs(luma * 2.0 - 1.0));
  return vec4f(out, 1.0);
}
