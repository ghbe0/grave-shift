//! Multiplayer modes and match rules: teams, spawns spread over the whole map, capture zones, the
//! moving hill, dropped tags and the weapon ladder. Survival lives in `survival.rs`; this module
//! covers everything a host can set up for player-versus-player matches.
use crate::arms::*;
use crate::catalog::*;
use crate::game::*;
use crate::math::*;

pub const MODE_TDM: u8 = 2;
pub const MODE_DOMINATION: u8 = 3;
pub const MODE_HILL: u8 = 4;
pub const MODE_TAGS: u8 = 5;
pub const MODE_LADDER: u8 = 6;
pub const MODE_COUNT: u8 = 7;

/// Capture zones A, B, C (`E_ZONE + index`), the hill, and dropped tags (`E_TAG + victim's team`).
/// Zones and the hill carry their owning team in `owner` and capture progress in `vel.x`
/// (-1: held by team 0, +1: held by team 1); on the wire `a` packs both (see `pack_zone`).
pub const E_ZONE: u8 = 40;
pub const E_HILL: u8 = 45;
pub const E_TAG: u8 = 50;

pub const ZONE_R: f32 = 3.5;
pub const HILL_R: f32 = 4.5;
/// Seconds for one player to take a neutral zone (twice that from the other team).
const CAPTURE_TIME: f32 = 5.0;
/// Each held zone scores a point this often.
const ZONE_TICK: f32 = 3.0;
const HILL_MOVE: f32 = 60.0;
const TAG_LIFE: f32 = 30.0;
const TAG_REACH: f32 = 1.4;

// EV_OBJ codes: [code, a, b]
pub const OB_CAPTURED: f32 = 1.0; // zone, team
pub const OB_NEUTRAL: f32 = 2.0; // zone, team that neutralised it
pub const OB_HILL_MOVED: f32 = 3.0; // spot
pub const OB_CONFIRMED: f32 = 4.0; // player id, team
pub const OB_DENIED: f32 = 5.0; // player id, team
pub const OB_LADDER_UP: f32 = 6.0; // player id, stage
pub const OB_LADDER_DOWN: f32 = 7.0; // player id, stage
pub const OB_SWITCHED: f32 = 8.0; // player id, new team

/// The weapon ladder, first rung to last: one kill moves you up a rung.
pub const LADDER: [i32; 20] = [13, 2, 14, 3, 12, 11, 4, 6, 17, 15, 5, 16, 18, 7, 19, W_COMET, 1, 21, 20, W_PISTOL];

/// Host-chosen match settings. Every value is clamped on the way in (`from_floats`), so a guest
/// or a hostile host cannot set anything outside the ranges the menus offer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rules {
    /// Match length in seconds, 0 for no limit.
    pub time_limit: f32,
    /// Score to win (kills, tags or objective points), 0 for no limit.
    pub score_limit: u32,
    pub respawn: f32,
    /// Health multiplier.
    pub health: f32,
    pub friendly_fire: bool,
    pub headshots_only: bool,
    pub abilities: bool,
    pub streaks: bool,
    /// Survival: the round to start on and the points each player starts with.
    pub start_round: u32,
    pub start_points: i32,
}
pub const RULES_LEN: usize = 10;

impl Rules {
    pub fn defaults(mode: u8) -> Rules {
        let (time_limit, score_limit) = match mode {
            MODE_SURVIVAL => (0.0, 0),
            MODE_SKIRMISH => (480.0, 25),
            MODE_TDM => (600.0, 75),
            MODE_DOMINATION => (600.0, 200),
            MODE_HILL => (600.0, 150),
            MODE_TAGS => (600.0, 65),
            _ => (600.0, LADDER.len() as u32),
        };
        Rules { time_limit, score_limit, respawn: 3.0, health: 1.0, friendly_fire: false, headshots_only: false, abilities: true, streaks: true, start_round: 1, start_points: 500 }
    }
    /// Rules from untrusted numbers: anything missing, non-finite or out of range takes the default.
    pub fn from_floats(mode: u8, d: &[f32]) -> Rules {
        let def = Rules::defaults(mode);
        let get = |i: usize, lo: f32, hi: f32, fallback: f32| d.get(i).copied().filter(|v| v.is_finite() && *v >= lo && *v <= hi).unwrap_or(fallback);
        let flag = |i: usize, fallback: bool| get(i, 0.0, 1.0, fallback as u32 as f32) >= 0.5;
        Rules {
            time_limit: get(0, 0.0, 3600.0, def.time_limit).round(),
            // The ladder always ends at its last rung.
            score_limit: if mode == MODE_LADDER { def.score_limit } else { get(1, 0.0, 10000.0, def.score_limit as f32) as u32 },
            respawn: get(2, 0.0, 30.0, def.respawn),
            health: get(3, 0.25, 4.0, def.health),
            friendly_fire: flag(4, def.friendly_fire),
            headshots_only: flag(5, def.headshots_only),
            abilities: flag(6, def.abilities),
            streaks: flag(7, def.streaks),
            start_round: get(8, 1.0, 100.0, def.start_round as f32) as u32,
            start_points: get(9, 0.0, 1_000_000.0, def.start_points as f32) as i32,
        }
    }
    pub fn to_floats(&self) -> [f32; RULES_LEN] {
        let b = |v: bool| v as u32 as f32;
        [self.time_limit, self.score_limit as f32, self.respawn, self.health, b(self.friendly_fire), b(self.headshots_only), b(self.abilities), b(self.streaks), self.start_round as f32, self.start_points as f32]
    }
}

