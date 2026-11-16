//! Weapon handling: fire/reload/switch state machine, ADS, recoil patterns and effective stats.
use crate::catalog::*;
use crate::controller::*;
use crate::math::{v3, V3};
use crate::state;
use crate::util::Rng;

state! {
    pub struct Gun {
        pub id: i32,
        pub ammo: f32,
        pub reserve: f32,
        /// 0 base, 1 upgraded at the bench.
        pub tier: u8,
        /// Index into `MODS` (re-upgrade effect).
        pub modi: u8,
        /// Attachment bitmask.
        pub att: u32,
    }
}

state! {
    pub struct Arms {
        pub guns: [Gun; 3],
        pub cur: u8,
        pub next: u8,
        pub cooldown: f32,
        pub reload_t: f32,
        pub switch_t: f32,
        pub switch_d: f32,
        pub ads: f32,
        /// Shots fired in a row (drives the recoil pattern).
        pub burst: f32,
        pub burst_t: f32,
        /// Shots still to fire in the current trigger pull of a burst weapon.
        pub queued: u8,
        pub sprint_out: f32,
        pub melee_t: f32,
        pub lethal: f32,
        pub tactical: f32,
    }
}

/// Weapon stats after attachments, upgrade tier and perks.
#[derive(Clone, Copy, Debug)]
pub struct Stats {
    pub dmg: f32,
    pub head: f32,
    pub interval: f32,
    pub auto: bool,
    pub mag: f32,
    pub reserve: f32,
    pub reload: f32,
    pub hip: f32,
    pub ads: f32,
    pub pellets: u32,
    pub r0: f32,
    pub r1: f32,
    pub rmin: f32,
    pub ads_t: f32,
    pub zoom: f32,
    pub mobility: f32,
    pub recoil: f32,
    pub pierce: u32,
    pub flags: u32,
    /// Shots per trigger pull (0: one, or continuous for automatics).
    pub burst: u32,
}

/// Pause after a burst before the trigger answers again, in seconds.
pub const BURST_DELAY: f32 = 0.2;

/// Player-wide combat modifiers (perks, abilities).
#[derive(Clone, Copy, Debug)]
pub struct Combat {
    pub reload: f32,
    pub fire_rate: f32,
    pub swap: f32,
    pub hip: f32,
    pub head: f32,
}
impl Default for Combat {
    fn default() -> Self {
        Combat { reload: 1.0, fire_rate: 1.0, swap: 1.0, hip: 1.0, head: 1.0 }
    }
}

impl Gun {
    pub const NONE: Gun = Gun { id: -1, ammo: 0.0, reserve: 0.0, tier: 0, modi: 0, att: 0 };
    pub fn new(id: i32, att: u32) -> Gun {
        let mut g = Gun { id, att, ..Gun::NONE };
        if let Some(s) = g.stats(&Combat::default()) {
            g.ammo = s.mag;
            g.reserve = s.reserve;
        }
        g
    }
    pub fn stats(&self, c: &Combat) -> Option<Stats> {
        let d = weapon(self.id)?;
        let has = |a: u32| self.att & a != 0;
        let up = self.tier > 0;
        let mut zoom = d.zoom;
        if has(A_REFLEX) {
            zoom *= 1.1;
        }
        if has(A_SCOPE) {
            zoom *= 1.8;
        }
        let mag = (d.mag * if has(A_EXTMAG) { 1.4 } else { 1.0 } * if up { 1.5 } else { 1.0 }).round();
        let range = if has(A_BARREL) { 1.35 } else { 1.0 };
        Some(Stats {
            dmg: d.dmg * if up { 2.2 } else { 1.0 },
            head: d.head * c.head,
            interval: 60.0 / (d.rpm * c.fire_rate),
            auto: d.auto,
            mag,
            reserve: (d.reserve * if up { 1.5 } else { 1.0 }).round(),
            reload: d.reload * c.reload * if has(A_LOADER) { 0.75 } else { 1.0 },
            hip: d.hip * c.hip * if has(A_LASER) { 0.6 } else { 1.0 },
            ads: d.ads * if has(A_REFLEX) { 0.8 } else { 1.0 },
            pellets: d.pellets,
            r0: d.r0 * range,
            r1: d.r1 * range,
            rmin: d.rmin,
            ads_t: d.ads_t * if has(A_QUICK) { 0.6 } else { 1.0 },
            zoom,
            mobility: d.mobility,
            recoil: if has(A_GRIP) { 0.75 } else { 1.0 },
            pierce: d.pierce + has(A_HARD) as u32 + up as u32,
            flags: d.flags,
            burst: d.burst,
        })
    }
}

