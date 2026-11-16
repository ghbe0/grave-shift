//! Round-based survival: health scaling, spawn queue and horde cap, zombie AI on the nav grid,
//! the points economy (doors, wall-buys, perks, crate, upgrade bench, tonics), barricades,
//! power-ups, downs/revives and the quest engine.
use crate::arms::*;
use crate::catalog::*;
use crate::controller::HEIGHT;
use crate::game::*;
use crate::loadout::L_TONIC;
use crate::maps::*;
use crate::math::*;

/// Zombie health for a round: linear through round 9, then 10% compounding.
pub fn zombie_health(round: u32) -> f32 {
    let r = round.max(1);
    if r < 10 { 150.0 + 100.0 * (r - 1) as f32 } else { 950.0 * 1.1f32.powi(r as i32 - 9) }
}
/// Zombies spawned over a whole round.
pub fn zombie_count(round: u32, players: u32) -> u32 {
    let r = round.max(1) as f32 - 1.0;
    let base = 6.0 + 2.2 * r + 0.18 * r * r;
    ((base * (1.0 + 0.5 * (players.max(1) - 1) as f32)).round() as u32).min(400)
}
/// Most zombies alive at once: 24 solo, more with friends.
pub fn horde_cap(players: u32) -> u32 {
    (24 + 6 * (players.max(1) - 1)).min(42)
}
pub const PTS_HIT: i32 = 10;
pub const PTS_KILL: i32 = 60;
pub const PTS_HEADSHOT: i32 = 100;
pub const PTS_MELEE: i32 = 130;

const BREAK_TIME: f32 = 8.0;
const USE_RANGE: f32 = 2.3;
const REVIVE_TIME: f32 = 3.0;

impl Game {
    /// True while a quest is waiting for the relay targets to be shot.
    pub fn relays_live(&self) -> bool {
        self.mode == MODE_SURVIVAL && self.map.def.quests.iter().enumerate().any(|(n, q)| matches!(q.steps.get(self.sv.quest[n].0), Some((Step::Shoot { .. }, _))))
    }

    /// Applies damage to a zombie and pays out the kill. `by` is a slot index or -1.
    pub fn damage_zombie(&mut self, id: i32, dmg: f32, by: i32, head: bool, melee: bool, at: V3) {
        let insta = self.sv.insta_t > 0.0;
        let Some(z) = self.sv.zombies.iter_mut().find(|z| z.id == id && z.state != Z_DEAD) else { return };
        z.hp -= if insta && by >= 0 { z.max_hp } else { dmg };
        let killed = z.hp <= 0.0;
        let (pos, turned) = (z.pos, z.state == Z_TURNED);
        if killed {
            z.state = Z_DEAD;
            z.t = 0.0;
        }
        let shooter = if by >= 0 { self.slots[by as usize].p.id as f32 } else { -1.0 };
        if by >= 0 {
            self.ev(EV_HIT, &[shooter, 0.0, head as u32 as f32, killed as u32 as f32, at.x, at.y, at.z]);
        }
        if !killed {
            return;
        }
        self.ev(EV_ZDEATH, &[id as f32, pos.x, pos.y, pos.z, head as u32 as f32, shooter]);
        if turned {
            return;
        }
        if by >= 0 {
            let i = by as usize;
            self.award(i, if melee { PTS_MELEE } else if head { PTS_HEADSHOT } else { PTS_KILL });
            let p = &mut self.slots[i].p;
            p.kills += 1;
            p.headshots += head as i32;
        }
        let zone = self.map.zone_of(pos);
        for n in 0..self.map.def.quests.len() {
            if let Some((Step::Kills { zone: want, .. }, _)) = self.map.def.quests[n].steps.get(self.sv.quest[n].0) {
                if *want as i32 == zone {
                    self.sv.quest[n].1 += 1.0;
                }
            }
        }
        // Power-up drops: rare, capped per round, never outside the playable area.
        if self.sv.drops < 4 && zone >= 0 && self.rng.chance(0.035) {
            self.sv.drops += 1;
            let kind = self.rng.range(POWERUPS.len()) as u8;
            self.drop_powerup(kind, pos);
        }
    }

    pub fn drop_powerup(&mut self, kind: u8, pos: V3) {
        self.ents.push(Ent { kind: E_POWERUP + kind, pos: v3(pos.x, pos.y + 0.9, pos.z), vel: V3::ZERO, t: 25.0, owner: -1, a: 0.0 });
        self.ev(EV_POWERUP, &[kind as f32, pos.x, pos.y, pos.z, 0.0]);
    }

    /// Re-upgraded weapons roll one of five on-hit effects, on a shared cooldown.
    pub fn proc_mod(&mut self, i: usize, gun: &Gun, zid: i32, at: V3) {
        if gun.modi == 0 || self.slots[i].mod_cd > 0.0 || !self.rng.chance(0.3) {
            return;
        }
        self.slots[i].mod_cd = 10.0;
        let pid = self.slots[i].p.id;
        let near = |g: &Game, r: f32| -> Vec<i32> { g.sv.zombies.iter().filter(|z| z.state != Z_DEAD && z.state != Z_TURNED && z.pos.dist(at) < r).map(|z| z.id).collect() };
        match gun.modi {
            1 => {
                // Arc Chain: lightning jumps through the pack.
                for id in near(self, 6.0).into_iter().take(6) {
                    self.damage_zombie(id, 1e7, i as i32, false, false, at);
                }
            }
            2 => self.ents.push(Ent { kind: E_CINDER, pos: at, vel: V3::ZERO, t: 4.0, owner: pid, a: 0.0 }),
            3 => {
                // Shockwave: everything close is thrown down.
                self.ev(EV_EXPLODE, &[at.x, at.y, at.z, 5.0, 1.0]);
                for id in near(self, 5.0) {
                    self.damage_zombie(id, 1e7, i as i32, false, false, at);
                }
            }
            4 => {
                // Turncoat: the target fights for you for a while.
                if let Some(z) = self.sv.zombies.iter_mut().find(|z| z.id == zid && z.state != Z_DEAD) {
                    z.state = Z_TURNED;
                    z.turned_t = 20.0;
                    z.hp = z.max_hp;
                }
            }
            _ => self.ents.push(Ent { kind: E_STARBURST, pos: at, vel: V3::ZERO, t: 4.0, owner: pid, a: 0.0 }),
        }
    }