/// Mode state that only the host simulates.
#[derive(Default)]
pub struct Obj {
    pub score: [i32; 2],
    /// Open floor where players can spawn and objectives can sit.
    pub spots: Vec<V3>,
    pub hill_spots: Vec<V3>,
    pub hill_at: usize,
    /// Seconds until the hill moves.
    pub hill_t: f32,
    /// Scoring accumulators.
    pub tick: f32,
}

/// A zone's owner, progress and whether both teams are standing in it, as one exact number.
pub fn pack_zone(owner: i32, prog: f32, contested: bool) -> f32 {
    ((owner.clamp(-1, 1) + 1) * 2 + contested as i32) as f32 * 4.0 + (prog.clamp(-1.0, 1.0) + 1.0)
}
pub fn unpack_zone(a: f32) -> (i32, f32, bool) {
    let q = (a / 4.0).floor();
    ((q as i32) / 2 - 1, a - q * 4.0 - 1.0, (q as i32) % 2 == 1)
}

impl Game {
    pub fn pvp(&self) -> bool {
        self.mode != MODE_SURVIVAL
    }
    pub fn teams(&self) -> bool {
        matches!(self.mode, MODE_TDM | MODE_DOMINATION | MODE_HILL | MODE_TAGS)
    }
    /// Whether slot `b` is on the other side from slot `a`.
    pub fn enemies(&self, a: usize, b: usize) -> bool {
        a != b && (!self.teams() || self.slots[a].p.team != self.slots[b].p.team)
    }
    /// Whether slot `a`'s attacks hurt slot `b`.
    pub fn hostile(&self, a: usize, b: usize) -> bool {
        a != b && (self.enemies(a, b) || self.rules.friendly_fire)
    }
    pub fn abilities_on(&self) -> bool {
        self.rules.abilities && self.mode != MODE_LADDER
    }
    pub fn streaks_on(&self) -> bool {
        self.pvp() && self.rules.streaks && self.mode != MODE_LADDER
    }

    pub fn set_rules(&mut self, r: Rules) {
        self.rules = r;
        self.score_limit = r.score_limit;
        if self.mode == MODE_SURVIVAL && self.phase == PH_WARMUP && self.sv.round < r.start_round {
            self.sv.round = r.start_round - 1;
        }
        // Players who joined before the rules arrived.
        for s in self.slots.iter_mut() {
            if self.mode == MODE_SURVIVAL && self.phase == PH_WARMUP {
                s.p.points = r.start_points;
            }
            if s.p.life == ALIVE {
                s.p.max_health = 100.0 * r.health;
                s.p.health = s.p.max_health;
            }
        }
    }

    /// Sets up objectives and spawn spots for a multiplayer map. Called once, from `Game::new`.
    pub fn setup_mode(&mut self) {
        if !self.pvp() {
            return;
        }
        let nav = &self.map.world.nav;
        let flat = |c: usize| !nav.solid[c] && nav.door[c] == 0 && nav.height[c] == 0.0;
        // Open floor with a clear square around it.
        let mut spots = vec![];
        for c in 0..nav.w * nav.h {
            let (x, z) = ((c % nav.w) as i32, (c / nav.w) as i32);
            let clear = (-1..=1).all(|dz| (-1..=1).all(|dx| {
                let (nx, nz) = (x + dx, z + dz);
                nx >= 0 && nz >= 0 && (nx as usize) < nav.w && (nz as usize) < nav.h && flat(nz as usize * nav.w + nx as usize)
            }));
            if clear {
                let (cx, cz) = nav.center(c);
                spots.push(v3(cx, 0.0, cz));
            }
        }
        if spots.is_empty() {
            spots = self.map.spawns.clone();
        }
        let (w, d) = self.map.size;
        let near = |fx: f32, fz: f32| {
            let t = v3(w * fx, 0.0, d * fz);
            spots.iter().copied().min_by(|a, b| a.dist(t).total_cmp(&b.dist(t))).unwrap_or(t)
        };
        // Objectives run along the map's long side.
        let at = |along: f32, across: f32| if w >= d { near(along, across) } else { near(across, along) };
        match self.mode {
            MODE_DOMINATION => {
                for (k, along) in [0.15, 0.5, 0.85].into_iter().enumerate() {
                    self.ents.push(Ent { kind: E_ZONE + k as u8, pos: at(along, 0.5), vel: V3::ZERO, t: 1e9, owner: -1, a: 0.0 });
                }
            }
            MODE_HILL => {
                self.obj.hill_spots = vec![at(0.5, 0.5), at(0.25, 0.3), at(0.75, 0.7), at(0.75, 0.3), at(0.25, 0.7)];
                self.obj.hill_t = HILL_MOVE;
                let pos = self.obj.hill_spots[0];
                self.ents.push(Ent { kind: E_HILL, pos, vel: V3::ZERO, t: 1e9, owner: -1, a: 0.0 });
            }
            _ => {}
        }
        self.obj.spots = spots;
    }

