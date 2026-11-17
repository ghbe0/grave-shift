// Picture and icon pickers in place of dropdowns. Each one wraps a hidden <select>, which stays the
// source of truth: code reads and sets `select.value` and listens for `change` as before, and the
// tiles follow along (options added, values set from code, the select disabled for guests).

export type Art = (value: string, label: string) => string;

const svg = (body: string, view = '0 0 48 48') => `<svg viewBox="${view}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Game mode pictograms, by mode id. */
export const MODE_ICONS: string[] = [
  // Survival: a skull.
  svg('<path d="M24 6c-9 0-15 6-15 14 0 5 2 8 5 10v6h20v-6c3-2 5-5 5-10 0-8-6-14-15-14z"/><circle cx="18" cy="21" r="3.6" fill="currentColor"/><circle cx="30" cy="21" r="3.6" fill="currentColor"/><path d="M24 26l-2 4h4z" fill="currentColor"/><path d="M19 36v5M24 36v5M29 36v5"/>'),
  // Free-for-all: a crosshair.
  svg('<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="3" fill="currentColor"/><path d="M24 4v10M24 34v10M4 24h10M34 24h10"/>'),
  // Team deathmatch: two shields.
  svg('<path d="M14 9l9 3v10c0 7-4 12-9 15-5-3-9-8-9-15V12z"/><path d="M34 9l9 3v10c0 7-4 12-9 15-5-3-9-8-9-15V12z" fill="currentColor" fill-opacity=".35"/>'),
  // Domination: three flags.
  svg('<path d="M8 42V8M24 42V8M40 42V8"/><path d="M8 9h9l-2 4 2 4H8M24 9h9l-2 4 2 4h-9M40 9h-0"/><path d="M40 9h-9l2 4-2 4h9" fill="currentColor" fill-opacity=".35"/>'),
  // King of the hill: a crown over a hill.
  svg('<path d="M11 22l4-12 9 7 9-7 4 12z" fill="currentColor" fill-opacity=".35"/><path d="M3 42c6-10 13-14 21-14s15 4 21 14z"/>'),
  // Tag hunt: a dog tag on its chain.
  svg('<rect x="13" y="14" width="22" height="28" rx="8"/><circle cx="24" cy="20" r="2"/><path d="M18 30h12M18 35h8"/><path d="M24 18C20 10 16 6 10 5M24 18c4-8 8-12 14-13" stroke-dasharray="2 3"/>'),
  // Weapon ladder: a ladder.
  svg('<path d="M14 4v40M34 4v40M14 12h20M14 22h20M14 32h20M14 42h20"/>'),
];

const clock = (frac: number) => {
  const a = frac * Math.PI * 2, x = 24 + Math.sin(a) * 15, y = 24 - Math.cos(a) * 15;
  const arc = frac >= 1 || frac <= 0 ? (frac >= 1 ? '<circle cx="24" cy="24" r="15" fill="currentColor" fill-opacity=".35" stroke="none"/>' : '') : `<path d="M24 24V9A15 15 0 ${frac > 0.5 ? 1 : 0} 1 ${x.toFixed(1)} ${y.toFixed(1)}z" fill="currentColor" fill-opacity=".35" stroke="none"/>`;
  return svg(`${arc}<circle cx="24" cy="24" r="17"/><path d="M24 4v3M20 3h8"/><path d="M24 24l${(Math.sin(a) * 10).toFixed(1)} ${(-Math.cos(a) * 10).toFixed(1)}"/>`);
};
const infinity = svg('<path d="M24 24c-5-7-15-7-15 0s10 7 15 0 15-7 15 0-10 7-15 0z"/>');
const heart = (frac: number) => svg(`<defs><clipPath id="hc${Math.round(frac * 100)}"><rect x="0" y="${(44 - 38 * Math.min(1, frac / 3)).toFixed(1)}" width="48" height="48"/></clipPath></defs><path d="M24 41S6 30 6 17a9 9 0 0118-3 9 9 0 0118 3c0 13-18 24-18 24z" fill="currentColor" fill-opacity=".55" stroke="none" clip-path="url(#hc${Math.round(frac * 100)})"/><path d="M24 41S6 30 6 17a9 9 0 0118-3 9 9 0 0118 3c0 13-18 24-18 24z"/>`);
const target = svg('<circle cx="24" cy="24" r="17"/><circle cx="24" cy="24" r="10"/><circle cx="24" cy="24" r="3" fill="currentColor"/>');
const respawn = svg('<path d="M38 18A15 15 0 1 0 39 30"/><path d="M39 8v10H29"/>');
const wave = svg('<path d="M6 40V28M14 40V22M22 40V16M30 40V22M38 40V10"/>');
const coins = svg('<ellipse cx="24" cy="12" rx="13" ry="5"/><path d="M11 12v8c0 3 6 5 13 5s13-2 13-5v-8M11 20v8c0 3 6 5 13 5s13-2 13-5v-8M11 28v8c0 3 6 5 13 5s13-2 13-5v-8"/>');
const gauge = (frac: number) => { const a = -2.3 + frac * 4.6; return svg(`<path d="M8 34a16 16 0 1132 0"/><path d="M24 30l${(Math.sin(a) * 13).toFixed(1)} ${(-Math.cos(a) * 13).toFixed(1)}"/><circle cx="24" cy="30" r="2.5" fill="currentColor"/>`); };
const bars = (n: number) => svg([0, 1, 2, 3].map(i => `<rect x="${7 + i * 9}" y="${34 - i * 8}" width="6" height="${8 + i * 8}" rx="1" ${i < n ? 'fill="currentColor"' : 'opacity=".35"'}/>`).join(''));
const phone = (state: string) => svg(`<rect x="15" y="5" width="18" height="38" rx="4"/><path d="M21 38h6"/>${state === 'on' ? '<circle cx="24" cy="22" r="5" fill="currentColor"/>' : state === 'off' ? '<path d="M9 9l30 30"/>' : '<path d="M19 22h10M24 17v10" />'}`);
const square = (px: number) => { const s = px ? 10 + (px / 250) * 26 : 0; return s ? svg(`<rect x="${24 - s / 2}" y="${24 - s / 2}" width="${s}" height="${s}" rx="3"/><circle cx="24" cy="24" r="2" fill="currentColor"/>`) : svg('<rect x="9" y="9" width="30" height="30" rx="3" opacity=".4"/><path d="M8 8l32 32"/>'); };
const rings = (m: number) => svg(`<circle cx="24" cy="24" r="${(6 + (m / 55) * 13).toFixed(1)}" fill="currentColor" fill-opacity=".25"/><circle cx="24" cy="24" r="19" opacity=".45"/><path d="M24 20l3 7h-6z" fill="currentColor"/>`);
const turn = (on: boolean) => on ? svg('<circle cx="24" cy="24" r="15"/><path d="M24 15l4 9h-8z" fill="currentColor"/><path d="M36 9a20 20 0 018 9M44 12v6h-6"/>') : svg('<circle cx="24" cy="24" r="15"/><path d="M24 15l4 9h-8z" fill="currentColor"/><text x="24" y="44" font-size="9" fill="currentColor" stroke="none" text-anchor="middle" font-weight="700">N</text>');

const short = (label: string) => {
  const m = label.match(/^(.*?)\s*\((.*)\)$/);
  return m ? `${m[1]}<small>${m[2]}</small>` : label;
};

/** The art for each picker by the id of the select it replaces. */
export const PICKER_ART: Record<string, Art> = {
  'time': v => (+v ? clock(Math.min(1, +v / 1800)) : infinity),
  'score': v => (+v ? target : infinity),
  'respawn': v => respawn + `<b class="pk-num">${+v ? `${v}s` : '0'}</b>`,
  'health': v => heart(+v),
  'round': () => wave,
  'points': () => coins,
  'set-fps': (v, l) => gauge(+v ? Math.min(1, +v / 240) : l.match(/\d+/) ? Math.min(1, +l.match(/\d+/)![0] / 240) : 0.5),
  'set-tex': v => bars({ low: 1, medium: 2, high: 3, ultra: 4 }[v] ?? 2),
  'set-touch': v => phone(v),
  'set-mapsize': v => square(+v),
  'set-maprotate': v => turn(v === '1'),
  'set-maprange': v => rings(+v),
};

/** Turns `sel` into a row of tiles drawn by `art`. Returns a function that redraws them. */
export function tilePicker(sel: HTMLSelectElement, art: Art, cls = ''): () => void {
  const box = document.createElement('div');
  box.className = `picker ${cls}`;
  box.setAttribute('role', 'radiogroup');
  sel.hidden = true;
  sel.after(box);
  let drawn = '';
  const render = () => {
    const opts = [...sel.options];
    const key = opts.map(o => `${o.value}:${o.text}`).join('|') + (sel.disabled ? '!' : '');
    if (key !== drawn) {
      drawn = key;
      box.innerHTML = opts.map(o => `<button type="button" class="pk" role="radio" data-v="${o.value}"${sel.disabled ? ' disabled' : ''}><span class="pk-art">${art(o.value, o.text)}</span><span class="pk-label">${short(o.text)}</span></button>`).join('');
    }
    for (const b of box.children as HTMLCollectionOf<HTMLButtonElement>) {
      const on = b.dataset.v === valueDesc.get!.call(sel);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    box.classList.toggle('locked', sel.disabled);
  };
  box.onclick = e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.pk');
    if (!b || sel.disabled || b.dataset.v === sel.value) return;
    valueDesc.set!.call(sel, b.dataset.v!);
    render();
    b.classList.remove('bump');
    void b.offsetWidth;
    b.classList.add('bump');
    sel.dispatchEvent(new Event('change'));
  };
  // Values and the disabled flag set from code redraw the tiles.
  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!;
  const disDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'disabled')!;
  Object.defineProperty(sel, 'value', { get: () => valueDesc.get!.call(sel), set: v => { valueDesc.set!.call(sel, v); render(); }, configurable: true });
  Object.defineProperty(sel, 'disabled', { get: () => disDesc.get!.call(sel), set: v => { disDesc.set!.call(sel, v); render(); }, configurable: true });
  new MutationObserver(render).observe(sel, { childList: true, subtree: true, characterData: true });
  render();
  return render;
}
