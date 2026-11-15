// Post-processing: bloom (threshold, downsample, upsample) and a composite pass doing camera
// motion blur, depth of field, tone mapping and vignette.
struct Post {
  invViewProj: mat4x4f,
  prevViewProj: mat4x4f,
  camPos: vec4f,
  a: vec4f, // exposure, bloom, motion blur, dof focus
  b: vec4f, // dof amount, vignette, damage, time
  c: vec4f, // viewmodel depth split, unused
}
@group(0) @binding(0) var<uniform> U: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
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

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_composite(i: FsIn) -> @location(0) vec4f {
  let split = U.c.x;
  let raw = textureLoad(depthTex, vec2i(i.pos.xy), 0);
  let isWorld = raw > split;
  var color = textureSampleLevel(src, samp, i.uv, 0.0).rgb;

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
  let edge = length(i.uv - 0.5);
  color *= 1.0 - U.b.y * smoothstep(0.35, 0.85, edge);
  color = mix(color, vec3f(0.55, 0.02, 0.02), U.b.z * smoothstep(0.25, 0.75, edge));
  return vec4f(pow(color, vec3f(1.0 / 2.2)), 1.0);
}