    /// Where slot `i` should spawn: open floor away from enemies, on its own side in team modes.
    pub fn pvp_spawn_point(&mut self, i: usize) -> V3 {
        let enemies: Vec<V3> = (0..self.slots.len()).filter(|j| self.enemies(i, *j) && self.slots[*j].p.life == ALIVE).map(|j| self.slots[j].p.ctl.pos).collect();
        let (w, d) = self.map.size;
        let long = w >= d;
        let side = if self.teams() { Some(self.slots[i].p.team == 0) } else { None };
        let mut best = (f32::MIN, self.map.spawns.first().copied().unwrap_or(V3::ZERO));
        for k in 0..self.obj.spots.len() {
            let s = self.obj.spots[k];
            let danger = enemies.iter().map(|e| e.dist(s)).fold(f32::MAX, f32::min).min(30.0);
            let home = side.map_or(0.0, |first| {
                let along = if long { s.x / w } else { s.z / d };
                14.0 * if first { 1.0 - along } else { along }
            });
            let score = danger + home + self.rng.f() * 4.0;
            if score > best.0 {
                best = (score, s);
            }
        }
        best.1
    }

    /// Team for a joining player: as asked in team modes if it is a real team, else the smaller one.
    pub fn pick_team(&self, asked: i32) -> i32 {
        if !self.teams() {
            return asked;
        }
        if asked == 0 || asked == 1 {
            return asked;
        }
        let n0 = self.slots.iter().filter(|s| s.p.team == 0).count();
        let n1 = self.slots.iter().filter(|s| s.p.team == 1).count();
        (n1 < n0) as i32
    }

    /// Moves a player to the other team mid-match if that keeps the sides within one of each
    /// other. They leave the field and respawn with their new team after the usual delay.
    pub fn set_team(&mut self, id: i32, team: i32) -> bool {
        if !self.authority || !self.teams() || !(team == 0 || team == 1) || self.phase == PH_OVER {
            return false;
        }
        let Some(i) = self.idx(id) else { return false };
        let cur = self.slots[i].p.team;
        let count = |t: i32| self.slots.iter().filter(|s| s.p.team == t).count() as i32;
        if cur == team || count(team) + 1 - (count(cur) - 1) > 1 {
            return false;
        }
        let respawn = self.rules.respawn;
        let p = &mut self.slots[i].p;
        p.team = team;
        if p.life == ALIVE {
            p.life = DEAD;
            p.health = 0.0;
            p.respawn_t = respawn;
        }
        self.ev(EV_OBJ, &[OB_SWITCHED, id as f32, team as f32]);
        true
    }

    /// Bookkeeping when slot `j` dies to slot `by` (-1: the world) in a multiplayer match.
    pub fn on_pvp_death(&mut self, j: usize, by: i32, weapon: i32) {
        let victim = self.slots[j].p;
        if self.mode == MODE_TAGS {
            self.ents.push(Ent { kind: E_TAG + victim.team.clamp(0, 1) as u8, pos: victim.ctl.pos + v3(0.0, 0.6, 0.0), vel: V3::ZERO, t: TAG_LIFE, owner: victim.id, a: 0.0 });
        }
        let Some(k) = usize::try_from(by).ok().filter(|k| *k != j && *k < self.slots.len()) else { return };
        if !self.enemies(k, j) {
            return;
        }
        match self.mode {
            MODE_TDM => self.obj.score[self.slots[k].p.team.clamp(0, 1) as usize] += 1,
            MODE_LADDER => {
                self.ladder_step(k, 1);
                // A knife kill sends the victim down a rung.
                if weapon == -1 && victim.stage > 0 {
                    self.ladder_step(j, -1);
                }
            }
            _ => {}
        }
    }

    fn ladder_step(&mut self, i: usize, by: i32) {
        let p = &mut self.slots[i].p;
        p.stage = (p.stage + by).clamp(0, LADDER.len() as i32);
        if let Some(&w) = LADDER.get(p.stage as usize) {
            if p.life == ALIVE {
                p.arms.equip(0, Gun::new(w, 0));
                p.arms.guns[1] = Gun::NONE;
            }
        }
        let (id, stage) = (p.id as f32, p.stage as f32);
        self.ev(EV_OBJ, &[if by > 0 { OB_LADDER_UP } else { OB_LADDER_DOWN }, id, stage]);
    }