    fn pay(&mut self, i: usize, cost: u32) -> bool {
        let p = &mut self.slots[i].p;
        if p.points < cost as i32 {
            let id = p.id as f32;
            self.ev(EV_MSG, &[MSG_POOR, id, cost as f32]);
            return false;
        }
        p.points -= cost as i32;
        true
    }

    fn quest_step(&self, n: usize) -> Option<Step> {
        self.map.def.quests.get(n).and_then(|q| q.steps.get(self.sv.quest[n].0)).map(|s| s.0)
    }
    fn wants_use(&self, kind: u8) -> bool {
        (0..2).any(|n| matches!(self.quest_step(n), Some(Step::Use { kind: k }) if k == kind))
    }

    /// What the player would interact with right now: (kind, id, cost). Negative costs are
    /// reasons it is unavailable: -2 needs power, -3 limit reached.
    fn find_prompt(&self, i: usize) -> (u8, i32, i32) {
        let s = &self.slots[i];
        let p = &s.p;
        if p.life != ALIVE || self.mode != MODE_SURVIVAL {
            return (0, -1, 0);
        }
        if let Some(o) = self.slots.iter().find(|o| o.p.life == DOWN && o.p.id != p.id && o.p.ctl.pos.dist(p.ctl.pos) < USE_RANGE) {
            return (I_REVIVE, o.p.id, 0);
        }
        let mut best: Option<(f32, usize)> = None;
        for (k, it) in self.map.inter.iter().enumerate() {
            let d = v3(it.pos.x - p.ctl.pos.x, 0.0, it.pos.z - p.ctl.pos.z).len();
            let reach = if it.kind == I_PART { 1.6 } else { USE_RANGE };
            if it.active && d < reach && (it.pos.y - p.ctl.pos.y).abs() < 2.5 && best.map_or(true, |b| d < b.0) && self.prompt_cost(i, k).is_some() {
                best = Some((d, k));
            }
        }
        best.map_or((0, -1, 0), |(_, k)| (self.map.inter[k].kind, k as i32, self.prompt_cost(i, k).unwrap_or(0)))
    }

    fn prompt_cost(&self, i: usize, k: usize) -> Option<i32> {
        let it = &self.map.inter[k];
        let s = &self.slots[i];
        let p = &s.p;
        let gun = p.arms.gun();
        let powered = !it.needs_power || self.sv.power;
        Some(match it.kind {
            I_DOOR if self.sv.doors & (1 << it.param) == 0 => it.cost as i32,
            I_WALLBUY => match p.arms.guns.iter().take(2).find(|g| g.id == it.param) {
                Some(g) => if g.tier > 0 { 4500 } else { (it.cost / 2).max(250) as i32 },
                None => it.cost as i32,
            },
            I_PERK if p.perks & (1 << it.param) == 0 => {
                if !powered {
                    -2
                } else if p.perks.count_ones() >= PERK_LIMIT {
                    -3
                } else if it.param == 3 && self.solo() {
                    500
                } else {
                    it.cost as i32
                }
            }
            I_CRATE if k == self.sv.crate_at => match self.sv.crate_state {
                0 => it.cost as i32,
                2 if self.sv.crate_owner == p.id => 0,
                _ => return None,
            },
            I_BENCH if weapon(gun.id).map_or(false, |d| d.flags & WF_ABILITY == 0) => {
                if !powered { -2 } else if gun.tier == 0 { UPGRADE_COST as i32 } else { REROLL_COST as i32 }
            }
            I_TONIC => if s.tonic_buys >= 3 { -3 } else { (TONIC_COST * (1 + s.tonic_buys)) as i32 },
            I_POWER if !self.sv.power => 0,
            I_WORKBENCH if self.wants_use(I_WORKBENCH) => 0,
            I_WORKBENCH if self.sv.shield_built && p.shield <= 0.0 => SHIELD_COST as i32,
            I_PART => 0,
            I_CONSOLE if self.wants_use(I_CONSOLE) => if powered { 0 } else { -2 },
            I_BARRICADE if self.map.barrs[it.param as usize].boards < BOARDS => 0,
            _ => return None,
        })
    }

    pub fn use_press(&mut self, i: usize) {
        let (kind, id, cost) = self.find_prompt(i);
        if kind == 0 || kind == I_REVIVE || kind == I_BARRICADE {
            return;
        }
        let pid = self.slots[i].p.id as f32;
        if cost < 0 {
            self.ev(EV_MSG, &[if cost == -2 { MSG_NO_POWER } else { MSG_PERK_LIMIT }, pid]);
            return;
        }
        if !self.pay(i, cost as u32) {
            return;
        }
        let k = id as usize;
        let it = self.map.inter[k];
        match kind {
            I_DOOR => {
                let mask = self.sv.doors | (1 << it.param);
                self.set_doors(mask);
                self.sv.flow_t = 0.0;
                self.ev(EV_DOOR, &[it.param as f32]);
            }
            I_WALLBUY => {
                let p = &mut self.slots[i].p;
                if let Some(g) = p.arms.guns.iter_mut().take(2).find(|g| g.id == it.param) {
                    if let Some(st) = g.stats(&Combat::default()) {
                        g.reserve = st.reserve;
                    }
                } else {
                    self.give_weapon(i, it.param);
                }
            }
            I_PERK => self.slots[i].p.perks |= 1 << it.param,
            I_CRATE => {
                if self.sv.crate_state == 2 {
                    let w = self.sv.crate_weapon;
                    self.give_weapon(i, w);
                    self.sv.crate_state = 0;
                } else {
                    self.sv.crate_state = 1;
                    self.sv.crate_t = 3.5;
                    self.sv.crate_owner = self.slots[i].p.id;
                    self.sv.crate_uses += 1;
                    self.ev(EV_CRATE, &[1.0, -1.0, k as f32, pid]);
                }
            }
            I_BENCH => {
                let roll = 1 + self.rng.range(MODS.len() - 1) as u8;
                let g = self.slots[i].p.arms.gun_mut();
                if g.tier == 0 {
                    g.tier = 1;
                } else {
                    // Re-upgrading always changes the effect.
                    g.modi = if roll == g.modi { roll % (MODS.len() as u8 - 1) + 1 } else { roll };
                }
                if let Some(st) = g.stats(&Combat::default()) {
                    g.ammo = st.mag;
                    g.reserve = st.reserve;
                }
            }
            I_TONIC => self.draw_tonic(i),
            I_POWER => {
                self.sv.power = true;
                self.ev(EV_POWER, &[]);
            }
            I_WORKBENCH => {
                if self.wants_use(I_WORKBENCH) {
                    self.quest_use(I_WORKBENCH);
                } else {
                    self.slots[i].p.shield = 3.0;
                }
            }
            I_PART => {
                self.map.inter[k].active = false;
                self.sv.parts |= 1 << it.param;
            }
            I_CONSOLE => self.quest_use(I_CONSOLE),
            _ => {}
        }
        self.ev(EV_BUY, &[pid, kind as f32, it.param as f32, cost as f32]);
    }

