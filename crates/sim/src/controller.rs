//! First-person character controller: thrust jumps, wall-running, slides, mantling and
//! the camera feel values (bob, FOV kick, roll) that go with them.
use crate::math::{approach, damp, smooth, v3, Aabb, V3};
use crate::state;
use crate::world::World;

pub const B_JUMP: u32 = 1;
pub const B_SPRINT: u32 = 2;
pub const B_CROUCH: u32 = 4;
pub const B_FIRE: u32 = 8;
pub const B_ADS: u32 = 16;
pub const B_RELOAD: u32 = 32;
pub const B_USE: u32 = 64;
pub const B_MELEE: u32 = 128;
pub const B_ABILITY: u32 = 256;
pub const B_SWITCH: u32 = 512;
pub const B_TONIC: u32 = 1024;
pub const B_LETHAL: u32 = 2048;
pub const B_TACTICAL: u32 = 4096;
pub const B_STREAK1: u32 = 8192;
pub const B_STREAK2: u32 = 16384;
pub const B_STREAK3: u32 = 32768;

pub const MODE_NORMAL: u8 = 0;
pub const MODE_SLIDE: u8 = 1;
pub const MODE_WALL: u8 = 2;
pub const MODE_MANTLE: u8 = 3;

// Events returned from `step`, for audio and effects.
pub const CE_JUMP: u32 = 1;
pub const CE_LAND: u32 = 2;
pub const CE_SLIDE: u32 = 4;
pub const CE_THRUST: u32 = 8;
pub const CE_WALLRUN: u32 = 16;
pub const CE_WALLJUMP: u32 = 32;
pub const CE_MANTLE: u32 = 64;

pub const RADIUS: f32 = 0.35;
pub const HEIGHT: f32 = 1.8;
pub const CROUCH_HEIGHT: f32 = 1.1;
pub const EYE_STAND: f32 = 1.62;
const EYE_CROUCH: f32 = 0.98;
const EYE_SLIDE: f32 = 0.72;

const GRAVITY: f32 = 22.0;
const WALK_SPEED: f32 = 5.0;
const SPRINT_SPEED: f32 = 7.2;
const CROUCH_SPEED: f32 = 2.6;
const GROUND_ACCEL: f32 = 10.0;
const GROUND_FRICTION: f32 = 8.0;
const STOP_SPEED: f32 = 2.0;
const AIR_ACCEL: f32 = 2.2;
const MAX_HSPEED: f32 = 13.0;
const JUMP_V: f32 = 6.6;
const COYOTE: f32 = 0.1;

/// Seconds of continuous thrust in a full meter.
const THRUST_TIME: f32 = 0.65;
const THRUST_ACC: f32 = 50.0;
const THRUST_VCAP: f32 = 4.0;
const THRUST_HACC: f32 = 8.0;
/// Airtime before holding jump turns into thrust.
const THRUST_ARM: f32 = 0.14;
const THRUST_REGEN: f32 = 1.8;
const THRUST_REGEN_DELAY: f32 = 0.3;

const SLIDE_MIN: f32 = 5.5;
const SLIDE_SPEED: f32 = 10.0;
const SLIDE_DECEL: f32 = 5.5;
const SLIDE_MAX_T: f32 = 1.1;
const SLIDE_CANCEL_AFTER: f32 = 0.2;

const WALL_SPEED: f32 = 7.6;
const WALL_MIN_ALONG: f32 = 3.0;
const WALL_MAX_T: f32 = 2.4;
const WALL_REACH: f32 = 0.45;
const WALL_JUMP_OUT: f32 = 5.0;
const WALL_JUMP_UP: f32 = 6.4;

const MANTLE_REACH: f32 = 1.9;

/// One tick of player input. Sent verbatim from clients to the host.
#[derive(Clone, Copy, Debug, Default)]
pub struct Cmd {
    pub seq: u32,
    pub dt: f32,
    pub mx: f32,
    pub mz: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub buttons: u32,
    /// Requested weapon slot, or -1.
    pub slot: i32,
    /// Host time the client was rendering when it sent this (lag compensation).
    pub rt: f32,
}
pub const CMD_LEN: usize = 9;

