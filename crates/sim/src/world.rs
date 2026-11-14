//! Static collision world made of axis-aligned boxes, plus the 2.5D nav grid zombies path on.
use crate::math::{v3, Aabb, V3};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// Ignored by the nav grid (ceilings, clip brushes).
pub const F_NONAV: u32 = 1;
/// Not rendered.
pub const F_HIDDEN: u32 = 2;
/// Removed when its door (tag) is bought.
pub const F_DOOR: u32 = 4;
/// Blocks players only: bullets and zombies pass.
pub const F_CLIP: u32 = 8;

pub const STEP: f32 = 0.55;
const EPS: f32 = 1e-3;

#[derive(Clone, Copy, Debug)]
pub struct Solid {
    pub bb: Aabb,
    pub mat: u8,
    pub flags: u32,
    pub tag: i32,
    pub on: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Contact {
    pub grounded: bool,
    pub wall: Option<V3>,
    pub ceiling: bool,
    pub impact: f32,
    pub stepped: f32,
}

#[derive(Default)]
pub struct World {
    pub solids: Vec<Solid>,
    pub nav: Nav,
}

impl World {
    pub fn overlaps(&self, a: &Aabb) -> bool {
        self.solids.iter().any(|s| s.on && s.bb.overlaps(a))
    }
    fn first(&self, a: &Aabb) -> Option<&Solid> {
        self.solids.iter().find(|s| s.on && s.bb.overlaps(a))
    }

    /// Bullet trace: nearest hit against everything that stops shots.
    pub fn raycast(&self, o: V3, d: V3, max: f32) -> Option<(f32, V3)> {
        let mut best: Option<(f32, V3)> = None;
        for s in &self.solids {
            if !s.on || s.flags & F_CLIP != 0 {
                continue;
            }
            if let Some((t, n)) = s.bb.ray(o, d, best.map_or(max, |b| b.0)) {
                best = Some((t, n));
            }
        }
        best
    }

    /// Axis-separated move-and-slide for a box standing on `pos`. Handles step-up.
    pub fn slide_move(&self, pos: &mut V3, vel: &mut V3, r: f32, h: f32, dt: f32, was_grounded: bool) -> Contact {
        let mut c = Contact::default();
        let total = *vel * dt;
        let n = ((total.len() / 0.3).ceil() as usize).clamp(1, 8);
        let d = total * (1.0 / n as f32);
        for _ in 0..n {
            for axis in 0..2 {
                let dd = if axis == 0 { d.x } else { d.z };
                if dd == 0.0 {
                    continue;
                }
                if axis == 0 { pos.x += dd } else { pos.z += dd }
                if !self.overlaps(&Aabb::feet(*pos, r, h)) {
                    continue;
                }
                // Try to step onto a low obstacle before treating it as a wall.
                if was_grounded || c.grounded {
                    let bb = Aabb::feet(*pos, r, h);
                    let top = self.solids.iter().filter(|s| s.on && s.bb.overlaps(&bb)).map(|s| s.bb.max.y).fold(f32::MIN, f32::max);
                    if top - pos.y <= STEP {
                        let up = v3(pos.x, top + EPS, pos.z);
                        if !self.overlaps(&Aabb::feet(up, r, h)) {
                            c.stepped += up.y - pos.y;
                            *pos = up;
                            continue;
                        }
                    }
                }
                for _ in 0..8 {
                    let Some(s) = self.first(&Aabb::feet(*pos, r, h)) else { break };
                    if axis == 0 {
                        pos.x = if dd > 0.0 { s.bb.min.x - r - EPS } else { s.bb.max.x + r + EPS };
                    } else {
                        pos.z = if dd > 0.0 { s.bb.min.z - r - EPS } else { s.bb.max.z + r + EPS };
                    }
                }
                if axis == 0 {
                    c.wall = Some(v3(-dd.signum(), 0.0, 0.0));
                    vel.x = 0.0;
                } else {
                    c.wall = Some(v3(0.0, 0.0, -dd.signum()));
                    vel.z = 0.0;
                }
            }
            pos.y += d.y;
            for _ in 0..8 {
                let Some(s) = self.first(&Aabb::feet(*pos, r, h)) else { break };
                if d.y <= 0.0 {
                    pos.y = s.bb.max.y;
                    if !c.grounded {
                        c.impact = c.impact.max(-vel.y);
                    }
                    c.grounded = true;
                } else {
                    pos.y = s.bb.min.y - h - EPS;
                    c.ceiling = true;
                }
                vel.y = 0.0;
            }
        }
        c
    }

    /// Keeps a walking player glued to stairs: drops onto ground within one step height.
    pub fn snap_down(&self, pos: &mut V3, r: f32, h: f32) -> bool {
        let probe = Aabb::feet(v3(pos.x, pos.y - STEP, pos.z), r, h);
        let mut top = f32::MIN;
        for s in self.solids.iter().filter(|s| s.on && s.bb.overlaps(&probe)) {
            if s.bb.max.y <= pos.y + EPS {
                top = top.max(s.bb.max.y);
            } else {
                return false;
            }
        }
        if top > f32::MIN {
            pos.y = top;
            true
        } else {
            false
        }
    }

