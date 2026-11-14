//! Ten-point loadout rules. A loadout is a flat array of ids (-1 = empty) so it crosses the
//! Wasm boundary and the network unchanged.
use crate::catalog::*;

pub const L_PRIMARY: usize = 0;
pub const L_PATT: usize = 1; // 3 slots
pub const L_SECONDARY: usize = 4;
pub const L_SATT: usize = 5; // 2 slots
pub const L_PERK: usize = 7; // 3 tiers x 2 slots
pub const L_LETHAL: usize = 13;
pub const L_TACTICAL: usize = 14;
pub const L_WILD: usize = 15; // 3 slots
pub const L_STREAK: usize = 18; // 3 slots, free
pub const L_ABILITY: usize = 21; // free
pub const L_TONIC: usize = 22; // 5 slots, free
pub const L_LEN: usize = 27;
pub const POINTS: u32 = 10;

pub const WC_GUNSMITH: i32 = 0;
pub const WC_SIDEARM: i32 = 1;
pub const WC_HEAVY: i32 = 2;
pub const WC_SURPLUS1: i32 = 3;

pub type Loadout = [i32; L_LEN];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
#[repr(i32)]
pub enum Invalid {
    OverBudget = 1,
    UnknownItem = 2,
    WrongSlot = 3,
    NeedsWildcard = 4,
    Duplicate = 5,
    Incompatible = 6,
}

pub fn default_loadout() -> Loadout {
    let mut l = [-1; L_LEN];
    l[L_PRIMARY] = 3;
    l[L_PATT] = 0;
    l[L_PATT + 1] = 4;
    l[L_SECONDARY] = 0;
    l[L_PERK] = 0;
    l[L_PERK + 2] = 3;
    l[L_PERK + 4] = 6;
    l[L_LETHAL] = 0;
    l[L_TACTICAL] = 0;
    l[L_STREAK] = 0;
    l[L_STREAK + 1] = 1;
    l[L_STREAK + 2] = 2;
    l[L_ABILITY] = 0;
    for i in 0..5 {
        l[L_TONIC + i] = i as i32;
    }
    l
}

pub fn from_floats(d: &[f32]) -> Loadout {
    let mut l = [-1; L_LEN];
    for (i, v) in l.iter_mut().enumerate() {
        *v = d.get(i).map_or(-1, |f| if f.is_finite() { *f as i32 } else { -1 });
    }
    l
}

fn dupes(s: &[i32]) -> bool {
    s.iter().enumerate().any(|(i, a)| *a >= 0 && s[..i].contains(a))
}
fn is_primary(class: u8) -> bool {
    class != C_PISTOL && class != C_SPECIAL
}

/// Checks every rule and returns the points spent.
pub fn validate(l: &Loadout) -> Result<u32, Invalid> {
    let wild = &l[L_WILD..L_WILD + 3];
    let has = |w: i32| wild.contains(&w);
    if wild.iter().any(|w| *w >= WILDCARDS.len() as i32) {
        return Err(Invalid::UnknownItem);
    }
    let groups: [&[i32]; 6] = [wild, &l[L_PATT..L_PATT + 3], &l[L_SATT..L_SATT + 2], &l[L_PERK..L_PERK + 6], &l[L_STREAK..L_STREAK + 3], &l[L_TONIC..L_TONIC + 5]];
    if groups.iter().any(|g| dupes(g)) {
        return Err(Invalid::Duplicate);
    }

    // Weapons and their attachments.
    for (slot, atts, max_free, card) in [(L_PRIMARY, &l[L_PATT..L_PATT + 3], 2, WC_GUNSMITH), (L_SECONDARY, &l[L_SATT..L_SATT + 2], 1, WC_SIDEARM)] {
        let used = atts.iter().filter(|a| **a >= 0).count();
        if l[slot] < 0 {
            if used > 0 {
                return Err(Invalid::WrongSlot);
            }
            continue;
        }
        let d = weapon(l[slot]).filter(|d| d.class != C_SPECIAL).ok_or(Invalid::UnknownItem)?;
        let primary = is_primary(d.class);
        if slot == L_PRIMARY && !primary {
            return Err(Invalid::WrongSlot);
        }
        if slot == L_SECONDARY && primary && !has(WC_HEAVY) {
            return Err(Invalid::NeedsWildcard);
        }
        if used > max_free && !has(card) {
            return Err(Invalid::NeedsWildcard);
        }
        for a in atts.iter().filter(|a| **a >= 0) {
            let def = ATTACHMENTS.get(*a as usize).ok_or(Invalid::UnknownItem)?;
            if def.2 & (1 << d.class) == 0 {
                return Err(Invalid::Incompatible);
            }
        }
    }
    if l[L_PRIMARY] >= 0 && l[L_PRIMARY] == l[L_SECONDARY] {
        return Err(Invalid::Duplicate);
    }

    // Perks: slot pair `t` only accepts tier `t`; the second of a pair needs that tier's surplus card.
    for t in 0..3 {
        for s in 0..2 {
            let p = l[L_PERK + t * 2 + s];
            if p < 0 {
                continue;
            }
            if p >= KIT_PERKS.len() as i32 {
                return Err(Invalid::UnknownItem);
            }
            if p as usize / 3 != t {
                return Err(Invalid::WrongSlot);
            }
            if s == 1 && !has(WC_SURPLUS1 + t as i32) {
                return Err(Invalid::NeedsWildcard);
            }
        }
    }
    let in_range = |v: i32, n: usize| v < n as i32;
    if !in_range(l[L_LETHAL], LETHALS.len()) || !in_range(l[L_TACTICAL], TACTICALS.len()) || !in_range(l[L_ABILITY], ABILITIES.len()) {
        return Err(Invalid::UnknownItem);
    }
    if l[L_STREAK..L_STREAK + 3].iter().any(|s| !in_range(*s, STREAKS.len())) || l[L_TONIC..L_TONIC + 5].iter().any(|s| !in_range(*s, TONICS.len())) {
        return Err(Invalid::UnknownItem);
    }

    let points = l[..L_STREAK].iter().filter(|v| **v >= 0).count() as u32;
    if points > POINTS {
        return Err(Invalid::OverBudget);
    }
    Ok(points)
}

