// In-match HUD drawn with DOM elements over the canvas.
import { t } from './i18n';
import { fireMode, WEAPON_CLASSES, type Sim, type Snap } from '../core/sim';
import { cardHtml, COLORS, DEFAULT_LOOK, reticleSvg, type Look } from '../game/look';
import type { Session } from '../game/session';
import { Minimap } from './minimap';
import { LADDER_RUNGS, MODES, TEAM_CSS, TEAM_NAMES } from '../game/rules';

/** Where a world point is on screen (0..1), or null when it is behind the camera. */
export type Project = (p: ArrayLike<number>) => [number, number] | null;
const ZONE_NAMES = ['A', 'B', 'C'];

const $ = (id: string) => document.getElementById(id)!;
const INTERACT = ['', 'door', 'wallbuy', 'perk', 'crate', 'bench', 'tonic', 'power', 'workbench', 'part', 'console', 'barricade', 'revive'];

export class Hud {
  private feed: { text: string; until: number }[] = [];
  private banner = { text: '', until: 0 };
  private hitUntil = 0;
  private hitKill = false;
  private names = new Map<number, string>();
  private reticleHtml = '';
  /** Each player's customization, for calling cards on the scoreboard. */
  lookOf: (id: number) => Look = () => DEFAULT_LOOK;

  /** Last frame's values, to spot changes worth animating. */
  private state = { gun: '', ammo: 0, hp: 1, thrust: 1, points: -1, round: '', shown: -1, banner: '', scoreA: 0, scoreB: 0, dirTimer: 0, clockMax: 0 };

  readonly minimap: Minimap;

  constructor(private sim: Sim) {
    this.minimap = new Minimap(sim, $('minimap') as HTMLCanvasElement, $('bigmap-canvas') as HTMLCanvasElement, $('minimap-label'));
    this.relabel();
  }

  /** (Re)builds text that is laid out once, in the current language. */
  relabel(): void {
    // Compass tape: three turns of headings every 15 degrees, so it can scroll without a seam.
    const names: Record<number, string> = Object.fromEntries(Object.entries({ 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }).map(([k, v]) => { const h = t(`compass.${v}`); return [k, h.startsWith('compass.') ? v : h]; }));
    const cell = (d: number) => `<span class="${d % 90 === 0 ? 'major' : ''}">${names[d] ?? (d % 45 === 0 ? '' : d)}</span>`;
    $('compass-tape').innerHTML = Array.from({ length: 72 }, (_, i) => cell((i * 15) % 360)).join('');
  }

  /** Crosshair style and colour, and the sight reticle shown while aiming. */
  applyLook(look: Look): void {
    const ch = $('crosshair');
    ch.dataset.style = String(look.crosshair);
    ch.style.setProperty('--ch', COLORS[look.crosshairColor]?.css ?? '#fff');
    this.reticleHtml = reticleSvg(look.reticle, COLORS[look.reticleColor]?.css ?? '#ff3b30');
    setHtml('reticle', this.reticleHtml);
  }

  setNames(players: { id: number; name: string }[]): void { for (const p of players) this.names.set(p.id, p.name); }
  private name(id: number): string { return this.names.get(id) ?? `Player ${id + 1}`; }
  say(text: string, secs = 4): void { this.feed.push({ text, until: performance.now() + secs * 1000 }); if (this.feed.length > 5) this.feed.shift(); }
  announce(text: string, secs = 3): void { this.banner = { text, until: performance.now() + secs * 1000 }; }

