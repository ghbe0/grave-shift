//! Static game data: weapons, attachments, perks, abilities, tonics. All names are original to Grave Shift.

pub const C_PISTOL: u8 = 0;
pub const C_SMG: u8 = 1;
pub const C_AR: u8 = 2;
pub const C_SHOTGUN: u8 = 3;
pub const C_LMG: u8 = 4;
pub const C_SNIPER: u8 = 5;
pub const C_SPECIAL: u8 = 6;
/// Launchers: secondary slot only, fire a rocket instead of bullets.
pub const C_LAUNCHER: u8 = 7;

/// Can come out of the mystery crate.
pub const WF_CRATE: u32 = 1;
/// Rare crate-only weapon.
pub const WF_WONDER: u32 = 2;
/// Granted by an ability, never bought.
pub const WF_ABILITY: u32 = 4;
/// Hits arc to nearby enemies.
pub const WF_CHAIN: u32 = 8;
/// Fires an explosive rocket (a projectile) instead of a hitscan bullet.
pub const WF_ROCKET: u32 = 16;

pub struct WeaponDef {
    pub name: &'static str,
    pub slug: &'static str,
    pub class: u8,
    pub dmg: f32,
    pub head: f32,
    pub rpm: f32,
    pub auto: bool,
    pub mag: f32,
    pub reserve: f32,
    pub reload: f32,
    pub hip: f32,
    pub ads: f32,
    pub pellets: u32,
    /// Damage falloff: full until `r0`, `rmin` multiplier from `r1`.
    pub r0: f32,
    pub r1: f32,
    pub rmin: f32,
    pub ads_t: f32,
    pub zoom: f32,
    pub mobility: f32,
    pub kick_v: f32,
    pub kick_h: f32,
    pub cost: u32,
    pub pierce: u32,
    pub flags: u32,
    /// Shots per trigger pull for burst weapons (0: not a burst weapon).
    pub burst: u32,
}

macro_rules! w {
    ($name:expr, $slug:expr, $class:expr, dmg $dmg:expr, $head:expr; rpm $rpm:expr, $auto:expr; mag $mag:expr, $res:expr, $reload:expr;
     spread $hip:expr, $ads:expr, $pel:expr; range $r0:expr, $r1:expr, $rmin:expr; ads $adst:expr, $zoom:expr, $mob:expr;
     kick $kv:expr, $kh:expr; cost $cost:expr; pierce $pierce:expr; flags $flags:expr $(; burst $burst:expr)?) => {
        WeaponDef { name: $name, slug: $slug, class: $class, dmg: $dmg, head: $head, rpm: $rpm, auto: $auto, mag: $mag, reserve: $res,
            reload: $reload, hip: $hip, ads: $ads, pellets: $pel, r0: $r0, r1: $r1, rmin: $rmin, ads_t: $adst, zoom: $zoom, mobility: $mob,
            kick_v: $kv, kick_h: $kh, cost: $cost, pierce: $pierce, flags: $flags, burst: 0 $(+ $burst)? }
    };
}

pub const W_PISTOL: i32 = 0;
pub const W_ARC: i32 = 8;
pub const W_STORMLANCE: i32 = 9;
pub const W_VERDICT: i32 = 10;

