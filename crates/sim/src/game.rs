//! Match state and the authoritative tick: command processing, hitscan with lag compensation,
//! damage, abilities, equipment, snapshots. The host runs it with `authority = true`; clients run
//! the same code without authority to predict their own player.
use crate::arms::*;
use crate::catalog::*;
use crate::controller::*;
use crate::loadout::*;
use crate::maps::*;
use crate::math::*;
use crate::modes::*;
use crate::state;
use crate::util::{Field, Rd, Rng};
use std::collections::VecDeque;

pub const MODE_SURVIVAL: u8 = 0;
pub const MODE_SKIRMISH: u8 = 1;

pub const PH_WARMUP: u8 = 0;
pub const PH_ACTIVE: u8 = 1;
pub const PH_BREAK: u8 = 2;
pub const PH_OVER: u8 = 3;

pub const ALIVE: u8 = 0;
pub const DOWN: u8 = 1;
pub const DEAD: u8 = 2;

pub const EV_STRIDE: usize = 8;
pub const EV_SHOT: u32 = 1;
pub const EV_HIT: u32 = 2;
pub const EV_ZDEATH: u32 = 3;
pub const EV_PDOWN: u32 = 4;
pub const EV_PDEATH: u32 = 5;
pub const EV_ROUND: u32 = 6;
pub const EV_BUY: u32 = 7;
pub const EV_POWERUP: u32 = 8;
pub const EV_EXPLODE: u32 = 9;
pub const EV_QUEST: u32 = 10;
pub const EV_MSG: u32 = 11;
pub const EV_LOCAL: u32 = 12;
pub const EV_CRATE: u32 = 13;
pub const EV_ABILITY: u32 = 14;
pub const EV_REVIVE: u32 = 15;
pub const EV_GAMEOVER: u32 = 16;
pub const EV_DOOR: u32 = 17;
pub const EV_POWER: u32 = 18;
pub const EV_BARR: u32 = 19;
pub const EV_MELEE: u32 = 20;
pub const EV_SPAWN: u32 = 21;
pub const EV_ZATTACK: u32 = 22;
pub const EV_STREAK: u32 = 23;
pub const EV_TONIC: u32 = 24;
/// Objective news: zone captured or lost, hill moved, tag confirmed or denied, ladder rung (see OB_*).
pub const EV_OBJ: u32 = 25;
pub const EVENT_NAMES: &str = "shot:1,hit:2,zdeath:3,pdown:4,pdeath:5,round:6,buy:7,powerup:8,explode:9,quest:10,msg:11,local:12,crate:13,ability:14,revive:15,gameover:16,door:17,power:18,barr:19,melee:20,spawn:21,zattack:22,streak:23,tonic:24,obj:25,";

// EV_LOCAL kinds
pub const LO_FIRE: f32 = 1.0;
pub const LO_DRY: f32 = 2.0;
pub const LO_RELOAD: f32 = 3.0;
pub const LO_MELEE: f32 = 4.0;
pub const LO_SWITCH: f32 = 5.0;
pub const LO_JUMP: f32 = 6.0;
pub const LO_LAND: f32 = 7.0;
pub const LO_SLIDE: f32 = 8.0;
pub const LO_THRUST: f32 = 9.0;
pub const LO_WALLRUN: f32 = 10.0;
pub const LO_WALLJUMP: f32 = 11.0;
pub const LO_MANTLE: f32 = 12.0;
pub const LO_THROW: f32 = 13.0;

// EV_MSG codes
pub const MSG_POOR: f32 = 1.0;
pub const MSG_PERK_LIMIT: f32 = 2.0;
pub const MSG_NO_POWER: f32 = 3.0;
pub const MSG_REWARD: f32 = 4.0;

pub const E_FRAG: u8 = 1;
pub const E_IMPACT: u8 = 2;
pub const E_STUN: u8 = 3;
/// A launcher rocket: flies straight and explodes on contact. On the wire its `a` is the packed
/// flight direction (see `pack_dir`); on the host, its zombie damage.
pub const E_ROCKET: u8 = 4;
pub const ROCKET_SPEED: f32 = 40.0;
const ROCKET_RADIUS: f32 = 5.0;

/// A direction as one exactly representable number: yaw and pitch, 9 bits each
/// (yaw = atan2(-x, -z), pitch = asin(y), the same angles the renderer uses).
pub fn pack_dir(v: V3) -> f32 {
    let n = v.norm();
    let (yaw, pitch) = ((-n.x).atan2(-n.z), n.y.clamp(-1.0, 1.0).asin());
    let q = |x: f32, lo: f32, span: f32| (((x - lo) / span) * 511.0).round().clamp(0.0, 511.0);
    q(yaw, -core::f32::consts::PI, core::f32::consts::TAU) * 512.0 + q(pitch, -core::f32::consts::FRAC_PI_2, core::f32::consts::PI)
}
pub const E_POWERUP: u8 = 10; // + powerup kind
pub const E_CINDER: u8 = 20;
pub const E_STARBURST: u8 = 21;
pub const E_STRIKE: u8 = 30;

state! {
    pub struct Player {
        pub id: i32,
        pub ack: u32,
        pub life: u8,
        pub health: f32,
        pub max_health: f32,
        pub points: i32,
        pub score: i32,
        pub kills: i32,
        pub deaths: i32,
        pub headshots: i32,
        pub team: i32,
        pub ctl: Ctl,
        pub arms: Arms,
        pub prev: u32,
        pub perks: u32,
        pub kit_perks: u32,
        pub ability: i32,
        pub charge: f32,
        pub active_t: f32,
        pub slam: bool,
        pub tonic: i32,
        pub tonic_left: f32,
        pub tonic_on: bool,
        pub streak_score: f32,
        pub streak_ready: u32,
        pub ping_t: f32,
        pub shield: f32,
        pub regen_t: f32,
        pub down_t: f32,
        pub revive_t: f32,
        pub respawn_t: f32,
        pub self_revive: f32,
        pub invuln_t: f32,
        pub slow_t: f32,
        pub calm_t: f32,
        pub hit_yaw: f32,
        pub prompt_kind: u8,
        pub prompt_id: i32,
        pub prompt_cost: i32,
        /// Weapon ladder rung.
        pub stage: i32,
        /// Objective work: zones taken, seconds on the hill, tags collected.
        pub objs: i32,
    }
}

state! {
    pub struct Hdr {
        pub time: f32,
        pub mode: u8,
        pub phase: u8,
        pub round: u32,
        pub left: u32,
        pub doors: u32,
        pub power: bool,
        pub timer: f32,
        pub insta_t: f32,
        pub double_t: f32,
        pub crate_at: i32,
        pub crate_state: u8,
        pub crate_weapon: i32,
        pub crate_owner: i32,
        pub parts: u32,
        pub targets: u32,
        pub shield_built: bool,
        pub q0_step: i32,
        pub q0_prog: f32,
        pub q1_step: i32,
        pub q1_prog: f32,
        pub score_limit: u32,
        /// Team scores (team modes).
        pub score_a: i32,
        pub score_b: i32,
        /// Seconds until the hill moves.
        pub obj_t: f32,
        pub n_players: u32,
        pub n_zombies: u32,
        pub n_ents: u32,
        pub n_barrs: u32,
    }
}
state! {
    pub struct ZRec {
        pub id: i32,
        pub pos: V3,
        pub yaw: f32,
        pub state: u8,
        pub hp: f32,
        pub kind: u8,
    }
}
state! {
    pub struct ERec {
        pub kind: u8,
        pub pos: V3,
        pub a: f32,
    }
}

pub struct Slot {
    pub p: Player,
    pub loadout: Loadout,
    /// Simulation time this client is still allowed to consume (speed-hack guard).
    pub bank: f32,
    pub mod_cd: f32,
    pub tonic_buys: u32,
    pub rebuilt: u32,
}

pub const Z_RISE: u8 = 0;
pub const Z_CHASE: u8 = 1;
pub const Z_ATTACK: u8 = 2;
pub const Z_TEAR: u8 = 3;
pub const Z_TURNED: u8 = 4;
pub const Z_DEAD: u8 = 5;

