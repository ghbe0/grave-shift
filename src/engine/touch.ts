// On-screen controls for phones and tablets: a floating joystick on the left of the screen, drag
// anywhere else to look, and buttons for the main actions. Pointer Events track each finger
// separately, so moving, aiming and shooting work at the same time.
import { Btn } from '../core/sim';

interface ButtonDef {
  id: string;
  label: string;
  bit?: number;
  /** Tap to switch on, tap again to switch off (aiming). */
  toggle?: boolean;
  /** Dragging this button also turns the view (the fire button), as in most mobile shooters. */
  look?: boolean;
  /** Not a game button: a callback on tap. */
  tap?: () => void;
  /** Also shown while holding the scoreboard. */
  hold?: (down: boolean) => void;
}

const STICK_RADIUS = 56;
/** Fraction of the stick throw that also sprints when pushing forward. */
const SPRINT_AT = 0.92;

export class TouchControls {
  readonly root: HTMLElement;
  /** Strafe and forward, each -1..1. */
  readonly axis: [number, number] = [0, 0];
  sensitivity = 1;
  private held = 0;
  private toggled = 0;
  /** Presses not yet seen by the simulation: a tap shorter than one game tick still counts. */
  private latched = 0;
  private sprint = false;
  private lookDx = 0;
  private lookDy = 0;
  private stick: { id: number; x: number; y: number } | null = null;
  private lookers = new Map<number, { x: number; y: number }>();
  private pressed = new Map<number, ButtonDef>();
  private base!: HTMLElement;
  private knob!: HTMLElement;
  private els = new Map<string, HTMLElement>();
  onPause: () => void = () => {};
  onScores: (down: boolean) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.hidden = true;
    parent.append(this.root);
    this.build();
    const r = this.root;
    r.addEventListener('pointerdown', e => this.down(e));
    r.addEventListener('pointermove', e => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) r.addEventListener(ev, e => this.up(e as PointerEvent));
    r.addEventListener('contextmenu', e => e.preventDefault());
  }

  get buttons(): number {
    const b = this.held | this.toggled | this.latched;
    // Shooting or aiming cancels the stick's auto-sprint, so you can run and gun with one thumb
    // pushed all the way forward (you can't fire while sprinting).
    const sprint = this.sprint && !(b & (Btn.fire | Btn.ads));
    return b | (sprint ? Btn.sprint : 0);
  }
  /** Called once the current buttons have gone into a game command. */
  consume(): void { this.latched = 0; }

  private build(): void {
    this.base = el('div', 'stick-base');
    this.knob = el('div', 'stick-knob');
    this.base.append(this.knob);
    this.root.append(this.base, el('div', 'stick-hint', 'Move'));
    const defs: ButtonDef[] = [
      { id: 'fire', label: 'FIRE', bit: Btn.fire, look: true },
      { id: 'ads', label: 'AIM', bit: Btn.ads, toggle: true },
      { id: 'jump', label: 'JUMP', bit: Btn.jump },
      { id: 'crouch', label: 'SLIDE', bit: Btn.crouch },
      { id: 'reload', label: 'R', bit: Btn.reload },
      { id: 'use', label: 'USE', bit: Btn.use },
      { id: 'swap', label: '⇄', bit: Btn.swap },
      { id: 'lethal', label: 'G', bit: Btn.lethal },
      { id: 'tactical', label: 'E', bit: Btn.tactical },
      { id: 'ability', label: 'Q', bit: Btn.ability },
      { id: 'melee', label: 'KNIFE', bit: Btn.melee },
      { id: 'tonic', label: 'Z', bit: Btn.tonic },
      { id: 'pause', label: '❚❚', tap: () => this.onPause() },
      { id: 'scores', label: '☰', hold: down => this.onScores(down) },
    ];
    for (const d of defs) {
      const b = el('button', `tb tb-${d.id}`, d.label);
      b.dataset.btn = d.id;
      b.setAttribute('aria-label', d.id);
      this.els.set(d.id, b);
      (b as unknown as { def: ButtonDef }).def = d;
      this.root.append(b);
    }
  }

  show(on: boolean): void {
    this.root.hidden = !on;
    if (!on) this.reset();
  }

  reset(): void {
    this.held = this.toggled = this.latched = 0;
    this.sprint = false;
    this.axis[0] = this.axis[1] = 0;
    this.stick = null;
    this.lookers.clear();
    this.pressed.clear();
    this.lookDx = this.lookDy = 0;
    this.base.classList.remove('active');
    for (const b of this.els.values()) b.classList.remove('down', 'on');
  }

  /** Look movement in radians since the last call. */
  look(zoom: number): [number, number] {
    const s = (0.0055 * this.sensitivity) / zoom;
    const out: [number, number] = [-this.lookDx * s, -this.lookDy * s];
    this.lookDx = this.lookDy = 0;
    return out;
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    // Keep receiving this finger's moves even when it slides off the button it started on.
    try { this.root.setPointerCapture(e.pointerId); } catch { /* not capturable; moves still arrive over #touch */ }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-btn]');
    const def = btn ? (btn as unknown as { def: ButtonDef }).def : null;
    if (def) {
      this.pressed.set(e.pointerId, def);
      btn!.classList.add('down');
      if (def.tap) def.tap();
      else if (def.hold) def.hold(true);
      else if (def.toggle && def.bit) {
        this.toggled ^= def.bit;
        btn!.classList.toggle('on', !!(this.toggled & def.bit));
      } else if (def.bit) {
        this.held |= def.bit;
        this.latched |= def.bit;
      }
      if (def.look) this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      navigator.vibrate?.(8);
      return;
    }
    // The left part of the screen is the joystick; it appears under the thumb wherever it lands.
    if (!this.stick && e.clientX < innerWidth * 0.42) {
      this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.classList.add('active');
      this.knob.style.transform = 'translate(-50%, -50%)';
      return;
    }
    this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  private move(e: PointerEvent): void {
    if (this.stick && e.pointerId === this.stick.id) {
      let dx = e.clientX - this.stick.x, dy = e.clientY - this.stick.y;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) { dx *= STICK_RADIUS / len; dy *= STICK_RADIUS / len; }
      this.axis[0] = dx / STICK_RADIUS;
      this.axis[1] = -dy / STICK_RADIUS;
      // Pushing the stick all the way forward sprints.
      this.sprint = len >= STICK_RADIUS * SPRINT_AT && this.axis[1] > 0.7;
      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.base.classList.toggle('sprint', this.sprint);
      return;
    }
    const l = this.lookers.get(e.pointerId);
    if (l) {
      this.lookDx += e.clientX - l.x;
      this.lookDy += e.clientY - l.y;
      l.x = e.clientX;
      l.y = e.clientY;
    }
  }

  private up(e: PointerEvent): void {
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
      this.axis[0] = this.axis[1] = 0;
      this.sprint = false;
      this.base.classList.remove('active', 'sprint');
    }
    this.lookers.delete(e.pointerId);
    const def = this.pressed.get(e.pointerId);
    if (def) {
      this.pressed.delete(e.pointerId);
      this.els.get(def.id)?.classList.remove('down');
      if (def.hold) def.hold(false);
      else if (def.bit && !def.toggle) {
        // Another finger may still be holding the same button.
        if (![...this.pressed.values()].some(d => d.bit === def.bit)) this.held &= ~def.bit;
      }
    }
  }
}

function el(tag: string, cls: string, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A phone or tablet: the main pointer is a finger and there is no fine pointer (mouse) as well. */
export function isTouchDevice(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}
