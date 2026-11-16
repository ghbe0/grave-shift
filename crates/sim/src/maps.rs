//! Map blueprints. A map is an ASCII floor plan plus tables for doors, purchases, zones and quests;
//! `build` turns it into collision boxes, a nav grid and interactables.
//!
//! Legend: `#` wall, `.` floor, `P` player spawn, `z` zombie spawn, `b` barricaded window,
//! `1`-`6` blocks 0.5 m per digit (stairs/platforms), `h`/`H` 1 m / 2 m crates, `A`-`D` doors,
//! `c` crate location, `u` upgrade bench, `t` tonic dispenser, `p` power switch, `k` workbench,
//! `q` quest console. Perk machines and wall-buys use the characters listed in the map tables.
use crate::catalog::*;
use crate::math::{v3, Aabb, V3};
use crate::world::*;

pub const CELL: f32 = 2.0;
pub const WALL_H: f32 = 7.0;

pub const I_DOOR: u8 = 1;
pub const I_WALLBUY: u8 = 2;
pub const I_PERK: u8 = 3;
pub const I_CRATE: u8 = 4;
pub const I_BENCH: u8 = 5;
pub const I_TONIC: u8 = 6;
pub const I_POWER: u8 = 7;
pub const I_WORKBENCH: u8 = 8;
pub const I_PART: u8 = 9;
pub const I_CONSOLE: u8 = 10;
pub const I_BARRICADE: u8 = 11;
pub const I_REVIVE: u8 = 12;

#[derive(Clone, Copy, Debug)]
pub enum Step {
    Power,
    /// Pick up `n` parts with this tag.
    Collect { tag: i32, n: u32 },
    /// Use an interactable of this kind.
    Use { kind: u8 },
    Kills { zone: usize, n: u32 },
    /// Shoot `n` of the map's relay targets.
    Shoot { n: u32 },
    Hold { zone: usize, secs: f32 },
    Round(u32),
}
#[derive(Clone, Copy, Debug)]
pub enum Reward {
    Weapon(i32),
    Shield,
    Points(u32),
}
pub struct QuestDef {
    pub name: &'static str,
    pub steps: &'static [(Step, &'static str)],
    pub reward: Reward,
}

pub struct MapDef {
    pub name: &'static str,
    pub rows: &'static [&'static str],
    /// (char, cost, name of the area it opens)
    pub doors: &'static [(char, u32, &'static str)],
    pub wallbuys: &'static [(char, i32)],
    pub perks: &'static [(char, i32)],
    /// (name, col0, row0, col1, row1) inclusive
    pub zones: &'static [(&'static str, usize, usize, usize, usize)],
    /// (tag, col, row, height)
    pub parts: &'static [(i32, f32, f32, f32)],
    /// Relay targets in world space.
    pub targets: &'static [(f32, f32, f32)],
    pub quests: &'static [QuestDef],
    /// glTF props: (asset slug, col, row, y, yaw)
    pub props: &'static [(&'static str, f32, f32, f32, f32)],
    pub sun: [f32; 3],
    pub sun_color: [f32; 3],
    pub sky: [f32; 3],
    pub fog: f32,
}