impl Cmd {
    pub fn parse(d: &[f32]) -> Cmd {
        let g = |i: usize| d.get(i).copied().filter(|v| v.is_finite()).unwrap_or(0.0);
        Cmd {
            seq: g(0) as u32,
            dt: g(1).clamp(1.0 / 240.0, 1.0 / 20.0),
            mx: g(2).clamp(-1.0, 1.0),
            mz: g(3).clamp(-1.0, 1.0),
            yaw: g(4),
            pitch: g(5).clamp(-1.55, 1.55),
            buttons: g(6) as u32,
            slot: g(7) as i32,
            rt: g(8),
        }
    }
}

/// Per-tick modifiers computed from perks, abilities, weapon weight and status effects.
#[derive(Clone, Copy, Debug)]
pub struct Mods {
    pub speed: f32,
    pub thrust_regen: f32,
    pub slide_decel: f32,
    pub inf_thrust: bool,
    pub no_sprint: bool,
    pub frozen: bool,
}
impl Default for Mods {
    fn default() -> Self {
        Mods { speed: 1.0, thrust_regen: 1.0, slide_decel: 1.0, inf_thrust: false, no_sprint: false, frozen: false }
    }
}

state! {
    pub struct Ctl {
        pub pos: V3,
        pub vel: V3,
        pub yaw: f32,
        pub pitch: f32,
        pub grounded: bool,
        pub mode: u8,
        pub crouched: bool,
        pub sprinting: bool,
        pub thrusting: bool,
        pub thrust: f32,
        pub thrust_delay: f32,
        pub air_t: f32,
        pub slide_t: f32,
        pub slide_cd: f32,
        pub wall_n: V3,
        pub wall_t: f32,
        pub wall_cd: f32,
        pub wall_s: f32,
        pub wall_off: f32,
        pub mantle_t: f32,
        pub mantle_d: f32,
        pub mantle_a: V3,
        pub mantle_b: V3,
        pub eye: f32,
        pub bob_ph: f32,
        pub bob_amp: f32,
        pub dip: f32,
        pub dip_v: f32,
        pub fov: f32,
        pub roll: f32,
        pub step_off: f32,
    }
}

impl Ctl {
    pub fn spawn(pos: V3, yaw: f32) -> Ctl {
        Ctl { pos, yaw, thrust: 1.0, eye: EYE_STAND, grounded: true, ..Default::default() }
    }
    pub fn height(&self) -> f32 {
        if self.crouched { CROUCH_HEIGHT } else { HEIGHT }
    }
    pub fn eye_pos(&self) -> V3 {
        v3(self.pos.x, self.pos.y + self.eye, self.pos.z)
    }
    fn can_stand(&self, w: &World) -> bool {
        !w.overlaps(&Aabb::feet(self.pos, RADIUS, HEIGHT))
    }

    fn accelerate(&mut self, dir: V3, wish_speed: f32, accel: f32, dt: f32) {
        let add = wish_speed - self.vel.dot(dir);
        if add > 0.0 {
            self.vel += dir * (accel * dt * wish_speed).min(add);
        }
    }
    fn friction(&mut self, amount: f32, dt: f32) {
        let s = self.vel.flat_len();
        if s < 0.01 {
            self.vel.x = 0.0;
            self.vel.z = 0.0;
            return;
        }
        let k = (s - s.max(STOP_SPEED) * amount * dt).max(0.0) / s;
        self.vel.x *= k;
        self.vel.z *= k;
    }
    fn start_slide(&mut self, fwd: V3) -> u32 {
        let hs = self.vel.flat_len();
        let dir = if hs > 0.5 { self.vel.flat() * (1.0 / hs) } else { fwd };
        let s = hs.max(SLIDE_SPEED);
        self.vel.x = dir.x * s;
        self.vel.z = dir.z * s;
        self.mode = MODE_SLIDE;
        self.slide_t = 0.0;
        self.crouched = true;
        self.sprinting = false;
        CE_SLIDE
    }
    fn jump(&mut self, w: &World) -> u32 {
        self.vel.y = JUMP_V;
        self.grounded = false;
        self.air_t = 0.0;
        if self.crouched && self.can_stand(w) {
            self.crouched = false;
        }
        CE_JUMP
    }

