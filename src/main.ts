// App entry: menus, party flow, and the frame loop.
import { Sfx } from './audio/sfx';
import { loadSim } from './core/load';
import type { Sim } from './core/sim';
import { Input } from './engine/input';
import { Ticker } from './engine/ticker';
import { Scene } from './game/scene';
import { Session } from './game/session';
import { frameRateOptions, FrameLimiter, FrameMeter, isFpsLimit } from './engine/pacing';
import { streamMaterials, type MaterialStream } from './gfx/materials';
import { createRenderer, TEXTURE_QUALITY, type Renderer, type TextureQuality } from './gfx/renderer';
import { clientToken, GuestLobby, HostLobby, MODES, type KickReason, type LobbyState, type StartMsg } from './netcode/lobby';
import { codeFromUrl, normalizeCode, partyLink, setUrlCode } from './netcode/party';
import { createTransport, NetError } from './netcode/transport';
import { escapeHtml, Hud } from './ui/hud';
import { LoadoutEditor } from './ui/loadout';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const transport = createTransport(params.get('net'));

interface Settings {
  sens: number; fov: number; volume: number; blur: boolean; dof: boolean;
  /** Material resolution preset. */
  textures: TextureQuality;
  /** Frame rate cap; 0 draws every display refresh (up to 360 Hz and beyond). */
  fpsLimit: number;
  showFps: boolean;
}
const DEFAULTS: Settings = { sens: 1, fov: 90, volume: 0.5, blur: true, dof: true, textures: 'high', fpsLimit: 0, showFps: false };
function loadSettings(): Settings {
  let s: Settings;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('gs.settings') ?? '{}') }; } catch { s = { ...DEFAULTS }; }
  if (!(s.textures in TEXTURE_QUALITY)) s.textures = DEFAULTS.textures;
  if (!isFpsLimit(s.fpsLimit)) s.fpsLimit = 0;
  return s;
}
/** The refresh rate measured on a previous visit, so the menu is right before measuring again. */
function storedHz(): number {
  try { const hz = Number(localStorage.getItem('gs.displayHz')); return hz > 0 && hz < 1000 ? hz : 0; } catch { return 0; }
}
function saveSettings(s: Settings): void { try { localStorage.setItem('gs.settings', JSON.stringify(s)); } catch { /* ignore */ } }

const KICK_TEXT: Record<KickReason, string> = {
  kicked: 'The host removed you from the party.',
  banned: 'You are banned from this party.',
  full: 'That party is full.',
  version: 'That party is running a different version. Refresh both pages.',
  'host-left': 'The host closed the party.',
};

class App {
  private sim!: Sim;
  private renderer!: Renderer;
  private canvas = $<HTMLCanvasElement>('canvas');
  private input = new Input(this.canvas);
  private sfx = new Sfx();
  private hud!: Hud;
  private editor!: LoadoutEditor;
  private settings = loadSettings();
  private host: HostLobby | null = null;
  private guest: GuestLobby | null = null;
  private lobby: LobbyState | null = null;
  private session: Session | null = null;
  private scene: Scene | null = null;
  private screen = 'loading';
  private back = 'main';
  private last = performance.now();
  private lastSim = performance.now();
  private zoom = 1;
  /** Resolves when every procedural material layer is on the GPU. */
  materials: Promise<void> = Promise.resolve();
  private materialStream: MaterialStream | null = null;
  private rendererName = '';
  private limiter = new FrameLimiter();
  /** Exposed for the settings screen and automated tests. Seeded with the rate measured last visit. */
  meter = new FrameMeter(storedHz());
  private shownHz = -1;
  private lastHud = 0;

  async init(): Promise<void> {
    this.sim = await loadSim();
    this.hud = new Hud(this.sim);
    this.resize();
    addEventListener('resize', () => this.resize());
    const tex = TEXTURE_QUALITY[this.settings.textures];
    const quality = { shadowSize: params.has('low') ? 1024 : 2048, post: !params.has('low'), offscreen: params.has('offscreen'), textureSize: tex.size, anisotropy: tex.anisotropy };
    this.renderer = await createRenderer(this.canvas, params.get('renderer'), quality);
    this.canvas = $<HTMLCanvasElement>('canvas') ?? this.canvas;
    this.rendererName = this.renderer.kind === 'webgpu' ? 'WebGPU' : 'WebGL2 (fallback)';
    this.limiter.limit = this.settings.fpsLimit;
    this.applyTextures(false);
    this.editor = new LoadoutEditor(this.sim, $('loadout-grid'), $('loadout-points'), $('loadout-error'));
    this.editor.onChange = l => { this.host?.setLoadout(l); this.guest?.setLoadout(l); };
    this.bindMenus();
    this.input.sensitivity = this.settings.sens;
    this.sfx.volume = this.settings.volume;
    this.input.onUnlock = () => { if (this.session && this.screen === 'none') this.show('pause'); };

    const code = codeFromUrl();
    this.show('main');
    if (code) {
      $<HTMLInputElement>('join-code').value = code;
      // Joining needs a name; if we have one saved, go straight in.
      if (this.name()) void this.join(code);
    }
    requestAnimationFrame(t => this.frame(t));
    // Simulation runs on its own clock so a slow or hidden page does not slow the match down.
    new Ticker(60, () => this.simulate());
  }