#[derive(Clone, Copy, Debug)]
pub struct Zombie {
    pub id: i32,
    pub pos: V3,
    pub yaw: f32,
    pub hp: f32,
    pub max_hp: f32,
    pub state: u8,
    pub t: f32,
    pub speed: f32,
    /// 0 walker, 1 runner, 2 sprinter.
    pub kind: u8,
    pub target: i32,
    pub atk_cd: f32,
    pub slow_t: f32,
    pub turned_t: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct Ent {
    pub kind: u8,
    pub pos: V3,
    pub vel: V3,
    pub t: f32,
    pub owner: i32,
    pub a: f32,
}

pub struct Hist {
    pub time: f32,
    pub z: Vec<(i32, V3)>,
    pub p: Vec<(i32, V3, f32)>,
}

#[derive(Default)]
pub struct Sv {
    pub round: u32,
    pub to_spawn: u32,
    pub spawn_cd: f32,
    pub zombies: Vec<Zombie>,
    pub next_id: i32,
    pub power: bool,
    pub doors: u32,
    pub insta_t: f32,
    pub double_t: f32,
    pub crate_at: usize,
    pub crate_state: u8,
    pub crate_t: f32,
    pub crate_weapon: i32,
    pub crate_owner: i32,
    pub crate_uses: u32,
    pub parts: u32,
    pub shield_built: bool,
    pub quest: [(usize, f32); 2],
    pub drops: u32,
    pub flow_t: f32,
}

pub struct Game {
    pub authority: bool,
    pub mode: u8,
    pub time: f32,
    pub phase: u8,
    pub timer: f32,
    pub score_limit: u32,
    pub local: i32,
    pub map: Built,
    pub slots: Vec<Slot>,
    pub rng: Rng,
    pub events: Vec<f32>,
    pub hist: VecDeque<Hist>,
    pub ents: Vec<Ent>,
    pub sv: Sv,
    pub rules: Rules,
    pub obj: Obj,
}

const REWIND_MAX: f32 = 0.4;
const Z_RADIUS: f32 = 0.38;
const Z_BODY: f32 = 1.45;
const Z_HEAD: f32 = 1.62;
const HEAD_R: f32 = 0.26;

#[derive(Clone, Copy)]
enum Target {
    Zombie(i32),
    Player(usize),
    Relay(usize),
}

impl Player {
    /// Clamps every field that is used as an index or a state selector into its valid range.
    pub fn sanitize(&mut self) {
        let a = &mut self.arms;
        a.cur = a.cur.min(2);
        a.next = a.next.min(2);
        for g in a.guns.iter_mut() {
            if weapon(g.id).is_none() {
                *g = Gun::NONE;
            }
            g.modi = g.modi.min(MODS.len() as u8 - 1);
            g.tier = g.tier.min(1);
        }
        if a.guns[a.cur as usize].id < 0 {
            a.cur = a.guns.iter().position(|g| g.id >= 0).unwrap_or(0) as u8;
            a.next = a.cur;
        }
        if !(-1..TONICS.len() as i32).contains(&self.tonic) {
            self.tonic = -1;
        }
        if !(-1..ABILITIES.len() as i32).contains(&self.ability) {
            self.ability = -1;
        }
        self.life = self.life.min(DEAD);
        self.charge = self.charge.clamp(0.0, 1.0);
        self.max_health = self.max_health.clamp(1.0, 1000.0);
        self.health = self.health.clamp(0.0, self.max_health);
        let c = &mut self.ctl;
        c.mode = c.mode.min(MODE_MANTLE);
        // Keep positions inside a sane range so later maths stays finite.
        for v in [&mut c.pos.x, &mut c.pos.y, &mut c.pos.z] {
            *v = v.clamp(-1e4, 1e4);
        }
        for v in [&mut c.vel.x, &mut c.vel.y, &mut c.vel.z] {
            *v = v.clamp(-200.0, 200.0);
        }
    }
}

impl Game {
    pub fn new(map: usize, mode: u8, seed: u32, authority: bool) -> Game {
        let mut g = Game {
            authority,
            mode,
            time: 0.0,
            phase: PH_WARMUP,
            timer: if mode == MODE_SURVIVAL { 6.0 } else { 5.0 },
            score_limit: Rules::defaults(mode).score_limit,
            local: -1,
            map: build(map),
            slots: vec![],
            rng: Rng::new(seed),
            events: vec![],
            hist: VecDeque::new(),
            ents: vec![],
            sv: Sv::default(),
            rules: Rules::defaults(mode),
            obj: Obj::default(),
        };
        g.sv.crate_at = g.map.inter.iter().position(|i| i.kind == I_CRATE).unwrap_or(usize::MAX);
        g.sv.crate_owner = -1;
        g.sv.crate_weapon = -1;
        if mode != MODE_SURVIVAL {
            g.set_doors(u32::MAX);
            g.sv.power = true;
            g.setup_mode();
        }
        g
    }

    pub fn ev(&mut self, kind: u32, a: &[f32]) {
        let mut rec = [0.0; EV_STRIDE];
        rec[0] = kind as f32;
        for (i, v) in a.iter().take(EV_STRIDE - 1).enumerate() {
            rec[i + 1] = *v;
        }
        self.events.extend_from_slice(&rec);
    }
    pub fn idx(&self, pid: i32) -> Option<usize> {
        self.slots.iter().position(|s| s.p.id == pid)
    }
    pub fn set_doors(&mut self, mask: u32) {
        self.sv.doors = mask;
        for d in 0..self.map.def.doors.len() {
            self.map.world.set_door(d as i32, mask & (1 << d) != 0);
        }
    }
    pub fn def_name(&self) -> &'static str {
        self.map.def.name
    }
    pub fn solo(&self) -> bool {
        self.slots.len() <= 1
    }

    pub fn add_player(&mut self, id: i32, team: i32, loadout: Loadout) {
        if self.idx(id).is_some() {
            return;
        }
        let team = self.pick_team(team);
        let p = Player { id, team, tonic: -1, prompt_id: -1, ability: -1, life: DEAD, ..Default::default() };
        self.slots.push(Slot { p, loadout: sanitize(&loadout), bank: 0.2, mod_cd: 0.0, tonic_buys: 0, rebuilt: 0 });
        let i = self.slots.len() - 1;
        if self.mode == MODE_SURVIVAL {
            self.slots[i].p.points = self.rules.start_points;
        }
        // Late joiners in survival wait for the next round.
        if self.pvp() || self.phase == PH_WARMUP || self.sv.round == 0 {
            self.spawn(i);
        }
    }
    pub fn remove_player(&mut self, id: i32) {
        self.slots.retain(|s| s.p.id != id);
    }

    pub fn spawn(&mut self, i: usize) {
        let pos = if self.pvp() {
            self.pvp_spawn_point(i)
        } else {
            let spawns = &self.map.spawns;
            spawns[self.slots[i].p.id.max(0) as usize % spawns.len()]
        };
        let (health, abilities) = (100.0 * self.rules.health, self.abilities_on());
        let center = v3(self.map.size.0 * 0.5, 0.0, self.map.size.1 * 0.5);
        let yaw = (-(center.x - pos.x)).atan2(-(center.z - pos.z));
        let mode = self.mode;
        let s = &mut self.slots[i];
        let l = s.loadout;
        let p = &mut s.p;
        p.ctl = Ctl::spawn(pos, yaw);
        p.life = ALIVE;
        p.max_health = health;
        p.health = health;
        p.invuln_t = 2.0;
        p.down_t = 0.0;
        p.revive_t = 0.0;
        p.slam = false;
        p.active_t = 0.0;
        p.streak_score = 0.0;
        p.streak_ready = 0;
        p.ability = if abilities { l[L_ABILITY] } else { -1 };
        p.arms = Arms::default();
        if mode == MODE_LADDER {
            p.kit_perks = perk_mask(&l);
            p.arms.guns = [Gun::new(LADDER[(p.stage.max(0) as usize).min(LADDER.len() - 1)], 0), Gun::NONE, Gun::NONE];
        } else if mode != MODE_SURVIVAL {
            p.kit_perks = perk_mask(&l);
            p.arms.guns = [Gun::new(l[L_PRIMARY], att_mask(&l[L_PATT..L_PATT + 3])), Gun::new(l[L_SECONDARY], att_mask(&l[L_SATT..L_SATT + 2])), Gun::NONE];
            if p.arms.guns[0].id < 0 {
                p.arms.guns.swap(0, 1);
            }
            if p.arms.guns[0].id < 0 {
                p.arms.guns[0] = Gun::new(W_PISTOL, 0);
            }
            p.arms.lethal = (l[L_LETHAL] >= 0) as u32 as f32;
            p.arms.tactical = (l[L_TACTICAL] >= 0) as u32 as f32;
        } else {
            p.perks = 0;
            p.arms.guns = [Gun::new(W_PISTOL, 0), Gun::NONE, Gun::NONE];
            p.arms.lethal = 2.0;
            p.arms.tactical = 1.0;
        }
        let id = p.id as f32;
        self.ev(EV_SPAWN, &[id]);
    }

    pub fn has_tonic(p: &Player, id: i32) -> bool {
        p.tonic == id && p.tonic_on
    }
    fn overclocked(p: &Player) -> bool {
        p.ability == 3 && p.active_t > 0.0
    }

