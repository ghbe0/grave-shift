// Key bindings: which key or mouse button does what. Saved in the browser; every action can be
// rebound from Settings.
import { Btn } from '../core/sim';

export interface Action { id: string; label: string; def: string; btn?: number }

/** Every bindable action, in menu order. `btn` is the simulation button it holds down. */
export const ACTIONS: Action[] = [
  { id: 'forward', label: 'Move forward', def: 'KeyW' },
  { id: 'back', label: 'Move back', def: 'KeyS' },
  { id: 'left', label: 'Move left', def: 'KeyA' },
  { id: 'right', label: 'Move right', def: 'KeyD' },
  { id: 'jump', label: 'Jump / thrust', def: 'Space', btn: Btn.jump },
  { id: 'sprint', label: 'Sprint', def: 'ShiftLeft', btn: Btn.sprint },
  { id: 'crouch', label: 'Crouch / slide', def: 'KeyC', btn: Btn.crouch },
  { id: 'fire', label: 'Fire', def: 'Mouse0', btn: Btn.fire },
  { id: 'aim', label: 'Aim down sights', def: 'Mouse2', btn: Btn.ads },
  { id: 'reload', label: 'Reload', def: 'KeyR', btn: Btn.reload },
  { id: 'swap', label: 'Switch weapon', def: 'KeyX', btn: Btn.swap },
  { id: 'weapon1', label: 'Primary weapon', def: 'Digit1' },
  { id: 'weapon2', label: 'Secondary weapon', def: 'Digit2' },
  { id: 'melee', label: 'Knife', def: 'KeyV', btn: Btn.melee },
  { id: 'lethal', label: 'Lethal grenade', def: 'KeyG', btn: Btn.lethal },
  { id: 'tactical', label: 'Tactical', def: 'KeyE', btn: Btn.tactical },
  { id: 'ability', label: 'Ability', def: 'KeyQ', btn: Btn.ability },
  { id: 'use', label: 'Use / buy / revive', def: 'KeyF', btn: Btn.use },
  { id: 'tonic', label: 'Tonic', def: 'KeyZ', btn: Btn.tonic },
  { id: 'streak1', label: 'Streak 1', def: 'Digit4', btn: Btn.streak1 },
  { id: 'streak2', label: 'Streak 2', def: 'Digit5', btn: Btn.streak2 },
  { id: 'streak3', label: 'Streak 3', def: 'Digit6', btn: Btn.streak3 },
  { id: 'third', label: 'Third-person view (hold)', def: 'KeyT' },
  { id: 'scores', label: 'Scoreboard (hold)', def: 'Tab' },
  { id: 'map', label: 'Full map (hold)', def: 'KeyM' },
  { id: 'mapzoom', label: 'Minimap zoom', def: 'KeyN' },
];

export type Binds = Record<string, string>;
const STORE = 'gs.binds';

export function defaultBinds(): Binds { return Object.fromEntries(ACTIONS.map(a => [a.id, a.def])); }

export function loadBinds(): Binds {
  const out = defaultBinds();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (saved && typeof saved === 'object') for (const a of ACTIONS) if (typeof saved[a.id] === 'string' && saved[a.id].length < 24) out[a.id] = saved[a.id];
  } catch { /* defaults */ }
  return out;
}
export function saveBinds(b: Binds): void {
  try { localStorage.setItem(STORE, JSON.stringify(b)); } catch { /* storage may be blocked */ }
}

/** Binds `code` to `action`; whatever used that key before takes the action's old key, so nothing is left unbound. */
export function rebind(b: Binds, action: string, code: string): void {
  const other = ACTIONS.find(a => a.id !== action && b[a.id] === code);
  if (other) b[other.id] = b[action];
  b[action] = code;
}

/** A readable name for a key or mouse-button code. */
export function keyName(code: string): string {
  const mouse: Record<string, string> = { Mouse0: 'Left mouse', Mouse1: 'Middle mouse', Mouse2: 'Right mouse', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5' };
  if (mouse[code]) return mouse[code];
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, 'Arrow ').replace('ShiftLeft', 'Left Shift').replace('ShiftRight', 'Right Shift').replace('ControlLeft', 'Left Ctrl').replace('ControlRight', 'Right Ctrl').replace('AltLeft', 'Left Alt').replace('AltRight', 'Right Alt').replace(/^Numpad/, 'Numpad ');
}