    /// Puts a weapon in an empty slot, or replaces the one in hand.
    pub fn give_weapon(&mut self, i: usize, id: i32) {
        let a = &mut self.slots[i].p.arms;
        if a.guns.iter().take(2).any(|g| g.id == id) {
            return;
        }
        let slot = a.guns.iter().take(2).position(|g| g.id < 0).unwrap_or(if a.cur < 2 { a.cur as usize } else { 0 });
        a.equip(slot, Gun::new(id, 0));
    }

    /// Hold interactions: reviving a teammate and rebuilding barricades.
    pub fn use_hold(&mut self, i: usize, dt: f32) {
        let (kind, id, _) = self.find_prompt(i);
        if kind == I_REVIVE {
            let fast = self.slots[i].p.perks & SP_SECOND != 0;
            if let Some(j) = self.idx(id) {
                self.slots[j].p.revive_t += dt * if fast { 4.0 } else { 2.0 } / REVIVE_TIME;
                if self.slots[j].p.revive_t >= 1.0 {
                    self.revive(j, self.slots[i].p.id);
                    self.award(i, 100);
                }
            }
        } else if kind == I_BARRICADE {
            let b = self.map.inter[id as usize].param as usize;
            let blocked = self.sv.zombies.iter().any(|z| z.state != Z_DEAD && z.pos.dist(self.map.barrs[b].pos) < 1.6);
            let s = &mut self.slots[i];
            s.p.revive_t += dt;
            if s.p.revive_t >= 0.7 && !blocked {
                s.p.revive_t = 0.0;
                self.map.barrs[b].boards += 1;
                let boards = self.map.barrs[b].boards as f32;
                if self.slots[i].rebuilt < 10 {
                    self.slots[i].rebuilt += 1;
                    self.award(i, 10);
                }
                self.ev(EV_BARR, &[b as f32, boards]);
            }
        }
    }

    fn revive(&mut self, j: usize, by: i32) {
        let p = &mut self.slots[j].p;
        p.life = ALIVE;
        p.health = p.max_health;
        p.invuln_t = 2.5;
        p.revive_t = 0.0;
        p.self_revive = 0.0;
        let id = p.id as f32;
        self.ev(EV_REVIVE, &[id, by as f32]);
    }

    /// Tonic dispenser: draws from the player's five-tonic pack; rare tonics come up less often.
    fn draw_tonic(&mut self, i: usize) {
        let pack: Vec<i32> = self.slots[i].loadout[L_TONIC..L_TONIC + 5].iter().copied().filter(|t| *t >= 0).collect();
        if pack.is_empty() {
            return;
        }
        let weight = |t: i32| if TONICS[t as usize].rare { 0.4 } else { 1.0 };
        let total: f32 = pack.iter().map(|t| weight(*t)).sum();
        let mut roll = self.rng.f() * total;
        let mut pick = pack[0];
        for t in &pack {
            pick = *t;
            roll -= weight(*t);
            if roll <= 0.0 {
                break;
            }
        }
        let def = &TONICS[pick as usize];
        let s = &mut self.slots[i];
        s.tonic_buys += 1;
        let (pid, pos) = (s.p.id as f32, s.p.ctl.pos);
        if def.kind == TN_INSTANT {
            self.drop_powerup(0, pos);
        } else {
            s.p.tonic = pick;
            s.p.tonic_left = def.amount;
            s.p.tonic_on = def.kind != TN_ACTIVATED;
        }
        self.ev(EV_TONIC, &[pid, pick as f32, 0.0]);
    }

    pub fn use_tonic(&mut self, i: usize) {
        let spawn = self.map.spawns[0];
        let p = &mut self.slots[i].p;
        if p.tonic < 0 || p.life != ALIVE || TONICS[p.tonic as usize].kind != TN_ACTIVATED {
            return;
        }
        let id = p.tonic;
        match id {
            T_PHASE => {
                p.ctl.pos = spawn;
                p.ctl.vel = V3::ZERO;
                p.invuln_t = 2.5;
            }
            _ => p.calm_t = 12.0,
        }
        p.tonic_left -= 1.0;
        if p.tonic_left <= 0.0 {
            p.tonic = -1;
        }
        let pid = p.id as f32;
        self.ev(EV_TONIC, &[pid, id as f32, 1.0]);
    }