pub static WEAPONS: [WeaponDef; 23] = [
    w!("P-9 Sidearm", "p9", C_PISTOL, dmg 40.0, 2.0; rpm 450.0, false; mag 12.0, 96.0, 1.4; spread 0.012, 0.002, 1; range 15.0, 35.0, 0.6; ads 0.15, 1.15, 1.0; kick 0.012, 0.004; cost 0; pierce 0; flags 0),
    w!("Hornet MP", "hornet", C_PISTOL, dmg 30.0, 1.8; rpm 900.0, true; mag 20.0, 160.0, 1.6; spread 0.03, 0.008, 1; range 10.0, 25.0, 0.55; ads 0.15, 1.15, 1.0; kick 0.008, 0.006; cost 750; pierce 0; flags WF_CRATE),
    w!("Vespa SMG", "vespa", C_SMG, dmg 34.0, 1.8; rpm 800.0, true; mag 32.0, 192.0, 1.9; spread 0.028, 0.006, 1; range 10.0, 28.0, 0.55; ads 0.18, 1.2, 1.0; kick 0.007, 0.005; cost 1000; pierce 0; flags WF_CRATE),
    w!("Kestrel AR", "kestrel", C_AR, dmg 42.0, 2.0; rpm 650.0, true; mag 30.0, 210.0, 2.2; spread 0.035, 0.003, 1; range 25.0, 55.0, 0.7; ads 0.25, 1.3, 0.95; kick 0.009, 0.004; cost 1400; pierce 0; flags WF_CRATE),
    w!("Field Carbine", "carbine", C_AR, dmg 75.0, 2.2; rpm 380.0, false; mag 12.0, 120.0, 2.0; spread 0.03, 0.0015, 1; range 35.0, 70.0, 0.75; ads 0.25, 1.4, 0.95; kick 0.018, 0.003; cost 500; pierce 0; flags WF_CRATE),
    w!("Breacher 12", "breacher", C_SHOTGUN, dmg 22.0, 1.5; rpm 80.0, false; mag 6.0, 42.0, 2.6; spread 0.075, 0.06, 8; range 6.0, 16.0, 0.25; ads 0.2, 1.15, 0.95; kick 0.05, 0.01; cost 1500; pierce 0; flags WF_CRATE),
    w!("Anvil LMG", "anvil", C_LMG, dmg 48.0, 2.0; rpm 600.0, true; mag 80.0, 320.0, 4.5; spread 0.045, 0.004, 1; range 30.0, 60.0, 0.75; ads 0.4, 1.3, 0.85; kick 0.008, 0.006; cost 2500; pierce 1; flags WF_CRATE),
    w!("Longshot", "longshot", C_SNIPER, dmg 400.0, 2.5; rpm 50.0, false; mag 5.0, 35.0, 3.0; spread 0.09, 0.0, 1; range 80.0, 120.0, 0.8; ads 0.35, 4.0, 0.9; kick 0.06, 0.01; cost 0; pierce 2; flags WF_CRATE),
    w!("Arc Caster", "arc", C_SPECIAL, dmg 1200.0, 1.0; rpm 180.0, false; mag 8.0, 48.0, 2.6; spread 0.01, 0.002, 1; range 60.0, 90.0, 0.8; ads 0.25, 1.3, 0.95; kick 0.02, 0.004; cost 0; pierce 5; flags WF_CRATE | WF_WONDER | WF_CHAIN),
    w!("Stormlance", "stormlance", C_SPECIAL, dmg 250.0, 1.0; rpm 300.0, true; mag 20.0, 0.0, 9.0; spread 0.02, 0.01, 1; range 30.0, 50.0, 0.7; ads 0.2, 1.15, 1.0; kick 0.006, 0.004; cost 0; pierce 0; flags WF_ABILITY | WF_CHAIN),
    w!("Verdict", "verdict", C_SPECIAL, dmg 5000.0, 1.0; rpm 150.0, false; mag 6.0, 0.0, 9.0; spread 0.004, 0.0, 1; range 80.0, 120.0, 0.9; ads 0.15, 1.2, 1.0; kick 0.05, 0.006; cost 0; pierce 2; flags WF_ABILITY),
    w!("Talon Burst", "talon", C_AR, dmg 46.0, 2.0; rpm 900.0, false; mag 30.0, 210.0, 2.3; spread 0.034, 0.002, 1; range 30.0, 60.0, 0.72; ads 0.26, 1.3, 0.95; kick 0.008, 0.003; cost 1300; pierce 0; flags WF_CRATE; burst 3),
    w!("Mako Bullpup", "mako", C_AR, dmg 36.0, 2.0; rpm 780.0, true; mag 32.0, 224.0, 2.0; spread 0.03, 0.004, 1; range 20.0, 45.0, 0.68; ads 0.22, 1.25, 0.97; kick 0.008, 0.006; cost 1500; pierce 0; flags WF_CRATE),
    w!("Wasp PDW", "wasp", C_SMG, dmg 24.0, 1.6; rpm 1050.0, true; mag 40.0, 240.0, 2.0; spread 0.032, 0.009, 1; range 8.0, 22.0, 0.5; ads 0.16, 1.15, 1.02; kick 0.006, 0.006; cost 1100; pierce 0; flags WF_CRATE),
    w!("Bastion SMG", "bastion", C_SMG, dmg 44.0, 1.8; rpm 600.0, true; mag 25.0, 175.0, 2.1; spread 0.03, 0.007, 1; range 12.0, 30.0, 0.6; ads 0.2, 1.2, 0.99; kick 0.01, 0.004; cost 1200; pierce 0; flags WF_CRATE),
    w!("Reaper Auto", "reaper", C_SHOTGUN, dmg 15.0, 1.4; rpm 260.0, true; mag 8.0, 48.0, 3.0; spread 0.085, 0.07, 8; range 5.0, 13.0, 0.25; ads 0.22, 1.1, 0.93; kick 0.03, 0.01; cost 2000; pierce 0; flags WF_CRATE),
    w!("Twinfang", "twinfang", C_SHOTGUN, dmg 30.0, 1.5; rpm 200.0, false; mag 2.0, 32.0, 2.4; spread 0.09, 0.075, 10; range 5.0, 12.0, 0.2; ads 0.2, 1.1, 0.96; kick 0.07, 0.015; cost 1200; pierce 0; flags WF_CRATE),
    w!("Torrent LMG", "torrent", C_LMG, dmg 36.0, 2.0; rpm 800.0, true; mag 100.0, 400.0, 5.0; spread 0.05, 0.005, 1; range 25.0, 55.0, 0.7; ads 0.42, 1.3, 0.84; kick 0.007, 0.007; cost 2800; pierce 1; flags WF_CRATE),
    w!("Hawkeye DMR", "hawkeye", C_SNIPER, dmg 110.0, 2.2; rpm 300.0, false; mag 15.0, 105.0, 2.5; spread 0.06, 0.0015, 1; range 50.0, 90.0, 0.8; ads 0.3, 2.6, 0.92; kick 0.025, 0.005; cost 2200; pierce 1; flags WF_CRATE),
    w!("Monolith .50", "monolith", C_SNIPER, dmg 700.0, 2.5; rpm 40.0, false; mag 4.0, 28.0, 3.6; spread 0.1, 0.0, 1; range 100.0, 150.0, 0.85; ads 0.42, 5.0, 0.86; kick 0.08, 0.012; cost 0; pierce 3; flags WF_CRATE),
    w!("Mamba Revolver", "mamba", C_PISTOL, dmg 110.0, 2.0; rpm 180.0, false; mag 6.0, 48.0, 2.4; spread 0.02, 0.002, 1; range 20.0, 40.0, 0.65; ads 0.16, 1.15, 1.0; kick 0.04, 0.008; cost 900; pierce 0; flags WF_CRATE),
    w!("Rattler Burst", "rattler", C_PISTOL, dmg 34.0, 1.8; rpm 1100.0, false; mag 18.0, 126.0, 1.6; spread 0.015, 0.003, 1; range 14.0, 32.0, 0.6; ads 0.15, 1.15, 1.0; kick 0.01, 0.004; cost 800; pierce 0; flags WF_CRATE; burst 3),
    w!("Comet Launcher", "comet", C_LAUNCHER, dmg 1500.0, 1.0; rpm 50.0, false; mag 1.0, 6.0, 3.2; spread 0.01, 0.002, 1; range 100.0, 150.0, 1.0; ads 0.4, 1.4, 0.85; kick 0.05, 0.01; cost 0; pierce 0; flags WF_CRATE | WF_ROCKET),
];
pub const W_TALON: i32 = 11;
pub const W_RATTLER: i32 = 21;
pub const W_COMET: i32 = 22;

