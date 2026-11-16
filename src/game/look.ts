// Player customization: operator outfit, weapon camo, sight reticle, crosshair and calling card.
// Every choice is a small integer, so a look travels over the network as a handful of numbers and
// can be checked field by field (see cleanLook).
import { MAT } from '../gfx/renderer';

export type RGB = [number, number, number];

export interface Look {
  /** 0 = team colour, then VESTS[n - 1]. */
  vest: number;
  fatigues: number;
  headgear: number;
  camo: number;
  reticle: number;
  reticleColor: number;
  crosshair: number;
  crosshairColor: number;
  card: number;
  emblem: number;
}

export const VESTS: { name: string; rgb: RGB }[] = [
  { name: 'Signal Orange', rgb: [1.0, 0.42, 0.12] },
  { name: 'Cobalt', rgb: [0.18, 0.42, 1.0] },
  { name: 'Moss', rgb: [0.32, 0.62, 0.24] },
  { name: 'Crimson', rgb: [0.85, 0.12, 0.14] },
  { name: 'Violet', rgb: [0.55, 0.25, 0.9] },
  { name: 'Sand', rgb: [0.82, 0.7, 0.48] },
  { name: 'Graphite', rgb: [0.22, 0.23, 0.26] },
  { name: 'Ice', rgb: [0.75, 0.9, 1.0] },
];
/** Tints applied to the fabric material (values above 1 brighten the dark base cloth). */
export const FATIGUES: { name: string; rgb: RGB }[] = [
  { name: 'Olive Drab', rgb: [1.6, 1.7, 1.4] },
  { name: 'Urban Grey', rgb: [1.7, 1.7, 1.75] },
  { name: 'Desert Tan', rgb: [2.4, 2.0, 1.45] },
  { name: 'Night Black', rgb: [0.7, 0.7, 0.75] },
  { name: 'Navy', rgb: [0.9, 1.1, 1.9] },
  { name: 'Rust Brown', rgb: [2.0, 1.35, 1.0] },
];
export const HEADGEAR = ['Combat Helmet', 'Field Cap', 'Beanie', 'Hood', 'Bare Head'];
/** Camos and the material layer each one uses (-1: the gun's own finish). */
export const CAMOS: { name: string; layer: number }[] = [
  { name: 'Factory Finish', layer: -1 },
  { name: 'Woodland', layer: MAT.woodland },
  { name: 'Digital Urban', layer: MAT.digital },
  { name: 'Desert', layer: MAT.desert },
  { name: 'Tiger Stripe', layer: MAT.tiger },
  { name: 'Arctic', layer: MAT.arctic },
  { name: 'Carbon Fiber', layer: MAT.carbon },
  { name: 'Gilded', layer: MAT.gilded },
];
export const RETICLES = ['Dot', 'Circle Dot', 'Chevron', 'Cross', 'Ring', 'Triangle'];
export const CROSSHAIRS = ['Classic', 'Dot', 'Circle', 'T-Shape'];
export const COLORS: { name: string; css: string }[] = [
  { name: 'Red', css: '#ff3b30' },
  { name: 'Green', css: '#37d65f' },
  { name: 'Amber', css: '#ffb000' },
  { name: 'Cyan', css: '#32d4ff' },
  { name: 'Magenta', css: '#ff4fd8' },
  { name: 'White', css: '#ffffff' },
];
/** Calling card backgrounds. */
export const CARDS: { name: string; css: string }[] = [
  { name: 'Steel', css: 'linear-gradient(120deg, #2b3440, #151a21)' },
  { name: 'Ember', css: 'linear-gradient(120deg, #ff7a2f, #6b1d0b 70%)' },
  { name: 'Deep Sea', css: 'linear-gradient(120deg, #0f4c75, #0b1622 75%)' },
  { name: 'Toxic', css: 'radial-gradient(circle at 20% 30%, #9be22d, #1d3a10 70%)' },
  { name: 'Royal', css: 'linear-gradient(120deg, #6c2bd9, #1a0b33 75%)' },
  { name: 'Hazard', css: 'repeating-linear-gradient(135deg, #ffc400 0 14px, #1b1b1b 14px 28px)' },
  { name: 'Dusk', css: 'linear-gradient(180deg, #ff9a5a, #7b2f6b 55%, #1b1530)' },
  { name: 'Carbon', css: 'repeating-linear-gradient(45deg, #1a1a1a 0 4px, #262626 4px 8px)' },
];
/** Emblems: simple original SVG marks (24x24 view box). */
export const EMBLEMS: { name: string; svg: string }[] = [
  { name: 'Star', svg: '<path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6z"/>' },
  { name: 'Chevrons', svg: '<path d="M4 6l8 5 8-5v4l-8 5-8-5zm0 6l8 5 8-5v4l-8 5-8-5z"/>' },
  { name: 'Skull', svg: '<path d="M12 2a8 8 0 0 0-8 8c0 3 1.6 5 3 6v3h2v-2h2v2h2v-2h2v2h2v-3c1.4-1 3-3 3-6a8 8 0 0 0-8-8zm-3 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>' },
  { name: 'Crosshair', svg: '<path d="M11 2h2v4h-2zm0 16h2v4h-2zM2 11h4v2H2zm16 0h4v2h-4zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>' },
  { name: 'Flame', svg: '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3-1-3 0-6 1-9z"/>' },
  { name: 'Crown', svg: '<path d="M3 7l5 4 4-7 4 7 5-4-2 12H5z"/>' },
  { name: 'Bolt', svg: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>' },
  { name: 'Shield', svg: '<path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/>' },
];

export const DEFAULT_LOOK: Look = { vest: 0, fatigues: 0, headgear: 0, camo: 0, reticle: 0, reticleColor: 0, crosshair: 0, crosshairColor: 5, card: 0, emblem: 0 };
const RANGES: Record<keyof Look, number> = {
  vest: VESTS.length + 1, fatigues: FATIGUES.length, headgear: HEADGEAR.length, camo: CAMOS.length,
  reticle: RETICLES.length, reticleColor: COLORS.length, crosshair: CROSSHAIRS.length, crosshairColor: COLORS.length,
  card: CARDS.length, emblem: EMBLEMS.length,
};

/** A valid look from anything (saved data, or another player's machine): bad fields take defaults. */
export function cleanLook(raw: unknown): Look {
  const out = { ...DEFAULT_LOOK };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(RANGES) as (keyof Look)[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (Number.isInteger(v) && (v as number) >= 0 && (v as number) < RANGES[key]) out[key] = v as number;
  }
  return out;
}

export function loadLook(): Look {
  try { return cleanLook(JSON.parse(localStorage.getItem('gs.look') ?? 'null')); } catch { return { ...DEFAULT_LOOK }; }
}
export function saveLook(look: Look): void {
  try { localStorage.setItem('gs.look', JSON.stringify(look)); } catch { /* storage may be blocked */ }
}

/** Calling card markup: background, emblem and name. `name` must already be escaped. */
export function cardHtml(look: Look, name: string, small = false): string {
  const card = CARDS[look.card] ?? CARDS[0], emblem = EMBLEMS[look.emblem] ?? EMBLEMS[0];
  return `<span class="card${small ? ' small' : ''}" style="background:${card.css}"><svg viewBox="0 0 24 24" aria-hidden="true">${emblem.svg}</svg><b>${name}</b></span>`;
}

/** Sight reticle markup for aiming down sights. */
export function reticleSvg(style: number, color: string): string {
  const shapes = [
    '<circle cx="50" cy="50" r="3"/>',
    '<circle cx="50" cy="50" r="2.5"/><circle cx="50" cy="50" r="16" fill="none" stroke-width="2.5"/>',
    '<path d="M38 60 L50 46 L62 60" fill="none" stroke-width="4" stroke-linejoin="round"/>',
    '<path d="M50 34v12M50 54v12M34 50h12M54 50h12" stroke-width="3"/>',
    '<circle cx="50" cy="50" r="12" fill="none" stroke-width="3.5"/>',
    '<path d="M50 42 L57 56 L43 56 Z"/>',
  ];
  return `<svg viewBox="0 0 100 100" fill="${color}" stroke="${color}">${shapes[style] ?? shapes[0]}</svg>`;
}