    fn quest_use(&mut self, kind: u8) {
        for n in 0..2 {
            if matches!(self.quest_step(n), Some(Step::Use { kind: k }) if k == kind) {
                self.quest_advance(n);
            }
        }
    }
    fn quest_advance(&mut self, n: usize) {
        let q = &self.map.def.quests[n];
        self.sv.quest[n] = (self.sv.quest[n].0 + 1, 0.0);
        let done = self.sv.quest[n].0 >= q.steps.len();
        self.ev(EV_QUEST, &[n as f32, self.sv.quest[n].0 as f32, done as u32 as f32]);
        if !done {
            return;
        }
        match q.reward {
            Reward::Weapon(w) => {
                for i in 0..self.slots.len() {
                    if self.slots[i].p.life == ALIVE {
                        self.give_weapon(i, w);
                    }
                }
            }
            Reward::Shield => {
                self.sv.shield_built = true;
                self.slots.iter_mut().for_each(|s| s.p.shield = 3.0);
            }
            Reward::Points(pts) => self.slots.iter_mut().for_each(|s| s.p.points += pts as i32),
        }
        self.ev(EV_MSG, &[MSG_REWARD, -1.0, n as f32]);
    }

    /// Steps whose completion is a condition on world state are polled every tick.
    fn quest_poll(&mut self, dt: f32) {
        for n in 0..self.map.def.quests.len().min(2) {
            let Some(step) = self.quest_step(n) else { continue };
            let done = match step {
                Step::Power => self.sv.power,
                Step::Collect { tag, n: need } => {
                    let have = (self.sv.parts >> (tag * 8)) & 0xFF;
                    self.sv.quest[n].1 = have.count_ones() as f32;
                    have.count_ones() >= need
                }
                Step::Kills { n: need, .. } => self.sv.quest[n].1 >= need as f32,
                Step::Shoot { n: need } => {
                    let hit = self.map.targets.iter().filter(|t| t.1).count() as u32;
                    self.sv.quest[n].1 = hit as f32;
                    hit >= need
                }
                Step::Hold { zone, secs } => {
                    let alive: Vec<bool> = self.slots.iter().filter(|s| s.p.life == ALIVE).map(|s| self.map.zone_of(s.p.ctl.pos) == zone as i32).collect();
                    let inside = !alive.is_empty() && alive.iter().all(|b| *b);
                    let prog = &mut self.sv.quest[n].1;
                    *prog = if inside { *prog + dt } else { (*prog - dt * 2.0).max(0.0) };
                    *prog >= secs
                }
                Step::Round(r) => self.sv.round >= r,
                Step::Use { .. } => false,
            };
            if done {
                self.quest_advance(n);
            }
        }
    }

    fn start_round(&mut self) {
        self.sv.round += 1;
        let players = self.slots.len() as u32;
        self.sv.to_spawn = zombie_count(self.sv.round, players);
        self.sv.spawn_cd = 1.5;
        self.sv.drops = 0;
        self.phase = PH_ACTIVE;
        self.ev(EV_ROUND, &[self.sv.round as f32, 0.0]);
    }

    fn end_round(&mut self) {
        self.phase = PH_BREAK;
        self.timer = BREAK_TIME;
        self.ev(EV_ROUND, &[self.sv.round as f32, 1.0]);
        for i in 0..self.slots.len() {
            let s = &mut self.slots[i];
            s.tonic_buys = 0;
            s.rebuilt = 0;
            let p = &mut s.p;
            p.arms.lethal = (p.arms.lethal + 2.0).min(4.0);
            p.arms.tactical = (p.arms.tactical + 1.0).min(2.0);
            if p.tonic >= 0 && p.tonic_on && TONICS[p.tonic as usize].kind == TN_ROUNDS {
                p.tonic_left -= 1.0;
                if p.tonic_left <= 0.0 {
                    p.tonic = -1;
                    p.tonic_on = false;
                }
            }
            // Anyone who bled out comes back between rounds.
            if p.life == DEAD {
                let pts = p.points;
                self.spawn(i);
                self.slots[i].p.points = pts.max(1500);
            }
        }
    }

    fn spawn_zombie(&mut self) -> bool {
        let nav = &self.map.world.nav;
        let mut open: Vec<(f32, V3)> = self.map.zspawns.iter().filter_map(|z| nav.cell(z.x, z.z).map(|c| (nav.dist[c], *z))).filter(|c| c.0.is_finite()).collect();
        if open.is_empty() {
            return false;
        }
        // Favour the entrances closest to the players so pressure stays on.
        open.sort_by(|a, b| a.0.total_cmp(&b.0));
        open.truncate(6);
        let at = open[self.rng.range(open.len())].1;
        let r = self.sv.round as f32;
        let roll = self.rng.f();
        let kind = if roll < ((r - 7.0) / 10.0).clamp(0.0, 0.6) {
            2
        } else if roll < ((r - 2.0) / 6.0).clamp(0.0, 1.0) {
            1
        } else {
            0
        };
        let speed = [1.7, 4.0, 5.6][kind as usize] * (0.9 + 0.2 * self.rng.f());
        let hp = zombie_health(self.sv.round);
        let jitter = v3(self.rng.f() - 0.5, 0.0, self.rng.f() - 0.5);
        let id = self.sv.next_id;
        self.sv.next_id += 1;
        self.sv.zombies.push(Zombie { id, pos: at + jitter, yaw: 0.0, hp, max_hp: hp, state: Z_RISE, t: 1.0, speed, kind, target: -1, atk_cd: 0.0, slow_t: 0.0, turned_t: 0.0 });
        true
    }

