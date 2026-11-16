//! Procedural PBR material textures. Every layer is seamlessly tileable and comes as two RGBA8
//! maps with a full mip chain:
//!   surface: rgb = albedo (sRGB), a = roughness
//!   detail:  rg  = tangent-space normal xy (z is rebuilt in the shader), b = metallic, a = ambient occlusion
//! Generating at load time keeps the download small and avoids shipping third-party art.

pub const LAYERS: usize = 17;
pub const L_CONCRETE: usize = 0;
pub const L_FLOOR: usize = 1;
pub const L_PAINTED: usize = 2;
pub const L_RUST: usize = 3;
pub const L_WOOD: usize = 4;
pub const L_BRICK: usize = 5;
pub const L_GUNMETAL: usize = 6;
pub const L_FABRIC: usize = 7;
pub const L_SKIN: usize = 8;
pub const L_POLYMER: usize = 9;
/// Weapon camos, applied in place of the polymer (and, for Gilded, the metal) on guns.
pub const L_WOODLAND: usize = 10;
pub const L_DIGITAL: usize = 11;
pub const L_DESERT: usize = 12;
pub const L_TIGER: usize = 13;
pub const L_ARCTIC: usize = 14;
pub const L_CARBON: usize = 15;
pub const L_GILDED: usize = 16;
/// Metres covered by one repeat of each layer.
pub const TILE: [f32; LAYERS] = [3.0, 4.0, 2.0, 2.5, 2.0, 2.0, 0.4, 0.6, 0.8, 0.3, 0.45, 0.4, 0.45, 0.4, 0.45, 0.12, 0.5];

fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841) ^ seed.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    (h & 0x00ff_ffff) as f32 / 16_777_216.0
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Value noise on a lattice that repeats every `p` cells. `u`, `v` in [0, 1).
fn noise(u: f32, v: f32, p: i32, seed: u32) -> f32 {
    let (x, y) = (u * p as f32, v * p as f32);
    let (xi, yi) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (fade(x - xi as f32), fade(y - yi as f32));
    let w = |i: i32| i.rem_euclid(p);
    let a = hash(w(xi), w(yi), seed);
    let b = hash(w(xi + 1), w(yi), seed);
    let c = hash(w(xi), w(yi + 1), seed);
    let d = hash(w(xi + 1), w(yi + 1), seed);
    let top = a + (b - a) * fx;
    top + (c + (d - c) * fx - top) * fy
}

/// Fractal noise in [0, 1], tileable.
fn fbm(u: f32, v: f32, p: i32, octaves: u32, seed: u32) -> f32 {
    let (mut sum, mut amp, mut norm, mut per) = (0.0, 1.0, 0.0, p);
    for o in 0..octaves {
        sum += noise(u, v, per, seed.wrapping_add(o * 101)) * amp;
        norm += amp;
        amp *= 0.5;
        per *= 2;
    }
    sum / norm
}

