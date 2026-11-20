// Minimap (top right) and the full map overlay.
//
// The level is drawn once into an off-screen picture: floor, walls, low cover, window walls,
// roofed interiors and trees. Every frame that picture is placed under the player (turning with
// the view, or north-up) and everything that moves is drawn over it:
//   you            arrow with a view cone
//   teammates      team-coloured arrows, a pulsing cross when downed, an edge marker when off the map
//   enemies        red, only while they give themselves away: firing an unsuppressed weapon,
//                  standing in your view cone at close range, or while a Recon Ping is running
//   the dead       red dots (blue when turned), brighter when they are attacking
//   objectives     zones A-C with their owner's colour and capture progress, the hill, dropped tags
//   survival       doors (shut or open) with their price, barricades with boards left, machines by
//                  type, the active mystery crate, quest parts, power-ups
//   action         grenades and rockets in flight, explosion rings, where shots were fired, deaths
// plus a north marker and cardinal ticks on the rim, range rings, the name of the area you are in,
// and a border that flashes when you are hit.
import { lang } from './i18n';
import type { Sim, Snap } from '../core/sim';
import { MODES, TEAM_CSS } from '../game/rules';
import type { Session } from '../game/session';

const PX = 6; // pixels per metre in the pre-drawn level picture
const SUPPRESSED = new Set(['vespa', 'bastion']);
const PERK_CSS = ['#e6392b', '#35d150', '#ffa51a', '#3b82ff', '#ffe433', '#b455ff'];
const POWERUP_CSS = ['#35ff55', '#ff3838', '#ffd91a', '#e6e6ff', '#4d99ff'];
const I = { door: 1, wallbuy: 2, perk: 3, crate: 4, bench: 5, tonic: 6, power: 7, workbench: 8, part: 9, console: 10, barricade: 11 };

export interface MinimapSettings { size: number; rotate: boolean; range: number }
interface Blip { x: number; z: number; until: number; life: number; kind: 'shot' | 'boom' | 'death' | 'hurt'; r?: number }

export class Minimap {
  private level: HTMLCanvasElement | null = null;
  private levelFor: Session | null = null;
  private ctx: CanvasRenderingContext2D;
  private big: CanvasRenderingContext2D;
  private blips: Blip[] = [];
  private hitUntil = 0;
  private lastHp = 1;
  /** Enemies recently revealed: id -> time the reveal ends. */
  private seen = new Map<number, number>();
  settings: MinimapSettings = { size: 190, rotate: true, range: 24 };
  /** Held: show the whole level in the middle of the screen. */
  expanded = false;

  constructor(private sim: Sim, private canvas: HTMLCanvasElement, private bigCanvas: HTMLCanvasElement, private label: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    this.big = bigCanvas.getContext('2d')!;
  }