    pub fn sv_step(&mut self, dt: f32) {
        if self.phase == PH_OVER {
            return;
        }
        self.sv.insta_t = (self.sv.insta_t - dt).max(0.0);
        self.sv.double_t = (self.sv.double_t - dt).max(0.0);

        // Flow field toward living players, refreshed a few times a second.
        self.sv.flow_t -= dt;
        if self.sv.flow_t <= 0.0 {
            self.sv.flow_t = 0.25;
            let doors = self.sv.doors;
            let nav = &self.map.world.nav;
            let pick = |want: u8| -> Vec<usize> {
                self.slots.iter().filter(|s| s.p.life == want && (want != ALIVE || s.p.calm_t <= 0.0)).filter_map(|s| nav.nearest(s.p.ctl.pos.x, s.p.ctl.pos.z, s.p.ctl.pos.y, doors)).collect()
            };
            let mut src = pick(ALIVE);
            if src.is_empty() {
                // Nobody to hunt (all downed or hidden): drift toward whoever is left.
                src = self.slots.iter().filter_map(|s| nav.nearest(s.p.ctl.pos.x, s.p.ctl.pos.z, s.p.ctl.pos.y, doors)).collect();
            }
            self.map.world.nav.flow(&src, doors);
        }

        match self.phase {
            PH_ACTIVE => {
                let alive = self.sv.zombies.iter().filter(|z| z.state != Z_DEAD && z.state != Z_TURNED).count() as u32;
                self.sv.spawn_cd -= dt;
                if self.sv.to_spawn > 0 && alive < horde_cap(self.slots.len() as u32) && self.sv.spawn_cd <= 0.0 && self.spawn_zombie() {
                    self.sv.to_spawn -= 1;
                    self.sv.spawn_cd = (2.0 * 0.93f32.powi(self.sv.round as i32 - 1)).max(0.2);
                }
                if self.sv.to_spawn == 0 && alive == 0 {
                    self.end_round();
                }
            }
            _ => {
                self.timer -= dt;
                if self.timer <= 0.0 && !self.slots.is_empty() {
                    self.start_round();
                }
            }
        }

        self.tick_zombies(dt);
        self.tick_downs(dt);
        self.tick_crate(dt);
        self.tick_powerups();
        self.quest_poll(dt);

        for i in 0..self.slots.len() {
            let (kind, id, cost) = self.find_prompt(i);
            let p = &mut self.slots[i].p;
            if kind != I_BARRICADE && kind != I_REVIVE && p.life == ALIVE {
                p.revive_t = 0.0;
            }
            (p.prompt_kind, p.prompt_id, p.prompt_cost) = (kind, id, cost);
        }

        let standing = self.slots.iter().any(|s| s.p.life == ALIVE || (s.p.life == DOWN && s.p.self_revive > 0.0));
        if !standing && !self.slots.is_empty() && self.sv.round > 0 {
            self.phase = PH_OVER;
            self.ev(EV_GAMEOVER, &[-1.0, self.sv.round as f32]);
        }
    }

    fn tick_zombies(&mut self, dt: f32) {
        let doors = self.sv.doors;
        let targets: Vec<(usize, i32, V3)> = self.slots.iter().enumerate().filter(|(_, s)| s.p.life == ALIVE && s.p.calm_t <= 0.0).map(|(i, s)| (i, s.p.id, s.p.ctl.pos)).collect();
        for zi in 0..self.sv.zombies.len() {
            let mut z = self.sv.zombies[zi];
            z.slow_t = (z.slow_t - dt).max(0.0);
            z.atk_cd = (z.atk_cd - dt).max(0.0);
            let speed = z.speed * if z.slow_t > 0.0 { 0.35 } else { 1.0 };
            let mut go: Option<V3> = None;
            match z.state {
                Z_DEAD => z.t += dt,
                Z_RISE => {
                    z.t -= dt;
                    if z.t <= 0.0 {
                        z.state = Z_CHASE;
                    }
                }
                Z_TURNED => {
                    z.turned_t -= dt;
                    let prey = self.sv.zombies.iter().filter(|o| o.id != z.id && o.state != Z_DEAD && o.state != Z_TURNED && o.state != Z_RISE).min_by(|a, b| a.pos.dist(z.pos).total_cmp(&b.pos.dist(z.pos))).map(|o| (o.id, o.pos));
                    if z.turned_t <= 0.0 {
                        z.state = Z_DEAD;
                        z.t = 0.0;
                        self.ev(EV_ZDEATH, &[z.id as f32, z.pos.x, z.pos.y, z.pos.z, 0.0, -1.0]);
                    } else if let Some((pid, pp)) = prey {
                        if pp.dist(z.pos) < 1.4 {
                            if z.atk_cd <= 0.0 {
                                z.atk_cd = 0.8;
                                self.sv.zombies[zi] = z;
                                self.damage_zombie(pid, 1e7, -1, false, false, pp);
                                z = self.sv.zombies[zi];
                            }
                        } else {
                            go = Some(pp);
                        }
                    }
                }
                Z_ATTACK => {
                    z.t -= dt;
                    if z.t <= 0.0 {
                        z.state = Z_CHASE;
                        z.atk_cd = 0.9;
                        if let Some(&(i, pid, pp)) = targets.iter().find(|t| t.1 == z.target) {
                            if pp.flat().dist(z.pos.flat()) < 1.9 && (pp.y - z.pos.y).abs() < 1.9 {
                                self.zombie_hit(i, z.pos);
                                self.ev(EV_ZATTACK, &[z.id as f32, pid as f32]);
                            }
                        }
                    }
                }
                Z_TEAR => {
                    z.t -= dt;
                    let b = z.target as usize;
                    if self.map.barrs[b].boards == 0 {
                        z.state = Z_CHASE;
                    } else if z.t <= 0.0 {
                        z.t = 1.1;
                        self.map.barrs[b].boards -= 1;
                        let boards = self.map.barrs[b].boards as f32;
                        self.ev(EV_BARR, &[b as f32, boards]);
                    }
                }
                _ => {
                    let near = targets.iter().min_by(|a, b| a.2.dist(z.pos).total_cmp(&b.2.dist(z.pos)));
                    let nav = &self.map.world.nav;
                    let cell = nav.cell(z.pos.x, z.pos.z);
                    if let Some(&(_, pid, pp)) = near {
                        let flat = pp.flat().dist(z.pos.flat());
                        let level = (pp.y - z.pos.y).abs() < 1.7;
                        if flat < 1.3 && level && z.atk_cd <= 0.0 {
                            z.state = Z_ATTACK;
                            z.t = 0.45;
                            z.target = pid;
                        } else if flat < 2.5 && level {
                            go = Some(pp);
                        }
                    }
                    if z.state == Z_CHASE && go.is_none() {
                        if let Some(n) = cell.and_then(|c| nav.next(c, doors)) {
                            let barr = nav.barr[n];
                            if barr > 0 && cell.map_or(true, |c| nav.barr[c] == 0) && self.map.barrs[barr as usize - 1].boards > 0 {
                                z.state = Z_TEAR;
                                z.t = 1.1;
                                z.target = barr as i32 - 1;
                            } else {
                                let (x, zz) = nav.center(n);
                                go = Some(v3(x, 0.0, zz));
                            }
                        }
                    }
                }
            }
            if let Some(to) = go {
                let d = (to - z.pos).flat();
                if d.len() > 0.05 {
                    let dir = d.norm();
                    z.pos += dir * (speed * dt).min(d.len());
                    z.yaw = (-dir.x).atan2(-dir.z);
                }
            }
            if z.state != Z_DEAD {
                if let Some(c) = self.map.world.nav.cell(z.pos.x, z.pos.z).filter(|c| !self.map.world.nav.solid[*c]) {
                    z.pos.y = approach(z.pos.y, self.map.world.nav.height[c], 6.0 * dt);
                }
            }
            self.sv.zombies[zi] = z;
        }
        // Keep the horde from stacking on one spot.
        let n = self.sv.zombies.len();
        for a in 0..n {
            for b in a + 1..n {
                let (za, zb) = (self.sv.zombies[a], self.sv.zombies[b]);
                if za.state == Z_DEAD || zb.state == Z_DEAD {
                    continue;
                }
                let d = (za.pos - zb.pos).flat();
                let l = d.len();
                if l < 0.7 && l > 1e-4 {
                    let push = d * ((0.7 - l) * 0.5 / l);
                    for (idx, sign) in [(a, 1.0), (b, -1.0)] {
                        let np = self.sv.zombies[idx].pos + push * sign;
                        let nav = &self.map.world.nav;
                        if nav.cell(np.x, np.z).map_or(false, |c| !nav.solid[c] && nav.height[c] <= np.y + 0.7) {
                            self.sv.zombies[idx].pos = np;
                        }
                    }
                }
            }
        }
        self.sv.zombies.retain(|z| z.state != Z_DEAD || z.t < 0.1);
    }

