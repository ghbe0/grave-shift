// Pictures for loadout items. Weapons use side views generated from their 3D models
// (public/assets/weapons/<slug>.svg); everything else gets a simple original glyph drawn here.
// Glyphs are 24x24, drawn with strokes in the current colour.

const stroke = (d: string, extra = '') => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
const fill = (d: string) => `<path d="${d}" fill="currentColor"/>`;
const circle = (cx: number, cy: number, r: number, filled = false) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7"/>`;

const ATTACHMENTS = [
  circle(12, 12, 7) + circle(12, 12, 1.4, true) + stroke('M3 19h18'), // reflex sight
  stroke('M3 9h14v6H3zM17 10l4-1v6l-4-1M6 15v3M13 15v3') + circle(8, 12, 1.2, true), // 2x scope
  stroke('M8 3h8v13l-1 5H9l-1-5zM8 8h8M8 12h8'), // extended mag
  stroke('M4 12a8 8 0 0 1 14-5M20 12a8 8 0 0 1-14 5M18 3v4h-4M6 21v-4h4'), // speed loader
  stroke('M3 7h18v4H3zM10 11l-1 9h4l1-9'), // foregrip
  stroke('M2 10h20v4H2zM16 10v4M19 10v4M5 14v3h4v-3'), // long barrel
  stroke('M3 9h9v6H3zM12 12h3') + stroke('M15 12h7', ' stroke-dasharray="1.5 2"') + circle(22, 12, 0.8, true), // laser
  stroke('M9 3h6l1 8-2 10h-4L8 11zM7 7l-3 2M17 7l3 2M5 13l-2 1'), // quickdraw grip
  stroke('M12 2c3 3 4 6 4 10v8H8v-8c0-4 1-7 4-10zM8 15h8M10 20v2M14 20v2'), // hardened rounds
];
const KIT_PERKS = [
  stroke('M12 3l5 8h-3v5h-4v-5H7zM9 19h6M10 22h4'), // afterburner
  stroke('M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z') + stroke('M9 9h6M9 13h6'), // padding
  stroke('M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11zM12 9v6M9 12h6'), // hardy
  stroke('M5 8h14l-1.5 12h-11zM9 8V5a3 3 0 0 1 6 0v3M10 13h4'), // scavenger
  stroke('M4 14l4-9 3 6 3-8 2 9 4-3-3 12H8z'), // fast hands
  circle(12, 12, 8) + stroke('M12 2v5M12 17v5M2 12h5M17 12h5'), // steady
  stroke('M3 17h10l5-5-5-5M3 12h7M5 7h4'), // momentum
  fill('M13 2L4 14h6l-1 8 9-12h-6z'), // surge
  circle(12, 12, 8) + stroke('M12 6v12M15 9c-1-1.5-6-1.5-6 1s6 1.5 6 4-5 2.5-6 1'), // bounty
];
const LETHALS = [
  stroke('M9 7h6v2a6 6 0 1 1-6 0zM10 4h4v3h-4zM14 5h4l1 4M9 14h6'), // frag
  stroke('M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z') + circle(12, 12, 1.4, true), // impact charge
];
const TACTICALS = [
  circle(12, 12, 3) + stroke('M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2'), // stun pulse
  stroke('M8 3h8v4H8zM9 7v11a3 3 0 0 0 6 0V7M12 10v6M9.5 13h5'), // stim
];
const WILDCARDS = [
  stroke('M3 9h12v5H3zM15 11h6M6 14v4M10 14l1 6') + circle(19, 6, 2.5), // gunsmith
  stroke('M4 7h13v5H9l-1 7H5l1-7H4zM17 9h3') + stroke('M19 15v5M16.5 17.5h5'), // sidearm specialist
  stroke('M2 8h15v4H2zM17 9h5M5 12v5M10 12l1 5M2 18h20M2 21h20'), // heavy hitter
  ...[1, 2, 3].map(n => stroke('M5 4h14v16H5z') + `<text x="12" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" font-family="system-ui,sans-serif">${n}+</text>`),
];
const STREAKS = [
  circle(12, 12, 9) + circle(12, 12, 5) + circle(12, 12, 1.3, true) + stroke('M12 12l6-6'), // recon ping
  stroke('M4 10h16v10H4zM8 10V6h8v4M12 13v4M10 15h4M12 2v2'), // supply pod
  stroke('M2 9l9-3 2 3 9-2-9 5-3-2-6 1zM7 16l-1 3M12 15l-1 4M17 14l-1 4'), // strafing run
];
const ABILITIES = [
  stroke('M12 2v9M8 8l4 4 4-4M3 18l4-3 3 3 4-4 3 3 4-2M3 22h18'), // seismic slam
  stroke('M3 10h10v4H3zM13 12h3M6 14v4') + fill('M18 6l-3 6h3l-2 6 6-8h-3l2-4z'), // stormlance
  stroke('M3 8h13v4H9l-1 7H5l1-7H3zM16 9h5v2h-5M11 12v2'), // verdict
  circle(12, 13, 8) + stroke('M12 13V8M12 13l4 2M9 2h6M12 2v3'), // overclock
];
const TONICS = [
  circle(9, 10, 5) + circle(15, 15, 5), // windfall
  stroke('M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z'), // thick skin
  stroke('M5 9h14v11H5zM5 9l2-5h10l2 5M9 13h6v3H9z'), // deep pockets
  stroke('M12 2c2 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3-1-3 0-6 1-9z'), // overdrive
  stroke('M4 9h16v11H4zM4 13h16M12 9v11M12 9c-2-4-6-4-6-2s4 2 6 2c2 0 6 0 6-2s-4-2-6 2'), // cache call
  stroke('M4 12a8 8 0 1 1 3 6M4 19v-5h5') + circle(12, 12, 1.5, true), // phase step
  circle(12, 12, 9) + stroke('M7 13c1.5 4 8.5 4 10 0M8.5 9h.01M15.5 9h.01'), // last laugh
  stroke('M4 15c2-4 4-4 6 0s4 4 6 0 3-3 4-1M4 9c2-3 4-3 6 0s4 3 6 0 3-2 4-1'), // dead calm
];

const SETS: Record<string, string[]> = { attachment: ATTACHMENTS, kitPerk: KIT_PERKS, lethal: LETHALS, tactical: TACTICALS, wildcard: WILDCARDS, streak: STREAKS, ability: ABILITIES, tonic: TONICS };
export type IconKind = keyof typeof SETS | 'weapon' | 'empty';

/** Picture markup for an item. Weapons are images of the model; `name` gives initials as a last resort. */
export function itemArt(kind: string, id: number, name = '', slug = ''): string {
  if (kind === 'weapon' && slug) return `<img class="art weapon-art" src="assets/weapons/${slug}.svg" alt="" loading="lazy" draggable="false">`;
  const glyph = SETS[kind]?.[id];
  if (glyph) return `<svg class="art glyph" viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg>`;
  if (kind === 'empty') return `<svg class="art glyph empty" viewBox="0 0 24 24" aria-hidden="true">${stroke('M12 6v12M6 12h12')}</svg>`;
  const initials = name.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase();
  return `<span class="art initials">${initials}</span>`;
}