/// A loadout that is safe to spawn with: the input if valid, else the default.
pub fn sanitize(l: &Loadout) -> Loadout {
    if validate(l).is_ok() { *l } else { default_loadout() }
}

pub fn att_mask(atts: &[i32]) -> u32 {
    atts.iter().filter(|a| **a >= 0).fold(0, |m, a| m | (1 << *a))
}
pub fn perk_mask(l: &Loadout) -> u32 {
    att_mask(&l[L_PERK..L_PERK + 6])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_valid_and_within_budget() {
        assert_eq!(validate(&default_loadout()), Ok(9));
    }

    #[test]
    fn budget_is_ten_points() {
        let mut l = default_loadout();
        l[L_SATT] = 2; // 10
        assert_eq!(validate(&l), Ok(10));
        l[L_WILD] = WC_GUNSMITH; // 11
        assert_eq!(validate(&l), Err(Invalid::OverBudget));
    }

    #[test]
    fn wildcards_unlock_extra_slots() {
        let mut l = default_loadout();
        l[L_PATT + 2] = 5;
        assert_eq!(validate(&l), Err(Invalid::NeedsWildcard));
        l[L_TACTICAL] = -1;
        l[L_WILD] = WC_GUNSMITH;
        assert_eq!(validate(&l), Ok(10));

        let mut l = default_loadout();
        l[L_SECONDARY] = 5; // shotgun as secondary
        assert_eq!(validate(&l), Err(Invalid::NeedsWildcard));
        l[L_WILD] = WC_HEAVY;
        assert_eq!(validate(&l), Ok(10));

        let mut l = default_loadout();
        l[L_PERK + 1] = 1;
        assert_eq!(validate(&l), Err(Invalid::NeedsWildcard));
    }

    #[test]
    fn rejects_bad_items() {
        let mut l = default_loadout();
        l[L_PRIMARY] = 0; // pistol is not a primary
        assert_eq!(validate(&l), Err(Invalid::WrongSlot));
        let mut l = default_loadout();
        l[L_PRIMARY] = W_VERDICT; // ability weapon
        assert_eq!(validate(&l), Err(Invalid::UnknownItem));
        let mut l = default_loadout();
        l[L_PATT + 1] = 0; // same attachment twice
        assert_eq!(validate(&l), Err(Invalid::Duplicate));
        let mut l = default_loadout();
        l[L_PRIMARY] = 5;
        l[L_PATT] = 1; // scope on a shotgun
        assert_eq!(validate(&l), Err(Invalid::Incompatible));
        let mut l = default_loadout();
        l[L_PERK] = 4; // tier 2 perk in a tier 1 slot
        assert_eq!(validate(&l), Err(Invalid::WrongSlot));
        assert_eq!(sanitize(&l), default_loadout());
    }
}