    fn mods(&self, i: usize) -> (Mods, Combat) {
        let p = &self.slots[i].p;
        let (sp, kp) = (p.perks, p.kit_perks);
        let oc = Self::overclocked(p);
        let mut m = Mods::default();
        // Low gravity in the open on some maps; modules with a roof keep normal gravity.
        let def = self.map.def;
        if def.gravity != 1.0 {
            let (c, r) = ((p.ctl.pos.x / CELL).floor(), (p.ctl.pos.z / CELL).floor());
            let roofed = def.roofs.iter().any(|f| c >= f.0 as f32 && c <= f.2 as f32 && r >= f.1 as f32 && r <= f.3 as f32 && p.ctl.pos.y < f.4);
            if !roofed {
                m.gravity = def.gravity;
            }
        }
        let mobility = p.arms.stats(&Combat::default()).map_or(1.0, |s| s.mobility);
        m.speed = mobility * (1.0 - 0.35 * p.arms.ads);
        if sp & SP_MARATHON != 0 {
            m.speed *= 1.08;
            m.thrust_regen *= 1.4;
        }
        if kp & KP_MOMENTUM != 0 {
            m.speed *= 1.05;
            m.slide_decel = 0.7;
        }
        if kp & KP_AFTERBURNER != 0 {
            m.thrust_regen *= 1.5;
        }
        if oc {
            m.speed *= 1.25;
        }
        if p.slow_t > 0.0 {
            m.speed *= 0.5;
        }
        m.inf_thrust = oc || Self::has_tonic(p, T_OVERDRIVE);
        m.no_sprint = p.arms.ads > 0.05;
        m.frozen = p.life != ALIVE || self.phase == PH_OVER;
        let mut c = Combat::default();
        if sp & SP_QUICKHANDS != 0 {
            c.reload *= 0.5;
        }
        if kp & KP_FASTHANDS != 0 {
            c.reload *= 0.85;
            c.swap = 0.5;
        }
        if sp & SP_HAIR != 0 {
            c.fire_rate *= 1.33;
        }
        if oc {
            c.fire_rate *= 1.3;
        }
        if sp & SP_DEADEYE != 0 {
            c.hip *= 0.7;
            c.head = 1.5;
        }
        if kp & KP_STEADY != 0 {
            c.hip *= 0.7;
        }
        (m, c)
    }

    /// Applies one input command to a player. On the host this is the authoritative simulation of
    /// that player; on a client it is the prediction step.
    pub fn cmd(&mut self, pid: i32, data: &[f32]) {
        let Some(i) = self.idx(pid) else { return };
        let c = Cmd::parse(data);
        let local = pid == self.local;
        if self.authority && !local {
            let s = &mut self.slots[i];
            if s.bank < c.dt {
                s.p.ack = c.seq;
                return;
            }
            s.bank -= c.dt;
        }
        let (mut m, cm) = self.mods(i);
        m.no_sprint |= c.buttons & (B_FIRE | B_ADS) != 0;
        let s = &mut self.slots[i];
        let prev = s.p.prev;
        s.p.ack = c.seq;
        s.p.prev = c.buttons;
        if s.p.life != ALIVE {
            s.p.ctl.yaw = c.yaw;
            s.p.ctl.pitch = c.pitch;
            return;
        }
        let ce = s.p.ctl.step(&self.map.world, &c, prev, &m);
        let blocked = s.p.ctl.mode == MODE_MANTLE || m.frozen;
        let ae = s.p.arms.step(&c, prev, &cm, s.p.ctl.sprinting, blocked);
        let (gun, burst) = (s.p.arms.gun().id as f32, s.p.arms.burst);
        if local {
            let table = [
                (ae & AE_FIRE, LO_FIRE),
                (ae & AE_DRY, LO_DRY),
                (ae & AE_RELOAD, LO_RELOAD),
                (ae & AE_MELEE, LO_MELEE),
                (ae & AE_SWITCH, LO_SWITCH),
                (ae & (AE_LETHAL | AE_TACTICAL), LO_THROW),
                (ce & CE_JUMP, LO_JUMP),
                (ce & CE_LAND, LO_LAND),
                (ce & CE_SLIDE, LO_SLIDE),
                (ce & CE_THRUST, LO_THRUST),
                (ce & CE_WALLRUN, LO_WALLRUN),
                (ce & CE_WALLJUMP, LO_WALLJUMP),
                (ce & CE_MANTLE, LO_MANTLE),
            ];
            for (bit, kind) in table {
                if bit != 0 {
                    self.ev(EV_LOCAL, &[kind, gun, burst]);
                }
            }
        }
        if !self.authority || self.phase == PH_OVER {
            return;
        }
        let pressed = |b: u32| c.buttons & b != 0 && prev & b == 0;
        if ae & AE_FIRE != 0 {
            self.fire(i, &c, &cm);
        }
        if ae & AE_MELEE != 0 {
            self.melee(i);
        }
        if ae & (AE_LETHAL | AE_TACTICAL) != 0 {
            self.throw(i, ae & AE_LETHAL != 0);
        }
        if ce & CE_LAND != 0 && self.slots[i].p.slam {
            self.slots[i].p.slam = false;
            let pos = self.slots[i].p.ctl.pos;
            self.explode(pos, 6.5, 2500.0, 160.0, pid);
        }
        if pressed(B_ABILITY) {
            self.activate_ability(i);
        }
        if self.mode == MODE_SURVIVAL {
            if pressed(B_USE) {
                self.use_press(i);
            }
            if c.buttons & B_USE != 0 {
                self.use_hold(i, c.dt);
            }
            if pressed(B_TONIC) {
                self.use_tonic(i);
            }
        } else {
            for (n, b) in [B_STREAK1, B_STREAK2, B_STREAK3].into_iter().enumerate() {
                if pressed(b) {
                    self.use_streak(i, n);
                }
            }
        }
    }

    /// Entity positions as the shooter saw them: nearest history frame to `t`.
    fn rewound(&self, t: f32) -> Option<&Hist> {
        self.hist.iter().min_by(|a, b| (a.time - t).abs().total_cmp(&(b.time - t).abs()))
    }

