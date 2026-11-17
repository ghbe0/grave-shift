// Keyboard and mouse input with Pointer Lock, plus on-screen touch controls on phones and tablets.
// Produces look deltas and a button bitmask that matches the simulation's `B_*` constants.
import { Btn } from '../core/sim';
import type { TouchControls } from './touch';

import { ACTIONS, loadBinds, type Binds } from './binds';

export class Input {
  private keyButtons = 0;
  /** Presses not yet seen by the simulation, so a very quick tap or click is never lost. */
  private latched = 0;
  /** On-screen controls, when touch mode is on. Engaged while a match is being played. */
  touch: TouchControls | null = null;
  private engaged = false;
  /** Requested weapon slot for the next command, or -1. */
  slot = -1;
  scoreboard = false;
  sensitivity = 1;
  private keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  onUnlock: () => void = () => {};
  /** Current key bindings (action id -> key or mouse-button code). */
  binds: Binds = loadBinds();
  /** While true, key and mouse presses are being captured by the settings screen. */
  capturing = false;
  /** Held while the third-person key is down. */
  thirdPerson = false;
  private act = new Map<string, { id: string; btn?: number }>();

  /** Rebuilds the key lookup after bindings change. */
  applyBinds(): void {
    this.act.clear();
    for (const a of ACTIONS) this.act.set(this.binds[a.id], { id: a.id, btn: a.btn });
  }
  private press(code: string, down: boolean): void {
    const a = this.act.get(code);
    if (!a) return;
    if (a.btn) { if (down) { this.keyButtons |= a.btn; this.latched |= a.btn; } else this.keyButtons &= ~a.btn; }
    if (down) this.keys.add(a.id); else this.keys.delete(a.id);
    if (a.id === 'weapon1' && down) this.slot = 0;
    if (a.id === 'weapon2' && down) this.slot = 1;
    if (a.id === 'scores') this.scoreboard = down;
    if (a.id === 'third') this.thirdPerson = down;
  }

  constructor(private canvas: HTMLCanvasElement) {
    this.applyBinds();
    addEventListener('keydown', e => {
      if (!this.locked || this.capturing) return;
      e.preventDefault();
      if (!e.repeat) this.press(e.code, true);
    });
    addEventListener('keyup', e => this.press(e.code, false));
    addEventListener('mousedown', e => {
      if (!this.locked || this.engaged || this.capturing) return;
      this.press(`Mouse${e.button}`, true);
    });
    addEventListener('mouseup', e => this.press(`Mouse${e.button}`, false));
    addEventListener('mousemove', e => {
      // Chrome can report one huge jump right after the pointer locks; no real flick is 300 px in one event.
      if (this.locked && Math.abs(e.movementX) < 300 && Math.abs(e.movementY) < 300) { this.dx += e.movementX; this.dy += e.movementY; }
    });
    addEventListener('wheel', () => { if (this.locked) this.keyButtons |= Btn.swap; setTimeout(() => (this.keyButtons &= ~Btn.swap), 60); }, { passive: true });
    addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('blur', () => this.reset());
    document.addEventListener('pointerlockchange', () => { if (!this.locked) { this.reset(); this.onUnlock(); } });
  }

  /** Held buttons from the keyboard and mouse, plus the touch controls while they are engaged. */
  get buttons(): number { return this.keyButtons | this.latched | (this.engaged && this.touch ? this.touch.buttons : 0); }
  set buttons(v: number) { this.keyButtons = v; }
  /** Call after the buttons have been put into a game command: releases latched presses. */
  consumePresses(): void {
    this.latched = 0;
    this.touch?.consume();
  }

  /** Whether the player is in control: the mouse is captured, or the touch controls are engaged. */
  get locked(): boolean { return this.engaged || document.pointerLockElement === this.canvas; }
  get touchEngaged(): boolean { return this.engaged; }
  lock(): void {
    if (this.touch) {
      this.engaged = true;
      this.touch.show(true);
      return;
    }
    // Unadjusted movement avoids OS mouse acceleration where the browser supports it.
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined;
    p?.catch?.(() => this.canvas.requestPointerLock());
  }
  unlock(): void {
    if (this.engaged) {
      this.engaged = false;
      this.touch?.show(false);
      this.reset();
      this.onUnlock();
      return;
    }
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
  private reset(): void { this.keyButtons = this.latched = 0; this.keys.clear(); this.dx = this.dy = 0; this.scoreboard = false; this.thirdPerson = false; }

  /** Strafe and forward axes, each -1..1. */
  move(): [number, number] {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    let x = k('right') - k('left'), z = k('forward') - k('back');
    if (this.engaged && this.touch) {
      x += this.touch.axis[0];
      z += this.touch.axis[1];
    }
    return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, z))];
  }
  /** Mouse (and touch) movement in radians since the last call. `zoom` slows the look while aiming. */
  look(zoom: number): [number, number] {
    const s = (0.0022 * this.sensitivity) / zoom;
    const out: [number, number] = [-this.dx * s, -this.dy * s];
    this.dx = this.dy = 0;
    if (this.engaged && this.touch) {
      const [tx, ty] = this.touch.look(zoom);
      out[0] += tx;
      out[1] += ty;
    }
    return out;
  }
  takeSlot(): number { const s = this.slot; this.slot = -1; return s; }
}
