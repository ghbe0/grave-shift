// In-match HUD drawn with DOM elements over the canvas.
import type { Sim, Snap } from '../core/sim';
import { PLAYER_COLORS } from '../game/scene';
import type { Session } from '../game/session';

const $ = (id: string) => document.getElementById(id)!;
const INTERACT = ['', 'door', 'wallbuy', 'perk', 'crate', 'bench', 'tonic', 'power', 'workbench', 'part', 'console', 'barricade', 'revive'];
const css = (c: number[]) => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;

export class Hud {
  private feed: { text: string; until: number }[] = [];
  private banner = { text: '', until: 0 };
  private hitUntil = 0;
  private hitKill = false;
  private names = new Map<number, string>();

  constructor(private sim: Sim) {}

  setNames(players: { id: number; name: string }[]): void { for (const p of players) this.names.set(p.id, p.name); }
  private name(id: number): string { return this.names.get(id) ?? `Player ${id + 1}`; }
  say(text: string, secs = 4): void { this.feed.push({ text, until: performance.now() + secs * 1000 }); if (this.feed.length > 5) this.feed.shift(); }
  announce(text: string, secs = 3): void { this.banner = { text, until: performance.now() + secs * 1000 }; }

  /** Turns simulation events into feed lines, banners and hit markers. */
  handleEvent(e: Float32Array, s: Session): void {
    const { V } = this.sim.L;
    const cat = this.sim.catalog;
    const me = s.selfId;
    switch (e[0]) {
      case V.hit: if (e[1] === me) { this.hitUntil = performance.now() + 120; this.hitKill = e[4] > 0; } break;
      case V.round: this.announce(e[2] ? `Round ${e[1]} survived` : s.start.mode === 0 ? `Round ${e[1]}` : 'Fight!'); break;
      case V.pdown: this.say(e[1] === me ? 'You are down' : `${this.name(e[1])} is down`); break;
      case V.pdeath: this.say(e[2] >= 0 ? `${this.name(e[2])} eliminated ${this.name(e[1])}` : e[1] === me ? 'You bled out' : `${this.name(e[1])} bled out`); break;
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
      case V.gameover: this.announce(s.start.mode === 0 ? `Overrun on round ${e[2]}` : `${this.name(e[1])} wins`, 60); break;
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
      case 'power': return 'Press F to turn on the power';
      case 'workbench': return cost > 0 ? `Press F for a Bulwark${price}` : 'Press F to assemble';
      case 'part': return 'Press F to pick up';
      case 'console': return 'Press F to use the console';
    }
    return '';
  }

  update(s: Session, scoreboard: boolean): void {
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
    $('weapon').textContent = w ? `${w.name}${g('tier') ? ' Mk II' : ''}${mod}` : '';
    $('ammo').textContent = w ? `${g('ammo')}` : '';
    $('reserve').textContent = w ? `/ ${Math.floor(g('reserve'))}` : '';
    $('ammo').classList.toggle('low', !!w && g('ammo') <= Math.max(1, w.mag * 0.25));
    $('equip').textContent = `G ×${p[P['arms.lethal']]}  E ×${p[P['arms.tactical']]}`;

    ($('health-fill') as HTMLElement).style.width = `${Math.max(0, (p[P.health] / p[P.max_health]) * 100)}%`;
    ($('thrust-fill') as HTMLElement).style.width = `${p[P['ctl.thrust']] * 100}%`;
    const ab = cat.abilities[p[P.ability]];
    const active = p[P.active_t] > 0;
    ($('ability-fill') as HTMLElement).style.width = `${(active ? 1 : p[P.charge]) * 100}%`;
    $('ability').classList.toggle('ready', p[P.charge] >= 1 || active);
    $('ability-name').textContent = ab ? `${ab.name}${p[P.charge] >= 1 ? ' [Q]' : ''}` : '';

    $('points').textContent = survival ? `${p[P.points]}` : `${p[P.kills]} / ${hdr[H.score_limit]}`;
    $('round').textContent = survival ? `${hdr[H.round] || ''}` : fmtTime(hdr[H.timer]);
    $('left').textContent = survival ? (hdr[H.phase] === 1 ? `${hdr[H.left]} left` : hdr[H.phase] === 3 ? '' : `Next round in ${Math.ceil(hdr[H.timer])}`) : hdr[H.phase] === 0 ? `Starting in ${Math.ceil(hdr[H.timer])}` : '';

    const perks = cat.perks.filter(k => p[P.perks] & (1 << k.id)).map(k => `<span class="chip" title="${k.desc}">${k.name}</span>`);
    if (p[P.shield] > 0) perks.push(`<span class="chip">Bulwark ×${p[P.shield]}</span>`);
    if (p[P.tonic] >= 0) {
      const tn = cat.tonics[p[P.tonic]];
      const left = tn.kind === 0 ? `${Math.ceil(p[P.tonic_left])}s` : tn.kind === 1 ? `${p[P.tonic_left]} rounds` : tn.kind === 3 ? `[Z] ×${p[P.tonic_left]}` : '';
      perks.push(`<span class="chip tonic">${tn.name} ${left}</span>`);
    }
    if (hdr[H.insta_t] > 0) perks.push(`<span class="chip hot">One-Shot ${Math.ceil(hdr[H.insta_t])}s</span>`);
    if (hdr[H.double_t] > 0) perks.push(`<span class="chip hot">Double Pay ${Math.ceil(hdr[H.double_t])}s</span>`);
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
    ch.style.opacity = `${life === 0 ? 1 - p[P['arms.ads']] * (w && w.zoom > 2 ? 0 : 0.9) : 0}`;
    $('scope').hidden = !(w && w.zoom > 2 && p[P['arms.ads']] > 0.9);
    const hm = $('hitmarker');
    hm.hidden = now > this.hitUntil;
    hm.classList.toggle('kill', this.hitKill);

    this.feed = this.feed.filter(f => f.until > now);
    setHtml('feed', this.feed.map(f => `<div>${escapeHtml(f.text)}</div>`).join(''));
    $('banner').textContent = this.banner.until > now ? this.banner.text : '';

    $('scoreboard').hidden = !scoreboard && hdr[H.phase] !== 3;
    if (!$('scoreboard').hidden) {
      const rows = [...snap.players].sort((a, b) => (survival ? b[P.score] - a[P.score] : b[P.kills] - a[P.kills])).map(r =>
        `<tr class="${r[P.id] === s.selfId ? 'me' : ''}"><td><i style="background:${css(PLAYER_COLORS[r[P.id] % PLAYER_COLORS.length])}"></i>${escapeHtml(this.name(r[P.id]))}</td><td>${survival ? r[P.points] : r[P.score]}</td><td>${r[P.kills]}</td><td>${survival ? r[P.headshots] : r[P.deaths]}</td><td>${survival ? r[P.deaths] : ''}</td></tr>`);
      setHtml('scoreboard', `<table><tr><th>${cat.maps[s.start.map].name}</th><th>${survival ? 'Points' : 'Score'}</th><th>Kills</th><th>${survival ? 'Headshots' : 'Deaths'}</th><th>${survival ? 'Downs' : ''}</th></tr>${rows.join('')}</table>`);
    }

    // Recon Ping: mark enemies through walls for the caller.
    const marks = p[P.ping_t] > 0 ? snap.players.filter(r => r[P.id] !== s.selfId && r[P.life] === 0).length : 0;
    $('ping').textContent = marks ? `Recon Ping: ${marks} hostile${marks > 1 ? 's' : ''} on the map` : '';
  }
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