/// Deterministic recoil pattern: (pitch up, yaw) in radians for the n-th shot of a burst.
pub fn recoil(id: i32, shot: f32, ads: f32, scale: f32) -> (f32, f32) {
    let Some(d) = weapon(id) else { return (0.0, 0.0) };
    let ramp = (shot / 6.0).min(1.0);
    let phase = id as f32 * 1.3;
    let k = scale * (1.0 - 0.35 * ads);
    let pitch = d.kick_v * (0.6 + 0.4 * ramp) * k;
    let yaw = d.kick_h * ((shot * 0.9 + phase).sin() * 0.7 + (shot * 0.37 + 2.0 * phase).sin() * 0.5) * (0.4 + 0.6 * ramp) * k;
    (pitch, yaw)
}

/// Pellet direction inside the spread cone. Seeded from the command sequence so host and client agree.
pub fn spread_dir(dir: V3, spread: f32, seq: u32, pellet: u32, pid: u32) -> V3 {
    if spread <= 0.0 {
        return dir;
    }
    let mut r = Rng::new(seq.wrapping_mul(7919) ^ pellet.wrapping_mul(104_729) ^ pid.wrapping_mul(31));
    let (a, m) = (r.f() * core::f32::consts::TAU, r.f().sqrt() * spread);
    let up = if dir.y.abs() > 0.99 { v3(1.0, 0.0, 0.0) } else { V3::UP };
    let right = v3(dir.y * up.z - dir.z * up.y, dir.z * up.x - dir.x * up.z, dir.x * up.y - dir.y * up.x).norm();
    let upv = v3(right.y * dir.z - right.z * dir.y, right.z * dir.x - right.x * dir.z, right.x * dir.y - right.y * dir.x);
    (dir + right * (a.cos() * m) + upv * (a.sin() * m)).norm()
}

pub const AE_FIRE: u32 = 1;
pub const AE_DRY: u32 = 2;
pub const AE_RELOAD: u32 = 4;
pub const AE_MELEE: u32 = 8;
pub const AE_SWITCH: u32 = 16;
pub const AE_LETHAL: u32 = 32;
pub const AE_TACTICAL: u32 = 64;

impl Arms {
    pub fn gun(&self) -> &Gun {
        &self.guns[self.cur as usize]
    }
    pub fn gun_mut(&mut self) -> &mut Gun {
        &mut self.guns[self.cur as usize]
    }
    pub fn stats(&self, c: &Combat) -> Option<Stats> {
        self.gun().stats(c)
    }
    pub fn reloading(&self) -> bool {
        self.reload_t > 0.0
    }
    /// Begins a swap to `slot` if it holds a weapon.
    pub fn switch_to(&mut self, slot: usize, c: &Combat) -> bool {
        if slot >= 3 || slot == self.cur as usize || self.guns[slot].id < 0 {
            return false;
        }
        self.next = slot as u8;
        self.switch_d = 0.45 * c.swap;
        self.switch_t = self.switch_d;
        self.reload_t = 0.0;
        self.queued = 0;
        true
    }
    /// Puts a weapon in hand immediately (purchases, ability weapons).
    pub fn equip(&mut self, slot: usize, gun: Gun) {
        self.guns[slot] = gun;
        self.cur = slot as u8;
        self.next = slot as u8;
        self.switch_d = 0.3;
        self.switch_t = 0.15;
        self.reload_t = 0.0;
        self.burst = 0.0;
        self.queued = 0;
    }

