// Ten-point loadout editor. The rules live in Rust (`loadout.rs`); this only builds the form and
// asks the core to validate, so the UI can never disagree with what the host accepts.
import { CLASS_ORDER, WEAPON_CLASSES, fireMode, type Sim, type WeaponInfo } from '../core/sim';

const STORE = 'gs.loadout';
const ERRORS = ['', 'Over the 10-point budget', 'Unknown item', 'Item in the wrong slot', 'Needs a wildcard', 'Duplicate item', 'Attachment does not fit that weapon'];

interface Option { id: number; name: string; desc?: string; group?: string }
interface Slot { index: number; label: string; options: () => Option[] }

/** One line of numbers for a weapon's tooltip. */
function weaponSummary(w: WeaponInfo): string {
  const rate = w.flags & 16 ? '' : ` · ${Math.round(w.rpm)} rpm`;
  return `${fireMode(w)} · damage ${Math.round(w.damage)}${rate} · ${w.mag} rounds · reload ${w.reload.toFixed(1)} s`;
}

export function savedLoadout(sim: Sim): number[] {
  try {
    const l = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (Array.isArray(l) && sim.validateLoadout(l) >= 0) return l;
  } catch { /* fall through to the default */ }
  return sim.defaultLoadout();
}

export class LoadoutEditor {
  loadout: number[];
  onChange: (l: number[]) => void = () => {};

  constructor(private sim: Sim, private root: HTMLElement, private pointsEl: HTMLElement, private errorEl: HTMLElement) {
    this.loadout = savedLoadout(sim);
  }

  private groups(): [string, Slot[]][] {
    const c = this.sim.catalog;
    // Primaries: every class but pistols and launchers. Secondaries: pistols and launchers, or a
    // primary with the Heavy wildcard (the core enforces that).
    const weapons = (primary: boolean) => () => CLASS_ORDER
      .filter(k => !primary || (k !== 0 && k !== 7))
      .sort((a, b) => primary ? 0 : +(a !== 0 && a !== 7) - +(b !== 0 && b !== 7))
      .flatMap(k => {
        const heavy = !primary && k !== 0 && k !== 7;
        return c.weapons.filter(w => w.cls === k).map(w => ({ id: w.id, name: w.name, desc: weaponSummary(w), group: WEAPON_CLASSES[k] + (heavy ? ' (Heavy Hitter wildcard)' : '') }));
      });
    const atts = (weaponSlot: number) => () => {
      const w = c.weapons[this.loadout[weaponSlot]];
      return w ? c.attachments.filter(a => a.classMask & (1 << w.cls)) : [];
    };
    const tier = (t: number) => () => c.kitPerks.slice(t * 3, t * 3 + 3);
    const s = (index: number, label: string, options: Slot['options']): Slot => ({ index, label, options });
    return [
      ['Primary', [s(0, 'Weapon', weapons(true)), s(1, 'Attachment', atts(0)), s(2, 'Attachment', atts(0)), s(3, 'Attachment (Gunsmith)', atts(0))]],
      ['Secondary', [s(4, 'Weapon', weapons(false)), s(5, 'Attachment', atts(4)), s(6, 'Attachment (Sidearm Specialist)', atts(4))]],
      ['Perks', [0, 1, 2].flatMap(t => [s(7 + t * 2, `Tier ${t + 1}`, tier(t)), s(8 + t * 2, `Tier ${t + 1} (Surplus)`, tier(t))])],
      ['Equipment', [s(13, 'Lethal', () => c.lethals), s(14, 'Tactical', () => c.tacticals)]],
      ['Wildcards', [15, 16, 17].map(i => s(i, 'Wildcard', () => c.wildcards))],
      ['Streaks (free)', [18, 19, 20].map(i => s(i, 'Streak', () => c.streaks.map(x => ({ ...x, name: `${x.name} (${x.score})` }))))],
      ['Ability (free)', [s(21, 'Ability', () => c.abilities)]],
      ['Tonic pack (free)', [22, 23, 24, 25, 26].map(i => s(i, 'Tonic', () => c.tonics.map(x => ({ ...x, name: x.rare ? `${x.name} (rare)` : x.name }))))],
    ];
  }

  render(): void {
    this.root.replaceChildren();
    for (const [title, slots] of this.groups()) {
      const fs = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = title;
      fs.append(legend);
      for (const slot of slots) {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `${title} ${slot.label}`);
        sel.add(new Option(`- ${slot.label} -`, '-1'));
        let group: HTMLOptGroupElement | null = null;
        for (const o of slot.options()) {
          const opt = new Option(o.name, String(o.id));
          if (o.desc) opt.title = o.desc;
          if (o.group && o.group !== group?.label) {
            group = document.createElement('optgroup');
            group.label = o.group;
            sel.append(group);
          }
          (o.group && group ? group : sel).append(opt);
        }
        sel.value = String(this.loadout[slot.index]);
        if (sel.selectedIndex < 0) sel.value = '-1';
        sel.onchange = () => {
          this.loadout[slot.index] = +sel.value;
          // A new weapon invalidates its attachments.
          if (slot.index === 0) [1, 2, 3].forEach(i => (this.loadout[i] = -1));
          if (slot.index === 4) [5, 6].forEach(i => (this.loadout[i] = -1));
          this.render();
        };
        fs.append(sel);
      }
      this.root.append(fs);
    }
    this.check();
  }

  /** Validates through the core. Returns true if the loadout can be used. */
  check(): boolean {
    const r = this.sim.validateLoadout(this.loadout);
    const used = this.loadout.slice(0, 18).filter(v => v >= 0).length;
    this.pointsEl.textContent = `${used} / 10`;
    this.errorEl.textContent = r < 0 ? ERRORS[-r] ?? 'Invalid loadout' : '';
    if (r >= 0) {
      try { localStorage.setItem(STORE, JSON.stringify(this.loadout)); } catch { /* storage may be blocked */ }
      this.onChange(this.loadout);
    }
    return r >= 0;
  }

  reset(): void { this.loadout = this.sim.defaultLoadout(); this.render(); }
}