  name_(id: number): string { return this.name(id); }
  private myTeam(s: Session): number {
    const { P } = this.sim.L;
    return s.local()[P.team] ?? -1;
  }
  /** Objective news (EV_OBJ, `modes.rs` OB_*). */
  private objective(e: Float32Array, s: Session): void {
    const mine = this.myTeam(s), me = s.selfId;
    const team = (t: number) => (t === mine ? `Your team (${TEAM_NAMES[t]})` : TEAM_NAMES[t] ?? '');
    switch (e[1]) {
      case 1: this.say(`${team(e[3])} took zone ${ZONE_NAMES[e[2]]}`); if (e[3] === mine) this.announce(`Zone ${ZONE_NAMES[e[2]]} secured`, 2); break;
      case 2: this.say(`${team(e[3])} neutralised zone ${ZONE_NAMES[e[2]]}`); break;
      case 3: this.announce('The hill has moved', 3); break;
      case 4: if (e[2] === me) this.announce('Tag confirmed', 1.5); else this.say(`${this.name(e[2])} confirmed a kill`); break;
      case 5: if (e[2] === me) this.announce('Tag denied', 1.5); else this.say(`${this.name(e[2])} denied a kill`); break;
      case 8: this.say(e[2] === me ? `You joined ${TEAM_NAMES[e[3]]}` : `${this.name(e[2])} switched to ${TEAM_NAMES[e[3]]}`); break;
      case 6: case 7: {
        if (e[2] !== me) { if (e[1] === 7) this.say(`${this.name(e[2])} was knocked down a rung`); break; }
        const w = this.sim.catalog.weapons[this.sim.catalog.ladder[e[3]]];
        this.announce(e[1] === 7 ? 'Knifed! Down a rung' : w ? `Rung ${e[3] + 1}: ${w.name}` : 'Ladder complete!', 2);
        break;
      }
    }
  }

  /** Turns simulation events into feed lines, banners and hit markers. */
  handleEvent(e: Float32Array, s: Session): void {
    const { V } = this.sim.L;
    const cat = this.sim.catalog;
    const me = s.selfId;
    this.minimap.event(e, s);
    switch (e[0]) {
      case V.hit: if (e[1] === me) { this.hitUntil = performance.now() + 120; this.hitKill = e[4] > 0; } break;
      case V.round: this.announce(e[2] ? `Round ${e[1]} survived` : s.start.mode === 0 ? `Round ${e[1]}` : 'Fight!'); break;
      case V.pdown: this.say(e[1] === me ? 'You are down' : `${this.name(e[1])} is down`); break;
      case V.pdeath: {
        const how = e[3] >= 0 ? cat.weapons[e[3]]?.name : e[3] === -1 ? 'Knife' : e[3] === -2 ? 'Explosive' : '';
        this.say(e[2] >= 0 ? `${this.name(e[2])} eliminated ${this.name(e[1])}${how ? ` · ${how}` : ''}` : e[1] === me ? 'You bled out' : `${this.name(e[1])} bled out`);
        break;
      }
      case V.revive: this.say(e[1] === me ? 'You are back up' : `${this.name(e[1])} is back up`); break;
      case V.door: this.say(`Opened ${cat.maps[s.start.map].doors[e[1]] ?? 'a door'}`); break;
      case V.power: this.announce('Power restored'); break;
      case V.powerup: if (e[5]) this.announce(cat.powerups[e[1]] ?? ''); break;
      case V.crate: if (e[1] === 3) this.say('The crate is empty. It is moving...'); break;
      case V.quest: {
        const q = cat.maps[s.start.map].quests[e[1]];
        if (q) this.announce(e[3] ? `${q.name} complete` : q.steps[e[2]] ?? '', 5);
        break;
      }
      case V.msg:
        if (e[2] === me || e[2] === -1) this.say(['', `Not enough points (${e[3]})`, 'Limit reached', 'Needs power', 'Reward unlocked'][e[1]] ?? '');
        break;
      case V.tonic: if (e[1] === me && !e[3]) this.say(`Tonic: ${cat.tonics[e[2]]?.name} - ${cat.tonics[e[2]]?.desc}`, 6); break;
      case V.ability: if (e[1] !== me) this.say(`${this.name(e[1])} used ${cat.abilities[e[2]]?.name}`); break;
      case V.streak: this.say(`${this.name(e[1])} called ${cat.streaks[e[2]]?.name}`); break;
      case V.gameover: {
        // Multiplayer: [winner id, score, winning team, draw].
        const text = s.start.mode === 0 ? `Overrun on round ${e[2]}`
          : e[4] ? 'Draw'
          : e[3] >= 0 ? `${TEAM_NAMES[e[3]]} win${this.myTeam(s) === e[3] ? ' - victory!' : ''}`
          : e[1] === me ? 'You win!' : `${this.name(e[1])} wins`;
        this.announce(text, 60);
        break;
      }
      case V.obj: this.objective(e, s); break;
    }
  }