pub static MAPS: [MapDef; 2] = [
    MapDef {
        name: "Foundry 9",
        rows: &[
            "##################################",
            "#####zz####zz#######zz#####zz#####",
            "#####b#####b########b######b######",
            "###.....!.......#....j.......&.###",
            "###.............#..............###",
            "###..P.....P....#...123456666..###",
            "###.....hh......#.........666..###",
            "#z#.....hH......A.........666..#z#",
            "#zb..P.....P....#..............bz#",
            "###t............#...c..........###",
            "###...........i.#..............###",
            "###@............#.........$....###",
            "#########C##############B#########",
            "###............l#..............###",
            "###.............#..hh......m...###",
            "###..#########..#.............^###",
            "#z#.............#.....44.......#z#",
            "#zb.............D.....44..p....bz#",
            "###.............#..............###",
            "###..#########..#..u...........###",
            "###o............#...........k..###",
            "###.....%....c..#......q.....n.###",
            "#####b#####b########b######b######",
            "#####zz####zz#######zz#####zz#####",
            "##################################",
        ],
        doors: &[('A', 750, "Smelter Floor"), ('B', 1000, "Control Room"), ('C', 1000, "the Yard"), ('D', 1250, "the Yard link")],
        wallbuys: &[('!', 4), ('@', 2), ('$', 3), ('%', 5), ('^', 6), ('&', 1)],
        perks: &[('i', 3), ('j', 1), ('l', 4), ('m', 0), ('n', 2), ('o', 5)],
        zones: &[("Loading Bay", 3, 3, 15, 11), ("Smelter Floor", 17, 3, 30, 11), ("The Yard", 3, 13, 15, 21), ("Control Room", 17, 13, 30, 21)],
        parts: &[(0, 27.0, 6.0, 3.0), (0, 14.0, 20.0, 0.0), (0, 30.0, 13.0, 0.0), (1, 15.0, 3.0, 0.0), (1, 9.0, 17.0, 0.0), (1, 17.0, 11.0, 0.0)],
        targets: &[(49.0, 5.0, 6.4), (18.0, 5.0, 32.4), (61.6, 5.0, 36.0)],
        quests: &[
            QuestDef {
                name: "Relight the Foundry",
                steps: &[
                    (Step::Power, "Restore power in the Control Room"),
                    (Step::Collect { tag: 0, n: 3 }, "Find three fuses"),
                    (Step::Use { kind: I_CONSOLE }, "Install the fuses at the console"),
                    (Step::Kills { zone: 1, n: 15 }, "Feed the crucible: 15 kills on the Smelter Floor"),
                    (Step::Shoot { n: 3 }, "Shoot the three glowing relays"),
                    (Step::Hold { zone: 3, secs: 40.0 }, "Hold the Control Room"),
                    (Step::Use { kind: I_CONSOLE }, "Throw the master switch"),
                ],
                reward: Reward::Weapon(W_ARC),
            },
            QuestDef {
                name: "Bulwark",
                steps: &[(Step::Collect { tag: 1, n: 3 }, "Find three armour plates"), (Step::Use { kind: I_WORKBENCH }, "Assemble the Bulwark at the workbench")],
                reward: Reward::Shield,
            },
        ],
        props: &[("generator", 28.0, 16.0, 0.0, 0.0)],
        // Dusk: low warm sun, long shadows, hazy horizon.
        sun: [-0.62, 0.34, 0.5],
        sun_color: [1.0, 0.58, 0.32],
        sky: [0.34, 0.31, 0.33],
        fog: 0.016,
    },
    MapDef {
        name: "Dry Dock",
        rows: &[
            "##########################",
            "#####zz#########zz########",
            "#####b##########b#########",
            "###P......!........j..P###",
            "###.........t..........###",
            "###...####......####...###",
            "#z#...h............h...#z#",
            "#zb.........44.........bz#",
            "###.........44.........###",
            "###...h............h...###",
            "###...####......####...###",
            "###....................###",
            "###P..c....p...u..i...P###",
            "#####b##########b#########",
            "#####zz#########zz########",
            "##########################",
        ],
        doors: &[],
        wallbuys: &[('!', 2)],
        perks: &[('i', 0), ('j', 1)],
        zones: &[("Dry Dock", 3, 3, 22, 12)],
        parts: &[],
        targets: &[],
        quests: &[QuestDef {
            name: "Dry Run",
            steps: &[(Step::Power, "Turn on the power"), (Step::Round(5), "Survive to round 5")],
            reward: Reward::Points(2000),
        }],
        props: &[],
        // Night under a cold moon; the lamps do most of the lighting.
        sun: [0.45, 0.55, -0.5],
        sun_color: [0.36, 0.44, 0.62],
        sky: [0.09, 0.11, 0.16],
        fog: 0.024,
    },
];

