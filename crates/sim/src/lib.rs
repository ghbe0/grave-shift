//! Grave Shift simulation core.
//!
//! Compiles to a dependency-free `wasm32-unknown-unknown` module with a plain C ABI. Data crosses
//! the boundary through one shared f32 buffer (`gs_io`) and one byte buffer (`gs_str_buf`).
pub mod arms;
pub mod catalog;
pub mod controller;
pub mod game;
pub mod loadout;
pub mod maps;
pub mod math;
pub mod modes;
pub mod survival;
pub mod texgen;
pub mod util;
pub mod world;

use game::Game;
use std::cell::RefCell;

const IO_LEN: usize = 16384;
const STR_LEN: usize = 4096;
static mut IO: [f32; IO_LEN] = [0.0; IO_LEN];
static mut STR: [u8; STR_LEN] = [0; STR_LEN];

thread_local! {
    static GAMES: RefCell<Vec<Option<Game>>> = const { RefCell::new(Vec::new()) };
    static TEX: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn io() -> &'static mut [f32] {
    // SAFETY: the module is single-threaded and no reference outlives one exported call.
    unsafe { &mut *core::ptr::addr_of_mut!(IO) }
}
fn out(v: &[f32]) -> u32 {
    let n = v.len().min(IO_LEN);
    io()[..n].copy_from_slice(&v[..n]);
    n as u32
}
fn out_str(s: &str) -> u32 {
    // SAFETY: as above.
    let buf = unsafe { &mut *core::ptr::addr_of_mut!(STR) };
    let n = s.len().min(STR_LEN);
    buf[..n].copy_from_slice(&s.as_bytes()[..n]);
    n as u32
}
fn with<R: Default>(h: u32, f: impl FnOnce(&mut Game) -> R) -> R {
    GAMES.with(|g| g.borrow_mut().get_mut(h as usize).and_then(|g| g.as_mut()).map(f).unwrap_or_default())
}
fn input(n: u32) -> Vec<f32> {
    io()[..(n as usize).min(IO_LEN)].to_vec()
}

#[no_mangle]
pub extern "C" fn gs_abi() -> u32 {
    3
}
#[no_mangle]
pub extern "C" fn gs_io() -> *mut f32 {
    core::ptr::addr_of_mut!(IO) as *mut f32
}
#[no_mangle]
pub extern "C" fn gs_str_buf() -> *mut u8 {
    core::ptr::addr_of_mut!(STR) as *mut u8
}
/// Field offsets for players, header, zombies, entities and event ids, as text.
#[no_mangle]
pub extern "C" fn gs_layout() -> u32 {
    out_str(&game::layout())
}