  private prompt(p: Float32Array, s: Session, snap: Snap): string {
    const { P, H } = this.sim.L;
    const cat = this.sim.catalog;
    const kind = INTERACT[p[P.prompt_kind]], id = p[P.prompt_id], cost = p[P.prompt_cost];
    if (!kind) return '';
    if (kind === 'revive') return `Hold F to revive ${this.name(id)}`;
    if (kind === 'barricade') return 'Hold F to rebuild';
    if (cost === -2) return 'Power required';
    if (cost === -3) return kind === 'perk' ? 'Perk limit reached (4)' : 'No more this round';
    const param = s.inter[id * 8 + 5];
    const price = cost > 0 ? ` [${cost}]` : '';
    const gun = p[P[`arms.guns${p[P['arms.cur']]}.id`]];
    const tier = p[P[`arms.guns${p[P['arms.cur']]}.tier`]];
    const owned = [0, 1].some(k => p[P[`arms.guns${k}.id`]] === param);
    switch (kind) {
      case 'door': return `Press F to open ${cat.maps[s.start.map].doors[param]}${price}`;
      case 'wallbuy': return `Press F for ${cat.weapons[param]?.name}${owned ? ' ammo' : ''}${price}`;
      case 'perk': return `Press F for ${cat.perks[param]?.name}: ${cat.perks[param]?.desc}${price}`;
      case 'crate': return snap.hdr[H.crate_state] === 2 ? `Press F to take ${cat.weapons[snap.hdr[H.crate_weapon]]?.name}` : `Press F for a random weapon${price}`;
      case 'bench': return `Press F to ${tier ? 're-roll the effect on' : 'upgrade'} ${cat.weapons[gun]?.name}${price}`;
      case 'tonic': return `Press F for a tonic${price}`;
      case 'power': return 'Press F to throw the main breaker';
      case 'workbench': return cost > 0 ? `Press F for a Bulwark${price}` : 'Press F to assemble';
      case 'part': return 'Press F to pick up';
      case 'console': return 'Press F to use the console';
    }
    return '';
  }