  /** Draws the parts of the level that never change. */
  private buildLevel(s: Session): HTMLCanvasElement {
    const [w, d] = s.mapInfo.size;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * PX);
    c.height = Math.ceil(d * PX);
    const g = c.getContext('2d')!;
    const lunar = s.mapInfo.theme === 3;
    g.fillStyle = lunar ? '#2a2c31' : '#1c2128';
    g.fillRect(0, 0, c.width, c.height);
    // A faint 10 m grid helps judge distance.
    g.strokeStyle = '#ffffff0d';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += 10) { g.beginPath(); g.moveTo(x * PX, 0); g.lineTo(x * PX, c.height); g.stroke(); }
    for (let z = 0; z <= d; z += 10) { g.beginPath(); g.moveTo(0, z * PX); g.lineTo(c.width, z * PX); g.stroke(); }
    const b = s.boxes;
    const rect = (o: number, fill: string, stroke?: string) => {
      const x = b[o] * PX, z = b[o + 2] * PX, bw = (b[o + 3] - b[o]) * PX, bd = (b[o + 5] - b[o + 2]) * PX;
      g.fillStyle = fill;
      g.fillRect(x, z, bw, bd);
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.strokeRect(x + 0.5, z + 0.5, bw - 1, bd - 1); }
    };
    // Low things first, then walls, then roofs over the top.
    for (let pass = 0; pass < 3; pass++) {
      for (let o = 0; o < b.length; o += 8) {
        const mat = b[o + 6], flags = b[o + 7] & 0xff;
        if (flags & (2 | 4) || mat === 0) continue;
        const cx = ((b[o] + b[o + 3]) / 2) * PX, cz = ((b[o + 2] + b[o + 5]) / 2) * PX;
        if (pass === 0) {
          if (mat === 2) rect(o, '#6b5a45', '#8d7a60'); // crates
          else if (mat === 3) rect(o, '#3c4a5c', '#55687f'); // platforms and stairs
          else if (mat >= 5 && mat <= 12) rect(o, '#3a4048', '#59616c'); // machines and stands
          else if (mat === 14 || mat === 15) rect(o, lunar ? '#8a8d93' : '#6f6a55', '#00000055'); // barrels, sandbags, cargo
          else if (mat === 16) { g.fillStyle = '#777b82'; g.beginPath(); g.ellipse(cx, cz, 0.8 * PX, 0.65 * PX, 0.5, 0, 6.3); g.fill(); }
          else if (mat === 18 && b[o + 1] === 0) rect(o, '#5d6672', '#9aa6b5'); // wall under a window
        } else if (pass === 1) {
          if (mat === 1) rect(o, lunar ? '#8f949c' : '#6a7480', lunar ? '#b9bec6' : '#8b96a3');
          else if (mat === 13) {
            // A tree (or a mast on the moon).
            g.fillStyle = lunar ? '#c9ced6' : '#2f6b34cc';
            g.beginPath(); g.arc(cx, cz, (lunar ? 0.5 : 1.7) * PX, 0, 6.3); g.fill();
            g.fillStyle = lunar ? '#5a5f66' : '#4a3a28';
            g.beginPath(); g.arc(cx, cz, 0.3 * PX, 0, 6.3); g.fill();
          }
        } else if (mat === 17) {
          // Roofed interior: a tinted wash with a dashed outline.
          const x = b[o] * PX, z = b[o + 2] * PX, bw = (b[o + 3] - b[o]) * PX, bd = (b[o + 5] - b[o + 2]) * PX;
          g.fillStyle = '#7fa4d81f';
          g.fillRect(x, z, bw, bd);
          g.setLineDash([5, 4]);
          g.strokeStyle = '#9fc0ee88';
          g.strokeRect(x + 1, z + 1, bw - 2, bd - 2);
          g.setLineDash([]);
        }
      }
    }
    return c;
  }

  /** Simulation events worth marking: shots, explosions, deaths. */
  event(e: Float32Array, s: Session): void {
    const { V } = this.sim.L;
    const now = performance.now();
    if (e[0] === V.shot && e[1] !== s.selfId) {
      const shooter = s.players().find(p => p.id === e[1]);
      const slug = this.sim.catalog.weapons[e[2]]?.slug ?? '';
      if (shooter && !SUPPRESSED.has(slug)) {
        this.seen.set(shooter.id, now + 2500);
        this.blips.push({ x: shooter.x, z: shooter.z, until: now + 600, life: 600, kind: 'shot' });
      }
    } else if (e[0] === V.explode) {
      this.blips.push({ x: e[1], z: e[3], until: now + 700, life: 700, kind: 'boom', r: e[4] });
    } else if (e[0] === V.pdeath || e[0] === V.pdown) {
      const victim = e[1] === s.selfId ? { x: s.feet()[0], z: s.feet()[2] } : s.players().find(p => p.id === e[1]);
      if (victim) this.blips.push({ x: victim.x, z: victim.z, until: now + 5000, life: 5000, kind: 'death' });
    }
  }

  private arrow(g: CanvasRenderingContext2D, x: number, y: number, heading: number, size: number, fill: string, outline = '#000') {
    g.save();
    g.translate(x, y);
    g.rotate(heading);
    g.beginPath();
    g.moveTo(0, -size);
    g.lineTo(size * 0.72, size * 0.8);
    g.lineTo(0, size * 0.38);
    g.lineTo(-size * 0.72, size * 0.8);
    g.closePath();
    g.fillStyle = fill;
    g.strokeStyle = outline;
    g.lineWidth = 1.5;
    g.stroke();
    g.fill();
    g.restore();
  }
  private text(g: CanvasRenderingContext2D, t: string, x: number, y: number, fill: string, px: number, upright: number) {
    g.save();
    g.translate(x, y);
    g.rotate(upright);
    g.font = `700 ${px}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = '#000c';
    g.strokeText(t, 0, 0.5);
    g.fillStyle = fill;
    g.fillText(t, 0, 0.5);
    g.restore();
  }

  /**
   * Everything that moves, in level coordinates (metres times `k` pixels). `upright` is the
   * rotation that keeps labels the right way up when the map turns.
   */
  private drawWorld(g: CanvasRenderingContext2D, s: Session, snap: Snap, me: Float32Array, k: number, upright: number, now: number, full: boolean): void {
    const { P, H, E, Z } = this.sim.L;
    const hdr = snap.hdr;
    const mode = s.start.mode, info = MODES[mode];
    const survival = mode === 0;
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    const mine = me[P.team];
    const feet = s.feet();
    const dot = (x: number, z: number, r: number, fill: string, stroke = '#000a') => { g.beginPath(); g.arc(x * k, z * k, r, 0, 6.3); g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); };

    // Doors: a bar across the opening while shut, with what it costs.
    const b = s.boxes;
    for (let o = 0; o < b.length; o += 8) {
      if (!((b[o + 7] & 0xff) & 4)) continue;
      const tag = (b[o + 7] >> 8) - 1;
      const open = (hdr[H.doors] & (1 << tag)) !== 0;
      g.fillStyle = open ? '#39d98a33' : '#7c8fa3';
      g.fillRect(b[o] * k, b[o + 2] * k, (b[o + 3] - b[o]) * k, (b[o + 5] - b[o + 2]) * k);
    }
    // Machines, stands and doors' prices (survival), from the list of things you can use.
    if (survival) {
      const it = s.inter;
      for (let o = 0, n = 0; o < it.length; o += 8, n++) {
        const [kind, x, , z, cost, param, , active] = it.subarray(o, o + 8);
        if (kind === I.door) { if (!(hdr[H.doors] & (1 << param)) && full) this.text(g, `${cost}`, x * k, z * k, '#b8dcff', 9, upright); continue; }
        if (kind === I.barricade) {
          const boards = snap.barrs[param] ?? 6;
          g.save();
          g.translate(x * k, z * k);
          g.fillStyle = boards === 0 ? `rgba(255,70,60,${0.5 + 0.5 * pulse})` : boards < 3 ? '#c8d3df' : '#8597aa';
          g.fillRect(-0.9 * k, -0.9 * k, 1.8 * k, 1.8 * k);
          g.restore();
          continue;
        }
        if (kind === I.crate && n !== hdr[H.crate_at]) continue;
        if (kind === I.part) {
          if (hdr[H.parts] & (1 << param)) continue;
          dot(x, z, 2.5 + pulse * 1.5, '#8fd0ff');
          continue;
        }
        const powered = !!hdr[H.power];
        const style: Record<number, [string, string]> = {
          [I.wallbuy]: ['W', '#e8d8a8'], [I.perk]: ['P', PERK_CSS[param] ?? '#fff'], [I.crate]: ['?', '#5aa9ff'], [I.bench]: ['U', '#c66bff'],
          [I.tonic]: ['T', '#2fd6c0'], [I.power]: ['⚡', powered ? '#39d98a' : '#ff4a3c'], [I.workbench]: ['B', '#8597aa'], [I.console]: ['C', '#32d4ff'],
        };
        const st = style[kind];
        if (!st || !active) continue;
        const dim = (kind === I.perk || kind === I.bench || kind === I.console) && !powered;
        g.globalAlpha = dim ? 0.45 : 1;
        dot(x, z, kind === I.crate ? 5 + pulse : 4.5, '#10141a', st[1]);
        // Hebrew letters: נ weapon (נשק), ה perk (הטבה), ש tonic (שיקוי), ד upgrade (שדרוג), ע workbench (עמדה), ב console (בקרה).
        const he: Record<string, string> = { W: 'נ', P: 'ה', U: 'ד', T: 'ש', B: 'ע', C: 'ב' };
        this.text(g, lang() === 'he' ? he[st[0]] ?? st[0] : st[0], x * k, z * k, st[1], 8, upright);
        g.globalAlpha = 1;
      }
    }
    // Objectives and other entities.
    for (const e of snap.ents) {
      const kind = e[E.kind], x = e[E.pos], z = e[E.pos + 2];
      if (kind >= 40 && kind <= 45) {
        const q = Math.floor(e[E.a] / 4), owner = Math.floor(q / 2) - 1, contested = q % 2 === 1, prog = e[E.a] - q * 4 - 1;
        const r = (kind === 45 ? 4.5 : 3.5) * k;
        const col = owner >= 0 ? TEAM_CSS[owner] : '#dddddd';
        g.beginPath(); g.arc(x * k, z * k, r, 0, 6.3);
        g.fillStyle = `${col}${contested && pulse > 0.5 ? '55' : '2e'}`; g.fill();
        g.strokeStyle = col; g.lineWidth = 2; g.stroke();
        if (kind !== 45 && Math.abs(prog) > 0.02 && owner < 0) {
          g.beginPath(); g.arc(x * k, z * k, r - 3, -Math.PI / 2, -Math.PI / 2 + Math.abs(prog) * 6.283);
          g.strokeStyle = prog < 0 ? TEAM_CSS[0] : TEAM_CSS[1]; g.lineWidth = 3; g.stroke();
        }
        this.text(g, kind === 45 ? 'H' : 'ABC'[kind - 40], x * k, z * k, '#fff', 11, upright);
      } else if (kind === 50 || kind === 51) {
        g.save(); g.translate(x * k, z * k); g.rotate(Math.PI / 4);
        g.fillStyle = TEAM_CSS[kind - 50]; g.strokeStyle = '#000'; g.lineWidth = 1;
        g.fillRect(-3, -3, 6, 6); g.strokeRect(-3, -3, 6, 6); g.restore();
      } else if (kind >= 10 && kind < 15) {
        dot(x, z, 3.5 + pulse * 2, POWERUP_CSS[kind - 10] ?? '#fff', '#fff');
      } else if (kind >= 1 && kind <= 4) {
        dot(x, z, kind === 4 ? 3 : 2.2, kind === 3 ? '#8fd0ff' : '#e8eef5', '#000');
      } else if (kind === 30) {
        g.strokeStyle = `rgba(255,60,40,${0.5 + pulse * 0.5})`; g.lineWidth = 2;
        g.beginPath(); g.arc(x * k, z * k, 5 * k, 0, 6.3); g.stroke();
      }
    }
    // Marks left by events.
    this.blips = this.blips.filter(bl => bl.until > now);
    for (const bl of this.blips) {
      const t = 1 - (bl.until - now) / bl.life;
      if (bl.kind === 'boom') {
        g.strokeStyle = `rgba(200,225,255,${1 - t})`; g.lineWidth = 2;
        g.beginPath(); g.arc(bl.x * k, bl.z * k, (bl.r ?? 4) * k * (0.3 + t * 0.7), 0, 6.3); g.stroke();
      } else if (bl.kind === 'shot') {
        g.strokeStyle = `rgba(255,80,60,${1 - t})`; g.lineWidth = 1.5;
        g.beginPath(); g.arc(bl.x * k, bl.z * k, 3 + t * 9, 0, 6.3); g.stroke();
      } else if (bl.kind === 'death') {
        g.save(); g.translate(bl.x * k, bl.z * k); g.rotate(upright);
        g.strokeStyle = `rgba(255,255,255,${Math.min(1, (1 - t) * 2)})`; g.lineWidth = 2;
        g.beginPath(); g.moveTo(-4, -4); g.lineTo(4, 4); g.moveTo(4, -4); g.lineTo(-4, 4); g.stroke(); g.restore();
      }
    }
    // The dead.
    for (const z of s.zombies()) {
      const state = z.rec[Z.state];
      if (state === 5) continue;
      dot(z.x, z.z, state === 2 ? 3.4 : 2.6, state === 4 ? '#5aa9ff' : state === 2 ? '#ff5a4a' : '#d23c2a');
    }
    // Other players.
    const pinged = me[P.ping_t] > 0;
    const myYaw = s.yaw;
    for (const p of s.players()) {
      const life = p.rec[P.life];
      if (life === 2) continue;
      const friend = survival || (info?.teams && p.rec[P.team] === mine);
      if (friend) {
        const col = info?.teams ? TEAM_CSS[mine] ?? '#7fd4ff' : '#7fd4ff';
        if (life === 1) {
          // Downed: a pulsing cross.
          g.save(); g.translate(p.x * k, p.z * k); g.rotate(upright);
          g.fillStyle = `rgba(255,255,255,${0.5 + pulse * 0.5})`;
          g.fillRect(-1.5, -6, 3, 12); g.fillRect(-6, -1.5, 12, 3); g.restore();
        } else this.arrow(g, p.x * k, p.z * k, -p.yaw, 6, col);
        continue;
      }
      // Enemies only show while something gives them away.
      const dx = p.x - feet[0], dz = p.z - feet[2], dist = Math.hypot(dx, dz);
      const ahead = dist < 14 && dist > 0.01 && (-Math.sin(myYaw) * dx - Math.cos(myYaw) * dz) / dist > 0.75;
      if (ahead) this.seen.set(p.id, Math.max(this.seen.get(p.id) ?? 0, now + 800));
      const until = this.seen.get(p.id) ?? 0;
      if (!pinged && until < now) continue;
      g.globalAlpha = pinged ? 1 : Math.min(1, (until - now) / 600);
      dot(p.x, p.z, 4, '#ff3b30', '#fff');
      g.globalAlpha = 1;
    }
    // Recon Ping: a sweep ring rolling out from you.
    if (pinged) {
      const t = (now / 1400) % 1;
      g.strokeStyle = `rgba(127,212,255,${1 - t})`; g.lineWidth = 2;
      g.beginPath(); g.arc(feet[0] * k, feet[2] * k, t * 60 * k, 0, 6.3); g.stroke();
    }
  }

  /** Called at the HUD's refresh rate. */
  update(s: Session, snap: Snap, me: Float32Array): void {
    const st = this.settings;
    const { P } = this.sim.L;
    const now = performance.now();
    if (this.levelFor !== s) { this.level = this.buildLevel(s); this.levelFor = s; this.blips = []; this.seen.clear(); }
    const level = this.level!;
    const hp = me[P.health] / (me[P.max_health] || 100);
    if (hp < this.lastHp - 0.01) this.hitUntil = now + 300;
    this.lastHp = hp;

    const show = st.size > 0;
    this.canvas.hidden = !show;
    this.label.hidden = !show;
    const feet = s.feet();
    if (show) {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const px = Math.round(st.size * dpr);
      if (this.canvas.width !== px) { this.canvas.width = this.canvas.height = px; this.canvas.style.width = this.canvas.style.height = `${st.size}px`; }
      const g = this.ctx;
      const half = px / 2, k = half / st.range; // pixels per metre
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, px, px);
      g.save();
      // Round window.
      g.beginPath(); g.arc(half, half, half - 2, 0, 6.3); g.clip();
      g.fillStyle = '#0b0e12e0';
      g.fillRect(0, 0, px, px);
      g.translate(half, half);
      const turn = st.rotate ? s.yaw : 0;
      g.rotate(turn);
      g.translate(-feet[0] * k, -feet[2] * k);
      g.imageSmoothingEnabled = true;
      g.drawImage(level, 0, 0, level.width, level.height, 0, 0, (level.width / PX) * k, (level.height / PX) * k);
      this.drawWorld(g, s, snap, me, k, -turn, now, false);
      // Yourself: a view cone and an arrow.
      const fov = (70 * Math.PI) / 180;
      g.save();
      g.translate(feet[0] * k, feet[2] * k);
      g.rotate(-s.yaw);
      const cone = g.createRadialGradient(0, 0, 0, 0, 0, 16 * k);
      cone.addColorStop(0, '#ffffff38'); cone.addColorStop(1, '#ffffff00');
      g.fillStyle = cone;
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 16 * k, -Math.PI / 2 - fov / 2, -Math.PI / 2 + fov / 2); g.closePath(); g.fill();
      g.restore();
      this.arrow(g, feet[0] * k, feet[2] * k, -s.yaw, 7 * dpr, me[P.life] === 0 ? '#ffffff' : '#ff6a5a');
      g.restore();
      // Rim: range rings, cardinal ticks and the north marker.
      g.save();
      g.translate(half, half);
      g.strokeStyle = '#ffffff14'; g.lineWidth = 1;
      for (const r of [10, 20, 30]) if (r < st.range) { g.beginPath(); g.arc(0, 0, r * k, 0, 6.3); g.stroke(); }
      const hit = this.hitUntil > now;
      g.strokeStyle = hit ? '#ff3b30' : '#ffffff55';
      g.lineWidth = hit ? 4 * dpr : 2 * dpr;
      g.beginPath(); g.arc(0, 0, half - 2 * dpr, 0, 6.3); g.stroke();
      g.rotate(turn);
      for (let i = 0; i < 8; i++) {
        g.save(); g.rotate((i * Math.PI) / 4);
        g.fillStyle = '#ffffffaa';
        g.fillRect(-1, -half + 2 * dpr, 2, (i % 2 ? 4 : 7) * dpr);
        g.restore();
      }
      this.text(g, lang() === 'he' ? 'צ' : 'N', 0, -half + 15 * dpr, '#6fb6ff', 11 * dpr, -turn);
      // Teammates outside the window: a marker on the rim pointing their way.
      const info = MODES[s.start.mode];
      const mine = me[P.team];
      for (const p of s.players()) {
        if (p.rec[P.life] === 2 || !(s.start.mode === 0 || (info?.teams && p.rec[P.team] === mine))) continue;
        const dx = p.x - feet[0], dz = p.z - feet[2];
        if (Math.hypot(dx, dz) <= st.range) continue;
        const a = Math.atan2(dz, dx);
        g.save(); g.rotate(a); g.translate(half - 9 * dpr, 0); g.rotate(Math.PI / 2);
        this.arrow(g, 0, 0, 0, 5 * dpr, info?.teams ? TEAM_CSS[mine] ?? '#7fd4ff' : '#7fd4ff');
        g.restore();
      }
      g.restore();
      // Where you are, by name and grid reference.
      const map = this.sim.catalog.maps[s.start.map];
      const col = String.fromCharCode(65 + Math.max(0, Math.min(25, Math.floor(feet[0] / 10)))), row = Math.floor(feet[2] / 10) + 1;
      const text = `${zoneAt(s, this.sim, feet) ?? map?.name ?? ''} · ${col}${row}`;
      if (this.label.textContent !== text) this.label.textContent = text;
    }

    // Full map: north-up, the whole level, with a legend.
    const bigWrap = this.bigCanvas.parentElement!;
    bigWrap.hidden = !this.expanded;
    if (this.expanded) {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const maxW = Math.min(innerWidth * 0.8, 900), maxH = innerHeight * 0.68;
      const k = Math.min(maxW / (level.width / PX), maxH / (level.height / PX)) * dpr;
      const w = Math.round((level.width / PX) * k), h = Math.round((level.height / PX) * k);
      if (this.bigCanvas.width !== w || this.bigCanvas.height !== h) { this.bigCanvas.width = w; this.bigCanvas.height = h; this.bigCanvas.style.width = `${w / dpr}px`; this.bigCanvas.style.height = `${h / dpr}px`; }
      const g = this.big;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(level, 0, 0, w, h);
      this.drawWorld(g, s, snap, me, k, 0, now, true);
      // Grid references along the edges.
      for (let x = 0; x * 10 * k < w; x++) this.text(g, String.fromCharCode(65 + x), (x * 10 + 5) * k, 9 * dpr, '#ffffff99', 10 * dpr, 0);
      for (let z = 0; z * 10 * k < h; z++) this.text(g, `${z + 1}`, 8 * dpr, (z * 10 + 5) * k, '#ffffff99', 10 * dpr, 0);
      this.arrow(g, feet[0] * k, feet[2] * k, -s.yaw, 9 * dpr, '#ffffff');
    }
  }
}

/** The named area a position is in, if the map names its areas. */
function zoneAt(s: Session, sim: Sim, feet: number[]): string | null {
  const zones = sim.catalog.maps[s.start.map]?.zoneRects;
  if (!zones) return null;
  const c = feet[0] / 2, r = feet[2] / 2;
  for (const z of zones) if (c >= z.c0 && c <= z.c1 + 1 && r >= z.r0 && r <= z.r1 + 1) return z.name;
  return null;
}