    /// Living players of each team within `r` of `pos` (and roughly at its height).
    fn present(&self, pos: V3, r: f32) -> [Vec<usize>; 2] {
        let mut out = [vec![], vec![]];
        for (i, s) in self.slots.iter().enumerate() {
            let q = s.p.ctl.pos;
            if s.p.life == ALIVE && (s.p.team == 0 || s.p.team == 1) && v3(q.x - pos.x, 0.0, q.z - pos.z).len() < r && (q.y - pos.y).abs() < 3.0 {
                out[s.p.team as usize].push(i);
            }
        }
        out
    }

    /// Objectives for one tick of a running match.
    pub fn mode_step(&mut self, dt: f32) {
        match self.mode {
            MODE_DOMINATION => self.zones_step(dt),
            MODE_HILL => self.hill_step(dt),
            MODE_TAGS => self.tags_step(),
            _ => {}
        }
    }

    fn zones_step(&mut self, dt: f32) {
        for n in 0..self.ents.len() {
            let e = self.ents[n];
            if !(E_ZONE..E_ZONE + 3).contains(&e.kind) {
                continue;
            }
            let zone = (e.kind - E_ZONE) as f32;
            let who = self.present(e.pos, ZONE_R);
            let contested = !who[0].is_empty() && !who[1].is_empty();
            let (mut owner, mut prog) = (e.owner, e.vel.x);
            if !contested && (!who[0].is_empty() || !who[1].is_empty()) {
                let team = if who[0].is_empty() { 1 } else { 0 };
                let n_in = who[team as usize].len().min(3) as f32;
                let dir = if team == 0 { -1.0 } else { 1.0 };
                prog = (prog + dir * (1.0 + 0.5 * (n_in - 1.0)) / CAPTURE_TIME * dt).clamp(-1.0, 1.0);
                if owner == 1 - team && prog * dir >= 0.0 {
                    owner = -1;
                    self.ev(EV_OBJ, &[OB_NEUTRAL, zone, team as f32]);
                }
                if prog * dir >= 1.0 && owner != team {
                    owner = team;
                    self.ev(EV_OBJ, &[OB_CAPTURED, zone, team as f32]);
                    for i in who[team as usize].clone() {
                        self.slots[i].p.objs += 1;
                        self.award(i, 150);
                    }
                }
            } else if who[0].is_empty() && who[1].is_empty() {
                // Left alone, a zone drifts back to whoever holds it (or back to neutral).
                let rest = match owner { 0 => -1.0, 1 => 1.0, _ => 0.0 };
                prog += (rest - prog).clamp(-0.1 * dt, 0.1 * dt);
            }
            let z = &mut self.ents[n];
            z.owner = owner;
            z.vel = v3(prog, contested as u32 as f32, 0.0);
        }
        self.obj.tick += dt;
        while self.obj.tick >= ZONE_TICK {
            self.obj.tick -= ZONE_TICK;
            for e in self.ents.iter().filter(|e| (E_ZONE..E_ZONE + 3).contains(&e.kind) && (e.owner == 0 || e.owner == 1)) {
                self.obj.score[e.owner as usize] += 1;
            }
        }
    }

    fn hill_step(&mut self, dt: f32) {
        let Some(n) = self.ents.iter().position(|e| e.kind == E_HILL) else { return };
        self.obj.hill_t -= dt;
        if self.obj.hill_t <= 0.0 && !self.obj.hill_spots.is_empty() {
            self.obj.hill_t = HILL_MOVE;
            self.obj.hill_at = (self.obj.hill_at + 1) % self.obj.hill_spots.len();
            self.ents[n].pos = self.obj.hill_spots[self.obj.hill_at];
            self.ev(EV_OBJ, &[OB_HILL_MOVED, self.obj.hill_at as f32]);
        }
        let who = self.present(self.ents[n].pos, HILL_R);
        let contested = !who[0].is_empty() && !who[1].is_empty();
        let holder = if contested || (who[0].is_empty() && who[1].is_empty()) { -1 } else if who[0].is_empty() { 1 } else { 0 };
        let h = &mut self.ents[n];
        h.owner = holder;
        h.vel = v3(if holder == 1 { 1.0 } else if holder == 0 { -1.0 } else { 0.0 }, contested as u32 as f32, 0.0);
        if holder < 0 {
            self.obj.tick = 0.0;
            return;
        }
        // One point a second while one team holds the hill alone.
        self.obj.tick += dt;
        while self.obj.tick >= 1.0 {
            self.obj.tick -= 1.0;
            self.obj.score[holder as usize] += 1;
            for i in who[holder as usize].clone() {
                self.slots[i].p.objs += 1;
                self.award(i, 10);
            }
        }
    }