    /// Advances one command. Returns `AE_*` bits; `AE_FIRE` means one shot left the barrel this tick.
    pub fn step(&mut self, c: &Cmd, prev: u32, cm: &Combat, sprinting: bool, blocked: bool) -> u32 {
        let dt = c.dt;
        let mut ev = 0;
        let held = |b: u32| c.buttons & b != 0 && !blocked;
        let pressed = |b: u32| c.buttons & b != 0 && prev & b == 0 && !blocked;
        self.cooldown = (self.cooldown - dt).max(-dt);
        self.melee_t = (self.melee_t - dt).max(0.0);
        self.burst_t += dt;
        if self.burst_t > 0.3 {
            self.burst = 0.0;
        }
        self.sprint_out = if sprinting { 0.18 } else { (self.sprint_out - dt).max(0.0) };
        if blocked || sprinting {
            self.queued = 0;
        }

        // Slot 2 only ever holds an ability weapon, so the swap key cycles the first two.
        if self.switch_t <= 0.0 {
            let want = if c.slot >= 0 { c.slot as usize } else if pressed(B_SWITCH) { if self.cur == 0 { 1 } else { 0 } } else { 99 };
            if want < 3 && self.switch_to(want, cm) {
                ev |= AE_SWITCH;
            }
        }
        if self.switch_t > 0.0 {
            let half = self.switch_d * 0.5;
            let before = self.switch_t;
            self.switch_t -= dt;
            if before > half && self.switch_t <= half {
                self.cur = self.next;
                self.burst = 0.0;
            }
            self.ads = (self.ads - dt * 8.0).max(0.0);
            return ev;
        }

        let Some(s) = self.stats(cm) else { return ev };
        let want_ads = held(B_ADS) && !self.reloading();
        self.ads = (self.ads + dt / s.ads_t.max(0.01) * if want_ads { 1.0 } else { -1.0 }).clamp(0.0, 1.0);

        if pressed(B_MELEE) && self.melee_t <= 0.0 {
            self.melee_t = 0.6;
            self.reload_t = 0.0;
            self.queued = 0;
            return ev | AE_MELEE;
        }
        if pressed(B_LETHAL) && self.lethal >= 1.0 && self.melee_t <= 0.0 {
            self.lethal -= 1.0;
            self.melee_t = 0.4;
            ev |= AE_LETHAL;
        }
        if pressed(B_TACTICAL) && self.tactical >= 1.0 && self.melee_t <= 0.0 {
            self.tactical -= 1.0;
            self.melee_t = 0.4;
            ev |= AE_TACTICAL;
        }

        if self.reload_t > 0.0 {
            self.reload_t -= dt;
            if self.reload_t <= 0.0 {
                let g = self.gun_mut();
                let take = (s.mag - g.ammo).min(g.reserve).max(0.0);
                g.ammo += take;
                g.reserve -= take;
            }
            return ev;
        }
        let g = *self.gun();
        if g.reserve > 0.0 && g.ammo < s.mag && (pressed(B_RELOAD) || (g.ammo <= 0.0 && self.cooldown <= 0.0)) {
            self.reload_t = s.reload;
            self.queued = 0;
            return ev | AE_RELOAD;
        }
        // A burst weapon keeps firing the rest of its burst after the trigger is let go.
        let trigger = self.queued > 0 || if s.auto { held(B_FIRE) } else { pressed(B_FIRE) };
        if trigger && self.cooldown <= 0.0 && self.melee_t <= 0.0 && self.sprint_out <= 0.0 {
            if g.ammo > 0.0 {
                self.gun_mut().ammo -= 1.0;
                self.cooldown += s.interval;
                self.burst += 1.0;
                self.burst_t = 0.0;
                ev |= AE_FIRE;
                if s.burst > 1 {
                    self.queued = if self.queued > 0 { self.queued - 1 } else { (s.burst - 1).min(255) as u8 };
                    if self.queued == 0 || g.ammo <= 1.0 {
                        self.queued = 0;
                        self.cooldown += BURST_DELAY;
                    }
                }
            } else if pressed(B_FIRE) {
                ev |= AE_DRY;
            }
        }
        ev
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(buttons: u32) -> Cmd {
        Cmd { dt: 1.0 / 60.0, buttons, slot: -1, ..Default::default() }
    }
    fn arms(id: i32) -> Arms {
        let mut a = Arms::default();
        a.guns = [Gun::new(id, 0), Gun::NONE, Gun::NONE];
        a
    }

    #[test]
    fn auto_fire_matches_rpm_and_reload_refills() {
        let (mut a, cm) = (arms(3), Combat::default());
        let mut shots = 0;
        let mut prev = 0;
        for _ in 0..60 {
            if a.step(&cmd(B_FIRE), prev, &cm, false, false) & AE_FIRE != 0 {
                shots += 1;
            }
            prev = B_FIRE;
        }
        assert!((10..=12).contains(&shots), "650 rpm is about 11 shots a second, got {shots}");
        let ev = a.step(&cmd(B_RELOAD), 0, &cm, false, false);
        assert!(ev & AE_RELOAD != 0);
        for _ in 0..140 {
            a.step(&cmd(0), 0, &cm, false, false);
        }
        assert_eq!(a.gun().ammo, 30.0);
        assert_eq!(a.gun().reserve, 210.0 - shots as f32);
    }

    #[test]
    fn semi_auto_needs_a_press_per_shot() {
        let (mut a, cm) = (arms(0), Combat::default());
        let mut shots = 0;
        let mut prev = 0;
        for _ in 0..30 {
            shots += (a.step(&cmd(B_FIRE), prev, &cm, false, false) & AE_FIRE != 0) as u32;
            prev = B_FIRE;
        }
        assert_eq!(shots, 1);
    }

    #[test]
    fn burst_weapons_fire_their_burst_from_one_press() {
        let (mut a, cm) = (arms(W_TALON), Combat::default());
        let fire = |a: &mut Arms, ticks: usize, first: u32| {
            let mut shots = vec![];
            let mut prev = 0;
            for t in 0..ticks {
                let b = if t < 2 { first } else { 0 }; // a two-tick tap
                if a.step(&cmd(b), prev, &cm, false, false) & AE_FIRE != 0 {
                    shots.push(t);
                }
                prev = b;
            }
            shots
        };
        let shots = fire(&mut a, 30, B_FIRE);
        assert_eq!(shots.len(), 3, "one tap, three rounds: {shots:?}");
        assert!(shots[2] - shots[0] <= 9, "the burst is quick: {shots:?}");
        assert_eq!(a.gun().ammo, 27.0);
        // Pressing again during the post-burst pause does nothing; after it, another burst.
        let mut a = arms(W_TALON);
        let mut prev = 0;
        let mut times = vec![];
        for t in 0..60 {
            let b = if t % 2 == 0 { B_FIRE } else { 0 }; // hammering the trigger
            if a.step(&cmd(b), prev, &cm, false, false) & AE_FIRE != 0 {
                times.push(t);
            }
            prev = b;
        }
        let gaps: Vec<usize> = times.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(gaps.iter().filter(|g| **g >= 12).count() >= 2, "bursts are separated by a pause: {times:?}");
        assert_eq!(times.len() % 3, 0, "only whole bursts: {times:?}");
        // Holding the trigger does not make it automatic.
        let mut a = arms(W_TALON);
        let mut n = 0;
        for t in 0..60 {
            n += (a.step(&cmd(B_FIRE), if t == 0 { 0 } else { B_FIRE }, &cm, false, false) & AE_FIRE != 0) as u32;
        }
        assert_eq!(n, 3);
        // A burst stops at an empty magazine and a reload interrupts it.
        let mut a = arms(W_TALON);
        a.guns[0].ammo = 2.0;
        assert_eq!(fire(&mut a, 30, B_FIRE).len(), 2);
        assert_eq!(a.queued, 0);
    }

    #[test]
    fn recoil_is_deterministic_and_climbs() {
        assert_eq!(recoil(3, 4.0, 0.0, 1.0), recoil(3, 4.0, 0.0, 1.0));
        assert!(recoil(3, 8.0, 0.0, 1.0).0 > recoil(3, 0.0, 0.0, 1.0).0);
        assert!(recoil(3, 8.0, 1.0, 1.0).0 < recoil(3, 8.0, 0.0, 1.0).0, "ADS reduces kick");
        let d = spread_dir(v3(0.0, 0.0, -1.0), 0.05, 7, 2, 1);
        assert_eq!(d, spread_dir(v3(0.0, 0.0, -1.0), 0.05, 7, 2, 1));
        assert!((d.len() - 1.0).abs() < 1e-4 && d.z < -0.99);
    }

    #[test]
    fn attachments_and_upgrade_change_stats() {
        let base = Gun::new(3, 0).stats(&Combat::default()).unwrap();
        let mut g = Gun::new(3, A_EXTMAG | A_GRIP | A_HARD);
        let s = g.stats(&Combat::default()).unwrap();
        assert_eq!(s.mag, 42.0);
        assert!(s.recoil < base.recoil && s.pierce == base.pierce + 1);
        g.tier = 1;
        assert!(g.stats(&Combat::default()).unwrap().dmg > base.dmg * 2.0);
    }
}