pub fn weapon(id: i32) -> Option<&'static WeaponDef> {
    WEAPONS.get(usize::try_from(id).ok()?)
}

/// (name, description, allowed-class mask)
pub static ATTACHMENTS: [(&str, &str, u32); 9] = [
    ("Reflex Sight", "Clean sight picture, tighter aimed fire", 0x3F),
    ("2x Scope", "Extra zoom for rifles", (1 << C_AR) | (1 << C_LMG) | (1 << C_SNIPER)),
    ("Extended Mag", "40% larger magazine", 0x3F),
    ("Speed Loader", "Reload 25% faster", 0x3F),
    ("Foregrip", "25% less recoil", 0x3F & !(1 << C_PISTOL)),
    ("Long Barrel", "35% more range", 0x3F),
    ("Laser", "Tighter hip fire", 0x3F),
    ("Quickdraw Grip", "Aim down sights faster", 0x3F),
    ("Hardened Rounds", "Bullets pierce one more target", 0x3F),
];
pub const A_REFLEX: u32 = 1 << 0;
pub const A_SCOPE: u32 = 1 << 1;
pub const A_EXTMAG: u32 = 1 << 2;
pub const A_LOADER: u32 = 1 << 3;
pub const A_GRIP: u32 = 1 << 4;
pub const A_BARREL: u32 = 1 << 5;
pub const A_LASER: u32 = 1 << 6;
pub const A_QUICK: u32 = 1 << 7;
pub const A_HARD: u32 = 1 << 8;