    fn fire(&mut self, i: usize, c: &Cmd, cm: &Combat) {
        let p = self.slots[i].p;
        let gun = *p.arms.gun();
        let Some(s) = gun.stats(cm) else { return };
        let origin = p.ctl.eye_pos();
        let dir = look_dir(c.yaw, c.pitch);
        let spread = lerp(s.hip, s.ads, p.arms.ads) * if p.ctl.grounded { 1.0 } else { 1.4 };
        if s.flags & WF_ROCKET != 0 {
            let d = spread_dir(dir, spread, c.seq, 0, p.id as u32);
            // Launched from just in front of the eye, but never from inside a wall.
            let ahead = self.map.world.raycast(origin, d, 0.6).map_or(0.6, |h| (h.0 - 0.05).max(0.0));
            let pos = origin + d * ahead;
            self.ents.push(Ent { kind: E_ROCKET, pos, vel: d * ROCKET_SPEED, t: 3.0, owner: p.id, a: s.dmg });
            self.ev(EV_SHOT, &[p.id as f32, gun.id as f32, pos.x, pos.y, pos.z, 0.0]);
            return;
        }
        // Lag compensation: remote shooters are evaluated against the world they were looking at,
        // bounded so a client cannot claim an arbitrarily old view.
        let view_t = if p.id == self.local { self.time } else { c.rt.clamp(self.time - REWIND_MAX, self.time) };
        let frame = self.rewound(view_t);
        let zpos: Vec<(i32, V3)> = self
            .sv
            .zombies
            .iter()
            .filter(|z| z.state != Z_DEAD && z.state != Z_TURNED)
            .map(|z| (z.id, frame.and_then(|f| f.z.iter().find(|h| h.0 == z.id)).map_or(z.pos, |h| h.1)))
            .collect();
        let ppos: Vec<(usize, V3, f32)> = if self.pvp() {
            self.slots
                .iter()
                .enumerate()
                .filter(|(j, o)| self.hostile(i, *j) && o.p.life == ALIVE)
                .map(|(j, o)| {
                    let h = frame.and_then(|f| f.p.iter().find(|h| h.0 == o.p.id));
                    (j, h.map_or(o.p.ctl.pos, |h| h.1), h.map_or(o.p.ctl.height(), |h| h.2))
                })
                .collect()
        } else {
            vec![]
        };
        let relays = self.relays_live();
        let mut end = origin + dir * 60.0;
        let mut hit_kind = 0.0;
        let mut paid = false;
        for pel in 0..s.pellets {
            let d = spread_dir(dir, spread, c.seq, pel, p.id as u32);
            let wall = self.map.world.raycast(origin, d, 200.0).map_or(200.0, |h| h.0);
            let mut hits: Vec<(f32, bool, Target)> = vec![];
            for &(id, zp) in &zpos {
                let body = Aabb::new(v3(zp.x - Z_RADIUS, zp.y, zp.z - Z_RADIUS), v3(zp.x + Z_RADIUS, zp.y + Z_BODY, zp.z + Z_RADIUS));
                let head = ray_sphere(origin, d, v3(zp.x, zp.y + Z_HEAD, zp.z), HEAD_R);
                let bt = body.ray(origin, d, wall).map(|h| h.0);
                match (head, bt) {
                    (Some(h), b) if h < wall && b.map_or(true, |b| h <= b + 0.3) => hits.push((h, true, Target::Zombie(id))),
                    (_, Some(b)) => hits.push((b, false, Target::Zombie(id))),
                    _ => {}
                }
            }
            for &(j, pp, ph) in &ppos {
                let body = Aabb::feet(pp, RADIUS, ph - 0.25);
                let head = ray_sphere(origin, d, v3(pp.x, pp.y + ph - 0.12, pp.z), 0.2);
                let bt = body.ray(origin, d, wall).map(|h| h.0);
                match (head, bt) {
                    (Some(h), b) if h < wall && b.map_or(true, |b| h <= b + 0.3) => hits.push((h, true, Target::Player(j))),
                    (_, Some(b)) => hits.push((b, false, Target::Player(j))),
                    _ => {}
                }
            }
            if relays {
                for (k, t) in self.map.targets.iter().enumerate() {
                    if !t.1 {
                        if let Some(h) = ray_sphere(origin, d, t.0, 0.7).filter(|h| *h < wall + 0.8) {
                            hits.push((h, false, Target::Relay(k)));
                        }
                    }
                }
            }
            hits.sort_by(|a, b| a.0.total_cmp(&b.0));
            hits.truncate(1 + s.pierce as usize);
            let stopped = hits.len() > s.pierce as usize;
            let reach = if stopped { hits.last().map_or(wall, |h| h.0) } else { wall };
            if pel == 0 {
                end = origin + d * reach;
            }
            for (n, (t, head, target)) in hits.into_iter().enumerate() {
                let falloff = lerp(1.0, s.rmin, ((t - s.r0) / (s.r1 - s.r0).max(0.1)).clamp(0.0, 1.0));
                let dmg = s.dmg * falloff * 0.8f32.powi(n as i32) * if head { s.head } else { 1.0 };
                let at = origin + d * t;
                match target {
                    Target::Zombie(id) => {
                        hit_kind = 1.0;
                        if !paid {
                            paid = true;
                            self.award(i, 10);
                        }
                        self.damage_zombie(id, dmg, i as i32, head, false, at);
                        self.proc_mod(i, &gun, id, at);
                        if s.flags & WF_CHAIN != 0 {
                            let near: Vec<i32> = self.sv.zombies.iter().filter(|z| z.id != id && z.state != Z_DEAD && z.pos.dist(at) < 5.5).take(4).map(|z| z.id).collect();
                            for nid in near {
                                self.damage_zombie(nid, dmg * 0.7, i as i32, false, false, at);
                            }
                        }
                    }
                    Target::Player(j) => {
                        hit_kind = 2.0;
                        // Headshots only: body hits still show, but do no damage.
                        let dmg = if self.rules.headshots_only && !head { 0.0 } else { dmg };
                        let killed = dmg > 0.0 && self.damage_player(j, dmg, i as i32, gun.id, false, origin);
                        self.ev(EV_HIT, &[p.id as f32, 1.0, head as u32 as f32, killed as u32 as f32, at.x, at.y, at.z]);
                        if s.flags & WF_CHAIN != 0 {
                            let near: Vec<usize> = (0..self.slots.len()).filter(|k| *k != j && self.hostile(i, *k) && self.slots[*k].p.life == ALIVE && self.slots[*k].p.ctl.pos.dist(at) < 4.5).collect();
                            for k in near {
                                self.damage_player(k, dmg * 0.5, i as i32, gun.id, false, at);
                            }
                        }
                    }
                    Target::Relay(k) => {
                        self.map.targets[k].1 = true;
                        self.ev(EV_EXPLODE, &[at.x, at.y, at.z, 1.0, 2.0]);
                    }
                }
            }
        }
        self.ev(EV_SHOT, &[p.id as f32, gun.id as f32, end.x, end.y, end.z, hit_kind]);
    }

    fn melee(&mut self, i: usize) {
        let p = self.slots[i].p;
        self.ev(EV_MELEE, &[p.id as f32]);
        let (origin, dir) = (p.ctl.eye_pos(), look_dir(p.ctl.yaw, p.ctl.pitch));
        let reach = |pos: V3, h: f32| {
            let to = v3(pos.x, pos.y + h * 0.6, pos.z) - origin;
            to.len() < 2.2 && to.norm().dot(dir) > 0.6
        };
        if let Some(z) = self.sv.zombies.iter().filter(|z| z.state != Z_DEAD && z.state != Z_TURNED && reach(z.pos, Z_BODY)).map(|z| (z.id, z.pos)).next() {
            let dmg = 150.0 + if self.sv.round < 12 { 0.0 } else { 100.0 };
            self.award(i, 10);
            self.damage_zombie(z.0, dmg, i as i32, false, true, z.1 + v3(0.0, 1.2, 0.0));
        } else if self.pvp() {
            if let Some(j) = (0..self.slots.len()).find(|j| self.hostile(i, *j) && self.slots[*j].p.life == ALIVE && reach(self.slots[*j].p.ctl.pos, HEIGHT)) {
                self.damage_player(j, 100.0, i as i32, -1, false, origin);
            }
        }
    }

    fn throw(&mut self, i: usize, lethal: bool) {
        let s = &self.slots[i];
        let p = s.p;
        let kind = if lethal {
            if self.mode != MODE_SURVIVAL && s.loadout[L_LETHAL] == 1 { E_IMPACT } else { E_FRAG }
        } else if self.mode != MODE_SURVIVAL && s.loadout[L_TACTICAL] == 1 {
            // Stim: no projectile.
            self.slots[i].p.health = p.max_health;
            return;
        } else {
            E_STUN
        };
        let dir = look_dir(p.ctl.yaw, p.ctl.pitch);
        self.ents.push(Ent { kind, pos: p.ctl.eye_pos() + dir * 0.4, vel: dir * 17.0 + v3(0.0, 3.0, 0.0) + p.ctl.vel * 0.5, t: 2.2, owner: p.id, a: 0.0 });
    }

    /// Adds points/score, applying multipliers, and feeds ability and streak meters.
    pub fn award(&mut self, i: usize, pts: i32) {
        let double = self.sv.double_t > 0.0;
        let p = &mut self.slots[i].p;
        let mut mult = 1.0;
        if double {
            mult *= 2.0;
        }
        if Self::has_tonic(p, T_WINDFALL) {
            mult *= 2.0;
        }
        if p.kit_perks & KP_BOUNTY != 0 {
            mult *= 1.25;
        }
        let got = (pts as f32 * mult).round();
        p.points += got as i32;
        p.score += got as i32;
        p.streak_score += got;
        if p.active_t <= 0.0 {
            if let Some(a) = usize::try_from(p.ability).ok().and_then(|a| ABILITIES.get(a)) {
                let surge = if p.kit_perks & KP_SURGE != 0 { 1.25 } else { 1.0 };
                p.charge = (p.charge + got / a.charge_score * surge).min(1.0);
            }
        }
    }

    /// Damages a player. Returns true if it killed (skirmish) or downed (survival) them.
    pub fn damage_player(&mut self, j: usize, mut dmg: f32, by: i32, weapon: i32, explosive: bool, from: V3) -> bool {
        let solo = self.solo();
        let mode = self.mode;
        let p = &mut self.slots[j].p;
        if p.life != ALIVE || p.invuln_t > 0.0 {
            return false;
        }
        if explosive && p.kit_perks & KP_PADDING != 0 {
            dmg *= 0.35;
        }
        if by < 0 && Self::has_tonic(p, T_THICK) {
            dmg *= 0.5;
        }
        let to = from - p.ctl.pos;
        p.hit_yaw = (-to.x).atan2(-to.z);
        p.health -= dmg;
        p.regen_t = 0.0;
        if p.health > 0.0 {
            return false;
        }
        let vid = p.id as f32;
        if mode != MODE_SURVIVAL {
            p.life = DEAD;
            p.respawn_t = self.rules.respawn;
            p.deaths += 1;
            p.health = 0.0;
            self.ev(EV_PDEATH, &[vid, if by >= 0 { self.slots[by as usize].p.id as f32 } else { -1.0 }, weapon as f32]);
            if by >= 0 && (by as usize) < self.slots.len() && self.enemies(by as usize, j) {
                let k = by as usize;
                self.slots[k].p.kills += 1;
                self.award(k, 100);
                if self.slots[k].p.kit_perks & KP_SCAVENGER != 0 {
                    self.resupply(k, 0.34);
                }
            }
            self.on_pvp_death(j, by, weapon);
            return true;
        }
        if Self::has_tonic(p, T_LAUGH) {
            p.health = p.max_health;
            p.invuln_t = 3.0;
            p.tonic = -1;
            p.tonic_on = false;
            let (pos, id) = (p.ctl.pos, p.id);
            self.ev(EV_TONIC, &[vid, T_LAUGH as f32, 2.0]);
            self.explode(pos, 7.0, 1e7, 0.0, id);
            return false;
        }
        p.life = DOWN;
        p.health = 0.0;
        p.down_t = 30.0;
        p.revive_t = 0.0;
        p.deaths += 1;
        p.self_revive = if solo && p.perks & SP_SECOND != 0 { 1.0 } else { 0.0 };
        p.perks = 0;
        p.max_health = 100.0 * self.rules.health;
        p.active_t = 0.0;
        if p.arms.guns[2].id >= 0 {
            p.arms.guns[2] = Gun::NONE;
            p.arms.cur = 0;
            p.arms.next = 0;
        }
        self.ev(EV_PDOWN, &[vid, by as f32]);
        true
    }