    fn tags_step(&mut self) {
        let mut n = 0;
        while n < self.ents.len() {
            let e = self.ents[n];
            if e.kind != E_TAG && e.kind != E_TAG + 1 {
                n += 1;
                continue;
            }
            let tag_team = (e.kind - E_TAG) as i32;
            let taker = (0..self.slots.len()).find(|i| {
                let p = &self.slots[*i].p;
                p.life == ALIVE && (p.team == 0 || p.team == 1) && p.ctl.pos.dist(e.pos - v3(0.0, 0.6, 0.0)) < TAG_REACH + 0.6
            });
            let Some(i) = taker else {
                n += 1;
                continue;
            };
            let team = self.slots[i].p.team;
            let id = self.slots[i].p.id as f32;
            if team != tag_team {
                self.obj.score[team as usize] += 1;
                self.ev(EV_OBJ, &[OB_CONFIRMED, id, team as f32]);
            } else {
                self.ev(EV_OBJ, &[OB_DENIED, id, team as f32]);
            }
            self.slots[i].p.objs += 1;
            self.award(i, 50);
            self.ents.swap_remove(n);
        }
    }

    /// The match result once the score or time limit is reached: (winner id or -1, their score,
    /// winning team or -1, draw).
    pub fn pvp_result(&self) -> Option<(f32, f32, f32, bool)> {
        let limit = self.rules.score_limit;
        let timed_out = self.rules.time_limit > 0.0 && self.timer <= 0.0;
        if self.teams() {
            let [a, b] = self.obj.score;
            let reached = limit > 0 && (a as u32 >= limit || b as u32 >= limit);
            if !reached && !timed_out {
                return None;
            }
            let team = if a > b { 0.0 } else if b > a { 1.0 } else { -1.0 };
            return Some((-1.0, a.max(b) as f32, team, a == b));
        }
        let key = |p: &Player| if self.mode == MODE_LADDER { p.stage } else { p.kills };
        let top = self.slots.iter().map(|s| &s.p).max_by_key(|p| (key(p), -p.deaths))?;
        let reached = limit > 0 && key(top) as u32 >= limit;
        if !reached && !timed_out {
            return None;
        }
        let tied = self.slots.iter().filter(|s| key(&s.p) == key(top)).count() > 1;
        Some((top.id as f32, key(top) as f32, -1.0, tied && !reached))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::*;
    use crate::loadout::*;

    fn match_of(mode: u8, map: usize, players: &[(i32, i32)]) -> Game {
        let mut g = Game::new(map, mode, 3, true);
        g.local = -1;
        for &(id, team) in players {
            g.add_player(id, team, default_loadout());
        }
        g.phase = PH_ACTIVE;
        g.timer = g.rules.time_limit;
        for s in g.slots.iter_mut() {
            s.p.invuln_t = 0.0;
        }
        g
    }
    fn put(g: &mut Game, id: i32, pos: V3) {
        let i = g.idx(id).unwrap();
        g.slots[i].p.ctl.pos = pos;
        g.slots[i].p.ctl.vel = V3::ZERO;
    }
    fn obj_events(g: &Game, code: f32) -> usize {
        g.events.chunks(EV_STRIDE).filter(|e| e[0] == EV_OBJ as f32 && e[1] == code).count()
    }

    #[test]
    fn rules_are_clamped_and_round_trip() {
        let r = Rules { time_limit: 300.0, score_limit: 40, respawn: 5.0, health: 1.5, friendly_fire: true, headshots_only: true, abilities: false, streaks: false, start_round: 10, start_points: 5000 };
        assert_eq!(Rules::from_floats(MODE_TDM, &r.to_floats()), r);
        let bad = Rules::from_floats(MODE_TDM, &[f32::NAN, -5.0, 1e9, 99.0, 0.7, -1.0, f32::INFINITY, 0.2, 1000.0, -3.0]);
        let def = Rules::defaults(MODE_TDM);
        assert_eq!((bad.time_limit, bad.score_limit, bad.respawn, bad.health), (def.time_limit, def.score_limit, def.respawn, def.health));
        assert!(bad.friendly_fire && !bad.headshots_only && bad.abilities && !bad.streaks);
        assert_eq!((bad.start_round, bad.start_points), (1, 500));
        assert_eq!(Rules::from_floats(MODE_LADDER, &[0.0, 3.0]).score_limit, LADDER.len() as u32, "the ladder always has every rung");
        for a in [(-1, 0.0, false), (0, -1.0, false), (1, 1.0, true), (-1, 0.37, true), (0, -0.5, true)] {
            let (o, p, c) = unpack_zone(pack_zone(a.0, a.1, a.2));
            assert_eq!((o, c), (a.0, a.2));
            assert!((p - a.1).abs() < 1e-5);
        }
    }

    #[test]
    fn ladder_rungs_are_real_weapons_ending_on_the_pistol() {
        assert!(LADDER.iter().all(|w| weapon(*w).is_some_and(|d| d.class != C_SPECIAL)));
        let mut seen = LADDER.to_vec();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), LADDER.len(), "no repeats");
        assert_eq!(*LADDER.last().unwrap(), W_PISTOL);
    }

    #[test]
    fn spawns_spread_over_the_map_and_teams_start_on_their_own_side() {
        for map in 0..crate::maps::MAPS.len() {
            let mut g = match_of(MODE_TDM, map, &[(1, 0), (2, 1), (3, 0), (4, 1)]);
            assert!(g.obj.spots.len() > 40, "map {map}: {} spots", g.obj.spots.len());
            let (w, d) = g.map.size;
            let along = |p: V3| if w >= d { p.x / w } else { p.z / d };
            for s in 0..g.slots.len() {
                g.slots[s].p.life = DEAD;
            }
            for i in 0..4 {
                let at = g.pvp_spawn_point(i);
                let team = g.slots[i].p.team;
                assert!(if team == 0 { along(at) < 0.5 } else { along(at) > 0.5 }, "map {map}: team {team} spawned at {at:?}");
                assert!(!g.map.world.overlaps(&Aabb::feet(at + v3(0.0, 0.05, 0.0), RADIUS, HEIGHT)), "spawn inside geometry at {at:?}");
            }
        }
    }

    #[test]
    fn teams_are_balanced_and_friendly_fire_is_off_by_default() {
        let mut g = Game::new(0, MODE_TDM, 1, true);
        for id in 0..5 {
            g.add_player(id, -1, default_loadout());
        }
        let n0 = g.slots.iter().filter(|s| s.p.team == 0).count();
        assert!(n0 == 2 || n0 == 3, "auto-balanced: {n0} on team 0");
        let (a, b) = ((0..5).find(|i| g.slots[*i].p.team == 0).unwrap(), (0..5).filter(|i| g.slots[*i].p.team == 0).nth(1).unwrap());
        assert!(!g.hostile(a, b));
        g.slots[b].p.invuln_t = 0.0;
        g.phase = PH_ACTIVE;
        g.explode(g.slots[b].p.ctl.pos, 3.0, 0.0, 500.0, g.slots[a].p.id);
        assert_eq!(g.slots[b].p.life, ALIVE, "a teammate's grenade does not hurt");
        let mut r = g.rules;
        r.friendly_fire = true;
        g.set_rules(r);
        assert!(g.hostile(a, b));
        g.slots[b].p.invuln_t = 0.0;
        g.explode(g.slots[b].p.ctl.pos, 3.0, 0.0, 500.0, g.slots[a].p.id);
        assert_eq!(g.slots[b].p.life, DEAD, "with friendly fire on it does");
        assert_eq!(g.obj.score, [0, 0], "team kills never score");
        assert_eq!(g.slots[a].p.kills, 0);
    }

    #[test]
    fn players_can_change_sides_mid_match_if_it_stays_fair() {
        let mut g = match_of(MODE_TDM, 1, &[(1, 0), (2, 0), (3, 1)]);
        assert!(!g.set_team(3, 0), "3 v 0 is refused");
        assert!(g.set_team(1, 1), "2 v 1 becomes 1 v 2");
        assert_eq!((g.slots[0].p.team, g.slots[0].p.life, g.slots[0].p.deaths), (1, DEAD, 0));
        assert!(!g.set_team(1, 1), "already there");
        assert!(!g.set_team(1, 5) && !g.set_team(99, 0));
        for _ in 0..(4.0 * 60.0) as usize {
            g.step(1.0 / 60.0);
        }
        assert_eq!(g.slots[0].p.life, ALIVE, "back in with the new team");
        assert_eq!(obj_events(&g, OB_SWITCHED), 1);
        let mut ffa = match_of(MODE_SKIRMISH, 1, &[(1, 1), (2, 2)]);
        assert!(!ffa.set_team(1, 0), "no teams in free-for-all");
    }

    #[test]
    fn team_deathmatch_counts_kills_to_the_limit() {
        let mut g = match_of(MODE_TDM, 1, &[(1, 0), (2, 1)]);
        let mut r = g.rules;
        r.score_limit = 3;
        g.set_rules(r);
        for _ in 0..3 {
            g.slots[1].p.invuln_t = 0.0;
            assert!(g.damage_player(1, 1000.0, 0, 3, false, V3::ZERO));
            g.slots[1].p.life = ALIVE;
            g.slots[1].p.health = 100.0;
        }
        assert_eq!(g.obj.score, [3, 0]);
        g.step(1.0 / 60.0);
        assert_eq!(g.phase, PH_OVER);
        let over = g.events.chunks(EV_STRIDE).find(|e| e[0] == EV_GAMEOVER as f32).unwrap();
        assert_eq!((over[3], over[4]), (0.0, 0.0), "team 0 wins, no draw");
        assert_eq!(g.header().score_a, 3);
    }

    #[test]
    fn domination_zones_capture_neutralise_and_score() {
        let mut g = match_of(MODE_DOMINATION, 0, &[(1, 0), (2, 1)]);
        let zones: Vec<V3> = g.ents.iter().filter(|e| (E_ZONE..E_ZONE + 3).contains(&e.kind)).map(|e| e.pos).collect();
        assert_eq!(zones.len(), 3);
        assert!(zones[0].dist(zones[1]) > 10.0 && zones[1].dist(zones[2]) > 10.0, "spread out: {zones:?}");
        let zone = |g: &Game, k: u8| *g.ents.iter().find(|e| e.kind == E_ZONE + k).unwrap();
        put(&mut g, 1, zones[0]);
        put(&mut g, 2, zones[2] + v3(30.0, 0.0, 0.0)); // well away
        for _ in 0..(4.0 * 60.0) as usize {
            g.mode_step(1.0 / 60.0);
        }
        assert_eq!(zone(&g, 0).owner, -1, "not yet: five seconds alone");
        for _ in 0..(1.5 * 60.0) as usize {
            g.mode_step(1.0 / 60.0);
        }
        assert_eq!(zone(&g, 0).owner, 0, "taken after five seconds");
        assert_eq!(obj_events(&g, OB_CAPTURED), 1);
        assert_eq!(g.slots[0].p.objs, 1);
        // Both teams on it: contested, nothing moves.
        put(&mut g, 2, zones[0] + v3(1.0, 0.0, 0.0));
        for _ in 0..120 {
            g.mode_step(1.0 / 60.0);
        }
        assert_eq!(zone(&g, 0).owner, 0);
        assert_eq!(unpack_zone(pack_zone(zone(&g, 0).owner, zone(&g, 0).vel.x, zone(&g, 0).vel.y > 0.5)).2, true);
        // Team 1 alone: neutralises (5 s), then takes it (5 s more).
        put(&mut g, 1, zones[2]);
        let before = g.obj.score[0];
        for _ in 0..(5.5 * 60.0) as usize {
            g.mode_step(1.0 / 60.0);
        }
        assert_eq!(zone(&g, 0).owner, -1);
        assert_eq!(obj_events(&g, OB_NEUTRAL), 1);
        assert!(g.obj.score[0] > before, "points while it was held");
        for _ in 0..(5.0 * 60.0) as usize {
            g.mode_step(1.0 / 60.0);
        }
        assert_eq!(zone(&g, 0).owner, 1);
        // Team 1 now holds A, and team 0 took C meanwhile? No: team 0's player stood on C.
        assert_eq!(zone(&g, 2).owner, 0);
    }

    #[test]
    fn hill_scores_for_a_lone_team_and_moves() {
        let mut g = match_of(MODE_HILL, 1, &[(1, 0), (2, 1)]);
        let hill = |g: &Game| *g.ents.iter().find(|e| e.kind == E_HILL).unwrap();
        let first = hill(&g).pos;
        put(&mut g, 1, first);
        put(&mut g, 2, first + v3(20.0, 0.0, 0.0));
        for _ in 0..(10.0 * 60.0) as usize + 2 {
            g.mode_step(1.0 / 60.0);
        }
        assert_eq!(g.obj.score, [10, 0]);
        assert_eq!(hill(&g).owner, 0);
        put(&mut g, 2, first + v3(1.0, 0.0, 1.0));
        for _ in 0..(5.0 * 60.0) as usize {
            g.mode_step(1.0 / 60.0);
        }
        assert_eq!(g.obj.score, [10, 0], "contested: no points");
        for _ in 0..(50.0 * 60.0) as usize {
            g.mode_step(1.0 / 60.0);
        }
        assert!(hill(&g).pos.dist(first) > 5.0, "the hill moved after a minute");
        assert_eq!(obj_events(&g, OB_HILL_MOVED), 1);
    }

    #[test]
    fn tags_are_confirmed_by_enemies_and_denied_by_friends() {
        let mut g = match_of(MODE_TAGS, 1, &[(1, 0), (2, 1), (3, 1)]);
        let spot = g.obj.spots[g.obj.spots.len() / 2];
        let far = g.obj.spots[0];
        put(&mut g, 1, far);
        put(&mut g, 3, far + v3(0.0, 0.0, 3.0));
        put(&mut g, 2, spot);
        assert!(g.damage_player(1, 1000.0, 0, 3, false, V3::ZERO), "player 1 kills player 2");
        assert_eq!(g.obj.score, [0, 0], "a kill alone scores nothing");
        assert_eq!(g.ents.iter().filter(|e| e.kind == E_TAG + 1).count(), 1);
        put(&mut g, 1, spot);
        g.mode_step(1.0 / 60.0);
        assert_eq!(g.obj.score, [1, 0], "confirmed");
        assert_eq!(obj_events(&g, OB_CONFIRMED), 1);
        // Player 2 (back alive) kills player 1; player 3, 1's enemy, denies... no: 3 is on team 1
        // like the killer, so 3 picking up 1's tag confirms it for team 1.
        g.slots[1].p.life = ALIVE;
        g.slots[0].p.invuln_t = 0.0;
        assert!(g.damage_player(0, 1000.0, 1, 3, false, V3::ZERO));
        let at = g.slots[0].p.ctl.pos;
        put(&mut g, 3, at);
        g.mode_step(1.0 / 60.0);
        assert_eq!(g.obj.score, [1, 1]);
        // A tag picked up by the victim's own team is denied.
        g.slots[0].p.life = ALIVE;
        g.slots[2].p.invuln_t = 0.0;
        put(&mut g, 3, far);
        assert!(g.damage_player(2, 1000.0, 0, 3, false, V3::ZERO), "player 1 kills player 3");
        let at = g.slots[2].p.ctl.pos;
        put(&mut g, 2, at);
        g.slots[1].p.life = ALIVE;
        g.mode_step(1.0 / 60.0);
        assert_eq!(g.obj.score, [1, 1], "denied: no point");
        assert_eq!(obj_events(&g, OB_DENIED), 1);
    }

    #[test]
    fn weapon_ladder_moves_up_on_kills_and_down_on_knife_deaths() {
        let mut g = match_of(MODE_LADDER, 1, &[(1, 1), (2, 2)]);
        assert_eq!(g.slots[0].p.arms.gun().id, LADDER[0]);
        assert_eq!(g.slots[0].p.arms.guns[1].id, -1, "only the ladder weapon");
        assert!(g.slots[0].p.ability < 0, "no abilities on the ladder");
        for rung in 1..4 {
            g.slots[1].p.invuln_t = 0.0;
            g.slots[1].p.life = ALIVE;
            g.slots[1].p.health = 100.0;
            assert!(g.damage_player(1, 1000.0, 0, LADDER[rung - 1], false, V3::ZERO));
            assert_eq!(g.slots[0].p.stage, rung as i32);
            assert_eq!(g.slots[0].p.arms.gun().id, LADDER[rung]);
        }
        // Knifed: down a rung.
        g.slots[0].p.invuln_t = 0.0;
        g.slots[1].p.life = ALIVE;
        assert!(g.damage_player(0, 1000.0, 1, -1, false, V3::ZERO));
        assert_eq!(g.slots[0].p.stage, 2);
        // Last rung wins.
        g.slots[0].p.life = ALIVE;
        g.slots[0].p.stage = LADDER.len() as i32 - 1;
        g.slots[1].p.invuln_t = 0.0;
        g.slots[1].p.life = ALIVE;
        g.slots[1].p.health = 100.0;
        assert!(g.damage_player(1, 1000.0, 0, W_PISTOL, false, V3::ZERO));
        g.step(1.0 / 60.0);
        assert_eq!(g.phase, PH_OVER);
        let over = g.events.chunks(EV_STRIDE).find(|e| e[0] == EV_GAMEOVER as f32).unwrap();
        assert_eq!(over[1], 1.0, "player 1 finished the ladder");
    }

    #[test]
    fn match_rules_apply() {
        // Health and respawn delay.
        let mut g = match_of(MODE_SKIRMISH, 1, &[(1, 1), (2, 2)]);
        let mut r = g.rules;
        r.health = 2.0;
        r.respawn = 8.0;
        r.headshots_only = true;
        r.streaks = false;
        g.set_rules(r);
        assert_eq!(g.slots[1].p.max_health, 200.0);
        g.slots[1].p.invuln_t = 0.0;
        g.explode(g.slots[1].p.ctl.pos, 4.0, 0.0, 500.0, 1);
        assert_eq!(g.slots[1].p.health, 200.0, "headshots only: explosives do not hurt players");
        assert!(g.damage_player(1, 1000.0, 0, 3, false, V3::ZERO));
        assert_eq!(g.slots[1].p.respawn_t, 8.0);
        for _ in 0..(7.0 * 60.0) as usize {
            g.step(1.0 / 60.0);
        }
        assert_eq!(g.slots[1].p.life, DEAD, "still waiting");
        for _ in 0..(1.5 * 60.0) as usize {
            g.step(1.0 / 60.0);
        }
        assert_eq!(g.slots[1].p.life, ALIVE);
        assert!(!g.streaks_on());
        // No time limit: the match runs on.
        let mut g = match_of(MODE_SKIRMISH, 1, &[(1, 1)]);
        let mut r = g.rules;
        r.time_limit = 0.0;
        g.set_rules(r);
        g.timer = -1.0;
        for _ in 0..600 {
            g.step(0.1);
        }
        assert_eq!(g.phase, PH_ACTIVE);
        // Survival start round and points.
        let mut g = Game::new(0, MODE_SURVIVAL, 1, true);
        let mut r = Rules::defaults(MODE_SURVIVAL);
        r.start_round = 10;
        r.start_points = 2500;
        g.set_rules(r);
        g.add_player(0, 0, default_loadout());
        assert_eq!(g.slots[0].p.points, 2500);
        for _ in 0..(8.0 * 60.0) as usize {
            g.step(1.0 / 60.0);
        }
        assert_eq!(g.sv.round, 10);
    }
}