    /// Advances the controller by one command. Returns `CE_*` event bits.
    pub fn step(&mut self, w: &World, c: &Cmd, prev: u32, m: &Mods) -> u32 {
        let dt = c.dt;
        let mut ev = 0;
        self.yaw = c.yaw;
        self.pitch = c.pitch;
        let (sy, cy) = self.yaw.sin_cos();
        let fwd = v3(-sy, 0.0, -cy);
        let right = v3(cy, 0.0, -sy);
        let (mx, mz) = if m.frozen { (0.0, 0.0) } else { (c.mx, c.mz) };
        let mut wish = fwd * mz + right * mx;
        let wl = wish.len();
        if wl > 1.0 {
            wish = wish * (1.0 / wl);
        }
        let buttons = if m.frozen { 0 } else { c.buttons };
        let held = |b: u32| buttons & b != 0;
        let pressed = |b: u32| buttons & b != 0 && prev & b == 0;
        self.slide_cd = (self.slide_cd - dt).max(0.0);
        self.wall_cd = (self.wall_cd - dt).max(0.0);

        if self.mode == MODE_MANTLE {
            self.mantle_t += dt;
            let k = (self.mantle_t / self.mantle_d).min(1.0);
            let (up, fw) = (smooth(k / 0.6), smooth((k - 0.45) / 0.55));
            let (a, b) = (self.mantle_a, self.mantle_b);
            self.pos = v3(a.x + (b.x - a.x) * fw, a.y + (b.y - a.y) * up, a.z + (b.z - a.z) * fw);
            self.vel = V3::ZERO;
            if k >= 1.0 {
                self.mode = MODE_NORMAL;
                self.grounded = true;
                self.air_t = 0.0;
                self.vel = fwd * if mz > 0.1 { 3.5 } else { 0.0 };
            }
            self.feel(0.0, mx, right, dt);
            return ev;
        }

        let was_grounded = self.grounded;
        let hs = self.vel.flat_len();

        // Entering a slide: crouch pressed while moving fast on the ground.
        if self.mode == MODE_NORMAL && self.grounded && pressed(B_CROUCH) && hs > SLIDE_MIN && self.slide_cd <= 0.0 {
            ev |= self.start_slide(fwd);
        }

        match self.mode {
            MODE_SLIDE => {
                self.slide_t += dt;
                let s = (hs - SLIDE_DECEL * m.slide_decel * dt).max(0.0);
                if hs > 0.01 {
                    self.vel.x *= s / hs;
                    self.vel.z *= s / hs;
                }
                let cancel = self.slide_t > SLIDE_CANCEL_AFTER && (pressed(B_CROUCH) || pressed(B_SPRINT));
                if pressed(B_JUMP) {
                    // Slide hop: leave the slide with all of its momentum.
                    self.mode = MODE_NORMAL;
                    self.slide_cd = 0.25;
                    self.crouched = false;
                    ev |= self.jump(w);
                } else if cancel && self.can_stand(w) {
                    // Slide cancel: stand up instantly and keep the speed.
                    self.mode = MODE_NORMAL;
                    self.crouched = false;
                    self.slide_cd = 0.25;
                } else if s < 3.0 || self.slide_t > SLIDE_MAX_T || !self.grounded {
                    self.mode = MODE_NORMAL;
                    self.slide_cd = 0.4;
                    self.crouched = held(B_CROUCH) || !self.can_stand(w);
                }
                self.vel.y -= GRAVITY * dt;
            }
            MODE_WALL => {
                self.wall_t += dt;
                self.wall_off = if mz > 0.1 { 0.0 } else { self.wall_off + dt };
                let n = self.wall_n;
                let mut t = v3(-n.z, 0.0, n.x);
                if t.dot(self.vel) < 0.0 {
                    t = -t;
                }
                let target = WALL_SPEED * m.speed;
                self.wall_s = if self.wall_s > target { approach(self.wall_s, target, 4.0 * dt) } else { target };
                // Height is held (a slight sink), then gravity returns so runs end naturally.
                let vy = if self.wall_t < 1.4 { approach(self.vel.y, -0.5, 6.0 * dt) } else { (self.vel.y - GRAVITY * 0.35 * dt).max(-4.0) };
                if pressed(B_JUMP) {
                    self.vel = t * self.wall_s + n * WALL_JUMP_OUT + V3::UP * WALL_JUMP_UP;
                    self.mode = MODE_NORMAL;
                    self.wall_cd = 0.4;
                    self.air_t = 0.0;
                    ev |= CE_WALLJUMP;
                } else if pressed(B_CROUCH) || self.wall_off > 0.15 || self.wall_t > WALL_MAX_T {
                    self.vel = t * self.wall_s + n * 2.0 + V3::UP * vy;
                    self.mode = MODE_NORMAL;
                    self.wall_cd = 0.5;
                } else {
                    // Lean into the wall so collision keeps us attached.
                    self.vel = t * self.wall_s - n * 1.5 + V3::UP * vy;
                }
            }
            _ => {
                if self.grounded {
                    if held(B_CROUCH) {
                        self.crouched = true;
                    } else if self.crouched && self.can_stand(w) {
                        self.crouched = false;
                    }
                    self.sprinting = held(B_SPRINT) && mz > 0.5 && !self.crouched && !m.no_sprint;
                    let max = if self.crouched { CROUCH_SPEED } else if self.sprinting { SPRINT_SPEED } else { WALK_SPEED };
                    self.friction(GROUND_FRICTION, dt);
                    if wl > 0.01 {
                        self.accelerate(wish.norm(), max * m.speed * wl.min(1.0), GROUND_ACCEL, dt);
                    }
                    self.thrusting = false;
                } else {
                    self.sprinting = false;
                    if self.crouched && !held(B_CROUCH) && self.can_stand(w) {
                        self.crouched = false;
                    }
                    if wl > 0.01 {
                        self.accelerate(wish.norm(), WALK_SPEED * m.speed, AIR_ACCEL, dt);
                    }
                    let want = held(B_JUMP) && self.air_t > THRUST_ARM && (self.thrust > 0.0 || m.inf_thrust);
                    if want {
                        if !self.thrusting {
                            ev |= CE_THRUST;
                            if self.vel.y < 0.0 {
                                self.vel.y *= 0.5;
                            }
                        }
                        if self.vel.y < THRUST_VCAP {
                            self.vel.y = (self.vel.y + THRUST_ACC * dt).min(THRUST_VCAP);
                        }
                        self.vel += wish * (THRUST_HACC * dt);
                        if !m.inf_thrust {
                            self.thrust = (self.thrust - dt / THRUST_TIME).max(0.0);
                        }
                        self.thrust_delay = THRUST_REGEN_DELAY;
                    }
                    self.thrusting = want;
                }
                if pressed(B_JUMP) && (self.grounded || (self.air_t < COYOTE && self.vel.y <= 0.0)) {
                    ev |= self.jump(w);
                }
                self.vel.y -= GRAVITY * dt;

                if !self.grounded && mz > 0.1 {
                    if self.vel.y > -14.0 {
                        if let Some(target) = w.ledge(self.pos, fwd, RADIUS, HEIGHT, MANTLE_REACH) {
                            self.mode = MODE_MANTLE;
                            self.mantle_a = self.pos;
                            self.mantle_b = target;
                            self.mantle_t = 0.0;
                            self.mantle_d = 0.3 + 0.1 * (target.y - self.pos.y).max(0.0);
                            self.crouched = false;
                            self.thrusting = false;
                            self.feel(0.0, mx, right, dt);
                            return ev | CE_MANTLE;
                        }
                    }
                    if let Some(n) = w.wall_near(self.pos, RADIUS, WALL_REACH) {
                        let mut t = v3(-n.z, 0.0, n.x);
                        if t.dot(self.vel) < 0.0 {
                            t = -t;
                        }
                        let along = t.dot(self.vel);
                        let same = self.wall_cd > 0.0 && n.dot(self.wall_n) > 0.9;
                        let clear = !w.overlaps(&Aabb::feet(v3(self.pos.x, self.pos.y - 0.5, self.pos.z), RADIUS, HEIGHT));
                        if along >= WALL_MIN_ALONG && !same && clear && self.air_t > 0.05 && self.vel.y > -10.0 {
                            self.mode = MODE_WALL;
                            self.wall_n = n;
                            self.wall_t = 0.0;
                            self.wall_off = 0.0;
                            self.wall_s = along.max(WALL_SPEED * m.speed);
                            self.vel = t * self.wall_s - n * 1.5 + V3::UP * self.vel.y.clamp(-1.0, 2.0);
                            self.thrusting = false;
                            ev |= CE_WALLRUN;
                        }
                    }
                }
            }
        }

        let hs2 = self.vel.flat_len();
        if hs2 > MAX_HSPEED {
            self.vel.x *= MAX_HSPEED / hs2;
            self.vel.z *= MAX_HSPEED / hs2;
        }

        let h = self.height();
        let rising = self.vel.y > 0.0;
        let ct = w.slide_move(&mut self.pos, &mut self.vel, RADIUS, h, dt, was_grounded);
        self.grounded = ct.grounded;
        if was_grounded && !self.grounded && !rising && w.snap_down(&mut self.pos, RADIUS, h) {
            self.grounded = true;
            self.vel.y = 0.0;
        }
        self.step_off -= ct.stepped;

        if self.mode == MODE_WALL && (self.grounded || w.wall_near(self.pos, RADIUS, WALL_REACH + 0.15).map_or(true, |n| n.dot(self.wall_n) < 0.9)) {
            self.mode = MODE_NORMAL;
            self.wall_cd = 0.3;
        }
        if self.grounded {
            if !was_grounded {
                ev |= CE_LAND;
                self.dip_v -= ct.impact.min(14.0) * 0.045;
                // Landing with crouch held and speed carries straight into a slide.
                if self.mode == MODE_NORMAL && held(B_CROUCH) && self.vel.flat_len() > SLIDE_MIN && self.slide_cd <= 0.0 {
                    ev |= self.start_slide(fwd);
                }
            }
            self.air_t = 0.0;
        } else {
            self.air_t += dt;
        }
        if self.grounded || self.mode == MODE_WALL {
            self.thrust_delay -= dt;
            if self.thrust_delay <= 0.0 {
                let rate = if self.mode == MODE_WALL { 0.5 } else { 1.0 };
                self.thrust = (self.thrust + dt / THRUST_REGEN * m.thrust_regen * rate).min(1.0);
            }
        }
        self.feel(self.vel.flat_len(), mx, right, dt);
        ev
    }