#[no_mangle]
pub extern "C" fn gs_new(map: u32, mode: u32, seed: u32, authority: u32) -> u32 {
    let game = Game::new(map as usize, mode as u8, seed, authority != 0);
    GAMES.with(|g| {
        let mut g = g.borrow_mut();
        match g.iter().position(|s| s.is_none()) {
            Some(i) => {
                g[i] = Some(game);
                i as u32
            }
            None => {
                g.push(Some(game));
                g.len() as u32 - 1
            }
        }
    })
}
#[no_mangle]
pub extern "C" fn gs_free(h: u32) {
    GAMES.with(|g| {
        if let Some(s) = g.borrow_mut().get_mut(h as usize) {
            *s = None;
        }
    });
}
/// Match rules (`modes::RULES_LEN` floats) are read from the io buffer and clamped.
#[no_mangle]
pub extern "C" fn gs_set_rules(h: u32) {
    let d = input(modes::RULES_LEN as u32);
    with(h, |g| g.set_rules(modes::Rules::from_floats(g.mode, &d)));
}
/// Moves a player to the other team mid-match; returns 1 if it was allowed.
#[no_mangle]
pub extern "C" fn gs_set_team(h: u32, id: i32, team: i32) -> u32 {
    with(h, |g| g.set_team(id, team) as u32)
}
/// Weapon ids of the weapon ladder, first rung to last.
#[no_mangle]
pub extern "C" fn gs_ladder() -> u32 {
    out(&modes::LADDER.map(|w| w as f32))
}
/// Default rules for a mode, written to the io buffer.
#[no_mangle]
pub extern "C" fn gs_default_rules(mode: u32) -> u32 {
    out(&modes::Rules::defaults(mode as u8).to_floats())
}
/// Loadout (27 floats) is read from the io buffer.
#[no_mangle]
pub extern "C" fn gs_add_player(h: u32, id: i32, team: i32) {
    let l = loadout::from_floats(&input(loadout::L_LEN as u32));
    with(h, |g| g.add_player(id, team, l));
}
#[no_mangle]
pub extern "C" fn gs_remove_player(h: u32, id: i32) {
    with(h, |g| g.remove_player(id));
}
#[no_mangle]
pub extern "C" fn gs_set_local(h: u32, id: i32) {
    with(h, |g| g.local = id);
}
/// Command (9 floats) is read from the io buffer.
#[no_mangle]
pub extern "C" fn gs_cmd(h: u32, id: i32) {
    let c = input(controller::CMD_LEN as u32);
    with(h, |g| g.cmd(id, &c));
}
#[no_mangle]
pub extern "C" fn gs_step(h: u32, dt: f32) {
    with(h, |g| g.step(dt.clamp(0.0, 0.1)));
}
#[no_mangle]
pub extern "C" fn gs_snapshot(h: u32) -> u32 {
    let mut v = Vec::with_capacity(2048);
    with(h, |g| g.snapshot(&mut v));
    out(&v)
}
/// Moves pending events into the io buffer and returns the float count.
#[no_mangle]
pub extern "C" fn gs_events(h: u32) -> u32 {
    let v = with(h, |g| core::mem::take(&mut g.events));
    out(&v)
}
#[no_mangle]
pub extern "C" fn gs_player_state(h: u32, id: i32) -> u32 {
    let mut v = Vec::new();
    with(h, |g| g.player_state(id, &mut v));
    out(&v)
}
#[no_mangle]
pub extern "C" fn gs_set_player_state(h: u32, n: u32) {
    let d = input(n);
    with(h, |g| g.set_player_state(&d));
}
#[no_mangle]
pub extern "C" fn gs_set_doors(h: u32, mask: u32) {
    with(h, |g| {
        if g.sv.doors != mask {
            g.set_doors(mask)
        }
    });
}
/// Collision boxes: 8 floats each (min, max, material, flags).
#[no_mangle]
pub extern "C" fn gs_boxes(h: u32) -> u32 {
    let v = with(h, |g| {
        let mut v = Vec::new();
        for s in &g.map.world.solids {
            v.extend_from_slice(&[s.bb.min.x, s.bb.min.y, s.bb.min.z, s.bb.max.x, s.bb.max.y, s.bb.max.z, s.mat as f32, (s.flags | ((s.tag.max(-1) + 1) as u32) << 8) as f32]);
        }
        v
    });
    out(&v) / 8
}
/// Interactables: 8 floats each (kind, x, y, z, cost, param, needs_power, active).
#[no_mangle]
pub extern "C" fn gs_interactables(h: u32) -> u32 {
    let v = with(h, |g| {
        let mut v = Vec::new();
        for i in &g.map.inter {
            v.extend_from_slice(&[i.kind as f32, i.pos.x, i.pos.y, i.pos.z, i.cost as f32, i.param as f32, i.needs_power as u32 as f32, i.active as u32 as f32]);
        }
        v
    });
    out(&v) / 8
}
/// Map info: size xz, sun dir, sun colour, sky colour, fog, then counts and positions of
/// barricades, relay targets, props (x, y, z, yaw) and player spawns.
#[no_mangle]
pub extern "C" fn gs_map_info(h: u32) -> u32 {
    let v = with(h, |g| {
        let d = g.map.def;
        let mut v = vec![g.map.size.0, g.map.size.1];
        v.extend_from_slice(&d.sun);
        v.extend_from_slice(&d.sun_color);
        v.extend_from_slice(&d.sky);
        v.push(d.fog);
        v.push(g.map.barrs.len() as f32);
        g.map.barrs.iter().for_each(|b| v.extend_from_slice(&[b.pos.x, b.pos.y, b.pos.z]));
        v.push(g.map.targets.len() as f32);
        g.map.targets.iter().for_each(|t| v.extend_from_slice(&[t.0.x, t.0.y, t.0.z]));
        v.push(d.props.len() as f32);
        d.props.iter().for_each(|p| v.extend_from_slice(&[(p.1 + 0.5) * maps::CELL, p.3, (p.2 + 0.5) * maps::CELL, p.4]));
        v.push(d.theme as f32);
        v.push(d.gravity);
        v
    });
    out(&v)
}
/// Bullet trace against static geometry. Reads origin, direction, max from io; returns distance.
#[no_mangle]
pub extern "C" fn gs_raycast(h: u32) -> f32 {
    let d = input(7);
    let (o, dir) = (math::v3(d[0], d[1], d[2]), math::v3(d[3], d[4], d[5]).norm());
    with(h, |g| g.map.world.raycast(o, dir, d[6]).map_or(d[6], |x| x.0))
}
/// Recoil for the n-th shot of a burst: writes (pitch, yaw) to io.
#[no_mangle]
pub extern "C" fn gs_recoil(weapon: i32, shot: f32, ads: f32, att: u32) {
    let scale = if att & catalog::A_GRIP != 0 { 0.75 } else { 1.0 };
    let (p, y) = arms::recoil(weapon, shot, ads, scale);
    out(&[p, y]);
}