    /// Nearest wall tall enough to run on within `reach` of the player's sides. Returns its outward normal.
    pub fn wall_near(&self, pos: V3, r: f32, reach: f32) -> Option<V3> {
        let mut best: Option<(f32, V3)> = None;
        for s in &self.solids {
            if !s.on || s.bb.max.y < pos.y + 1.4 || s.bb.min.y > pos.y + 0.5 {
                continue;
            }
            let b = &s.bb;
            let in_z = pos.z > b.min.z - r * 0.5 && pos.z < b.max.z + r * 0.5;
            let in_x = pos.x > b.min.x - r * 0.5 && pos.x < b.max.x + r * 0.5;
            let cands = [
                (in_z, b.min.x - (pos.x + r), v3(-1.0, 0.0, 0.0)),
                (in_z, (pos.x - r) - b.max.x, v3(1.0, 0.0, 0.0)),
                (in_x, b.min.z - (pos.z + r), v3(0.0, 0.0, -1.0)),
                (in_x, (pos.z - r) - b.max.z, v3(0.0, 0.0, 1.0)),
            ];
            for (ok, gap, n) in cands {
                if ok && gap > -0.05 && gap < reach && best.map_or(true, |x| gap < x.0) {
                    best = Some((gap, n));
                }
            }
        }
        best.map(|b| b.1)
    }

    /// Finds a ledge ahead that can be mantled: returns the standing position on top of it.
    pub fn ledge(&self, pos: V3, fwd: V3, r: f32, h: f32, reach: f32) -> Option<V3> {
        let (px, pz) = (pos.x + fwd.x * (r + 0.3), pos.z + fwd.z * (r + 0.3));
        let mut top = f32::MIN;
        for s in &self.solids {
            if s.on && s.bb.contains_xz(px, pz) && s.bb.min.y < pos.y + h && s.bb.max.y > pos.y + STEP {
                top = top.max(s.bb.max.y);
            }
        }
        if top == f32::MIN || top > pos.y + reach {
            return None;
        }
        let target = v3(pos.x + fwd.x * (r + 0.5), top + EPS, pos.z + fwd.z * (r + 0.5));
        let lift = v3(pos.x, top + EPS, pos.z);
        if self.overlaps(&Aabb::feet(target, r, h)) || self.overlaps(&Aabb::feet(lift, r, h)) {
            return None;
        }
        Some(target)
    }

    pub fn set_door(&mut self, door: i32, open: bool) {
        for s in self.solids.iter_mut().filter(|s| s.flags & F_DOOR != 0 && s.tag == door) {
            s.on = !open;
        }
    }
}

/// Height-field navigation grid. One walkable layer: every platform must be solid down to the floor.
#[derive(Default)]
pub struct Nav {
    pub w: usize,
    pub h: usize,
    pub ox: f32,
    pub oz: f32,
    /// Floor height per cell.
    pub height: Vec<f32>,
    /// Never walkable (inside a full-height wall).
    pub solid: Vec<bool>,
    /// Door index + 1 that blocks this cell while closed.
    pub door: Vec<u8>,
    /// Barricade index + 1 standing in this cell.
    pub barr: Vec<u8>,
    /// Path distance to the nearest living player.
    pub dist: Vec<f32>,
}

/// Zombies walk up this much and climb up to `CLIMB`.
const WALK: f32 = 0.6;
const CLIMB: f32 = 2.2;
const CLIMB_COST: f32 = 3.0;

impl Nav {
    pub fn build(solids: &[Solid], min: V3, max: V3, wall_h: f32) -> Nav {
        let w = (max.x - min.x).ceil() as usize;
        let h = (max.z - min.z).ceil() as usize;
        let mut nav = Nav { w, h, ox: min.x, oz: min.z, ..Default::default() };
        nav.height = vec![0.0; w * h];
        nav.solid = vec![false; w * h];
        nav.door = vec![0; w * h];
        nav.barr = vec![0; w * h];
        nav.dist = vec![f32::INFINITY; w * h];
        for c in 0..w * h {
            let (x, z) = nav.center(c);
            let probe = Aabb::new(v3(x - 0.4, -100.0, z - 0.4), v3(x + 0.4, 100.0, z + 0.4));
            let mut top = f32::MIN;
            for s in solids.iter().filter(|s| s.bb.overlaps(&probe)) {
                if s.flags & F_DOOR != 0 {
                    nav.door[c] = (s.tag + 1) as u8;
                } else if s.flags & F_NONAV == 0 {
                    top = top.max(s.bb.max.y);
                }
            }
            nav.height[c] = top;
            nav.solid[c] = top == f32::MIN || top > wall_h - 1.5;
        }
        nav
    }

