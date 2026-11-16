// Ten-point loadout screen: a board of picture slots (weapons with their attachments, perks,
// equipment, wildcards, streaks, ability and tonics) and a picker that opens when a slot is
// clicked. The rules live in Rust (`loadout.rs`); this builds the screen and asks the core to
// validate, so the UI can never disagree with what the host accepts.
import { CLASS_ORDER, WEAPON_CLASSES, fireMode, type Sim, type WeaponInfo } from '../core/sim';
import { itemArt } from './icons';

const STORE = 'gs.loadout';
const ERRORS = ['', 'Over the 10-point budget', 'Unknown item', 'Item in the wrong slot', 'Needs a wildcard', 'Duplicate item', 'Attachment does not fit that weapon'];
const WC = { gunsmith: 0, sidearm: 1, heavy: 2, surplus: 3 };

interface Option { id: number; name: string; desc?: string; group?: string; kind: string; slug?: string; weapon?: WeaponInfo; note?: string }
interface Slot { index: number; label: string; kind: string; options: () => Option[]; size?: 'weapon' | 'small'; needs?: number; free?: boolean }

export function savedLoadout(sim: Sim): number[] {
  try {
    const l = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (Array.isArray(l) && sim.validateLoadout(l) >= 0) return l;
  } catch { /* fall through to the default */ }
  return sim.defaultLoadout();
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Weapon stats as 0..1 bars. */
function bars(w: WeaponInfo): [string, number][] {
  const clamp = (v: number) => Math.max(0.04, Math.min(1, v));
  const rocket = (w.flags & 16) !== 0;
  return [
    ['Damage', clamp(rocket ? 1 : Math.sqrt(w.damage / 260))],
    ['Fire rate', clamp(w.rpm / 1100)],
    ['Range', clamp(w.range / 150)],
    ['Handling', clamp(1.15 - w.reload / 5)],
  ];
}
const barsHtml = (w: WeaponInfo) => `<div class="bars">${bars(w).map(([n, v]) => `<div><span>${n}</span><i><b style="width:${Math.round(v * 100)}%"></b></i></div>`).join('')}</div>`;

export class LoadoutEditor {
  loadout: number[];
  onChange: (l: number[]) => void = () => {};
  /** The slot whose picker is open, if any. */
  private picking: Slot | null = null;

  constructor(private sim: Sim, private root: HTMLElement, private pointsEl: HTMLElement, private errorEl: HTMLElement) {
    this.loadout = savedLoadout(sim);
  }

  private has(wildcard: number): boolean { return [15, 16, 17].some(i => this.loadout[i] === wildcard); }

  private weaponOptions(primary: boolean): Option[] {
    const c = this.sim.catalog;
    // Primaries: every class but pistols and launchers. Secondaries: pistols and launchers first,
    // then primaries (which need the Heavy Hitter wildcard; the core enforces that).
    return CLASS_ORDER
      .filter(k => !primary || (k !== 0 && k !== 7))
      .sort((a, b) => (primary ? 0 : +(a !== 0 && a !== 7) - +(b !== 0 && b !== 7)))
      .flatMap(k => {
        const heavy = !primary && k !== 0 && k !== 7;
        return c.weapons.filter(w => w.cls === k).map(w => ({
          id: w.id, name: w.name, kind: 'weapon', slug: w.slug, weapon: w, desc: `${fireMode(w)} · ${w.mag} rounds`,
          group: WEAPON_CLASSES[k], note: heavy ? 'Needs Heavy Hitter' : undefined,
        }));
      });
  }

  private groups(): { title: string; slots: Slot[]; cls: string }[] {
    const c = this.sim.catalog;
    const simple = (kind: string, list: { id: number; name: string; desc?: string }[]) => () => list.map(x => ({ ...x, kind }));
    const atts = (weaponSlot: number) => () => {
      const w = c.weapons[this.loadout[weaponSlot]];
      return w ? c.attachments.filter(a => a.classMask & (1 << w.cls)).map(a => ({ ...a, kind: 'attachment' })) : [];
    };
    const tier = (t: number) => simple('kitPerk', c.kitPerks.slice(t * 3, t * 3 + 3));
    const s = (index: number, label: string, kind: string, options: Slot['options'], extra: Partial<Slot> = {}): Slot => ({ index, label, kind, options, ...extra });
    return [
      { title: 'Primary', cls: 'g-weapon', slots: [
        s(0, 'Primary weapon', 'weapon', () => this.weaponOptions(true), { size: 'weapon' }),
        s(1, 'Attachment', 'attachment', atts(0)), s(2, 'Attachment', 'attachment', atts(0)),
        s(3, 'Attachment', 'attachment', atts(0), { needs: WC.gunsmith }),
      ] },
      { title: 'Secondary', cls: 'g-weapon', slots: [
        s(4, 'Secondary weapon', 'weapon', () => this.weaponOptions(false), { size: 'weapon' }),
        s(5, 'Attachment', 'attachment', atts(4)),
        s(6, 'Attachment', 'attachment', atts(4), { needs: WC.sidearm }),
      ] },
      { title: 'Perks', cls: 'g-perks', slots: [0, 1, 2].flatMap(t => [
        s(7 + t * 2, `Perk ${t + 1}`, 'kitPerk', tier(t)),
        s(8 + t * 2, `Perk ${t + 1}`, 'kitPerk', tier(t), { needs: WC.surplus + t }),
      ]) },
      { title: 'Equipment', cls: '', slots: [s(13, 'Lethal', 'lethal', simple('lethal', c.lethals)), s(14, 'Tactical', 'tactical', simple('tactical', c.tacticals))] },
      { title: 'Wildcards', cls: '', slots: [15, 16, 17].map(i => s(i, 'Wildcard', 'wildcard', simple('wildcard', c.wildcards))) },
      { title: 'Streaks', cls: '', slots: [18, 19, 20].map(i => s(i, 'Streak', 'streak', () => c.streaks.map(x => ({ ...x, kind: 'streak', note: `${x.score} score` })), { free: true })) },
      { title: 'Ability', cls: '', slots: [s(21, 'Ability', 'ability', simple('ability', c.abilities), { free: true })] },
      { title: 'Tonic pack', cls: '', slots: [22, 23, 24, 25, 26].map(i => s(i, 'Tonic', 'tonic', () => c.tonics.map(x => ({ ...x, kind: 'tonic', note: x.rare ? 'Rare' : undefined })), { free: true })) },
    ];
  }

  private current(slot: Slot): Option | undefined {
    const id = this.loadout[slot.index];
    return id >= 0 ? slot.options().find(o => o.id === id) ?? this.anyOption(slot, id) : undefined;
  }
  /** An equipped item the slot no longer offers (for example an attachment after a weapon change). */
  private anyOption(slot: Slot, id: number): Option | undefined {
    const c = this.sim.catalog;
    if (slot.kind === 'attachment') { const a = c.attachments[id]; return a && { ...a, kind: 'attachment' }; }
    if (slot.kind === 'weapon') { const w = c.weapons[id]; return w && { id, name: w.name, kind: 'weapon', slug: w.slug, weapon: w }; }
    return undefined;
  }

  render(): void {
    if (this.picking) { this.renderPicker(this.picking); return; }
    this.root.className = 'loadout-board';
    this.root.replaceChildren();
    for (const group of this.groups()) {
      const box = document.createElement('section');
      box.className = `lo-group ${group.cls}`;
      box.innerHTML = `<h3>${group.title}${group.slots[0].free ? ' <small>free</small>' : ''}</h3>`;
      const row = document.createElement('div');
      row.className = 'lo-slots';
      for (const slot of group.slots) row.append(this.slotTile(slot));
      box.append(row);
      this.root.append(box);
    }
    this.check();
  }

  private slotTile(slot: Slot): HTMLElement {
    const item = this.current(slot);
    const locked = slot.needs !== undefined && !this.has(slot.needs);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `lo-tile ${slot.size === 'weapon' ? 'big' : ''} ${item ? 'filled' : 'empty'} ${locked ? 'locked' : ''}`;
    tile.dataset.slot = String(slot.index);
    tile.setAttribute('aria-label', `${slot.label}: ${item ? item.name : 'empty'}`);
    const wildcard = slot.needs !== undefined ? this.sim.catalog.wildcards[slot.needs]?.name : '';
    const stats = item?.weapon && slot.size === 'weapon' ? barsHtml(item.weapon) : '';
    tile.innerHTML = `<div class="pic">${item ? itemArt(item.kind, item.id, item.name, item.slug) : itemArt('empty', 0)}</div>`
      + `<div class="cap"><b>${item ? esc(item.name) : slot.label}</b><span>${item ? esc(item.group ?? item.desc ?? '') : locked ? `Needs ${esc(wildcard ?? '')}` : 'Empty'}</span></div>${stats}`;
    tile.onclick = () => { this.picking = slot; this.render(); };
    return tile;
  }

  private renderPicker(slot: Slot): void {
    this.root.className = 'loadout-picker';
    this.root.replaceChildren();
    const head = document.createElement('div');
    head.className = 'lo-pick-head';
    head.innerHTML = `<h3>Choose: ${esc(slot.label)}</h3>`;
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back';
    back.onclick = () => { this.picking = null; this.render(); };
    head.append(back);
    this.root.append(head);

    const choose = (id: number) => {
      this.loadout[slot.index] = id;
      // A new weapon invalidates its attachments.
      if (slot.index === 0) [1, 2, 3].forEach(i => (this.loadout[i] = -1));
      if (slot.index === 4) [5, 6].forEach(i => (this.loadout[i] = -1));
      this.picking = null;
      this.render();
    };
    const list = document.createElement('div');
    list.className = `lo-options ${slot.kind === 'weapon' ? 'weapons' : ''}`;
    const options = slot.options();
    // Items already used in another slot of the same kind are shown but cannot be picked twice.
    const used = new Set(this.groups().flatMap(g => g.slots).filter(o => o.kind === slot.kind && o.index !== slot.index).map(o => this.loadout[o.index]).filter(v => v >= 0));
    let group = '';
    const card = (o: Option | null) => {
      const b = document.createElement('button');
      b.type = 'button';
      const taken = !!o && used.has(o.id) && slot.kind !== 'weapon';
      b.className = `lo-card ${o && this.loadout[slot.index] === o.id ? 'on' : ''} ${taken ? 'taken' : ''}`;
      b.disabled = taken;
      b.dataset.option = String(o ? o.id : -1);
      b.innerHTML = o
        ? `<div class="pic">${itemArt(o.kind, o.id, o.name, o.slug)}</div><div class="cap"><b>${esc(o.name)}</b><span>${esc(o.desc ?? '')}</span>${o.note || taken ? `<em>${esc(taken ? 'Already equipped' : o.note!)}</em>` : ''}</div>${o.weapon ? barsHtml(o.weapon) : ''}`
        : `<div class="pic">${itemArt('empty', 0).replace('M12 6v12M6 12h12', 'M7 7l10 10M17 7L7 17')}</div><div class="cap"><b>None</b><span>Leave this slot empty${slot.free ? '' : ' and keep the point'}</span></div>`;
      b.onclick = () => choose(o ? o.id : -1);
      return b;
    };
    list.append(card(null));
    for (const o of options) {
      if (o.group && o.group !== group) {
        group = o.group;
        const h = document.createElement('h4');
        h.textContent = group;
        list.append(h);
      }
      list.append(card(o));
    }
    if (!options.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = slot.kind === 'attachment' ? 'Choose a weapon for this slot first.' : 'Nothing to choose.';
      list.append(p);
    }
    this.root.append(list);
    this.check();
  }

  /** Validates through the core. Returns true if the loadout can be used. */
  check(): boolean {
    const r = this.sim.validateLoadout(this.loadout);
    const used = this.loadout.slice(0, 18).filter(v => v >= 0).length;
    this.pointsEl.innerHTML = `<span class="pips">${Array.from({ length: 10 }, (_, i) => `<i class="${i < used ? 'on' : ''}"></i>`).join('')}</span> ${used} / 10`;
    this.pointsEl.classList.toggle('over', used > 10);
    this.errorEl.textContent = r < 0 ? ERRORS[-r] ?? 'Invalid loadout' : '';
    if (r >= 0) {
      try { localStorage.setItem(STORE, JSON.stringify(this.loadout)); } catch { /* storage may be blocked */ }
      this.onChange(this.loadout);
    }
    return r >= 0;
  }

  /** Closes the picker (when the screen is left) so it reopens on the board. */
  close(): void { this.picking = null; }
  reset(): void { this.picking = null; this.loadout = this.sim.defaultLoadout(); this.render(); }
}