  update(s: Session, scoreboard: boolean, project?: Project): void {
    const snap = s.snap;
    const p = s.local();
    if (!snap || !p.length) { $('hud').hidden = true; return; }
    $('hud').hidden = false;
    const { P, H } = this.sim.L;
    const cat = this.sim.catalog;
    const now = performance.now();
    const survival = s.start.mode === 0;
    const hdr = snap.hdr;

    const cur = p[P['arms.cur']];
    const g = (f: string) => p[P[`arms.guns${cur}.${f}`]];
    const w = cat.weapons[g('id')];
    const mod = g('modi') > 0 ? ` · ${cat.mods[g('modi')]}` : '';
    $('weapon').textContent = w ? `${w.name}${g('tier') ? ' Mk II' : ''}${w.burst > 1 ? ' · Burst' : ''}${mod}` : '';
    $('ammo').textContent = w ? `${g('ammo')}` : '';
    $('reserve').textContent = w ? `/ ${Math.floor(g('reserve'))}` : '';
    $('ammo').classList.toggle('low', !!w && g('ammo') <= Math.max(1, w.mag * 0.25));
    // Weapon name slides in on a swap; the ammo counter kicks with each shot.
    const st = this.state;
    const gunKey = `${cur}:${g('id')}`;
    if (gunKey !== st.gun) { st.gun = gunKey; restart($('weapon'), 'swap'); st.ammo = g('ammo'); }
    if (w && g('ammo') < st.ammo) restart($('ammo'), 'shot');
    st.ammo = g('ammo');
    $('firemode').textContent = w ? `${fireMode(w)} · ${WEAPON_CLASSES[w.cls] ?? ''}` : '';
    // Magazine: one tick per round (a bar for belts and big magazines).
    const mag = $('mag');
    if (!w) setHtml('mag', '');
    else {
      const size = Math.max(1, Math.round(this.sim.gunStats(g('id'), g('att'), g('tier'))?.mag ?? w.mag));
      const belt = size > 60;
      mag.className = belt ? 'belt' : size > 36 ? 'wide' : '';
      setHtml('mag', belt ? `<i style="--p:${Math.round((g('ammo') / size) * 100)}%"></i>` : Array.from({ length: size }, (_, i) => `<i class="${i < g('ammo') ? '' : 'off'}"></i>`).join(''));
    }
    const pips = (n: number, max: number, cls: string) => Array.from({ length: Math.max(max, n) }, (_, i) => `<i class="${cls}${i < n ? '' : ' off'}"></i>`).join('');
    setHtml('equip', `<span class="eq"><b>G</b>${pips(p[P['arms.lethal']], 2, '')}</span><span class="eq"><b>E</b>${pips(p[P['arms.tactical']], 1, 'tac')}</span>`);

    // Health: the bar drops at once, a pale ghost trails behind it; it shakes on a hit and pulses when low.
    const hpFrac = Math.max(0, p[P.health] / (p[P.max_health] || 100));
    const hb = $('health-bar');
    ($('health-fill') as HTMLElement).style.width = `${hpFrac * 100}%`;
    ($('health-ghost') as HTMLElement).style.width = `${hpFrac * 100}%`;
    if (hpFrac < st.hp - 0.01) {
      restart(hb, 'hit');
      // Show where it came from.
      const dir = $('hit-dir');
      dir.style.rotate = `${((s.yaw - p[P.hit_yaw]) * 180) / Math.PI}deg`;
      dir.classList.add('on');
      clearTimeout(st.dirTimer);
      st.dirTimer = window.setTimeout(() => dir.classList.remove('on'), 350);
    }
    hb.classList.toggle('heal', hpFrac > st.hp + 0.001 && hpFrac < 1);
    hb.classList.toggle('low', hpFrac < 0.35 && p[P.life] === 0);
    st.hp = hpFrac;
    $('health-num').textContent = `${Math.ceil(p[P.health])}`;
    const thrust = p[P['ctl.thrust']];
    ($('thrust-fill') as HTMLElement).style.width = `${thrust * 100}%`;
    $('thrust-num').textContent = `${Math.round(thrust * 100)}%`;
    if (thrust <= 0.02 && st.thrust > 0.02) restart($('thrust-bar'), 'empty');
    st.thrust = thrust;
    // Reload ring round the crosshair.
    const rl = p[P['arms.reload_t']];
    const ring = $('reload-ring');
    ring.hidden = !(rl > 0 && w && p[P.life] === 0);
    if (!ring.hidden) ($('reload-arc') as unknown as SVGElement).style.strokeDashoffset = `${163.4 * Math.min(1, rl / Math.max(w!.reload, 0.1))}`;
    // Compass tape.
    const deg = ((((-s.yaw * 180) / Math.PI) % 360) + 360) % 360;
    ($('compass-tape') as HTMLElement).style.transform = `translateX(${150 - 15 - (deg / 15 + 24) * 30}px)`;
    const ab = cat.abilities[p[P.ability]];
    const active = p[P.active_t] > 0;
    const abFrac = active && ab ? Math.min(1, p[P.active_t] / 30) : p[P.charge];
    ($('ability-ring') as HTMLElement).style.setProperty('--p', `${ab ? abFrac : 0}`);
    $('ability-pct').textContent = !ab ? '' : active ? `${Math.ceil(p[P.active_t])}s` : p[P.charge] >= 1 ? 'Q' : `${Math.floor(p[P.charge] * 100)}`;
    $('ability-state').textContent = !ab ? '' : active ? 'Active' : p[P.charge] >= 1 ? 'Ready' : 'Charging';
    $('ability').classList.toggle('active', active);
    $('ability').style.visibility = ab ? 'visible' : 'hidden';
    $('ability').classList.toggle('ready', p[P.charge] >= 1 || active);
    $('ability-name').textContent = ab ? ab.name : '';

    const mode = s.start.mode, info = MODES[mode];
    const limit = hdr[H.score_limit];
    // Points count up to their new value, with the gain (or cost) floating off beside them.
    const target = survival ? p[P.points] : p[P.score];
    if (st.points < 0 || Math.abs(target - st.points) > 100000) { st.points = target; st.shown = target; }
    if (target !== st.points) {
      const delta = target - st.points;
      const pop = document.createElement('span');
      pop.textContent = `${delta > 0 ? '+' : ''}${delta}`;
      if (delta < 0) pop.className = 'neg';
      const pops = $('point-pops');
      pops.append(pop);
      setTimeout(() => pop.remove(), 950);
      while (pops.childElementCount > 5) pops.firstElementChild!.remove();
      if (delta > 0) restart($('points'), 'bump');
      st.points = target;
    }
    st.shown += (target - st.shown) * 0.25;
    if (Math.abs(target - st.shown) < 1) st.shown = target;
    const counted = Math.round(st.shown);
    $('points').textContent = survival ? `${counted}`
      : mode === 6 ? `Rung ${Math.min(p[P.stage] + 1, LADDER_RUNGS)} / ${LADDER_RUNGS}`
      : info?.teams ? `${counted}`
      : `${p[P.kills]}${limit ? ` / ${limit}` : ''}`;
    // No time limit: the clock counts up instead.
    const roundText = survival ? `${hdr[H.round] || ''}` : hdr[H.timer] < 0 ? fmtTime(hdr[H.time]) : fmtTime(hdr[H.timer]);
    const roundEl = $('round');
    roundEl.textContent = roundText;
    // A new round number slams in; the last half minute of a match pulses red.
    if (survival && roundText !== st.round) { st.round = roundText; restart(roundEl, 'pulse'); }
    roundEl.classList.toggle('urgent', !survival && hdr[H.phase] === 1 && hdr[H.timer] >= 0 && hdr[H.timer] < 30);
    // Under the clock: time left in the match, or how much of the horde remains this round.
    const clock = $('clock-bar'), horde = $('horde-bar');
    clock.hidden = survival || hdr[H.timer] < 0 || hdr[H.phase] !== 1;
    if (!clock.hidden) { st.clockMax = Math.max(st.clockMax, hdr[H.timer]); ($('clock-fill') as HTMLElement).style.width = `${(hdr[H.timer] / Math.max(st.clockMax, 1)) * 100}%`; }
    horde.hidden = !(survival && hdr[H.phase] === 1);
    if (!horde.hidden) ($('horde-fill') as HTMLElement).style.width = `${Math.min(1, hdr[H.left] / Math.max(1, this.sim.zombieCount(hdr[H.round], snap.players.length))) * 100}%`;
    this.minimap.update(s, snap, p);
    this.objectiveBar(s, snap, p);
    this.markers(s, snap, project);
    $('left').textContent = survival ? (hdr[H.phase] === 1 ? `${hdr[H.left]} left` : hdr[H.phase] === 3 ? '' : `Next round in ${Math.ceil(hdr[H.timer])}`) : hdr[H.phase] === 0 ? `Starting in ${Math.ceil(hdr[H.timer])}` : '';

    const perks = cat.perks.filter(k => p[P.perks] & (1 << k.id)).map(k => `<span class="chip" title="${k.desc}">${k.name}</span>`);
    if (p[P.shield] > 0) perks.push(`<span class="chip">Bulwark ×${p[P.shield]}</span>`);
    const tn = cat.tonics[p[P.tonic]];
    if (tn) {
      const left = tn.kind === 0 ? `${Math.ceil(p[P.tonic_left])}s` : tn.kind === 1 ? `${p[P.tonic_left]} rounds` : tn.kind === 3 ? `[Z] ×${p[P.tonic_left]}` : '';
      perks.push(`<span class="chip tonic">${tn.name} <i>${left}</i></span>`);
    }
    if (hdr[H.insta_t] > 0) perks.push(`<span class="chip hot">One-Shot <i>${Math.ceil(hdr[H.insta_t])}s</i></span>`);
    if (hdr[H.double_t] > 0) perks.push(`<span class="chip hot">Double Pay <i>${Math.ceil(hdr[H.double_t])}s</i></span>`);
    const streaks = [0, 1, 2].filter(n => p[P.streak_ready] & (1 << n)).map(n => `<span class="chip hot">[${n + 4}] ${cat.streaks[s.start.players.find(q => q.id === s.selfId)?.loadout[18 + n] ?? n]?.name ?? 'Streak'}</span>`);
    setHtml('perks', perks.concat(streaks).join(''));

    // Quest tracker.
    const quests = cat.maps[s.start.map].quests;
    const lines = survival ? quests.map((q, n) => {
      const step = hdr[n ? H.q1_step : H.q0_step], prog = hdr[n ? H.q1_prog : H.q0_prog];
      if (step < 0 || step >= q.steps.length) return step >= q.steps.length ? `<div class="done">${q.name} ✓</div>` : '';
      return `<div><b>${q.name}</b> ${q.steps[step]}${prog > 0 ? ` (${Math.floor(prog)})` : ''}</div>`;
    }) : [];
    setHtml('quest', lines.join(''));

    const life = p[P.life];
    $('prompt').textContent = hdr[H.phase] === 3 ? 'Press Esc to leave' : life === 1 ? (p[P.self_revive] > 0 ? 'Second Wind: getting back up...' : `Down! Bleeding out in ${Math.ceil(p[P.down_t])}s`) : life === 2 ? (survival ? 'You return next round' : `Respawning in ${Math.ceil(p[P.respawn_t])}`) : this.prompt(p, s, snap);
    const reviving = p[P.revive_t];
    ($('progress') as HTMLElement).style.width = reviving > 0 && reviving < 1 ? `${reviving * 100}%` : '0';

    // Crosshair spreads with movement and closes while aiming.
    const speed = Math.hypot(p[P['ctl.vel']], p[P['ctl.vel'] + 2]);
    const gap = 6 + speed * 1.2 + (p[P['ctl.grounded']] ? 0 : 8);
    const ch = $('crosshair');
    ch.style.setProperty('--gap', `${gap}px`);
    // Aiming swaps the crosshair for the sight's reticle (scoped rifles use the scope overlay).
    const ads = p[P['arms.ads']];
    const scoped = !!w && w.zoom > 2;
    ch.style.opacity = `${life === 0 ? (scoped ? 1 - ads : Math.max(0, 1 - ads * 1.6)) : 0}`;
    $('scope').hidden = !(scoped && ads > 0.9);
    const ret = $('reticle');
    ret.hidden = !(life === 0 && w && !scoped && ads > 0.55);
    if (!ret.hidden) ret.style.opacity = `${Math.min(1, (ads - 0.55) / 0.35)}`;
    const hm = $('hitmarker');
    hm.hidden = now > this.hitUntil;
    hm.classList.toggle('kill', this.hitKill);

    this.feed = this.feed.filter(f => f.until > now);
    setHtml('feed', this.feed.map(f => `<div>${escapeHtml(f.text)}</div>`).join(''));
    const bannerText = this.banner.until > now ? this.banner.text : '';
    if (bannerText !== st.banner) { st.banner = bannerText; $('banner').textContent = bannerText; if (bannerText) restart($('banner'), 'show'); }

    $('scoreboard').hidden = !scoreboard && hdr[H.phase] !== 3;
    if (!$('scoreboard').hidden) {
      const teams = !!info?.teams;
      // Last column: what the mode is about (downs in survival, objectives, or the ladder rung).
      const extra = survival ? 'Downs' : mode === 6 ? 'Rung' : mode === 3 ? 'Captures' : mode === 4 ? 'Hill secs' : mode === 5 ? 'Tags' : '';
      const extraOf = (r: Float32Array) => survival ? r[P.deaths] : mode === 6 ? Math.min(r[P.stage] + 1, LADDER_RUNGS) : extra ? r[P.objs] : '';
      const key = (r: Float32Array) => survival ? r[P.score] : mode === 6 ? r[P.stage] * 1000 + r[P.kills] : teams ? r[P.score] : r[P.kills];
      const sorted = [...snap.players].sort((a, b) => (teams ? a[P.team] - b[P.team] : 0) || key(b) - key(a));
      const rows = sorted.map(r => {
        const side = teams ? ` style="--team:${TEAM_CSS[r[P.team]] ?? '#fff'}" data-team="${r[P.team]}"` : '';
        return `<tr class="${r[P.id] === s.selfId ? 'me' : ''}"${side}><td>${cardHtml(this.lookOf(r[P.id]), escapeHtml(this.name(r[P.id])), true)}</td><td>${survival ? r[P.points] : r[P.score]}</td><td>${r[P.kills]}</td><td>${survival ? r[P.headshots] : r[P.deaths]}</td><td>${extraOf(r)}</td></tr>`;
      });
      const head = teams ? `<caption>${TEAM_NAMES[0]} ${hdr[H.score_a]} - ${hdr[H.score_b]} ${TEAM_NAMES[1]}</caption>` : '';
      setHtml('scoreboard', `<table>${head}<tr><th>${cat.maps[s.start.map].name} · ${info?.name ?? ''}</th><th>${survival ? 'Points' : 'Score'}</th><th>Kills</th><th>${survival ? 'Headshots' : 'Deaths'}</th><th>${extra}</th></tr>${rows.join('')}</table>`);
    }

    // Recon Ping: mark enemies through walls for the caller.
    const marks = p[P.ping_t] > 0 ? snap.players.filter(r => r[P.id] !== s.selfId && r[P.life] === 0).length : 0;
    $('ping').textContent = marks ? `Recon Ping: ${marks} hostile${marks > 1 ? 's' : ''} on the map` : '';
  }