    pub fn center(&self, c: usize) -> (f32, f32) {
        (self.ox + (c % self.w) as f32 + 0.5, self.oz + (c / self.w) as f32 + 0.5)
    }
    pub fn cell(&self, x: f32, z: f32) -> Option<usize> {
        let (cx, cz) = ((x - self.ox).floor(), (z - self.oz).floor());
        if cx < 0.0 || cz < 0.0 || cx as usize >= self.w || cz as usize >= self.h {
            return None;
        }
        Some(cz as usize * self.w + cx as usize)
    }
    fn open(&self, c: usize, doors: u32) -> bool {
        !self.solid[c] && (self.door[c] == 0 || doors & (1 << (self.door[c] - 1)) != 0)
    }
    /// Cost for a zombie to move from `a` to adjacent `b`, or None if it cannot.
    fn cost(&self, a: usize, b: usize, doors: u32) -> Option<f32> {
        if !self.open(a, doors) || !self.open(b, doors) {
            return None;
        }
        let dh = self.height[b] - self.height[a];
        if dh <= WALK {
            Some(if dh < -WALK { 1.5 } else { 1.0 })
        } else if dh <= CLIMB {
            Some(1.0 + CLIMB_COST)
        } else {
            None
        }
    }
    fn neighbors(&self, c: usize) -> impl Iterator<Item = (usize, bool)> + '_ {
        let (x, z) = ((c % self.w) as i32, (c / self.w) as i32);
        const D: [(i32, i32); 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)];
        D.iter().filter_map(move |&(dx, dz)| {
            let (nx, nz) = (x + dx, z + dz);
            if nx < 0 || nz < 0 || nx as usize >= self.w || nz as usize >= self.h {
                return None;
            }
            Some((nz as usize * self.w + nx as usize, dx != 0 && dz != 0))
        })
    }
    /// Step cost from `a` to neighbour `b`, forbidding diagonal corner cutting.
    fn step_cost(&self, a: usize, b: usize, diag: bool, doors: u32) -> Option<f32> {
        let c = self.cost(a, b, doors)?;
        if !diag {
            return Some(c);
        }
        let (ax, az, bx, bz) = (a % self.w, a / self.w, b % self.w, b / self.w);
        let (s1, s2) = (az * self.w + bx, bz * self.w + ax);
        let flat = |n: usize| self.open(n, doors) && (self.height[n] - self.height[a]).abs() <= WALK;
        if flat(s1) && flat(s2) && (self.height[b] - self.height[a]).abs() <= WALK { Some(c * 1.414) } else { None }
    }

    /// Rebuilds the distance field from the given source cells (Dijkstra).
    pub fn flow(&mut self, sources: &[usize], doors: u32) {
        self.dist.iter_mut().for_each(|d| *d = f32::INFINITY);
        let mut heap = BinaryHeap::new();
        for &s in sources {
            if self.open(s, doors) {
                self.dist[s] = 0.0;
                heap.push(Reverse((0u32, s)));
            }
        }
        while let Some(Reverse((bits, c))) = heap.pop() {
            let d = f32::from_bits(bits);
            if d > self.dist[c] {
                continue;
            }
            let ns: Vec<(usize, bool)> = self.neighbors(c).collect();
            for (n, diag) in ns {
                // Zombies travel n -> c, so the edge is evaluated in that direction.
                if let Some(cost) = self.step_cost(n, c, diag, doors) {
                    let nd = d + cost;
                    if nd < self.dist[n] {
                        self.dist[n] = nd;
                        heap.push(Reverse((nd.to_bits(), n)));
                    }
                }
            }
        }
    }

    /// Best neighbouring cell to walk to from `c`.
    pub fn next(&self, c: usize, doors: u32) -> Option<usize> {
        let mut best: Option<(f32, usize)> = None;
        for (n, diag) in self.neighbors(c) {
            if let Some(cost) = self.step_cost(c, n, diag, doors) {
                let total = self.dist[n] + cost;
                if total.is_finite() && best.map_or(true, |b| total < b.0) {
                    best = Some((total, n));
                }
            }
        }
        best.filter(|b| b.0 < self.dist[c] + 0.01 || !self.dist[c].is_finite()).map(|b| b.1)
    }

    /// Walkable cell closest to a point, searching outward a few rings.
    pub fn nearest(&self, x: f32, z: f32, y: f32, doors: u32) -> Option<usize> {
        let c = self.cell(x.clamp(self.ox, self.ox + self.w as f32 - 0.01), z.clamp(self.oz, self.oz + self.h as f32 - 0.01))?;
        let (cx, cz) = ((c % self.w) as i32, (c / self.w) as i32);
        let mut best: Option<(f32, usize)> = None;
        for r in 0..4i32 {
            for dz in -r..=r {
                for dx in -r..=r {
                    if dx.abs().max(dz.abs()) != r {
                        continue;
                    }
                    let (nx, nz) = (cx + dx, cz + dz);
                    if nx < 0 || nz < 0 || nx as usize >= self.w || nz as usize >= self.h {
                        continue;
                    }
                    let n = nz as usize * self.w + nx as usize;
                    if !self.open(n, doors) || self.height[n] > y + 1.0 {
                        continue;
                    }
                    let (px, pz) = self.center(n);
                    let d = (px - x).powi(2) + (pz - z).powi(2);
                    if best.map_or(true, |b| d < b.0) {
                        best = Some((d, n));
                    }
                }
            }
            if best.is_some() {
                break;
            }
        }
        best.map(|b| b.1)
    }
}