/// Catalog kinds for `gs_count`, `gs_str` and `gs_stat`.
const K_WEAPON: u32 = 0;
const K_ATTACHMENT: u32 = 1;
const K_PERK: u32 = 2;
const K_KIT_PERK: u32 = 3;
const K_LETHAL: u32 = 4;
const K_TACTICAL: u32 = 5;
const K_WILDCARD: u32 = 6;
const K_STREAK: u32 = 7;
const K_ABILITY: u32 = 8;
const K_TONIC: u32 = 9;
const K_MOD: u32 = 10;
const K_POWERUP: u32 = 11;
const K_MAP: u32 = 12;
const K_ZONE: u32 = 13;
const K_QUEST: u32 = 14;
const K_QUEST_STEP: u32 = 15;
const K_DOOR: u32 = 16;
const K_PROP: u32 = 17;

#[no_mangle]
pub extern "C" fn gs_count(kind: u32, a: u32) -> u32 {
    use catalog::*;
    let map = maps::MAPS.get(a as usize);
    (match kind {
        K_WEAPON => WEAPONS.len(),
        K_ATTACHMENT => ATTACHMENTS.len(),
        K_PERK => PERKS.len(),
        K_KIT_PERK => KIT_PERKS.len(),
        K_LETHAL => LETHALS.len(),
        K_TACTICAL => TACTICALS.len(),
        K_WILDCARD => WILDCARDS.len(),
        K_STREAK => STREAKS.len(),
        K_ABILITY => ABILITIES.len(),
        K_TONIC => TONICS.len(),
        K_MOD => MODS.len(),
        K_POWERUP => POWERUPS.len(),
        K_MAP => maps::MAPS.len(),
        K_ZONE => map.map_or(0, |m| m.zones.len()),
        K_QUEST => map.map_or(0, |m| m.quests.len()),
        K_DOOR => map.map_or(0, |m| m.doors.len()),
        K_PROP => map.map_or(0, |m| m.props.len()),
        _ => 0,
    }) as u32
}

/// Text for a catalog entry. `which`: 0 name, 1 description/slug. For map-scoped kinds `a` is the
/// map and `b` the index; quest steps pack `quest * 16 + step` into `b`.
#[no_mangle]
pub extern "C" fn gs_str(kind: u32, a: u32, b: u32, which: u32) -> u32 {
    use catalog::*;
    let (i, j) = (a as usize, b as usize);
    let pair = |p: Option<(&'static str, &'static str)>| p.map(|p| if which == 0 { p.0 } else { p.1 });
    let s: Option<&str> = match kind {
        K_WEAPON => pair(WEAPONS.get(i).map(|w| (w.name, w.slug))),
        K_ATTACHMENT => pair(ATTACHMENTS.get(i).map(|x| (x.0, x.1))),
        K_PERK => pair(PERKS.get(i).map(|x| (x.0, x.1))),
        K_KIT_PERK => pair(KIT_PERKS.get(i).copied()),
        K_LETHAL => pair(LETHALS.get(i).copied()),
        K_TACTICAL => pair(TACTICALS.get(i).copied()),
        K_WILDCARD => pair(WILDCARDS.get(i).copied()),
        K_STREAK => pair(STREAKS.get(i).map(|x| (x.0, x.1))),
        K_ABILITY => pair(ABILITIES.get(i).map(|x| (x.name, x.desc))),
        K_TONIC => pair(TONICS.get(i).map(|x| (x.name, x.desc))),
        K_MOD => MODS.get(i).copied(),
        K_POWERUP => POWERUPS.get(i).copied(),
        K_MAP => maps::MAPS.get(i).map(|m| m.name),
        K_ZONE => maps::MAPS.get(i).and_then(|m| m.zones.get(j)).map(|z| z.0),
        K_QUEST => maps::MAPS.get(i).and_then(|m| m.quests.get(j)).map(|q| q.name),
        K_QUEST_STEP => maps::MAPS.get(i).and_then(|m| m.quests.get(j / 16)).and_then(|q| q.steps.get(j % 16)).map(|s| s.1),
        K_DOOR => maps::MAPS.get(i).and_then(|m| m.doors.get(j)).map(|d| d.2),
        K_PROP => maps::MAPS.get(i).and_then(|m| m.props.get(j)).map(|p| p.0),
        _ => None,
    };
    out_str(s.unwrap_or(""))
}