  /** Team scores, zones, the hill or the race for the top, along the top of the screen. */
  objectiveBar(s: Session, snap: NonNullable<Session['snap']>, p: Float32Array): void {
    const { P, H, E } = this.sim.L;
    const mode = s.start.mode, info = MODES[mode], hdr = snap.hdr;
    if (!info || mode === 0) { setHtml('objective', ''); return; }
    const limit = hdr[H.score_limit];
    const mine = p[P.team];
    const side = (t: number, score: number) => `<div class="side${t === mine ? ' mine' : ''}" style="--team:${TEAM_CSS[t]}"><small>${TEAM_NAMES[t]}</small>${score}<u style="width:${limit ? Math.min(100, (score / limit) * 100) : 0}%"></u></div>`;
    const parts: string[] = [];
    if (info.teams) {
      parts.push(side(0, hdr[H.score_a]));
      if (mode === 3) {
        const zones = snap.ents.filter(e => e[E.kind] >= 40 && e[E.kind] <= 42).sort((a, b) => a[E.kind] - b[E.kind]);
        for (const z of zones) {
          const { owner, contested, prog } = zoneOf(z[E.a]);
          const fill = prog < 0 ? TEAM_CSS[0] : TEAM_CSS[1];
          parts.push(`<div class="zone${contested ? ' contested' : ''}" style="--team:${owner >= 0 ? TEAM_CSS[owner] : '#ddd'};--fill:${fill};--p:${Math.abs(prog).toFixed(2)}">${ZONE_NAMES[z[E.kind] - 40]}</div>`);
        }
      } else if (mode === 4) {
        const hill = snap.ents.find(e => e[E.kind] === 45);
        const st = hill ? zoneOf(hill[E.a]) : null;
        const who = !st ? '' : st.contested ? 'Contested' : st.owner >= 0 ? `${TEAM_NAMES[st.owner]} hold the hill` : 'Hill empty';
        parts.push(`<div class="info">${who} · moves in ${fmtTime(hdr[H.obj_t])}</div>`);
      } else {
        parts.push(`<div class="info">${limit ? `First to ${limit}` : 'No score limit'}</div>`);
      }
      parts.push(side(1, hdr[H.score_b]));
    } else {
      // Free-for-all and the ladder: you against the leader.
      const key = (r: Float32Array) => (mode === 6 ? r[P.stage] : r[P.kills]);
      const others = snap.players.filter(r => r[P.id] !== s.selfId);
      const lead = others.reduce<Float32Array | null>((b, r) => (!b || key(r) > key(b) ? r : b), null);
      const unit = mode === 6 ? 'rung' : 'kills';
      const mineKey = mode === 6 ? Math.min(p[P.stage] + 1, LADDER_RUNGS) : p[P.kills];
      parts.push(`<div class="info">You ${mineKey}${mode === 6 ? ` / ${LADDER_RUNGS}` : ''} ${unit}${lead ? ` · Leader ${escapeHtml(this.name(lead[P.id]))} ${mode === 6 ? Math.min(lead[P.stage] + 1, LADDER_RUNGS) : key(lead)}` : ''}${mode !== 6 && limit ? ` · First to ${limit}` : ''}</div>`);
    }
    setHtml('objective', parts.join(''));
  }