  /**
   * (Re)generates the material textures at the selected quality. Materials stream in while the
   * menu is up; surfaces show neutral grey until each layer arrives.
   */
  private applyTextures(reallocate: boolean): void {
    const tex = TEXTURE_QUALITY[this.settings.textures];
    this.materialStream?.cancel();
    if (reallocate) this.renderer.setMaterialQuality(tex.size, tex.anisotropy);
    const status = (text: string) => {
      this.texText = text;
      this.showRendererInfo();
      $('tex-status').textContent = text;
    };
    status(`generating ${tex.label.toLowerCase()} textures...`);
    this.materialStream = streamMaterials(this.renderer, this.sim, tex.size, (done, total) => {
      status(done < total ? `generating ${tex.label.toLowerCase()} textures ${done}/${total}` : `${tex.label} textures (${tex.size} px, ${tex.anisotropy}x filtering)`);
    });
    this.materials = this.materialStream.done;
  }

  private texText = '';
  private showRendererInfo(): void {
    const hz = this.meter.displayHz;
    $('renderer-info').textContent = [`Renderer: ${this.rendererName}`, hz ? `${hz} Hz display` : '', this.texText].filter(Boolean).join(' · ');
  }

  private name(): string { return $<HTMLInputElement>('name').value.trim(); }