/// Numeric catalog data. Weapons: 0 class, 1 damage, 2 rpm, 3 mag, 4 reserve, 5 reload, 6 zoom,
/// 7 cost, 8 flags, 9 auto, 10 range, 11 burst. Attachments: 0 class mask. Perks: 0 cost. Streaks: 0 score.
/// Abilities: 0 kind. Tonics: 0 kind, 1 amount, 2 rare.
#[no_mangle]
pub extern "C" fn gs_stat(kind: u32, id: u32, field: u32) -> f32 {
    use catalog::*;
    let i = id as usize;
    match kind {
        K_WEAPON => WEAPONS.get(i).map_or(0.0, |w| match field {
            0 => w.class as f32,
            1 => w.dmg * w.pellets as f32,
            2 => w.rpm,
            3 => w.mag,
            4 => w.reserve,
            5 => w.reload,
            6 => w.zoom,
            7 => w.cost as f32,
            8 => w.flags as f32,
            9 => w.auto as u32 as f32,
            11 => w.burst as f32,
            _ => w.r1,
        }),
        // Zone rectangles in map cells: id = map * 64 + zone; fields col0, row0, col1, row1.
        K_ZONE => maps::MAPS.get(i / 64).and_then(|m| m.zones.get(i % 64)).map_or(0.0, |z| [z.1, z.2, z.3, z.4].get(field as usize).copied().unwrap_or(0) as f32),
        K_ATTACHMENT => ATTACHMENTS.get(i).map_or(0.0, |a| a.2 as f32),
        K_PERK => PERKS.get(i).map_or(0.0, |p| p.2 as f32),
        K_STREAK => STREAKS.get(i).map_or(0.0, |s| s.2 as f32),
        K_ABILITY => ABILITIES.get(i).map_or(0.0, |a| a.kind as f32),
        K_TONIC => TONICS.get(i).map_or(0.0, |t| match field {
            0 => t.kind as f32,
            1 => t.amount,
            _ => t.rare as u32 as f32,
        }),
        _ => 0.0,
    }
}

/// Effective zoom and attachment mask aside, the HUD needs the stats of the gun in hand:
/// writes (mag, zoom, auto, flags) for a weapon with attachments and tier.
#[no_mangle]
pub extern "C" fn gs_gun_stats(id: i32, att: u32, tier: u32) -> u32 {
    let g = arms::Gun { id, att, tier: tier as u8, ..arms::Gun::NONE };
    match g.stats(&arms::Combat::default()) {
        Some(s) => out(&[s.mag, s.zoom, s.auto as u32 as f32, s.flags as f32, s.reserve]),
        None => 0,
    }
}

/// Validates the loadout in io. Returns points used, or a negative `Invalid` code.
#[no_mangle]
pub extern "C" fn gs_loadout_validate() -> i32 {
    match loadout::validate(&loadout::from_floats(&input(loadout::L_LEN as u32))) {
        Ok(p) => p as i32,
        Err(e) => -(e as i32),
    }
}
#[no_mangle]
pub extern "C" fn gs_loadout_default() -> u32 {
    let l: Vec<f32> = loadout::default_loadout().iter().map(|v| *v as f32).collect();
    out(&l)
}
#[no_mangle]
pub extern "C" fn gs_zombie_health(round: u32) -> f32 {
    survival::zombie_health(round)
}
#[no_mangle]
pub extern "C" fn gs_zombie_count(round: u32, players: u32) -> u32 {
    survival::zombie_count(round, players)
}
#[no_mangle]
pub extern "C" fn gs_horde_cap(players: u32) -> u32 {
    survival::horde_cap(players)
}

/// Generates material layer `layer` at `size` (a power of two). Returns a pointer to the bytes
/// (surface mip chain then detail mip chain, RGBA8); `gs_texgen_len` gives the length. The buffer
/// is reused by the next call.
#[no_mangle]
pub extern "C" fn gs_texgen(layer: u32, size: u32) -> *const u8 {
    TEX.with(|t| {
        let mut t = t.borrow_mut();
        t.clear();
        texgen::generate(layer as usize % texgen::LAYERS, (size as usize).clamp(4, 2048).next_power_of_two(), &mut t);
        t.as_ptr()
    })
}
#[no_mangle]
pub extern "C" fn gs_texgen_len() -> u32 {
    TEX.with(|t| t.borrow().len() as u32)
}
#[no_mangle]
pub extern "C" fn gs_texgen_layers() -> u32 {
    texgen::LAYERS as u32
}
/// Metres covered by one repeat of a material layer.
#[no_mangle]
pub extern "C" fn gs_texgen_tile(layer: u32) -> f32 {
    texgen::TILE.get(layer as usize).copied().unwrap_or(1.0)
}
