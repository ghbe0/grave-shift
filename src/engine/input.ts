// Keyboard and mouse input with Pointer Lock. Produces look deltas and a button bitmask that
// matches the simulation's `B_*` constants.
import { Btn } from '../core/sim';

const KEYS: Record<string, number> = {
  Space: Btn.jump, ShiftLeft: Btn.sprint, ShiftRight: Btn.sprint, KeyC: Btn.crouch, ControlLeft: Btn.crouch,
  KeyR: Btn.reload, KeyF: Btn.use, KeyV: Btn.melee, KeyQ: Btn.ability, KeyX: Btn.swap, KeyZ: Btn.tonic,
  KeyG: Btn.lethal, KeyE: Btn.tactical, Digit4: Btn.streak1, Digit5: Btn.streak2, Digit6: Btn.streak3,
};
const MOUSE = [Btn.fire, Btn.melee, Btn.ads];

export class Input {
  buttons = 0;
  /** Requested weapon slot for the next command, or -1. */
  slot = -1;
  scoreboard = false;
  sensitivity = 1;
  private keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  onUnlock: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', e => {
      if (!this.locked) return;
      e.preventDefault();
      this.keys.add(e.code);
      if (KEYS[e.code]) this.buttons |= KEYS[e.code];
      if (e.code === 'Digit1') this.slot = 0;
      if (e.code === 'Digit2') this.slot = 1;
      if (e.code === 'Tab') this.scoreboard = true;
    });
    addEventListener('keyup', e => {
      this.keys.delete(e.code);
      if (KEYS[e.code]) this.buttons &= ~KEYS[e.code];
      if (e.code === 'Tab') this.scoreboard = false;
    });
    addEventListener('mousedown', e => { if (this.locked) this.buttons |= MOUSE[e.button] ?? 0; });
    addEventListener('mouseup', e => { this.buttons &= ~(MOUSE[e.button] ?? 0); });
    addEventListener('mousemove', e => {
      // Chrome can report one huge jump right after the pointer locks; no real flick is 300 px in one event.
      if (this.locked && Math.abs(e.movementX) < 300 && Math.abs(e.movementY) < 300) { this.dx += e.movementX; this.dy += e.movementY; }
    });
    addEventListener('wheel', () => { if (this.locked) this.buttons |= Btn.swap; setTimeout(() => (this.buttons &= ~Btn.swap), 60); }, { passive: true });
    addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('blur', () => this.reset());
    document.addEventListener('pointerlockchange', () => { if (!this.locked) { this.reset(); this.onUnlock(); } });
  }

  get locked(): boolean { return document.pointerLockElement === this.canvas; }
  lock(): void {
    // Unadjusted movement avoids OS mouse acceleration where the browser supports it.
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined;
    p?.catch?.(() => this.canvas.requestPointerLock());
  }
  unlock(): void { if (this.locked) document.exitPointerLock(); }
  private reset(): void { this.buttons = 0; this.keys.clear(); this.dx = this.dy = 0; this.scoreboard = false; }

  /** Strafe and forward axes, each -1..1. */
  move(): [number, number] {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    return [k('KeyD') - k('KeyA'), k('KeyW') - k('KeyS')];
  }
  /** Mouse movement in radians since the last call. `zoom` slows the look while aiming. */
  look(zoom: number): [number, number] {
    const s = (0.0022 * this.sensitivity) / zoom;
    const out: [number, number] = [-this.dx * s, -this.dy * s];
    this.dx = this.dy = 0;
    return out;
  }
  takeSlot(): number { const s = this.slot; this.slot = -1; return s; }
}