    /// Refills a fraction of every carried weapon's reserve, plus equipment.
    pub fn resupply(&mut self, i: usize, frac: f32) {
        let p = &mut self.slots[i].p;
        for g in p.arms.guns.iter_mut().take(2) {
            if let Some(s) = g.stats(&Combat::default()) {
                g.reserve = (g.reserve + (s.reserve * frac).ceil()).min(s.reserve);
            }
        }
        if frac >= 1.0 {
            p.arms.lethal = 2.0;
            p.arms.tactical = 1.0;
        } else {
            p.arms.lethal = (p.arms.lethal + 1.0).min(2.0);
        }
    }

    /// Radial damage. `zdmg` applies to zombies, `pdmg` to players (skirmish only; owner takes half).
    pub fn explode(&mut self, pos: V3, r: f32, zdmg: f32, pdmg: f32, owner: i32) {
        self.explode_by(pos, r, zdmg, pdmg, owner, -2);
    }
    /// `explode` crediting a weapon in the kill feed (-2: generic explosive).
    pub fn explode_by(&mut self, pos: V3, r: f32, zdmg: f32, pdmg: f32, owner: i32, weapon: i32) {
        self.ev(EV_EXPLODE, &[pos.x, pos.y, pos.z, r, 0.0]);
        let oi = self.idx(owner).map_or(-1, |i| i as i32);
        let hit: Vec<(i32, f32)> = self.sv.zombies.iter().filter(|z| z.state != Z_DEAD).map(|z| (z.id, z.pos.dist(pos))).filter(|z| z.1 < r).collect();
        for (id, d) in hit {
            self.damage_zombie(id, zdmg * (1.0 - 0.6 * d / r), oi, false, false, pos);
        }
        if self.pvp() && pdmg > 0.0 && !self.rules.headshots_only {
            for j in 0..self.slots.len() {
                let d = self.slots[j].p.ctl.pos.dist(pos);
                // Your own blast always hurts you; others' only if they are hostile to you.
                let hurts = oi < 0 || j as i32 == oi || self.hostile(oi as usize, j);
                if d < r && hurts {
                    let own = if j as i32 == oi { 0.5 } else { 1.0 };
                    self.damage_player(j, pdmg * (1.0 - 0.7 * d / r) * own, oi, weapon, true, pos);
                }
            }
        }
    }

    fn activate_ability(&mut self, i: usize) {
        let p = &mut self.slots[i].p;
        let Some(a) = usize::try_from(p.ability).ok().and_then(|a| ABILITIES.get(a)) else { return };
        if p.charge < 1.0 || p.active_t > 0.0 || p.life != ALIVE {
            return;
        }
        p.charge = 0.0;
        let (id, ab, pos, grounded) = (p.id, p.ability, p.ctl.pos, p.ctl.grounded);
        match a.kind {
            AB_WEAPON => {
                p.arms.equip(2, Gun::new(a.weapon, 0));
                p.active_t = a.duration;
            }
            AB_BUFF => p.active_t = a.duration,
            _ => {
                if grounded {
                    self.explode(pos, 6.5, 2500.0, 160.0, id);
                } else {
                    p.slam = true;
                    p.ctl.vel = v3(0.0, -28.0, 0.0);
                }
            }
        }
        self.ev(EV_ABILITY, &[id as f32, ab as f32, 1.0]);
    }

    fn use_streak(&mut self, i: usize, n: usize) {
        let s = &mut self.slots[i];
        let id = s.loadout[L_STREAK + n];
        if id < 0 || s.p.streak_ready & (1 << n) == 0 || s.p.life != ALIVE {
            return;
        }
        s.p.streak_ready &= !(1 << n);
        let p = s.p;
        match id {
            0 => self.slots[i].p.ping_t = 20.0,
            1 => {
                self.resupply(i, 1.0);
                let p = &mut self.slots[i].p;
                p.charge = (p.charge + 0.5).min(1.0);
            }
            _ => {
                let (o, d) = (p.ctl.eye_pos(), look_dir(p.ctl.yaw, p.ctl.pitch));
                let t = self.map.world.raycast(o, d, 80.0).map_or(80.0, |h| h.0);
                let at = o + d * t;
                let (sy, cy) = p.ctl.yaw.sin_cos();
                self.ents.push(Ent { kind: E_STRIKE, pos: v3(at.x, 0.0, at.z), vel: v3(-sy, 0.0, -cy), t: 2.0, owner: p.id, a: 0.0 });
            }
        }
        self.ev(EV_STREAK, &[p.id as f32, id as f32]);
    }

    /// World tick. Host only.
    pub fn step(&mut self, dt: f32) {
        if !self.authority {
            return;
        }
        self.time += dt;
        for i in 0..self.slots.len() {
            self.tick_player(i, dt);
        }
        self.tick_ents(dt);
        if self.mode == MODE_SURVIVAL {
            self.sv_step(dt);
        } else {
            self.sk_step(dt);
        }
        self.hist.push_back(Hist {
            time: self.time,
            z: self.sv.zombies.iter().map(|z| (z.id, z.pos)).collect(),
            p: self.slots.iter().map(|s| (s.p.id, s.p.ctl.pos, s.p.ctl.height())).collect(),
        });
        while self.hist.front().map_or(false, |h| h.time < self.time - 0.6) {
            self.hist.pop_front();
        }
    }

    fn tick_player(&mut self, i: usize, dt: f32) {
        // Safety net: anyone who somehow ends up outside the map (a collision bug, a glitch) is put
        // back at a spawn point instead of falling forever or hiding where zombies cannot reach.
        let (w, d) = self.map.size;
        let pos = self.slots[i].p.ctl.pos;
        if self.slots[i].p.life != DEAD && (pos.x < 0.0 || pos.z < 0.0 || pos.x > w || pos.z > d || pos.y < -2.0 || pos.y > WALL_H) {
            let back = self.map.spawns.iter().copied().min_by(|a, b| a.dist(pos).total_cmp(&b.dist(pos))).unwrap_or(pos);
            let c = &mut self.slots[i].p.ctl;
            c.pos = back;
            c.vel = V3::ZERO;
            c.mode = MODE_NORMAL;
        }
        let mode = self.mode;
        let (health_mult, streaks) = (self.rules.health, self.streaks_on());
        let s = &mut self.slots[i];
        s.bank = (s.bank + dt).min(0.5);
        s.mod_cd = (s.mod_cd - dt).max(0.0);
        let l = s.loadout;
        let p = &mut s.p;
        for t in [&mut p.invuln_t, &mut p.slow_t, &mut p.calm_t, &mut p.ping_t] {
            *t = (*t - dt).max(0.0);
        }
        if p.life != ALIVE {
            return;
        }
        p.max_health = if p.perks & SP_IRONHIDE != 0 { 200.0 } else { 100.0 } * health_mult;
        p.regen_t += dt;
        let delay = if p.kit_perks & KP_HARDY != 0 { 2.5 } else { 4.0 };
        if p.regen_t > delay {
            p.health = (p.health + 45.0 * dt).min(p.max_health);
        }
        // Ability meter: passive charge, then run down any active ability.
        if let Some(a) = usize::try_from(p.ability).ok().and_then(|a| ABILITIES.get(a)) {
            if p.active_t > 0.0 {
                p.active_t -= dt;
                let spent = a.kind == AB_WEAPON && p.arms.guns[2].ammo <= 0.0 && p.arms.cooldown <= 0.0;
                if p.active_t <= 0.0 || spent {
                    p.active_t = 0.0;
                    if p.arms.guns[2].id >= 0 {
                        p.arms.guns[2] = Gun::NONE;
                        let back = if p.arms.guns[0].id >= 0 { 0 } else { 1 };
                        p.arms.cur = back;
                        p.arms.next = back;
                        p.arms.switch_t = 0.0;
                    }
                }
            } else {
                let rate = if p.kit_perks & KP_SURGE != 0 { 1.25 } else { 1.0 } * if mode == MODE_SURVIVAL { 0.7 } else { 1.0 };
                p.charge = (p.charge + dt / a.charge_time * rate).min(1.0);
            }
        }
        if streaks {
            for n in 0..3 {
                let id = l[L_STREAK + n];
                let got = 1 << (8 + n);
                if id >= 0 && p.streak_ready & got == 0 && p.streak_score >= STREAKS[id as usize].2 as f32 {
                    p.streak_ready |= got | (1 << n);
                }
            }
        }
        if p.tonic >= 0 && p.tonic_on && TONICS[p.tonic as usize].kind == TN_TIMED {
            p.tonic_left -= dt;
            if p.tonic_left <= 0.0 {
                p.tonic = -1;
                p.tonic_on = false;
            }
        }
        if Self::has_tonic(p, T_POCKETS) {
            let g = p.arms.gun_mut();
            if let Some(st) = g.stats(&Combat::default()) {
                g.reserve = (g.reserve + st.reserve * 0.02 * dt).min(st.reserve);
            }
        }
    }