  /** Floating labels: zone letters, the hill, and teammates' names. */
  private markers(s: Session, snap: NonNullable<Session['snap']>, project?: Project): void {
    const { P, E } = this.sim.L;
    const mode = s.start.mode, info = MODES[mode];
    if (!project || !info || mode === 0) { setHtml('markers', ''); return; }
    const out: string[] = [];
    const me = s.local();
    const myPos = [me[P['ctl.pos']], me[P['ctl.pos'] + 1], me[P['ctl.pos'] + 2]];
    const place = (pos: number[], html: string, cls: string, color: string) => {
      const at = project(pos);
      if (!at || at[0] < -0.05 || at[0] > 1.05 || at[1] < -0.05 || at[1] > 1.05) return;
      const dist = Math.hypot(pos[0] - myPos[0], pos[2] - myPos[2]);
      out.push(`<div class="mk ${cls}" style="left:${(at[0] * 100).toFixed(2)}%;top:${(at[1] * 100).toFixed(2)}%;--team:${color}">${html}${cls === 'obj' ? `<br>${Math.round(dist)} m` : ''}</div>`);
    };
    for (const e of snap.ents) {
      const k = e[E.kind];
      if (k < 40 || k > 45) continue;
      const { owner } = zoneOf(e[E.a]);
      const label = k === 45 ? 'H' : ZONE_NAMES[k - 40];
      place([e[E.pos], e[E.pos + 1] + 3.2, e[E.pos + 2]], `<b>${label}</b>`, 'obj', owner >= 0 ? TEAM_CSS[owner] : '#ddd');
    }
    if (info.teams) {
      const mine = me[P.team];
      for (const pl of s.players()) {
        if (pl.id === s.selfId || pl.rec[P.team] !== mine || pl.rec[P.life] !== 0) continue;
        place([pl.x, pl.y + 2.15, pl.z], escapeHtml(this.name(pl.id)), 'ally', TEAM_CSS[mine]);
      }
    }
    setHtml('markers', out.join(''));
  }
}

const zoneOf = (a: number) => { const q = Math.floor(a / 4); return { owner: Math.floor(q / 2) - 1, contested: q % 2 === 1, prog: a - q * 4 - 1 }; };

/** Replays a CSS animation class on an element. */
function restart(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const cache = new Map<string, string>();
/** Only touches the DOM when the markup actually changed. */
function setHtml(id: string, html: string): void {
  if (cache.get(id) === html) return;
  cache.set(id, html);
  $(id).innerHTML = html;
}
function fmtTime(t: number): string { const s = Math.max(0, Math.ceil(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
export function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