  private resize(): void {
    // ?low renders at half resolution for weak GPUs (and the automated browser tests).
    const dpr = Math.min(devicePixelRatio, 2) * (params.has('low') ? 0.5 : 1);
    const [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer?.resize(w, h);
  }

  private show(screen: string): void {
    this.screen = screen;
    for (const el of document.querySelectorAll<HTMLElement>('.screen')) el.hidden = el.id !== `screen-${screen}`;
    $('menu').classList.toggle('clear', screen === 'none');
  }
  private error(text: string): void { $('main-error').textContent = text; }

  private bindMenus(): void {
    const nameEl = $<HTMLInputElement>('name');
    try { nameEl.value = localStorage.getItem('gs.name') ?? ''; } catch { /* ignore */ }
    nameEl.onchange = () => { try { localStorage.setItem('gs.name', this.name()); } catch { /* ignore */ } };

    const click = (id: string, fn: () => void) => { $(id).onclick = () => { this.sfx.unlock(); fn(); }; };
    click('btn-solo', () => this.startSolo());
    click('btn-host', () => void this.hostParty());
    click('btn-join', () => {
      const code = normalizeCode($<HTMLInputElement>('join-code').value);
      if (!code) return this.error('Party codes are 6 letters and numbers.');
      void this.join(code);
    });
    $<HTMLInputElement>('join-code').onkeydown = e => { if (e.key === 'Enter') $('btn-join').click(); };
    click('btn-loadout', () => this.openLoadout('main'));
    click('btn-lobby-loadout', () => this.openLoadout('lobby'));
    click('btn-loadout-done', () => { if (this.editor.check()) this.show(this.back); });
    click('btn-loadout-reset', () => this.editor.reset());
    click('btn-settings', () => this.openSettings('main'));
    click('btn-pause-settings', () => this.openSettings('pause'));
    click('btn-settings-done', () => this.show(this.back));
    click('btn-resume', () => this.resume());
    click('btn-end', () => this.leaveMatch());
    click('btn-leave', () => this.leaveParty());
    click('btn-copy', () => {
      const input = $<HTMLInputElement>('lobby-link');
      void navigator.clipboard?.writeText(input.value).then(() => ($('btn-copy').textContent = 'Copied!'), () => input.select());
      setTimeout(() => ($('btn-copy').textContent = 'Copy invite link'), 1500);
    });
    click('btn-copy-code', () => {
      const code = $('lobby-code').textContent ?? '';
      void navigator.clipboard?.writeText(code).then(() => ($('btn-copy-code').textContent = 'Copied!'), () => {});
      setTimeout(() => ($('btn-copy-code').textContent = 'Copy code'), 1500);
    });
    click('btn-start', () => this.startParty());
    click('btn-ready', () => {
      const me = this.lobby?.players.find(p => p.id === this.guest?.selfId);
      this.guest?.setReady(!me?.ready);
    });
    const mode = $<HTMLSelectElement>('lobby-mode'), map = $<HTMLSelectElement>('lobby-map');
    MODES.forEach(m => mode.add(new Option(`${m.name} (up to ${m.max})`, String(m.id))));
    this.sim.catalog.maps.forEach(m => map.add(new Option(m.name, String(m.id))));
    mode.onchange = () => this.host?.setMode(+mode.value);
    map.onchange = () => this.host?.setMap(+map.value);

    const s = this.settings;
    const bind = (id: string, key: keyof Settings, apply: () => void) => {
      const el = $<HTMLInputElement>(id);
      if (el.type === 'checkbox') el.checked = s[key] as boolean; else el.value = String(s[key]);
      el.oninput = () => { (s as unknown as Record<string, unknown>)[key] = el.type === 'checkbox' ? el.checked : +el.value; apply(); saveSettings(s); };
    };
    bind('set-sens', 'sens', () => (this.input.sensitivity = s.sens));
    bind('set-fov', 'fov', () => {});
    bind('set-volume', 'volume', () => (this.sfx.volume = s.volume));
    bind('set-blur', 'blur', () => {});
    bind('set-dof', 'dof', () => {});
    bind('set-showfps', 'showFps', () => ($('fps').hidden = !s.showFps));
    $('fps').hidden = !s.showFps;

    const texSel = $<HTMLSelectElement>('set-tex');
    for (const [key, q] of Object.entries(TEXTURE_QUALITY)) texSel.add(new Option(`${q.label} (${q.size} px, ${q.anisotropy}x filtering)`, key));
    texSel.value = s.textures;
    texSel.onchange = () => {
      s.textures = texSel.value as TextureQuality;
      saveSettings(s);
      this.applyTextures(true);
    };
    const fpsSel = $<HTMLSelectElement>('set-fps');
    this.updateDisplayHz(true);
    // The refresh rate can change (the window moved to another monitor): keep the menu in step.
    setInterval(() => this.updateDisplayHz(false), 1000);
    fpsSel.onchange = () => {
      s.fpsLimit = +fpsSel.value;
      this.limiter.limit = s.fpsLimit;
      this.limiter.reset();
      saveSettings(s);
    };

    // Clicking the game resumes; Escape (handled by the browser) releases the mouse and pauses.
    this.canvas.onclick = () => { if (this.session && this.screen === 'none') this.input.lock(); };
  }

  private openLoadout(back: string): void { this.back = back; this.editor.render(); this.show('loadout'); }
  private openSettings(back: string): void {
    this.back = back;
    this.show('settings');
    this.updateDisplayHz(true);
  }

  /**
   * Rebuilds the frame rate menu around the measured refresh rate: the default draws every
   * refresh (shown as that rate), and only caps the display can actually show are offered.
   */
  private updateDisplayHz(force: boolean): void {
    const hz = this.meter.displayHz;
    if (!force && hz === this.shownHz) return;
    this.shownHz = hz;
    if (hz) try { localStorage.setItem('gs.displayHz', String(hz)); } catch { /* storage may be blocked */ }
    const sel = $<HTMLSelectElement>('set-fps');
    sel.replaceChildren(...frameRateOptions(hz, this.settings.fpsLimit).map(o => new Option(o.label, String(o.value))));
    sel.value = String(this.settings.fpsLimit);
    $('display-hz').textContent = hz
      ? `Detected a ${hz} Hz display, so the game draws up to ${hz} frames a second. Browsers can't draw faster than the monitor refreshes; a 360 Hz monitor gets 360 fps.`
      : 'Measuring your display\'s refresh rate...';
    this.showRendererInfo();
  }

  // ---- Party flow ----

  private startSolo(): void {
    const seed = (Math.random() * 2 ** 31) | 0;
    this.hud.setNames([{ id: 0, name: this.name() || 'You' }]);
    this.begin({ t: 'start', map: 0, mode: 0, seed, players: [{ id: 0, team: 0, loadout: this.editor.loadout }] }, 0);
  }

  private async hostParty(): Promise<void> {
    this.error('');
    $('btn-host').textContent = 'Creating...';
    try {
      this.host = await HostLobby.create(transport, this.name() || 'Host', this.editor.loadout, this.sim.catalog.maps.length);
      this.host.onChange = st => this.renderLobby(st);
      setUrlCode(this.host.code);
      this.renderLobby(this.host.state);
      this.show('lobby');
    } catch (e) {
      this.error(e instanceof NetError && e.kind === 'network' ? 'Could not reach the matchmaking broker. Check your connection and try again.' : String((e as Error).message ?? e));
    } finally {
      $('btn-host').textContent = 'Host a party';
    }
  }

  private async join(code: string): Promise<void> {
    this.error('');
    $('btn-join').textContent = 'Joining...';
    try {
      this.guest = await GuestLobby.join(transport, code, this.name() || 'Guest', clientToken(), this.editor.loadout);
      const g = this.guest;
      g.onChange = st => this.renderLobby(st);
      g.onStart = msg => this.begin(msg, g.selfId);
      g.onEnd = () => this.endMatch();
      g.onGone = reason => { this.teardown(); this.show('main'); this.error(KICK_TEXT[reason]); };
      setUrlCode(code);
      this.renderLobby(g.state);
      this.show('lobby');
      if (g.state.inMatch) $('lobby-status').textContent = 'Match in progress. You will drop in shortly...';
    } catch (e) {
      const kind = e instanceof NetError ? e.kind : 'network';
      const reason = (e as Error).message as KickReason;
      this.error(KICK_TEXT[reason] ?? (kind === 'not-found' ? 'No party with that code. Ask for a fresh invite.' : kind === 'timeout' ? 'The host did not answer. Try again.' : 'Could not connect. Check your connection and try again.'));
      setUrlCode(null);
    } finally {
      $('btn-join').textContent = 'Join';
    }
  }

  private renderLobby(st: LobbyState): void {
    this.lobby = st;
    this.hud.setNames(st.players);
    const isHost = !!this.host;
    $('lobby-code').textContent = st.code;
    $<HTMLInputElement>('lobby-link').value = partyLink(st.code);
    $<HTMLSelectElement>('lobby-mode').value = String(st.mode);
    $<HTMLSelectElement>('lobby-map').value = String(st.map);
    $<HTMLSelectElement>('lobby-mode').disabled = !isHost;
    $<HTMLSelectElement>('lobby-map').disabled = !isHost;
    $('btn-start').hidden = !isHost;
    $('btn-ready').hidden = isHost;
    const list = $('lobby-players');
    list.innerHTML = st.players.map(p => `<li><span>${escapeHtml(p.name)}</span><em>${p.host ? 'host' : p.ready ? 'ready' : 'not ready'}</em>${isHost && !p.host ? `<button data-kick="${p.id}">Kick</button><button data-ban="${p.id}">Ban</button>` : ''}</li>`).join('');
    list.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach(b => (b.onclick = () => this.host?.kick(+b.dataset.kick!)));
    list.querySelectorAll<HTMLButtonElement>('[data-ban]').forEach(b => (b.onclick = () => this.host?.ban(+b.dataset.ban!)));
    const waiting = st.players.filter(p => !p.host && !p.ready).length;
    $('lobby-status').textContent = `${st.players.length} / ${MODES[st.mode].max} players · ${MODES[st.mode].desc}${isHost && waiting ? ` · ${waiting} not ready` : ''}`;
    if (!isHost) $('btn-ready').textContent = st.players.find(p => p.id === this.guest?.selfId)?.ready ? 'Not ready' : 'Ready';
  }

  private startParty(): void {
    if (!this.host) return;
    this.host.setLoadout(this.editor.loadout);
    const msg = this.host.start();
    this.begin(msg, 0);
  }

  // ---- Match ----

  private begin(start: StartMsg, selfId: number): void {
    // The map index may come from another player's machine: keep it within the maps we have.
    start = { ...start, map: Math.min(Math.max(0, start.map | 0), this.sim.catalog.maps.length - 1) };
    this.session?.dispose();
    const session = new Session(this.sim, start, selfId, this.host, this.guest);
    this.session = session;
    this.scene = new Scene(this.renderer, this.sim, session);
    session.onEvent = e => {
      if (!this.scene || !this.session) return;
      this.scene.handleEvent(e, this.session.view(this.settings.fov));
      this.hud.handleEvent(e, this.session);
      this.sound(e);
    };
    $('pause-code').textContent = this.lobby ? `Party ${this.lobby.code} · ${partyLink(this.lobby.code)}` : 'Solo';
    this.resume();
  }

  private resume(): void {
    this.show('none');
    this.input.lock();
  }

  private sound(e: Float32Array): void {
    const { V } = this.sim.L;
    const s = this.session!;
    const heavy = (w: number) => Math.min(1, (this.sim.catalog.weapons[w]?.damage ?? 50) / 200);
    switch (e[0]) {
      case V.local:
        switch (e[1]) {
          case 1: (this.sim.catalog.weapons[e[2]]?.flags ?? 0) & 8 ? this.sfx.energy() : this.sfx.shot(heavy(e[2])); break;
          case 2: this.sfx.dry(); break;
          case 3: this.sfx.reload(); break;
          case 6: case 11: this.sfx.jump(); break;
          case 7: this.sfx.land(); break;
          case 8: this.sfx.slide(); break;
          case 9: this.sfx.thrust(); break;
          case 12: this.sfx.jump(); break;
        }
        break;
      case V.shot: if (e[1] !== s.selfId) this.sfx.shot(heavy(e[2]), true); break;
      case V.hit: if (e[1] === s.selfId) this.sfx.hit(e[4] > 0); break;
      case V.explode: if (e[5] !== 2) this.sfx.explode(); break;
      case V.buy: if (e[1] === s.selfId) this.sfx.buy(); break;
      case V.msg: if (e[2] === s.selfId && e[1] < 4) this.sfx.deny(); break;
      case V.round: this.sfx.round(); break;
      case V.powerup: if (e[5]) this.sfx.powerup(); break;
      case V.zattack: if (e[2] === s.selfId) this.sfx.hurt(); break;
      case V.spawn: if (Math.random() < 0.3) this.sfx.groan(); break;
    }
  }

  /** Host: back to the lobby for everyone. Guest/solo: leave. */
  private leaveMatch(): void {
    if (this.host) { this.host.endMatch(); this.endMatch(); return; }
    if (this.guest) { this.leaveParty(); return; }
    this.endMatch();
    this.show('main');
  }

  private endMatch(): void {
    this.input.unlock();
    this.session?.dispose();
    this.session = null;
    this.scene = null;
    $('hud').hidden = true;
    if (this.lobby) { this.renderLobby(this.host?.state ?? this.lobby); this.show('lobby'); }
  }

  private teardown(): void {
    this.input.unlock();
    this.session?.dispose();
    this.session = null;
    this.scene = null;
    $('hud').hidden = true;
    this.host?.close();
    this.guest?.close();
    this.host = this.guest = null;
    this.lobby = null;
    setUrlCode(null);
  }
  private leaveParty(): void { this.teardown(); this.show('main'); }

  private simulate(): void {
    const now = performance.now();
    const dt = (now - this.lastSim) / 1000;
    this.lastSim = now;
    this.session?.update(dt, this.input, this.zoom, this.screen !== 'none' || !this.input.locked);
  }

  private frame(now: number): void {
    requestAnimationFrame(t => this.frame(t));
    const s = this.session;
    // Measure the display only while nothing 3D is drawn: in a match the gap between callbacks
    // is the render time, which would make a 144 Hz monitor look like a 60 Hz one on a slow GPU.
    if (!s || !this.scene) { this.meter.refresh(now); this.last = now; return; }
    if (!this.limiter.shouldRender(now)) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.meter.rendered(now);
    // Apply anything due before drawing, so the camera never lags a tick behind input.
    this.simulate();
    const me = s.local();
    const { P } = this.sim.L;
    this.zoom = 1;
    if (me.length) {
      const cur = me[P['arms.cur']];
      const stats = this.sim.gunStats(me[P[`arms.guns${cur}.id`]], me[P[`arms.guns${cur}.att`]], me[P[`arms.guns${cur}.tier`]]);
      this.zoom = 1 + ((stats?.zoom ?? 1) - 1) * me[P['arms.ads']];
    }
    const view = s.view(this.settings.fov);
    const frame = this.scene.build(view, dt, this.canvas.width / this.canvas.height, { fov: this.settings.fov, motionBlur: this.settings.blur, dof: this.settings.dof });
    this.renderer.render(frame);
    // The HUD is DOM text: refreshing it faster than 60 Hz costs time and shows nothing new.
    if (now - this.lastHud >= 16) {
      this.lastHud = now;
      this.hud.update(s, this.input.scoreboard);
      if (this.settings.showFps) $('fps').textContent = `${Math.round(this.meter.fps)} fps · ${this.meter.frameMs.toFixed(1)} ms${this.meter.displayHz ? ` · ${this.meter.displayHz} Hz display` : ''}`;
    }
  }
}

const app = new App();
app.init().catch(e => {
  console.error(e);
  $('loading-text').textContent = `Could not start: ${(e as Error).message ?? e}`;
});
// Exposed for automated browser tests.
(window as unknown as { app: App }).app = app;