    fn tick_ents(&mut self, dt: f32) {
        let mut i = 0;
        while i < self.ents.len() {
            let mut e = self.ents[i];
            e.t -= dt;
            let mut done = e.t <= 0.0;
            let mut boom = false;
            match e.kind {
                E_FRAG | E_IMPACT | E_STUN => {
                    e.vel.y -= 15.0 * dt;
                    let step = e.vel * dt;
                    let len = step.len();
                    if let Some((t, n)) = self.map.world.raycast(e.pos, step.norm(), len).filter(|_| len > 1e-5) {
                        e.pos += step.norm() * (t - 0.02).max(0.0);
                        if e.kind == E_FRAG {
                            e.vel = (e.vel - n * (2.0 * e.vel.dot(n))) * 0.45;
                        } else {
                            done = true;
                        }
                    } else {
                        e.pos += step;
                    }
                    boom = done;
                }
                E_ROCKET => {
                    let step = e.vel * dt;
                    let len = step.len();
                    let d = step.norm();
                    let mut reach = self.map.world.raycast(e.pos, d, len).map(|h| h.0);
                    // Direct hits: the first body the flight path passes through this tick.
                    let mut touch = |c: V3, r: f32| {
                        let along = (c - e.pos).dot(d).clamp(0.0, len);
                        if (e.pos + d * along).dist(c) < r && reach.map_or(true, |t| along < t) {
                            reach = Some(along);
                        }
                    };
                    for z in self.sv.zombies.iter().filter(|z| z.state != Z_DEAD && z.state != Z_TURNED) {
                        touch(z.pos + v3(0.0, Z_BODY * 0.55, 0.0), Z_RADIUS + 0.3);
                    }
                    if self.pvp() {
                        let shooter = self.idx(e.owner);
                        for (_, o) in self.slots.iter().enumerate().filter(|(j, o)| o.p.life == ALIVE && shooter.map_or(true, |k| self.hostile(k, *j))) {
                            touch(o.p.ctl.pos + v3(0.0, o.p.ctl.height() * 0.5, 0.0), RADIUS + 0.3);
                        }
                    }
                    match reach {
                        Some(t) => {
                            e.pos += d * (t - 0.05).max(0.0);
                            done = true;
                        }
                        None => e.pos += step,
                    }
                    boom = true; // on contact, or in the air when its fuel runs out
                }
                E_CINDER => {
                    let ids: Vec<(i32, f32)> = self.sv.zombies.iter().filter(|z| z.state != Z_DEAD && z.pos.dist(e.pos) < 3.2).map(|z| (z.id, z.max_hp)).collect();
                    for (id, hp) in ids {
                        self.damage_zombie(id, hp * 0.4 * dt + 30.0 * dt, self.idx(e.owner).map_or(-1, |x| x as i32), false, false, e.pos);
                    }
                }
                E_STARBURST => {
                    e.a += dt;
                    if e.a >= 0.5 {
                        e.a = 0.0;
                        if let Some(z) = self.sv.zombies.iter().filter(|z| z.state != Z_DEAD && z.state != Z_TURNED && z.pos.dist(e.pos) < 7.0).map(|z| (z.id, z.pos)).next() {
                            self.ev(EV_SHOT, &[-1.0, W_ARC as f32, z.1.x, z.1.y + 1.0, z.1.z, 1.0]);
                            self.damage_zombie(z.0, 1e7, self.idx(e.owner).map_or(-1, |x| x as i32), false, false, z.1);
                        }
                    }
                }
                _ => {}
            }
            if done {
                self.ents.swap_remove(i);
                match e.kind {
                    E_FRAG | E_IMPACT if boom => {
                        let zd = 400.0 + 90.0 * self.sv.round as f32;
                        self.explode(e.pos, if e.kind == E_FRAG { 6.0 } else { 4.5 }, zd, 180.0, e.owner);
                    }
                    E_ROCKET if boom => {
                        // Splash keeps pace with zombie health so the launcher stays useful late.
                        let zd = e.a * (1.0 + 0.1 * self.sv.round as f32);
                        self.explode_by(e.pos, ROCKET_RADIUS, zd, 260.0, e.owner, W_COMET);
                    }
                    E_STUN => {
                        self.ev(EV_EXPLODE, &[e.pos.x, e.pos.y, e.pos.z, 6.0, 1.0]);
                        for z in self.sv.zombies.iter_mut().filter(|z| z.pos.dist(e.pos) < 6.0) {
                            z.slow_t = 5.0;
                        }
                        if self.pvp() {
                            let thrower = self.idx(e.owner);
                            let hit: Vec<usize> = (0..self.slots.len()).filter(|j| thrower.map_or(true, |k| self.hostile(k, *j)) && self.slots[*j].p.ctl.pos.dist(e.pos) < 6.0).collect();
                            for j in hit {
                                self.slots[j].p.slow_t = 4.0;
                            }
                        }
                    }
                    E_STRIKE => {
                        for k in -2..=2 {
                            self.explode(e.pos + e.vel * (k as f32 * 3.5), 5.0, 3000.0, 220.0, e.owner);
                        }
                    }
                    _ => {}
                }
            } else {
                self.ents[i] = e;
                i += 1;
            }
        }
    }

    fn sk_step(&mut self, dt: f32) {
        match self.phase {
            PH_WARMUP => {
                self.timer -= dt;
                if self.timer <= 0.0 {
                    self.phase = PH_ACTIVE;
                    // No time limit: the clock reads -1 and never runs out.
                    self.timer = if self.rules.time_limit > 0.0 { self.rules.time_limit } else { -1.0 };
                    self.ev(EV_ROUND, &[1.0, 0.0]);
                }
            }
            PH_ACTIVE => {
                if self.rules.time_limit > 0.0 {
                    self.timer -= dt;
                }
                for i in 0..self.slots.len() {
                    let p = &mut self.slots[i].p;
                    if p.life == DEAD {
                        p.respawn_t -= dt;
                        if p.respawn_t <= 0.0 {
                            self.spawn(i);
                        }
                    }
                }
                self.mode_step(dt);
                if let Some((id, score, team, draw)) = self.pvp_result() {
                    self.phase = PH_OVER;
                    self.ev(EV_GAMEOVER, &[id, score, team, draw as u32 as f32]);
                }
            }
            _ => {}
        }
    }

    pub fn header(&self) -> Hdr {
        let q = |n: usize| {
            let len = self.map.def.quests.get(n).map_or(0, |q| q.steps.len());
            if len == 0 { (-1, 0.0) } else { (self.sv.quest[n].0.min(len) as i32, self.sv.quest[n].1) }
        };
        let targets = self.map.targets.iter().enumerate().fold(0, |m, (i, t)| m | ((t.1 as u32) << i));
        Hdr {
            time: self.time,
            mode: self.mode,
            phase: self.phase,
            round: self.sv.round,
            left: self.sv.to_spawn + self.sv.zombies.iter().filter(|z| z.state != Z_DEAD && z.state != Z_TURNED).count() as u32,
            doors: self.sv.doors,
            power: self.sv.power,
            timer: self.timer,
            insta_t: self.sv.insta_t,
            double_t: self.sv.double_t,
            crate_at: self.sv.crate_at as i32,
            crate_state: self.sv.crate_state,
            crate_weapon: self.sv.crate_weapon,
            crate_owner: self.sv.crate_owner,
            parts: self.sv.parts,
            targets: targets | if self.relays_live() { 1 << 16 } else { 0 },
            shield_built: self.sv.shield_built,
            q0_step: q(0).0,
            q0_prog: q(0).1,
            q1_step: q(1).0,
            q1_prog: q(1).1,
            score_limit: self.score_limit,
            score_a: self.obj.score[0],
            score_b: self.obj.score[1],
            obj_t: self.obj.hill_t,
            n_players: self.slots.len() as u32,
            n_zombies: self.sv.zombies.len() as u32,
            n_ents: self.ents.len() as u32,
            n_barrs: self.map.barrs.len() as u32,
        }
    }

    /// Full world state for clients: header, players, zombies, entities, barricade boards.
    pub fn snapshot(&self, o: &mut Vec<f32>) {
        self.header().put(o);
        for s in &self.slots {
            s.p.put(o);
        }
        for z in &self.sv.zombies {
            ZRec { id: z.id, pos: z.pos, yaw: z.yaw, state: z.state, hp: (z.hp / z.max_hp).clamp(0.0, 1.0), kind: z.kind }.put(o);
        }
        for e in &self.ents {
            let a = match e.kind {
                E_ROCKET => pack_dir(e.vel),
                k if (E_ZONE..E_ZONE + 3).contains(&k) || k == E_HILL => pack_zone(e.owner, e.vel.x, e.vel.y > 0.5),
                _ => e.t,
            };
            ERec { kind: e.kind, pos: e.pos, a }.put(o);
        }
        for b in &self.map.barrs {
            o.push(b.boards as f32);
        }
    }