#[derive(Clone, Copy, Debug)]
pub struct Inter {
    pub kind: u8,
    pub pos: V3,
    pub cost: u32,
    /// Door index, weapon id, perk id or `tag * 8 + index` for parts.
    pub param: i32,
    pub needs_power: bool,
    pub active: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Barricade {
    pub pos: V3,
    pub boards: u8,
}
pub const BOARDS: u8 = 6;

pub struct Built {
    pub def: &'static MapDef,
    pub world: World,
    pub spawns: Vec<V3>,
    pub zspawns: Vec<V3>,
    pub inter: Vec<Inter>,
    pub barrs: Vec<Barricade>,
    /// Relay targets and whether each has been shot.
    pub targets: Vec<(V3, bool)>,
    pub size: (f32, f32),
}

fn center(col: usize, row: usize) -> V3 {
    v3((col as f32 + 0.5) * CELL, 0.0, (row as f32 + 0.5) * CELL)
}

pub fn build(id: usize) -> Built {
    let def = &MAPS[id.min(MAPS.len() - 1)];
    let (w, h) = (def.rows[0].len(), def.rows.len());
    let size = (w as f32 * CELL, h as f32 * CELL);
    let mut b = Built { def, world: World::default(), spawns: vec![], zspawns: vec![], inter: vec![], barrs: vec![], targets: vec![], size };
    let mut solids = vec![
        Solid { bb: Aabb::new(v3(0.0, -1.0, 0.0), v3(size.0, 0.0, size.1)), mat: 0, flags: 0, tag: -1, on: true },
        Solid { bb: Aabb::new(v3(0.0, WALL_H, 0.0), v3(size.0, WALL_H + 1.0, size.1)), mat: 0, flags: F_NONAV | F_HIDDEN, tag: -1, on: true },
    ];
    let block = |ch: u8| -> Option<(f32, u8)> {
        match ch {
            b'#' => Some((WALL_H, 1)),
            b'1'..=b'6' => Some(((ch - b'0') as f32 * 0.5, 3)),
            b'h' => Some((1.0, 2)),
            b'H' => Some((2.0, 2)),
            _ => None,
        }
    };
    // A machine or prop that stands in the middle of its cell.
    let stand = |solids: &mut Vec<Solid>, c: V3, hx: f32, hz: f32, height: f32, mat: u8| {
        solids.push(Solid { bb: Aabb::new(v3(c.x - hx, 0.0, c.z - hz), v3(c.x + hx, height, c.z + hz)), mat, flags: 0, tag: -1, on: true });
    };
    for (row, line) in def.rows.iter().enumerate() {
        let bytes = line.as_bytes();
        let mut col = 0;
        while col < w {
            let ch = bytes[col];
            if let Some((height, mat)) = block(ch) {
                // Merge a run of identical blocks into one box.
                let start = col;
                while col < w && bytes[col] == ch {
                    col += 1;
                }
                let (z0, z1) = (row as f32 * CELL, (row + 1) as f32 * CELL);
                solids.push(Solid { bb: Aabb::new(v3(start as f32 * CELL, 0.0, z0), v3(col as f32 * CELL, height, z1)), mat, flags: 0, tag: -1, on: true });
                continue;
            }
            let c = center(col, row);
            let cell_box = Aabb::new(v3(c.x - 1.0, 0.0, c.z - 1.0), v3(c.x + 1.0, WALL_H, c.z + 1.0));
            let at = |y: f32| v3(c.x, y, c.z);
            let chr = ch as char;
            match ch {
                b'P' => b.spawns.push(c),
                b'z' => b.zspawns.push(c),
                b'b' => {
                    solids.push(Solid { bb: cell_box, mat: 0, flags: F_CLIP | F_NONAV | F_HIDDEN, tag: b.barrs.len() as i32, on: true });
                    b.inter.push(Inter { kind: I_BARRICADE, pos: at(1.0), cost: 0, param: b.barrs.len() as i32, needs_power: false, active: true });
                    b.barrs.push(Barricade { pos: c, boards: BOARDS });
                }
                b'c' => {
                    stand(&mut solids, c, 0.8, 0.5, 0.9, 6);
                    let first = !b.inter.iter().any(|i| i.kind == I_CRATE);
                    b.inter.push(Inter { kind: I_CRATE, pos: at(1.0), cost: CRATE_COST, param: 0, needs_power: false, active: first });
                }
                b'u' => {
                    stand(&mut solids, c, 0.7, 0.7, 2.3, 7);
                    b.inter.push(Inter { kind: I_BENCH, pos: at(1.2), cost: UPGRADE_COST, param: 0, needs_power: true, active: true });
                }
                b't' => {
                    stand(&mut solids, c, 0.5, 0.5, 2.3, 9);
                    b.inter.push(Inter { kind: I_TONIC, pos: at(1.2), cost: TONIC_COST, param: 0, needs_power: false, active: true });
                }
                b'p' => {
                    stand(&mut solids, c, 0.3, 0.3, 1.4, 8);
                    b.inter.push(Inter { kind: I_POWER, pos: at(1.2), cost: 0, param: 0, needs_power: false, active: true });
                }
                b'k' => {
                    stand(&mut solids, c, 0.8, 0.5, 1.0, 10);
                    b.inter.push(Inter { kind: I_WORKBENCH, pos: at(1.0), cost: 0, param: 0, needs_power: false, active: true });
                }
                b'q' => {
                    stand(&mut solids, c, 0.5, 0.4, 1.2, 11);
                    b.inter.push(Inter { kind: I_CONSOLE, pos: at(1.2), cost: 0, param: 0, needs_power: true, active: true });
                }
                _ => {
                    if let Some(i) = def.doors.iter().position(|d| d.0 == chr) {
                        solids.push(Solid { bb: cell_box, mat: 4, flags: F_DOOR, tag: i as i32, on: true });
                        b.inter.push(Inter { kind: I_DOOR, pos: at(1.2), cost: def.doors[i].1, param: i as i32, needs_power: false, active: true });
                    } else if let Some(wb) = def.wallbuys.iter().find(|d| d.0 == chr) {
                        stand(&mut solids, c, 0.3, 0.3, 0.9, 12);
                        b.inter.push(Inter { kind: I_WALLBUY, pos: at(1.2), cost: WEAPONS[wb.1 as usize].cost, param: wb.1, needs_power: false, active: true });
                    } else if let Some(pk) = def.perks.iter().find(|d| d.0 == chr) {
                        stand(&mut solids, c, 0.6, 0.6, 2.3, 5);
                        b.inter.push(Inter { kind: I_PERK, pos: at(1.2), cost: PERKS[pk.1 as usize].2, param: pk.1, needs_power: true, active: true });
                    }
                }
            }
            col += 1;
        }
    }
    let mut counts = [0; 8];
    for &(tag, col, row, y) in def.parts {
        let c = center(col as usize, row as usize);
        b.inter.push(Inter { kind: I_PART, pos: v3(c.x, y + 0.6, c.z), cost: 0, param: tag * 8 + counts[tag as usize], needs_power: false, active: true });
        counts[tag as usize] += 1;
    }
    b.targets = def.targets.iter().map(|t| (v3(t.0, t.1, t.2), false)).collect();
    b.world.nav = Nav::build(&solids, v3(0.0, 0.0, 0.0), v3(size.0, 0.0, size.1), WALL_H);
    for (i, barr) in b.barrs.iter().enumerate() {
        for (dx, dz) in [(-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)] {
            if let Some(c) = b.world.nav.cell(barr.pos.x + dx, barr.pos.z + dz) {
                b.world.nav.barr[c] = i as u8 + 1;
            }
        }
    }
    b.world.solids = solids;
    b
}

impl Built {
    pub fn zone_of(&self, p: V3) -> i32 {
        let (c, r) = ((p.x / CELL) as usize, (p.z / CELL) as usize);
        self.def.zones.iter().position(|z| c >= z.1 && c <= z.3 && r >= z.2 && r <= z.4).map_or(-1, |i| i as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_are_well_formed_and_navigable() {
        for id in 0..MAPS.len() {
            let mut b = build(id);
            let def = b.def;
            assert!(def.rows.iter().all(|r| r.len() == def.rows[0].len()), "{}: ragged rows", def.name);
            assert!(b.spawns.len() >= 4 && b.zspawns.len() >= 4, "{}", def.name);
            assert_eq!(b.inter.iter().filter(|i| i.kind == I_DOOR).count(), def.doors.len());
            assert_eq!(b.inter.iter().filter(|i| i.kind == I_PERK).count(), def.perks.len());
            assert_eq!(b.inter.iter().filter(|i| i.kind == I_WALLBUY).count(), def.wallbuys.len());
            let nav_cell = |b: &Built, p: V3| b.world.nav.cell(p.x, p.z).unwrap();
            let src = [nav_cell(&b, b.spawns[0])];

            // Doors shut: the start area still has zombie entrances, but not all of them.
            b.world.nav.flow(&src, 0);
            let open = b.zspawns.iter().filter(|z| b.world.nav.dist[nav_cell(&b, **z)].is_finite()).count();
            assert!(open >= 2, "{}: start area needs spawners, has {open}", def.name);
            if !def.doors.is_empty() {
                assert!(open < b.zspawns.len(), "{}: doors should gate spawners", def.name);
            }

            // Doors open: everything is connected, and every interactable has a reachable cell beside it.
            b.world.nav.flow(&src, u32::MAX);
            for z in &b.zspawns {
                assert!(b.world.nav.dist[nav_cell(&b, *z)].is_finite(), "{}: spawner {z:?} is cut off", def.name);
            }
            for it in &b.inter {
                let near = (-2..=2).flat_map(|dx| (-2..=2).map(move |dz| (dx, dz))).any(|(dx, dz)| {
                    b.world.nav.cell(it.pos.x + dx as f32, it.pos.z + dz as f32).map_or(false, |c| b.world.nav.dist[c].is_finite())
                });
                assert!(near, "{}: interactable {it:?} unreachable", def.name);
            }
            for s in &b.spawns {
                assert!(!b.world.overlaps(&Aabb::feet(*s, 0.35, 1.8)), "{}: spawn inside geometry", def.name);
            }
        }
    }
}