    /// Camera feel: eye height, view bob, landing dip, speed FOV and roll.
    fn feel(&mut self, hs: f32, mx: f32, right: V3, dt: f32) {
        let eye = match self.mode {
            MODE_SLIDE => EYE_SLIDE,
            _ if self.crouched => EYE_CROUCH,
            _ => EYE_STAND,
        };
        self.eye = damp(self.eye, eye, 14.0, dt);
        let walking = self.grounded && self.mode == MODE_NORMAL && hs > 0.5;
        let amp = if self.mode == MODE_WALL {
            0.035
        } else if !walking {
            0.0
        } else if self.sprinting {
            0.055
        } else if self.crouched {
            0.018
        } else {
            0.03
        };
        self.bob_amp = damp(self.bob_amp, amp, 10.0, dt);
        if walking || self.mode == MODE_WALL {
            self.bob_ph = (self.bob_ph + hs * dt * 1.9) % (core::f32::consts::TAU * 8.0);
        }
        self.dip_v += (-self.dip * 140.0 - self.dip_v * 16.0) * dt;
        self.dip += self.dip_v * dt;
        let mut fov = ((hs - 6.5) / 5.0).clamp(0.0, 1.0) * 7.0;
        fov += match self.mode {
            MODE_SLIDE => 8.0,
            MODE_WALL => 6.0,
            _ if self.thrusting => 5.0,
            _ if self.sprinting => 3.0,
            _ => 0.0,
        };
        self.fov = damp(self.fov, fov, 8.0, dt);
        let roll = match self.mode {
            MODE_WALL => self.wall_n.dot(right) * 0.2,
            MODE_SLIDE => 0.035,
            _ => -mx * 0.012,
        };
        self.roll = damp(self.roll, roll, 10.0, dt);
        self.step_off = damp(self.step_off, 0.0, 14.0, dt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::Solid;

    fn solid(min: V3, max: V3) -> Solid {
        Solid { bb: Aabb::new(min, max), mat: 0, flags: 0, tag: -1, on: true }
    }
    /// Floor, a long tall wall along +X at z = -2, and a 1.5 m ledge at x >= 10.
    fn world() -> World {
        let mut w = World::default();
        w.solids.push(solid(v3(-50.0, -1.0, -50.0), v3(50.0, 0.0, 50.0)));
        w.solids.push(solid(v3(-40.0, 0.0, -3.0), v3(40.0, 8.0, -2.0)));
        w.solids.push(solid(v3(10.0, 0.0, 5.0), v3(14.0, 1.5, 9.0)));
        w
    }
    fn cmd(mz: f32, yaw: f32, buttons: u32) -> Cmd {
        Cmd { dt: 1.0 / 60.0, mz, yaw, buttons, slot: -1, ..Default::default() }
    }
    fn run(c: &mut Ctl, w: &World, cmd: Cmd, prev: &mut u32, ticks: usize) -> u32 {
        let mut ev = 0;
        for _ in 0..ticks {
            ev |= c.step(w, &cmd, *prev, &Mods::default());
            *prev = cmd.buttons;
        }
        ev
    }
    const EAST: f32 = -core::f32::consts::FRAC_PI_2; // looking toward +X

    #[test]
    fn sprint_reaches_top_speed_and_stays_grounded() {
        let (w, mut c, mut p) = (world(), Ctl::spawn(v3(0.0, 0.0, 10.0), EAST), 0);
        run(&mut c, &w, cmd(1.0, EAST, B_SPRINT), &mut p, 120);
        assert!(c.grounded);
        assert!((c.vel.flat_len() - SPRINT_SPEED).abs() < 0.3, "speed {}", c.vel.flat_len());
        assert!(c.vel.x > 0.0);
    }

    #[test]
    fn thrust_jump_goes_higher_and_drains_meter() {
        let w = world();
        let apex = |hold: bool| {
            let (mut c, mut p, mut top) = (Ctl::spawn(v3(0.0, 0.0, 10.0), 0.0), 0, 0.0f32);
            run(&mut c, &w, cmd(0.0, 0.0, B_JUMP), &mut p, 1);
            for _ in 0..180 {
                run(&mut c, &w, cmd(0.0, 0.0, if hold { B_JUMP } else { 0 }), &mut p, 1);
                top = top.max(c.pos.y);
            }
            (top, c)
        };
        let (hop, _) = apex(false);
        let (boost, c) = apex(true);
        assert!(hop > 0.8 && hop < 1.2, "hop {hop}");
        assert!(boost > 3.0 && boost < 4.2, "boost {boost}");
        assert!(c.grounded && c.thrust > 0.0, "meter regenerates on the ground");
    }

    #[test]
    fn slide_boosts_then_cancels_with_momentum() {
        let (w, mut c, mut p) = (world(), Ctl::spawn(v3(0.0, 0.0, 10.0), EAST), 0);
        run(&mut c, &w, cmd(1.0, EAST, B_SPRINT), &mut p, 90);
        let ev = run(&mut c, &w, cmd(1.0, EAST, B_SPRINT | B_CROUCH), &mut p, 1);
        assert!(ev & CE_SLIDE != 0 && c.mode == MODE_SLIDE);
        assert!(c.vel.flat_len() > 9.0);
        run(&mut c, &w, cmd(1.0, EAST, B_SPRINT), &mut p, 20);
        assert_eq!(c.mode, MODE_SLIDE, "releasing crouch does not end the slide");
        run(&mut c, &w, cmd(1.0, EAST, B_SPRINT | B_CROUCH), &mut p, 1);
        assert_eq!(c.mode, MODE_NORMAL, "second crouch press cancels");
        assert!(!c.crouched && c.vel.flat_len() > 7.5, "cancel keeps speed: {}", c.vel.flat_len());
    }

    #[test]
    fn wall_run_holds_height_and_wall_jump_pushes_off() {
        let (w, mut p) = (world(), 0);
        // Start beside the wall (its face is at z = -2), sprinting along it.
        let mut c = Ctl::spawn(v3(-20.0, 0.0, -1.5), EAST);
        run(&mut c, &w, cmd(1.0, EAST, B_SPRINT), &mut p, 60);
        run(&mut c, &w, cmd(1.0, EAST, B_SPRINT | B_JUMP), &mut p, 1);
        let ev = run(&mut c, &w, cmd(1.0, EAST, B_SPRINT), &mut p, 20);
        assert!(ev & CE_WALLRUN != 0 && c.mode == MODE_WALL, "mode {}", c.mode);
        let y0 = c.pos.y;
        run(&mut c, &w, cmd(1.0, EAST, B_SPRINT), &mut p, 45);
        assert_eq!(c.mode, MODE_WALL);
        assert!((c.pos.y - y0).abs() < 1.2, "height drift {}", c.pos.y - y0);
        assert!(c.vel.x >= WALL_SPEED - 0.2, "speed maintained: {}", c.vel.x);
        assert!(c.roll.abs() > 0.05, "camera rolls on the wall");
        let ev = run(&mut c, &w, cmd(1.0, EAST, B_SPRINT | B_JUMP), &mut p, 1);
        assert!(ev & CE_WALLJUMP != 0);
        assert!(c.vel.z > 3.0 && c.vel.y > 5.0, "pushed away from the wall and up");
    }

    #[test]
    fn mantles_onto_ledge() {
        let (w, mut p) = (world(), 0);
        let mut c = Ctl::spawn(v3(8.5, 0.0, 7.0), EAST);
        run(&mut c, &w, cmd(1.0, EAST, B_JUMP), &mut p, 1);
        let ev = run(&mut c, &w, cmd(1.0, EAST, 0), &mut p, 90);
        assert!(ev & CE_MANTLE != 0);
        assert!(c.grounded && (c.pos.y - 1.5).abs() < 0.05 && c.pos.x > 10.0, "pos {:?}", c.pos);
    }

    #[test]
    fn wedged_against_a_box_edge_never_pushes_through_the_wall_behind() {
        // A wall ending at z = 6 and a 0.9 m box starting at z = 6.7: a gap exactly one body wide.
        // Feet 0.4 mm below the box top, drifting toward it. This used to chain push-outs through
        // every wall behind the player and out of the map.
        let mut w = World::default();
        w.solids.push(solid(v3(-50.0, -1.0, -50.0), v3(50.0, 0.0, 50.0)));
        for z in [0.0, 2.0, 4.0] {
            w.solids.push(solid(v3(-10.0, 0.0, z), v3(10.0, 7.0, z + 2.0)));
        }
        w.solids.push(solid(v3(0.7, 0.0, 6.7), v3(1.3, 0.9, 7.3)));
        let mut pos = v3(0.39, 0.8996, 6.3500547);
        let mut vel = v3(0.0, -0.09, 0.21);
        w.slide_move(&mut pos, &mut vel, RADIUS, HEIGHT, 1.0 / 20.0, false);
        assert!(pos.z > 6.3 && pos.z < 6.4, "player was pushed to z = {}", pos.z);
        assert!(!w.overlaps(&Aabb::feet(pos, RADIUS, HEIGHT)) || pos.y > 0.85, "left inside geometry at {pos:?}");
    }

    #[test]
    fn brushing_a_tall_wall_while_falling_does_not_land_on_its_top() {
        let mut w = world();
        // Overlapping the 8 m wall by a hair (as if wedged), falling.
        let mut pos = v3(0.0, 3.0, -1.66);
        let mut vel = v3(0.0, -5.0, 0.0);
        w.slide_move(&mut pos, &mut vel, RADIUS, HEIGHT, 1.0 / 60.0, false);
        assert!(pos.y <= 3.0, "teleported up to y = {}", pos.y);
        w.solids.clear();
    }

    #[test]
    fn state_round_trips() {
        use crate::util::{Field, Rd};
        let (w, mut c, mut p) = (world(), Ctl::spawn(v3(0.0, 0.0, 10.0), 0.3), 0);
        run(&mut c, &w, cmd(1.0, 0.3, B_SPRINT | B_JUMP), &mut p, 30);
        let mut buf = Vec::new();
        c.put(&mut buf);
        let mut d = Ctl::default();
        d.get(&mut Rd::new(&buf));
        let mut buf2 = Vec::new();
        d.put(&mut buf2);
        assert_eq!(buf, buf2);
    }
}