    pub fn player_state(&self, pid: i32, o: &mut Vec<f32>) {
        if let Some(i) = self.idx(pid) {
            self.slots[i].p.put(o);
        }
    }
    /// Overwrites a player with host state (client reconciliation). Creates the player if needed.
    ///
    /// The data comes from another player's machine, so it is treated as untrusted: non-finite
    /// numbers become 0 and every value used as an index is clamped to a valid range, so a
    /// malformed or hostile snapshot cannot crash this client.
    pub fn set_player_state(&mut self, d: &[f32]) {
        let clean: Vec<f32> = d.iter().map(|v| if v.is_finite() { *v } else { 0.0 }).collect();
        let mut p = Player::default();
        p.get(&mut Rd::new(&clean));
        p.sanitize();
        match self.idx(p.id) {
            Some(i) => self.slots[i].p = p,
            None if self.slots.len() < 16 => self.slots.push(Slot { p, loadout: default_loadout(), bank: 0.0, mod_cd: 0.0, tonic_buys: 0, rebuilt: 0 }),
            None => {}
        }
    }
}

pub fn layout() -> String {
    let mut out = String::new();
    let mut section = |tag: &str, f: &dyn Fn(&mut usize, &mut String)| {
        let mut off = 0;
        out.push_str(tag);
        out.push('|');
        f(&mut off, &mut out);
        out.push_str(&format!("_len:{off};"));
    };
    section("P", &|o, s| Player::layout("", o, s));
    section("H", &|o, s| Hdr::layout("", o, s));
    section("Z", &|o, s| ZRec::layout("", o, s));
    section("E", &|o, s| ERec::layout("", o, s));
    out.push_str("V|");
    out.push_str(EVENT_NAMES);
    out.push_str(&format!("_len:{EV_STRIDE};"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::Rng;

    fn cmd(seq: u32, yaw: f32, pitch: f32, buttons: u32, rt: f32) -> [f32; CMD_LEN] {
        [seq as f32, 1.0 / 60.0, 0.0, 0.0, yaw, pitch, buttons as f32, -1.0, rt]
    }
    fn zombie(g: &mut Game, pos: V3) -> i32 {
        let id = g.sv.next_id;
        g.sv.next_id += 1;
        g.sv.zombies.push(Zombie { id, pos, yaw: 0.0, hp: 150.0, max_hp: 150.0, state: Z_CHASE, t: 0.0, speed: 0.0, kind: 0, target: -1, atk_cd: 9.0, slow_t: 0.0, turned_t: 0.0 });
        id
    }
    fn aim(from: V3, to: V3) -> (f32, f32) {
        let d = (to - from).norm();
        ((-d.x).atan2(-d.z), d.y.asin())
    }

    #[test]
    fn hits_pay_points_and_headshots_kill_faster() {
        let mut g = Game::new(1, MODE_SURVIVAL, 1, true);
        g.local = 0;
        g.add_player(0, 0, default_loadout());
        g.phase = PH_ACTIVE;
        g.sv.round = 1;
        let eye = g.slots[0].p.ctl.eye_pos();
        let zp = g.slots[0].p.ctl.pos + v3(4.0, 0.0, 0.0);
        let z = zombie(&mut g, zp);
        let (yaw, pitch) = aim(eye, zp + v3(0.0, 1.0, 0.0));
        g.cmd(0, &cmd(1, yaw, pitch, B_FIRE, 0.0));
        assert_eq!(g.slots[0].p.points, 510, "+10 for a hit");
        assert_eq!(g.sv.zombies.iter().find(|x| x.id == z).unwrap().hp, 110.0);
        // Two pistol headshots (40 x 2) finish a round-1 zombie from 110.
        let (yaw, pitch) = aim(eye, zp + v3(0.0, Z_HEAD, 0.0));
        for s in 0..40 {
            g.cmd(0, &cmd(2 + s, yaw, pitch, if s % 20 == 10 { B_FIRE } else { 0 }, 0.0));
        }
        assert_eq!(g.sv.zombies.iter().find(|x| x.id == z).unwrap().state, Z_DEAD);
        assert_eq!(g.slots[0].p.points, 510 + 10 + 10 + 100, "headshot kill pays 100");
        assert_eq!(g.slots[0].p.headshots, 1);
    }

    /// Arms player `i` with `id` in hand, ready to fire.
    fn hold(g: &mut Game, i: usize, id: i32) {
        g.slots[i].p.arms.equip(0, Gun::new(id, 0));
        g.slots[i].p.arms.switch_t = 0.0;
    }
    fn deaths(g: &Game) -> Vec<(f32, f32, f32)> {
        g.events.chunks(EV_STRIDE).filter(|e| e[0] == EV_PDEATH as f32).map(|e| (e[1], e[2], e[3])).collect()
    }

    #[test]
    fn rockets_fly_then_explode_on_contact() {
        let mut g = Game::new(1, MODE_SURVIVAL, 1, true);
        g.local = 0;
        g.add_player(0, 0, default_loadout());
        g.phase = PH_ACTIVE;
        g.sv.round = 1;
        g.timer = 99.0;
        hold(&mut g, 0, W_COMET);
        let eye = g.slots[0].p.ctl.eye_pos();
        let zp = g.slots[0].p.ctl.pos + v3(4.0, 0.0, 0.0);
        let z = zombie(&mut g, zp);
        let (yaw, pitch) = aim(eye, zp + v3(0.0, 1.0, 0.0));
        g.cmd(0, &cmd(1, yaw, pitch, B_FIRE, 0.0));
        assert_eq!(g.slots[0].p.arms.gun().ammo, 0.0, "one rocket per load");
        let rocket = |g: &Game| g.ents.iter().find(|e| e.kind == E_ROCKET).map(|e| e.pos);
        let start = rocket(&g).expect("a rocket is in flight");
        assert!(g.sv.zombies[0].hp == 150.0, "nothing is hit at the moment of firing");
        g.step(1.0 / 60.0);
        let moved = rocket(&g).expect("still flying after one tick");
        assert!((moved.dist(start) - ROCKET_SPEED / 60.0).abs() < 0.01, "flies at a steady speed");
        for _ in 0..20 {
            g.step(1.0 / 60.0);
        }
        assert!(rocket(&g).is_none(), "it hit something");
        assert!(g.sv.zombies.iter().find(|x| x.id == z).map_or(true, |x| x.state == Z_DEAD), "the zombie is dead");
        assert_eq!(g.slots[0].p.kills, 1);
        assert!(g.events.chunks(EV_STRIDE).any(|e| e[0] == EV_EXPLODE as f32 && v3(e[1], e[2], e[3]).dist(zp) < 1.5), "exploded at the zombie");

        // A rocket fired into the sky runs out of fuel and bursts in the air.
        let mut g = Game::new(1, MODE_SURVIVAL, 1, true);
        g.local = 0;
        g.add_player(0, 0, default_loadout());
        g.phase = PH_ACTIVE;
        hold(&mut g, 0, W_COMET);
        g.cmd(0, &cmd(1, 0.0, 1.5, B_FIRE, 0.0));
        for _ in 0..200 {
            g.step(1.0 / 60.0);
        }
        assert!(rocket(&g).is_none());
    }

    #[test]
    fn rocket_kills_are_credited_to_the_launcher() {
        let mut g = Game::new(1, MODE_SKIRMISH, 1, true);
        g.local = 0;
        g.add_player(0, 0, default_loadout());
        g.add_player(1, 1, default_loadout());
        g.phase = PH_ACTIVE;
        g.timer = 100.0;
        hold(&mut g, 0, W_COMET);
        let (me, eye) = (g.slots[0].p.ctl.pos, g.slots[0].p.ctl.eye_pos());
        // A direction with open ground in front of the shooter.
        let dir = (0..32)
            .map(|k| look_dir(k as f32 * core::f32::consts::TAU / 32.0, 0.0))
            .find(|d| g.map.world.raycast(eye, *d, 12.0).is_none() && g.map.world.raycast(me + v3(0.0, 0.3, 0.0), *d, 12.0).is_none())
            .expect("open ground near the spawn");
        g.slots[1].p.ctl.pos = me + dir * 8.0;
        g.slots[1].p.ctl.vel = V3::ZERO;
        g.slots[1].p.invuln_t = 0.0;
        g.slots[0].p.invuln_t = 0.0;
        let (yaw, pitch) = aim(eye, me + dir * 8.0 + v3(0.0, 1.0, 0.0));
        g.cmd(0, &cmd(1, yaw, pitch, B_FIRE, 0.0));
        for _ in 0..30 {
            g.step(1.0 / 60.0);
        }
        assert_eq!(g.slots[1].p.life, DEAD, "a direct hit kills");
        assert_eq!(deaths(&g), vec![(g.slots[1].p.id as f32, g.slots[0].p.id as f32, W_COMET as f32)]);
        assert_eq!(g.slots[0].p.life, ALIVE, "the shooter is outside the blast");
    }

    #[test]
    fn packed_directions_round_trip() {
        for (yaw, pitch) in [(0.0, 0.0), (1.2, -0.4), (-2.9, 1.1), (3.1, -1.5)] {
            let a = pack_dir(look_dir(yaw, pitch));
            assert_eq!(a, a.round(), "an exact integer");
            let (yq, pq) = ((a / 512.0).floor(), a % 512.0);
            let (y2, p2) = (yq / 511.0 * core::f32::consts::TAU - core::f32::consts::PI, pq / 511.0 * core::f32::consts::PI - core::f32::consts::FRAC_PI_2);
            let back = look_dir(y2, p2);
            assert!(back.dot(look_dir(yaw, pitch)) > 0.9995, "({yaw}, {pitch}) came back as ({y2}, {p2})");
        }
    }

    #[test]
    fn lag_compensation_rewinds_remote_shooters_only_within_the_window() {
        let mut g = Game::new(1, MODE_SURVIVAL, 1, true);
        g.local = 0;
        g.add_player(0, 0, default_loadout());
        g.add_player(1, 0, default_loadout());
        g.phase = PH_ACTIVE;
        g.sv.round = 1;
        g.timer = 99.0;
        let eye = g.slots[1].p.ctl.eye_pos();
        let old = g.slots[1].p.ctl.pos + v3(0.0, 0.0, 5.0);
        let z = zombie(&mut g, old);
        g.step(1.0 / 60.0);
        let seen = g.time;
        // The zombie teleports away; the remote client was still looking at the old spot.
        g.sv.zombies.iter_mut().find(|x| x.id == z).unwrap().pos = old + v3(6.0, 0.0, 0.0);
        for _ in 0..6 {
            g.step(1.0 / 60.0);
        }
        let hp = |g: &Game| g.sv.zombies.iter().find(|x| x.id == z).unwrap().hp;
        let (yaw, pitch) = aim(eye, old + v3(0.0, 1.0, 0.0));
        g.cmd(1, &cmd(1, yaw, pitch, B_FIRE, seen));
        assert!(hp(&g) < 150.0, "shot at the remembered position lands");
        // A claim far older than the rewind window is clamped, so it misses.
        let before = hp(&g);
        for s in 0..40 {
            g.step(1.0 / 60.0);
            g.cmd(1, &cmd(2 + s, yaw, pitch, 0, seen));
        }
        let ammo = g.slots[1].p.arms.gun().ammo;
        g.cmd(1, &cmd(50, yaw, pitch, B_FIRE, seen));
        assert_eq!(g.slots[1].p.arms.gun().ammo, ammo - 1.0, "the shot was fired");
        assert_eq!(hp(&g), before);
    }

    #[test]
    fn speed_hack_commands_are_dropped() {
        let mut g = Game::new(1, MODE_SKIRMISH, 1, true);
        g.local = 0;
        g.add_player(1, 0, default_loadout());
        let start = g.slots[0].p.ctl.pos;
        // 120 commands with no world time passing: only the initial allowance is simulated.
        for s in 0..120 {
            let mut c = cmd(s, 0.0, 0.0, B_SPRINT, 0.0);
            c[3] = 1.0;
            g.cmd(1, &c);
        }
        assert!(g.slots[0].p.ctl.pos.dist(start) < 1.0);
        assert_eq!(g.slots[0].p.ack, 119, "dropped commands are still acknowledged");
    }

    #[test]
    fn skirmish_kill_scores_and_respawns() {
        let mut g = Game::new(1, MODE_SKIRMISH, 1, true);
        g.local = 0;
        g.add_player(0, 0, default_loadout());
        g.add_player(1, 1, default_loadout());
        g.phase = PH_ACTIVE;
        g.timer = 100.0;
        g.slots[1].p.invuln_t = 0.0;
        assert!(g.damage_player(1, 500.0, 0, 3, false, V3::ZERO));
        assert_eq!((g.slots[0].p.kills, g.slots[1].p.deaths, g.slots[1].p.life), (1, 1, DEAD));
        for _ in 0..200 {
            g.step(1.0 / 60.0);
        }
        assert_eq!(g.slots[1].p.life, ALIVE);
    }

    #[test]
    fn prediction_matches_authority() {
        let mut host = Game::new(0, MODE_SKIRMISH, 1, true);
        let mut client = Game::new(0, MODE_SKIRMISH, 1, false);
        host.add_player(1, 0, default_loadout());
        let mut st = vec![];
        host.player_state(1, &mut st);
        client.set_player_state(&st);
        client.local = 1;
        client.set_doors(u32::MAX);
        for s in 0..180u32 {
            let mut c = cmd(s, 0.4, 0.0, B_SPRINT | if s % 50 == 20 { B_JUMP } else { 0 } | if s > 100 { B_FIRE } else { 0 }, 0.0);
            c[3] = 1.0;
            host.step(1.0 / 60.0);
            host.cmd(1, &c);
            client.cmd(1, &c);
        }
        let (a, b) = (host.slots[0].p, client.slots[0].p);
        assert!(a.ctl.pos.dist(b.ctl.pos) < 1e-4, "{:?} vs {:?}", a.ctl.pos, b.ctl.pos);
        assert_eq!(a.arms.gun().ammo, b.arms.gun().ammo);
        assert!(a.arms.gun().ammo < 30.0);
    }

    /// Values a hostile or buggy peer might send: NaN, infinities, huge, negative, fractional.
    fn junk(r: &mut Rng) -> f32 {
        match r.range(10) {
            0 => f32::NAN,
            1 => f32::INFINITY,
            2 => f32::NEG_INFINITY,
            3 => 1e30,
            4 => -1e30,
            5 => (r.f() - 0.5) * 4.0e9,
            6 => r.range(70000) as f32 - 1000.0,
            _ => (r.f() - 0.5) * 20.0,
        }
    }

    #[test]
    fn host_survives_garbage_from_guests() {
        let mut r = Rng::new(99);
        for map in 0..crate::maps::MAPS.len() {
            for mode in 0..MODE_COUNT {
                let mut g = Game::new(map, mode, 7, true);
                g.local = 0;
                g.add_player(0, 0, default_loadout());
                for id in 1..4 {
                    let l: Vec<f32> = (0..40).map(|_| junk(&mut r)).collect();
                    g.add_player(id, id, crate::loadout::from_floats(&l));
                }
                for tick in 0..3000u32 {
                    for id in 1..4 {
                        let n = r.range(14);
                        let c: Vec<f32> = (0..n).map(|_| junk(&mut r)).collect();
                        g.cmd(id, &c);
                    }
                    // An honest player keeps playing.
                    g.cmd(0, &cmd(tick, tick as f32 * 0.01, 0.0, B_FIRE | if tick % 40 == 0 { B_RELOAD } else { 0 }, g.time));
                    g.step(1.0 / 60.0);
                    if tick % 500 == 0 {
                        g.remove_player(3);
                        let l: Vec<f32> = (0..27).map(|_| junk(&mut r)).collect();
                        g.add_player(3, 3, crate::loadout::from_floats(&l));
                    }
                    if tick % 60 == 0 {
                        let mut snap = vec![];
                        g.snapshot(&mut snap);
                        assert!(snap.iter().all(|v| v.is_finite()), "snapshot has non-finite values (map {map}, mode {mode}, tick {tick})");
                    }
                }
                for s in &g.slots {
                    let p = s.p.ctl.pos;
                    assert!(p.x.is_finite() && p.y.is_finite() && p.z.is_finite());
                    assert!(p.x > -5.0 && p.z > -5.0 && p.x < g.map.size.0 + 5.0 && p.z < g.map.size.1 + 5.0, "player {} left the map: {p:?}", s.p.id);
                }
            }
        }
    }

    #[test]
    fn client_survives_garbage_snapshots_from_a_host() {
        let mut r = Rng::new(7);
        let mut g = Game::new(0, MODE_SURVIVAL, 1, false);
        g.local = 5;
        for tick in 0..4000u32 {
            let n = r.range(200);
            let mut d: Vec<f32> = (0..n).map(|_| junk(&mut r)).collect();
            if !d.is_empty() {
                d[0] = 5.0; // our own id, so it is applied to the predicted player
            }
            g.set_player_state(&d);
            let c: Vec<f32> = (0..CMD_LEN).map(|_| junk(&mut r)).collect();
            g.cmd(5, &c);
            g.cmd(5, &cmd(tick, 0.3, 0.0, B_FIRE | B_SPRINT | B_JUMP | B_TONIC | B_ABILITY, 0.0));
            g.set_doors(r.next());
        }
        assert!(g.slots.len() <= 16, "a host cannot make a client allocate players without bound");
    }

    #[test]
    fn layout_lists_fields() {
        let l = layout();
        assert!(l.contains("P|id:0,ack:1,life:2,health:3,") && l.contains("ctl.pos:11,ctl.vel:14,") && l.contains("H|time:0,"), "{l}");
    }
}