/// Survival perk machines: (name, description, cost). Four-perk limit per player.
pub static PERKS: [(&str, &str, u32); 6] = [
    ("Ironhide", "Double health", 2500),
    ("Quickhands", "Reload twice as fast", 3000),
    ("Hair Trigger", "Fire a third faster", 2000),
    ("Second Wind", "Revive yourself once; revive others faster", 1500),
    ("Marathon", "Move faster, thrust recharges faster", 2000),
    ("Deadeye", "Headshots hit 50% harder, tighter hip fire", 2500),
];
pub const PERK_LIMIT: u32 = 4;
pub const SP_IRONHIDE: u32 = 1;
pub const SP_QUICKHANDS: u32 = 2;
pub const SP_HAIR: u32 = 4;
pub const SP_SECOND: u32 = 8;
pub const SP_MARATHON: u32 = 16;
pub const SP_DEADEYE: u32 = 32;

/// Loadout perks, three per tier: (name, description).
pub static KIT_PERKS: [(&str, &str); 9] = [
    ("Afterburner", "Thrust recharges 50% faster"),
    ("Padding", "Take 65% less explosive damage"),
    ("Hardy", "Health regenerates sooner"),
    ("Scavenger", "Kills resupply ammo and equipment"),
    ("Fast Hands", "Swap weapons twice as fast, reload faster"),
    ("Steady", "Tighter hip fire"),
    ("Momentum", "Slides carry further, move 5% faster"),
    ("Surge", "Ability charges 25% faster"),
    ("Bounty", "Earn 25% more score"),
];
pub const KP_AFTERBURNER: u32 = 1;
pub const KP_PADDING: u32 = 2;
pub const KP_HARDY: u32 = 4;
pub const KP_SCAVENGER: u32 = 8;
pub const KP_FASTHANDS: u32 = 16;
pub const KP_STEADY: u32 = 32;
pub const KP_MOMENTUM: u32 = 64;
pub const KP_SURGE: u32 = 128;
pub const KP_BOUNTY: u32 = 256;

pub static LETHALS: [(&str, &str); 2] = [("Frag", "Bouncing grenade on a fuse"), ("Impact Charge", "Detonates on contact")];
pub static TACTICALS: [(&str, &str); 2] = [("Stun Pulse", "Slows everything caught in the blast"), ("Stim", "Instantly restores health")];

pub static WILDCARDS: [(&str, &str); 6] = [
    ("Gunsmith", "Third attachment on your primary"),
    ("Sidearm Specialist", "Second attachment on your secondary"),
    ("Heavy Hitter", "Carry a primary weapon in the secondary slot"),
    ("Tier 1 Surplus", "Second tier 1 perk"),
    ("Tier 2 Surplus", "Second tier 2 perk"),
    ("Tier 3 Surplus", "Second tier 3 perk"),
];

/// Score streak rewards: (name, description, score needed in one life).
pub static STREAKS: [(&str, &str, u32); 3] = [
    ("Recon Ping", "Reveals enemies for 20 seconds", 400),
    ("Supply Pod", "Refills ammo and half your ability", 700),
    ("Strafing Run", "Calls a line of explosions where you aim", 1100),
];