    /// A zombie swipe. The Bulwark on your back soaks hits from behind.
    fn zombie_hit(&mut self, i: usize, from: V3) {
        let p = &mut self.slots[i].p;
        let to = (from - p.ctl.pos).flat().norm();
        let (sy, cy) = p.ctl.yaw.sin_cos();
        if p.shield > 0.0 && to.dot(v3(-sy, 0.0, -cy)) < -0.2 {
            p.shield -= 1.0;
            return;
        }
        self.damage_player(i, 34.0, -1, -1, false, from);
    }

    fn tick_downs(&mut self, dt: f32) {
        for j in 0..self.slots.len() {
            let p = &mut self.slots[j].p;
            if p.life != DOWN {
                continue;
            }
            if p.self_revive > 0.0 {
                p.revive_t += dt / 6.0;
                if p.revive_t >= 1.0 {
                    let id = p.id;
                    self.revive(j, id);
                }
                continue;
            }
            p.revive_t = (p.revive_t - dt / REVIVE_TIME).max(0.0);
            p.down_t -= dt;
            if p.down_t <= 0.0 {
                p.life = DEAD;
                let id = p.id as f32;
                self.ev(EV_PDEATH, &[id, -1.0, -1.0]);
            }
        }
    }

    fn tick_crate(&mut self, dt: f32) {
        if self.sv.crate_state == 0 {
            return;
        }
        self.sv.crate_t -= dt;
        if self.sv.crate_t > 0.0 {
            return;
        }
        let at = self.sv.crate_at;
        let locs: Vec<usize> = self.map.inter.iter().enumerate().filter(|(_, i)| i.kind == I_CRATE).map(|(k, _)| k).collect();
        match self.sv.crate_state {
            1 => {
                let owner = self.idx(self.sv.crate_owner);
                // After a few pulls the crate can come up empty, refund you and move.
                if self.sv.crate_uses >= 4 && locs.len() > 1 && self.rng.chance(0.3) {
                    self.sv.crate_state = 3;
                    self.sv.crate_t = 2.5;
                    if let Some(i) = owner {
                        self.slots[i].p.points += CRATE_COST as i32;
                    }
                    self.ev(EV_CRATE, &[3.0, -1.0, at as f32, self.sv.crate_owner as f32]);
                    return;
                }
                let owned: Vec<i32> = owner.map_or(vec![], |i| self.slots[i].p.arms.guns.iter().map(|g| g.id).collect());
                let pool: Vec<(i32, f32)> = WEAPONS.iter().enumerate().filter(|(id, w)| w.flags & WF_CRATE != 0 && !owned.contains(&(*id as i32))).map(|(id, w)| (id as i32, if w.flags & WF_WONDER != 0 { 0.25 } else { 1.0 })).collect();
                let mut roll = self.rng.f() * pool.iter().map(|p| p.1).sum::<f32>();
                let mut pick = pool[0].0;
                for (id, w) in pool {
                    pick = id;
                    roll -= w;
                    if roll <= 0.0 {
                        break;
                    }
                }
                self.sv.crate_weapon = pick;
                self.sv.crate_state = 2;
                self.sv.crate_t = 9.0;
                self.ev(EV_CRATE, &[2.0, pick as f32, at as f32, self.sv.crate_owner as f32]);
            }
            3 => {
                let cur = locs.iter().position(|k| *k == at).unwrap_or(0);
                let next = locs[(cur + 1 + self.rng.range(locs.len() - 1)) % locs.len()];
                self.map.inter[at].active = false;
                self.map.inter[next].active = true;
                self.sv.crate_at = next;
                self.sv.crate_uses = 0;
                self.sv.crate_state = 0;
                self.ev(EV_CRATE, &[0.0, -1.0, next as f32, -1.0]);
            }
            _ => self.sv.crate_state = 0,
        }
    }

