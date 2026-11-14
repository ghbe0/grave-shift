//! Minimal vector maths. Y is up; yaw 0 looks down -Z.
use core::ops::{Add, AddAssign, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct V3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub const fn v3(x: f32, y: f32, z: f32) -> V3 {
    V3 { x, y, z }
}

impl V3 {
    pub const ZERO: V3 = v3(0.0, 0.0, 0.0);
    pub const UP: V3 = v3(0.0, 1.0, 0.0);
    pub fn dot(self, o: V3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn len(self) -> f32 {
        self.dot(self).sqrt()
    }
    pub fn norm(self) -> V3 {
        let l = self.len();
        if l > 1e-6 { self * (1.0 / l) } else { V3::ZERO }
    }
    /// Horizontal part.
    pub fn flat(self) -> V3 {
        v3(self.x, 0.0, self.z)
    }
    pub fn flat_len(self) -> f32 {
        (self.x * self.x + self.z * self.z).sqrt()
    }
    pub fn dist(self, o: V3) -> f32 {
        (self - o).len()
    }
    pub fn lerp(self, o: V3, t: f32) -> V3 {
        self + (o - self) * t
    }
}

impl Add for V3 {
    type Output = V3;
    fn add(self, o: V3) -> V3 {
        v3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl AddAssign for V3 {
    fn add_assign(&mut self, o: V3) {
        *self = *self + o;
    }
}
impl Sub for V3 {
    type Output = V3;
    fn sub(self, o: V3) -> V3 {
        v3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl Mul<f32> for V3 {
    type Output = V3;
    fn mul(self, s: f32) -> V3 {
        v3(self.x * s, self.y * s, self.z * s)
    }
}
impl Neg for V3 {
    type Output = V3;
    fn neg(self) -> V3 {
        v3(-self.x, -self.y, -self.z)
    }
}

pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
/// Move `cur` toward `target` by at most `step`.
pub fn approach(cur: f32, target: f32, step: f32) -> f32 {
    if cur < target { (cur + step).min(target) } else { (cur - step).max(target) }
}
/// Frame-rate independent exponential smoothing.
pub fn damp(cur: f32, target: f32, rate: f32, dt: f32) -> f32 {
    lerp(cur, target, 1.0 - (-rate * dt).exp())
}
pub fn smooth(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}
/// Unit view direction for yaw/pitch.
pub fn look_dir(yaw: f32, pitch: f32) -> V3 {
    let (sy, cy) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    v3(-sy * cp, sp, -cy * cp)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Aabb {
    pub min: V3,
    pub max: V3,
}

impl Aabb {
    pub fn new(min: V3, max: V3) -> Aabb {
        Aabb { min, max }
    }
    /// Box standing on `feet` with half-width `r` and height `h`.
    pub fn feet(feet: V3, r: f32, h: f32) -> Aabb {
        Aabb { min: v3(feet.x - r, feet.y, feet.z - r), max: v3(feet.x + r, feet.y + h, feet.z + r) }
    }
    /// Strict overlap with a small tolerance, so touching faces do not count.
    pub fn overlaps(&self, o: &Aabb) -> bool {
        const E: f32 = 1e-4;
        self.min.x < o.max.x - E
            && self.max.x > o.min.x + E
            && self.min.y < o.max.y - E
            && self.max.y > o.min.y + E
            && self.min.z < o.max.z - E
            && self.max.z > o.min.z + E
    }
    pub fn contains_xz(&self, x: f32, z: f32) -> bool {
        x >= self.min.x && x <= self.max.x && z >= self.min.z && z <= self.max.z
    }
    /// Slab test. Returns entry distance and the surface normal that was hit.
    pub fn ray(&self, o: V3, d: V3, max: f32) -> Option<(f32, V3)> {
        let (mut t0, mut t1) = (0.0f32, max);
        let mut n = V3::ZERO;
        let axes = [
            (o.x, d.x, self.min.x, self.max.x, v3(1.0, 0.0, 0.0)),
            (o.y, d.y, self.min.y, self.max.y, v3(0.0, 1.0, 0.0)),
            (o.z, d.z, self.min.z, self.max.z, v3(0.0, 0.0, 1.0)),
        ];
        for (oo, dd, mn, mx, unit) in axes {
            if dd.abs() < 1e-8 {
                if oo < mn || oo > mx {
                    return None;
                }
                continue;
            }
            let inv = 1.0 / dd;
            let (mut a, mut b, mut s) = ((mn - oo) * inv, (mx - oo) * inv, -1.0);
            if a > b {
                core::mem::swap(&mut a, &mut b);
                s = 1.0;
            }
            if a > t0 {
                t0 = a;
                n = unit * s;
            }
            if b < t1 {
                t1 = b;
            }
            if t0 > t1 {
                return None;
            }
        }
        Some((t0, n))
    }
}

/// Nearest positive hit distance of a ray against a sphere.
pub fn ray_sphere(o: V3, d: V3, c: V3, r: f32) -> Option<f32> {
    let m = o - c;
    let b = m.dot(d);
    let cc = m.dot(m) - r * r;
    if cc > 0.0 && b > 0.0 {
        return None;
    }
    let disc = b * b - cc;
    if disc < 0.0 {
        return None;
    }
    Some((-b - disc.sqrt()).max(0.0))
}