/// Distances to the nearest and second-nearest feature points of a tileable cell grid.
fn worley(u: f32, v: f32, p: i32, seed: u32) -> (f32, f32, u32) {
    let (x, y) = (u * p as f32, v * p as f32);
    let (xi, yi) = (x.floor() as i32, y.floor() as i32);
    let (mut f1, mut f2, mut id) = (9.0f32, 9.0f32, 0);
    for dy in -1..=1 {
        for dx in -1..=1 {
            let (cx, cy) = (xi + dx, yi + dy);
            let (wx, wy) = (cx.rem_euclid(p), cy.rem_euclid(p));
            let px = cx as f32 + hash(wx, wy, seed);
            let py = cy as f32 + hash(wx, wy, seed ^ 0x9e37);
            let d = ((px - x).powi(2) + (py - y).powi(2)).sqrt();
            if d < f1 {
                f2 = f1;
                f1 = d;
                id = (wy * p + wx) as u32;
            } else if d < f2 {
                f2 = d;
            }
        }
    }
    (f1, f2, id)
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
fn scale3(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
/// Distance from `x` to the nearest multiple of `step`, in units of `step` (0 on a line, 0.5 between).
fn line(x: f32, step: f32) -> f32 {
    let f = (x / step).fract();
    f.min(1.0 - f)
}

/// One texel: albedo (linear 0..1, encoded to sRGB later), roughness, metallic, height, ambient occlusion.
struct Px {
    albedo: [f32; 3],
    rough: f32,
    metal: f32,
    height: f32,
    ao: f32,
}

fn sample(layer: usize, u: f32, v: f32) -> Px {
    let s = layer as u32 * 7919;
    match layer {
        L_CONCRETE => {
            let big = fbm(u, v, 3, 5, s);
            let grain = fbm(u, v, 64, 3, s + 1);
            // Water streaks run down the wall.
            let streak = fbm(u * 1.0, v * 0.1, 24, 3, s + 2);
            // Formwork panels with tie-rod holes.
            let seam = smooth(0.0, 0.008, line(u, 0.5).min(line(v, 0.5)));
            let hole = ((u * 4.0).fract() - 0.5).hypot((v * 2.0).fract() - 0.5);
            let hole = smooth(0.03, 0.05, hole);
            let base = 0.26 + big * 0.14 + grain * 0.06 - smooth(0.55, 0.8, streak) * 0.1;
            Px {
                albedo: scale3([1.0, 0.98, 0.94], base * (0.8 + 0.2 * seam) * (0.5 + 0.5 * hole)),
                rough: 0.88 + grain * 0.1,
                metal: 0.0,
                height: grain * 0.5 + seam * 0.4 + hole * 0.6,
                ao: 0.7 + 0.3 * seam * hole,
            }
        }
        L_FLOOR => {
            let big = fbm(u, v, 4, 5, s);
            let grain = fbm(u, v, 96, 2, s + 1);
            let joint = smooth(0.0, 0.006, line(u, 0.25).min(line(v, 0.25)));
            let (f1, f2, _) = worley(u, v, 6, s + 2);
            let crack = 1.0 - smooth(0.0, 0.03, f2 - f1) * 1.0;
            let crack = crack * smooth(0.55, 0.7, fbm(u, v, 5, 3, s + 3));
            let oil = smooth(0.6, 0.75, fbm(u, v, 5, 4, s + 4));
            let base = (0.22 + big * 0.12 + grain * 0.05) * (1.0 - oil * 0.45) * (1.0 - crack * 0.6) * (0.75 + 0.25 * joint);
            Px {
                albedo: scale3([1.0, 0.97, 0.92], base),
                rough: 0.9 - oil * 0.55 + grain * 0.05,
                metal: 0.0,
                height: grain * 0.4 + joint * 0.5 - crack * 0.5,
                ao: 0.75 + 0.25 * joint * (1.0 - crack),
            }
        }
        L_PAINTED | L_RUST => {
            let painted = layer == L_PAINTED;
            let big = fbm(u, v, 4, 5, s);
            let fine = fbm(u, v, 48, 3, s + 1);
            let pits = fbm(u, v, 128, 2, s + 2);
            // Paint chips where wear noise crosses a threshold; rust everywhere on the rust layer.
            let wear = fbm(u, v, 8, 5, s + 3);
            let chip = if painted { smooth(0.62, 0.66, wear) } else { 1.0 };
            let rust_amt = smooth(0.35, 0.75, big * 0.7 + fine * 0.3);
            let rust = mix3([0.30, 0.13, 0.05], [0.52, 0.25, 0.09], fine);
            let rust = mix3(rust, [0.18, 0.09, 0.05], pits * 0.6);
            let bare = [0.34, 0.33, 0.32];
            let under = mix3(bare, rust, rust_amt);
            let paint = scale3([0.20, 0.24, 0.21], 0.85 + big * 0.3);
            let panel = smooth(0.0, 0.01, line(v, 0.5));
            let rivet = smooth(0.012, 0.02, ((u * 8.0).fract() - 0.5).hypot((v * 2.0).fract() - 0.06) / 8.0);
            let albedo = mix3(paint, under, chip);
            let metal = (1.0 - rust_amt) * chip;
            Px {
                albedo: scale3(albedo, 0.75 + 0.25 * panel),
                rough: if painted { 0.55 + chip * (0.35 * rust_amt) + fine * 0.1 } else { 0.7 + rust_amt * 0.25 },
                metal: metal * 0.9,
                height: (1.0 - chip) * 0.3 + pits * rust_amt * 0.5 + panel * 0.3 + (1.0 - rivet) * 0.5,
                ao: 0.8 + 0.2 * panel,
            }
        }
        L_WOOD => {
            let plank = (u * 5.0).floor();
            let pu = (u * 5.0).fract();
            let off = hash(plank as i32, 0, s);
            let grain = fbm((u + off) * 1.0, v, 8, 4, s + plank as u32);
            let rings = ((grain * 40.0 + pu * 3.0).sin() * 0.5 + 0.5).powf(3.0);
            let knot = smooth(0.08, 0.0, (pu - 0.5).hypot(((v + off) * 3.0).fract() - 0.5)) * smooth(0.6, 0.7, off);
            let gap = smooth(0.0, 0.04, pu.min(1.0 - pu));
            let weather = fbm(u, v, 6, 4, s + 9);
            let col = mix3([0.38, 0.24, 0.13], [0.24, 0.15, 0.08], rings * 0.7 + knot);
            let col = mix3(col, [0.33, 0.31, 0.28], smooth(0.5, 0.8, weather) * 0.6);
            Px {
                albedo: scale3(col, (0.8 + off * 0.35) * (0.25 + 0.75 * gap)),
                rough: 0.82 + rings * 0.1,
                metal: 0.0,
                height: gap * 0.6 + rings * 0.2 - knot * 0.2,
                ao: 0.55 + 0.45 * gap,
            }
        }
        L_BRICK => {
            let row = (v * 8.0).floor();
            let bu = u * 4.0 + if row as i32 % 2 == 1 { 0.5 } else { 0.0 };
            let (cu, cv) = (bu.fract(), (v * 8.0).fract());
            let mortar = smooth(0.0, 0.05, cu.min(1.0 - cu) * 2.0).min(smooth(0.0, 0.08, cv.min(1.0 - cv)));
            let id = hash(bu.floor() as i32 & 3, row as i32, s);
            let grain = fbm(u, v, 64, 3, s + 1);
            let dirt = fbm(u, v, 4, 4, s + 2);
            let brick = mix3([0.42, 0.16, 0.10], [0.30, 0.12, 0.08], id);
            let brick = mix3(brick, [0.2, 0.18, 0.16], dirt * 0.5);
            let col = mix3([0.38, 0.36, 0.33], scale3(brick, 0.85 + grain * 0.3), mortar);
            Px { albedo: col, rough: 0.85 + grain * 0.1, metal: 0.0, height: mortar * 0.6 + grain * 0.2, ao: 0.55 + 0.45 * mortar }
        }
        L_GUNMETAL => {
            let fine = fbm(u, v, 64, 3, s);
            // Machining marks and scratches.
            let brushed = fbm(u * 0.05, v, 256, 2, s + 1);
            let scratch = smooth(0.985, 1.0, noise(u * 0.02 + v, v, 512, s + 2)) + smooth(0.99, 1.0, noise(u, v * 0.03 + u, 512, s + 3));
            let wear = smooth(0.6, 0.8, fbm(u, v, 6, 4, s + 4));
            let base = 0.035 + fine * 0.02 + brushed * 0.015 + wear * 0.04 + scratch * 0.12;
            Px { albedo: [base, base * 1.02, base * 1.06], rough: 0.42 - wear * 0.12 - scratch * 0.2 + brushed * 0.1, metal: 0.95, height: brushed * 0.2 - scratch * 0.3, ao: 1.0 }
        }
        L_FABRIC => {
            let (wu, wv) = ((u * 64.0 * core::f32::consts::PI).sin(), (v * 64.0 * core::f32::consts::PI).sin());
            let weave = (wu * wv) * 0.5 + 0.5;
            let dirt = fbm(u, v, 6, 5, s);
            let blood = smooth(0.71, 0.76, fbm(u, v, 5, 5, s + 1));
            let tear = smooth(0.72, 0.75, fbm(u, v, 10, 4, s + 2));
            let cloth = mix3([0.16, 0.17, 0.14], [0.09, 0.09, 0.08], dirt);
            let cloth = mix3(cloth, [0.20, 0.03, 0.02], blood * 0.85);
            let col = mix3(cloth, [0.03, 0.03, 0.03], tear);
            Px { albedo: scale3(col, 0.92 + weave * 0.12), rough: 0.95 - blood * 0.35, metal: 0.0, height: weave * 0.15 - tear * 0.6, ao: 0.7 + 0.3 * (1.0 - tear) }
        }
        L_SKIN => {
            let mottle = fbm(u, v, 6, 5, s);
            let (f1, f2, _) = worley(u, v, 10, s + 1);
            let vein = 1.0 - smooth(0.0, 0.04, f2 - f1);
            let vein = vein * smooth(0.4, 0.6, fbm(u, v, 4, 3, s + 2));
            let rot = smooth(0.6, 0.75, fbm(u, v, 5, 5, s + 3));
            let wound = smooth(0.74, 0.78, fbm(u, v, 7, 4, s + 4));
            let col = mix3([0.2, 0.22, 0.16], [0.13, 0.15, 0.11], mottle);
            let col = mix3(col, [0.1, 0.07, 0.11], vein * 0.6);
            let col = mix3(col, [0.12, 0.1, 0.06], rot * 0.7);
            let col = mix3(col, [0.16, 0.01, 0.01], wound);
            Px { albedo: col, rough: 0.55 + mottle * 0.2 - wound * 0.3, metal: 0.0, height: mottle * 0.3 + vein * 0.2 - wound * 0.5, ao: 0.85 + 0.15 * (1.0 - wound) }
        }
        L_WOODLAND | L_DESERT | L_ARCTIC => {
            // Four-colour blob camouflage from two noise fields.
            let a = fbm(u, v, 5, 4, s);
            let b = fbm(u, v, 7, 4, s + 1);
            let pal: [[f32; 3]; 4] = match layer {
                L_WOODLAND => [[0.13, 0.15, 0.08], [0.06, 0.08, 0.04], [0.20, 0.14, 0.07], [0.02, 0.02, 0.02]],
                L_DESERT => [[0.42, 0.33, 0.21], [0.30, 0.22, 0.13], [0.52, 0.44, 0.31], [0.20, 0.15, 0.10]],
                _ => [[0.80, 0.82, 0.84], [0.55, 0.58, 0.62], [0.68, 0.70, 0.73], [0.30, 0.32, 0.35]],
            };
            let i = if a > 0.62 { 3 } else if b > 0.58 { 2 } else if a < 0.42 { 1 } else { 0 };
            let grain = fbm(u, v, 96, 2, s + 2);
            Px { albedo: scale3(pal[i], 0.9 + grain * 0.2), rough: 0.62 + grain * 0.15, metal: 0.0, height: grain * 0.25, ao: 1.0 }
        }
        L_DIGITAL => {
            // Pixelated urban pattern: noise sampled on a coarse grid, so it comes out in squares.
            let q = |x: f32| (x * 48.0).floor() / 48.0 + 0.5 / 48.0;
            let (qu, qv) = (q(u), q(v));
            let a = fbm(qu, qv, 6, 4, s);
            let b = fbm(qu, qv, 12, 3, s + 1);
            let c = if a > 0.6 { [0.05, 0.05, 0.06] } else if b > 0.55 { [0.42, 0.43, 0.45] } else if a < 0.42 { [0.62, 0.63, 0.64] } else { [0.20, 0.21, 0.23] };
            let edge = smooth(0.0, 0.08, line(u * 48.0, 1.0).min(line(v * 48.0, 1.0)));
            Px { albedo: c, rough: 0.6, metal: 0.0, height: edge * 0.15, ao: 0.92 + 0.08 * edge }
        }
        L_TIGER => {
            // Warped horizontal stripes.
            let warp = fbm(u, v, 4, 4, s) * 0.35;
            let stripe = ((v * 9.0 + warp * 6.0 + (u * 2.0 * core::f32::consts::PI).sin() * 0.25) * core::f32::consts::PI).sin();
            let breakup = fbm(u * 3.0, v, 12, 3, s + 1);
            let black = stripe > 0.55 - breakup * 0.4;
            let base = mix3([0.26, 0.28, 0.12], [0.36, 0.31, 0.16], fbm(u, v, 8, 3, s + 2));
            Px { albedo: if black { [0.025, 0.025, 0.02] } else { base }, rough: 0.6, metal: 0.0, height: 0.1, ao: 1.0 }
        }
        L_CARBON => {
            // 2x2 twill weave, glossy clear coat.
            let (cu, cv) = ((u * 32.0).floor() as i32, (v * 32.0).floor() as i32);
            let along_u = ((cu + cv).rem_euclid(4)) < 2;
            let (fu, fv) = ((u * 32.0).fract(), (v * 32.0).fract());
            let fibre = if along_u { (fv * core::f32::consts::PI).sin() } else { (fu * core::f32::consts::PI).sin() };
            let sheen = if along_u { 0.055 } else { 0.035 };
            Px { albedo: [sheen * (0.7 + 0.3 * fibre); 3], rough: 0.22 + (1.0 - fibre) * 0.12, metal: 0.0, height: fibre * 0.3, ao: 0.9 + 0.1 * fibre }
        }
        L_GILDED => {
            // Polished gold with fine scratches and slightly darker hollows.
            let fine = fbm(u, v, 64, 3, s);
            let scratch = smooth(0.985, 1.0, noise(u * 0.03 + v, v, 512, s + 1)) + smooth(0.99, 1.0, noise(u, v * 0.02 + u, 512, s + 2));
            let tarnish = smooth(0.55, 0.8, fbm(u, v, 5, 4, s + 3));
            let gold = mix3([1.0, 0.77, 0.34], [0.78, 0.55, 0.22], tarnish * 0.6);
            Px { albedo: scale3(gold, 0.92 + fine * 0.1 + scratch * 0.1), rough: 0.18 + fine * 0.1 + tarnish * 0.15 - scratch * 0.08, metal: 1.0, height: fine * 0.15 - scratch * 0.2, ao: 1.0 }
        }
        _ => {
            let stipple = fbm(u, v, 192, 2, s);
            let wear = smooth(0.7, 0.85, fbm(u, v, 6, 4, s + 1));
            let b = 0.045 + stipple * 0.025 + wear * 0.05;
            Px { albedo: [b, b, b * 1.05], rough: 0.75 - wear * 0.25, metal: 0.0, height: stipple * 0.5, ao: 1.0 }
        }
    }
}

fn to_srgb(x: f32) -> u8 {
    let x = x.clamp(0.0, 1.0);
    let s = if x <= 0.003_130_8 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0 + 0.5) as u8
}
fn unorm(x: f32) -> u8 {
    (x.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// Generates one layer at `size` x `size` and appends both maps' mip chains to `out`
/// (surface levels first, then detail levels; level n is `size >> n` square, down to 1x1).
pub fn generate(layer: usize, size: usize, out: &mut Vec<u8>) {
    let n = size * size;
    let mut height = vec![0f32; n];
    let mut surface = vec![0u8; n * 4];
    let mut other = vec![[0f32; 2]; n];
    for y in 0..size {
        for x in 0..size {
            let i = y * size + x;
            let p = sample(layer, (x as f32 + 0.5) / size as f32, (y as f32 + 0.5) / size as f32);
            surface[i * 4] = to_srgb(p.albedo[0]);
            surface[i * 4 + 1] = to_srgb(p.albedo[1]);
            surface[i * 4 + 2] = to_srgb(p.albedo[2]);
            surface[i * 4 + 3] = unorm(p.rough);
            height[i] = p.height;
            other[i] = [p.metal, p.ao];
        }
    }
    // Normals from the height field (wrapping, so seams stay invisible).
    let strength = size as f32 / 96.0;
    let mut detail = vec![0u8; n * 4];
    let h = |x: isize, y: isize| height[(y.rem_euclid(size as isize) as usize) * size + x.rem_euclid(size as isize) as usize];
    for y in 0..size as isize {
        for x in 0..size as isize {
            let dx = (h(x + 1, y) - h(x - 1, y)) * strength;
            let dy = (h(x, y + 1) - h(x, y - 1)) * strength;
            let l = (dx * dx + dy * dy + 1.0).sqrt();
            let i = y as usize * size + x as usize;
            detail[i * 4] = unorm(-dx / l * 0.5 + 0.5);
            detail[i * 4 + 1] = unorm(-dy / l * 0.5 + 0.5);
            detail[i * 4 + 2] = unorm(other[i][0]);
            detail[i * 4 + 3] = unorm(other[i][1]);
        }
    }
    for (map, is_detail) in [(surface, false), (detail, true)] {
        let mut level = map;
        let mut s = size;
        loop {
            out.extend_from_slice(&level);
            if s == 1 {
                break;
            }
            level = downsample(&level, s, is_detail);
            s /= 2;
        }
    }
}

/// 2x2 box filter. Albedo is averaged in linear space; normals are averaged then renormalised.
fn downsample(src: &[u8], size: usize, normals: bool) -> Vec<u8> {
    let half = size / 2;
    let mut out = vec![0u8; half * half * 4];
    let lin = |b: u8| (b as f32 / 255.0).powf(2.2);
    for y in 0..half {
        for x in 0..half {
            let idx = |dx: usize, dy: usize| ((y * 2 + dy) * size + x * 2 + dx) * 4;
            let o = (y * half + x) * 4;
            for c in 0..4 {
                let vals = [src[idx(0, 0) + c], src[idx(1, 0) + c], src[idx(0, 1) + c], src[idx(1, 1) + c]];
                out[o + c] = if !normals && c < 3 {
                    let avg = vals.iter().map(|v| lin(*v)).sum::<f32>() / 4.0;
                    (avg.powf(1.0 / 2.2) * 255.0 + 0.5) as u8
                } else {
                    ((vals.iter().map(|v| *v as u32).sum::<u32>() + 2) / 4) as u8
                };
            }
            if normals {
                // Averaging shortens normals: fold the lost length into roughness-like flattening.
                let (nx, ny) = (out[o] as f32 / 127.5 - 1.0, out[o + 1] as f32 / 127.5 - 1.0);
                out[o] = unorm(nx * 0.5 + 0.5);
                out[o + 1] = unorm(ny * 0.5 + 0.5);
            }
        }
    }
    out
}

/// Bytes `generate` produces for one layer.
pub fn layer_bytes(size: usize) -> usize {
    let mut total = 0;
    let mut s = size;
    loop {
        total += s * s * 4;
        if s == 1 {
            break;
        }
        s /= 2;
    }
    total * 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layers_tile_and_have_full_mip_chains() {
        for layer in 0..LAYERS {
            let mut out = vec![];
            generate(layer, 64, &mut out);
            assert_eq!(out.len(), layer_bytes(64), "layer {layer}");
            // Seamless: opposite edges of the base level match closely.
            let px = |x: usize, y: usize, c: usize| out[(y * 64 + x) * 4 + c] as i32;
            let mut diff = 0;
            for y in 0..64 {
                for c in 0..3 {
                    diff += (px(0, y, c) - px(63, y, c)).abs();
                }
            }
            assert!(diff / (64 * 3) < 40, "layer {layer} left/right edge differs by {}", diff / (64 * 3));
            // Not flat: real variation in albedo.
            let lum: Vec<i32> = (0..64 * 64).map(|i| out[i * 4] as i32).collect();
            let (min, max) = (lum.iter().min().unwrap(), lum.iter().max().unwrap());
            assert!(max - min > 10, "layer {layer} has no variation");
        }
    }
}