    fn tick_powerups(&mut self) {
        let mut k = 0;
        while k < self.ents.len() {
            let e = self.ents[k];
            let taker = if e.kind >= E_POWERUP && e.kind < E_POWERUP + POWERUPS.len() as u8 {
                self.slots.iter().position(|s| s.p.life == ALIVE && (s.p.ctl.pos + v3(0.0, HEIGHT * 0.5, 0.0)).dist(e.pos) < 1.5)
            } else {
                None
            };
            let Some(_) = taker else {
                k += 1;
                continue;
            };
            self.ents.swap_remove(k);
            let kind = e.kind - E_POWERUP;
            self.ev(EV_POWERUP, &[kind as f32, e.pos.x, e.pos.y, e.pos.z, 1.0]);
            match kind {
                0 => (0..self.slots.len()).for_each(|i| self.resupply(i, 1.0)),
                1 => self.sv.insta_t = 30.0,
                2 => self.sv.double_t = 30.0,
                3 => {
                    let ids: Vec<(i32, V3)> = self.sv.zombies.iter().filter(|z| z.state != Z_DEAD).map(|z| (z.id, z.pos)).collect();
                    for (id, pos) in ids {
                        self.damage_zombie(id, 1e7, -1, false, false, pos);
                    }
                    (0..self.slots.len()).for_each(|i| self.award(i, 400));
                }
                _ => {
                    self.map.barrs.iter_mut().for_each(|b| b.boards = BOARDS);
                    for b in 0..self.map.barrs.len() {
                        self.ev(EV_BARR, &[b as f32, BOARDS as f32]);
                    }
                    (0..self.slots.len()).for_each(|i| self.award(i, 200));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::{B_USE, CMD_LEN};
    use crate::loadout::default_loadout;
    use crate::math::Aabb;

    #[test]
    fn health_follows_the_two_stage_curve() {
        assert_eq!(zombie_health(1), 150.0);
        assert_eq!(zombie_health(2), 250.0);
        assert_eq!(zombie_health(9), 950.0);
        assert!((zombie_health(10) - 1045.0).abs() < 0.01);
        assert!((zombie_health(11) - 1149.5).abs() < 0.01);
        assert!((zombie_health(30) - 950.0 * 1.1f32.powi(21)).abs() < 1.0);
    }

    #[test]
    fn horde_cap_and_counts() {
        assert_eq!(horde_cap(1), 24);
        assert!(horde_cap(4) > 24 && horde_cap(8) <= 42);
        assert_eq!(zombie_count(1, 1), 6);
        assert!(zombie_count(10, 1) > zombie_count(5, 1));
        assert!(zombie_count(5, 4) > zombie_count(5, 1));
    }

    fn game(map: usize) -> Game {
        let mut g = Game::new(map, MODE_SURVIVAL, 7, true);
        g.local = 0;
        g.add_player(0, 0, default_loadout());
        g
    }
    fn idle(seq: u32, buttons: u32) -> [f32; CMD_LEN] {
        [seq as f32, 1.0 / 60.0, 0.0, 0.0, 0.0, 0.0, buttons as f32, -1.0, 0.0]
    }
    fn run(g: &mut Game, secs: f32) {
        for _ in 0..(secs * 60.0) as usize {
            g.step(1.0 / 60.0);
        }
    }

    #[test]
    fn rounds_spawn_respect_the_cap_and_advance() {
        let mut g = game(1);
        g.slots[0].p.calm_t = 1e9; // spectate: zombies ignore the player
        run(&mut g, 7.0);
        assert_eq!((g.sv.round, g.phase), (1, PH_ACTIVE));
        g.sv.round = 12;
        g.sv.to_spawn = 80;
        let mut peak = 0;
        for _ in 0..60 * 40 {
            g.step(1.0 / 60.0);
            peak = peak.max(g.sv.zombies.iter().filter(|z| z.state != Z_DEAD).count());
        }
        assert_eq!(peak, 24, "solo horde cap");
        // Clear the round: it ends, then the next one starts after the break.
        g.sv.to_spawn = 0;
        let ids: Vec<i32> = g.sv.zombies.iter().map(|z| z.id).collect();
        for id in ids {
            g.damage_zombie(id, 1e9, 0, false, false, V3::ZERO);
        }
        run(&mut g, 0.5);
        assert_eq!(g.phase, PH_BREAK);
        run(&mut g, 9.0);
        assert_eq!((g.sv.round, g.phase), (13, PH_ACTIVE));
    }

    #[test]
    fn zombies_break_in_reach_the_player_and_down_them() {
        let mut g = game(1);
        run(&mut g, 60.0);
        assert!(g.map.barrs.iter().any(|b| b.boards < BOARDS), "boards get torn off");
        assert_eq!(g.slots[0].p.life, DOWN, "an idle player is overrun");
        assert_eq!(g.phase, PH_OVER, "solo with no self-revive ends the game");
    }

    #[test]
    fn economy_doors_perks_and_limits() {
        let mut g = game(0);
        let find = |g: &Game, kind: u8, param: i32| g.map.inter.iter().position(|i| i.kind == kind && i.param == param).unwrap();
        let mut seq = 0;
        let mut press = |g: &mut Game, k: usize| {
            let at = g.map.inter[k].pos;
            let side = [(1.5, 0.0), (-1.5, 0.0), (0.0, 1.5), (0.0, -1.5)].into_iter().map(|(x, z)| v3(at.x + x, 0.0, at.z + z));
            g.slots[0].p.ctl.pos = side.into_iter().find(|p| !g.map.world.overlaps(&Aabb::feet(*p, 0.35, 1.8))).unwrap();
            g.cmd(0, &idle(seq, 0));
            g.cmd(0, &idle(seq + 1, B_USE));
            seq += 2;
        };
        // Cannot afford the 750 door with 500 points.
        let door = find(&g, I_DOOR, 0);
        press(&mut g, door);
        assert_eq!((g.sv.doors, g.slots[0].p.points), (0, 500));
        g.slots[0].p.points = 20000;
        press(&mut g, door);
        assert_eq!((g.sv.doors, g.slots[0].p.points), (1, 19250));
        // Perks need power, then stop at four.
        let perk = |g: &Game, id: i32| find(g, I_PERK, id);
        let k = perk(&g, 0);
        press(&mut g, k);
        assert_eq!(g.slots[0].p.perks, 0, "no power yet");
        let sw = g.map.inter.iter().position(|i| i.kind == I_POWER).unwrap();
        press(&mut g, sw);
        assert!(g.sv.power);
        for id in 0..6 {
            let k = perk(&g, id);
            press(&mut g, k);
        }
        assert_eq!(g.slots[0].p.perks.count_ones(), 4, "four-perk limit");
        // Wall-buy fills the empty slot; the bench upgrades the weapon in hand.
        let wb = find(&g, I_WALLBUY, 3);
        press(&mut g, wb);
        assert_eq!(g.slots[0].p.arms.gun().id, 3);
        let bench = g.map.inter.iter().position(|i| i.kind == I_BENCH).unwrap();
        g.slots[0].p.points = 20000;
        press(&mut g, bench);
        assert_eq!((g.slots[0].p.arms.gun().tier, g.slots[0].p.points), (1, 15000));
        press(&mut g, bench);
        assert!(g.slots[0].p.arms.gun().modi > 0 && g.slots[0].p.points == 12500, "re-upgrade rolls an effect");
    }

    #[test]
    fn quest_progresses_through_power_parts_and_console() {
        let mut g = game(0);
        g.slots[0].p.calm_t = 1e9;
        g.sv.power = true;
        run(&mut g, 0.1);
        assert_eq!(g.sv.quest[0].0, 1, "power step completes");
        for k in 0..g.map.inter.len() {
            if g.map.inter[k].kind == I_PART && g.map.inter[k].param < 8 {
                let at = g.map.inter[k].pos;
                g.slots[0].p.ctl.pos = v3(at.x + 0.5, at.y - 0.6, at.z);
                g.cmd(0, &idle(1, 0));
                g.cmd(0, &idle(2, B_USE));
            }
        }
        run(&mut g, 0.1);
        assert_eq!(g.sv.quest[0].0, 2, "three fuses collected");
        let console = g.map.inter.iter().position(|i| i.kind == I_CONSOLE).unwrap();
        let at = g.map.inter[console].pos;
        g.slots[0].p.ctl.pos = v3(at.x, 0.0, at.z - 1.5);
        g.cmd(0, &idle(3, 0));
        g.cmd(0, &idle(4, B_USE));
        assert_eq!(g.sv.quest[0].0, 3);
        assert!(!g.relays_live());
    }

    /// Stands the player beside interactable `k` (on a side that is not inside geometry) and presses use.
    fn use_at(g: &mut Game, k: usize, seq: &mut u32) {
        let at = g.map.inter[k].pos;
        let side = [(1.5, 0.0), (-1.5, 0.0), (0.0, 1.5), (0.0, -1.5)].into_iter().map(|(x, z)| v3(at.x + x, 0.0, at.z + z));
        g.slots[0].p.ctl.pos = side.into_iter().find(|p| !g.map.world.overlaps(&Aabb::feet(*p, 0.35, 1.8))).unwrap();
        g.cmd(0, &idle(*seq, 0));
        g.cmd(0, &idle(*seq + 1, B_USE));
        *seq += 2;
    }

    #[test]
    fn tonic_dispenser_draws_from_the_pack_with_a_rising_price() {
        use crate::controller::B_TONIC;
        for map in 0..MAPS.len() {
            let mut g = game(map);
            g.slots[0].p.calm_t = 1e9;
            g.slots[0].p.points = 10_000;
            let k = g.map.inter.iter().position(|i| i.kind == I_TONIC).unwrap_or_else(|| panic!("{} has no tonic machine", g.def_name()));
            let pack = &g.slots[0].loadout[L_TONIC..L_TONIC + 5].to_vec();
            let mut seq = 0;
            for (n, cost) in [500, 1000, 1500].into_iter().enumerate() {
                let before = g.slots[0].p.points;
                g.events.clear();
                use_at(&mut g, k, &mut seq);
                assert_eq!(before - g.slots[0].p.points, cost, "buy {n} costs {cost}");
                let got = g.events.chunks(EV_STRIDE).find(|e| e[0] as u32 == EV_TONIC).map(|e| e[2] as i32).expect("tonic event");
                assert!(pack.contains(&got), "drew {got}, not from the pack {pack:?}");
            }
            // Three a round, then the machine refuses until the next round.
            let before = g.slots[0].p.points;
            use_at(&mut g, k, &mut seq);
            assert_eq!(g.slots[0].p.points, before);
            assert_eq!(g.slots[0].p.prompt_cost, 0, "prompt not refreshed until the next tick");
            g.step(1.0 / 60.0);
            assert_eq!(g.slots[0].p.prompt_cost, -3, "limit reached");
        }
        // Activated tonics: Phase Step blinks you back to the start, twice.
        let mut g = game(0);
        g.slots[0].p.calm_t = 1e9;
        let p = &mut g.slots[0].p;
        (p.tonic, p.tonic_left, p.tonic_on) = (T_PHASE, 2.0, false);
        p.ctl.pos = g.map.spawns[0] + v3(9.0, 0.0, 0.0);
        g.cmd(0, &idle(100, 0));
        g.cmd(0, &idle(101, B_TONIC));
        assert!(g.slots[0].p.ctl.pos.dist(g.map.spawns[0]) < 0.5);
        assert_eq!((g.slots[0].p.tonic, g.slots[0].p.tonic_left), (T_PHASE, 1.0));
    }

    #[test]
    fn coop_revive_brings_a_teammate_back() {
        let mut g = game(1);
        g.add_player(1, 0, default_loadout());
        g.slots.iter_mut().for_each(|s| s.p.calm_t = 1e9);
        run(&mut g, 2.5);
        g.slots[1].p.ctl.pos = g.slots[0].p.ctl.pos + v3(1.0, 0.0, 0.0);
        assert!(g.damage_player(1, 999.0, -1, -1, false, V3::ZERO));
        assert_eq!(g.slots[1].p.life, DOWN);
        for s in 0..200 {
            g.step(1.0 / 60.0);
            g.cmd(0, &idle(s, B_USE));
        }
        assert_eq!(g.slots[1].p.life, ALIVE);
        assert_eq!(g.slots[0].p.points, 600, "reviver is paid");
    }
}