pub const AB_INSTANT: u8 = 0;
pub const AB_WEAPON: u8 = 1;
pub const AB_BUFF: u8 = 2;
pub struct AbilityDef {
    pub name: &'static str,
    pub desc: &'static str,
    pub kind: u8,
    pub weapon: i32,
    pub duration: f32,
    /// Seconds to fill from time alone.
    pub charge_time: f32,
    /// Score needed to fill from score alone.
    pub charge_score: f32,
}
pub static ABILITIES: [AbilityDef; 4] = [
    AbilityDef { name: "Seismic Slam", desc: "Crash down and blast everything around you", kind: AB_INSTANT, weapon: -1, duration: 0.0, charge_time: 200.0, charge_score: 900.0 },
    AbilityDef { name: "Stormlance", desc: "Arc gun whose shots chain between enemies", kind: AB_WEAPON, weapon: W_STORMLANCE, duration: 30.0, charge_time: 240.0, charge_score: 1100.0 },
    AbilityDef { name: "Verdict", desc: "Six-round hand cannon that drops anything", kind: AB_WEAPON, weapon: W_VERDICT, duration: 25.0, charge_time: 240.0, charge_score: 1100.0 },
    AbilityDef { name: "Overclock", desc: "Move and fire faster with unlimited thrust", kind: AB_BUFF, weapon: -1, duration: 9.0, charge_time: 170.0, charge_score: 800.0 },
];

pub const TN_TIMED: u8 = 0;
pub const TN_ROUNDS: u8 = 1;
pub const TN_INSTANT: u8 = 2;
pub const TN_ACTIVATED: u8 = 3;
pub const TN_AUTO: u8 = 4;
pub struct TonicDef {
    pub name: &'static str,
    pub desc: &'static str,
    pub kind: u8,
    /// Seconds, rounds or uses depending on `kind`.
    pub amount: f32,
    pub rare: bool,
}
pub const T_WINDFALL: i32 = 0;
pub const T_THICK: i32 = 1;
pub const T_POCKETS: i32 = 2;
pub const T_OVERDRIVE: i32 = 3;
pub const T_CACHE: i32 = 4;
pub const T_PHASE: i32 = 5;
pub const T_LAUGH: i32 = 6;
pub const T_CALM: i32 = 7;
pub static TONICS: [TonicDef; 8] = [
    TonicDef { name: "Windfall", desc: "Double points for 60 seconds", kind: TN_TIMED, amount: 60.0, rare: false },
    TonicDef { name: "Thick Skin", desc: "Take half damage for 3 rounds", kind: TN_ROUNDS, amount: 3.0, rare: false },
    TonicDef { name: "Deep Pockets", desc: "Reserve ammo trickles back for 3 rounds", kind: TN_ROUNDS, amount: 3.0, rare: false },
    TonicDef { name: "Overdrive", desc: "Unlimited thrust for 45 seconds", kind: TN_TIMED, amount: 45.0, rare: false },
    TonicDef { name: "Cache Call", desc: "Drops a Resupply at your feet", kind: TN_INSTANT, amount: 1.0, rare: false },
    TonicDef { name: "Phase Step", desc: "Activate to blink back to the start. Two uses", kind: TN_ACTIVATED, amount: 2.0, rare: true },
    TonicDef { name: "Last Laugh", desc: "When downed, explode and get back up", kind: TN_AUTO, amount: 1.0, rare: true },
    TonicDef { name: "Dead Calm", desc: "Activate: the dead ignore you for 12 seconds", kind: TN_ACTIVATED, amount: 1.0, rare: true },
];

/// Effects a re-upgraded weapon can roll at the Overclock Bench.
pub static MODS: [&str; 6] = ["None", "Arc Chain", "Cinder", "Shockwave", "Turncoat", "Starburst"];
pub static POWERUPS: [&str; 5] = ["Resupply", "One-Shot", "Double Pay", "Purge", "Rebuild"];

pub const UPGRADE_COST: u32 = 5000;
pub const REROLL_COST: u32 = 2500;
pub const CRATE_COST: u32 = 950;
pub const TONIC_COST: u32 = 500;
pub const SHIELD_COST: u32 = 500;
