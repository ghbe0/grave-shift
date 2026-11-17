// App entry: menus, party flow, and the frame loop.
import { Sfx } from './audio/sfx';
import { loadSim } from './core/load';
import { WF, type Sim } from './core/sim';
import { Input } from './engine/input';
import { ACTIONS, defaultBinds, keyName, rebind, saveBinds } from './engine/binds';
import { Ticker } from './engine/ticker';
import { isTouchDevice, TouchControls } from './engine/touch';
import { Scene } from './game/scene';
import { Session } from './game/session';
import { frameRateOptions, FrameLimiter, FrameMeter, isFpsLimit } from './engine/pacing';
import { streamMaterials, type MaterialStream } from './gfx/materials';
import { createRenderer, TEXTURE_QUALITY, type Renderer, type TextureQuality } from './gfx/renderer';
import { clientToken, GuestLobby, HostLobby, MODES, type KickReason, type LobbyState, type StartMsg } from './netcode/lobby';
import { defaultRules, HEALTH_CHOICES, POINTS_CHOICES, RESPAWN_CHOICES, ROUND_CHOICES, rulesSummary, scoreChoices, TEAM_CSS, TEAM_NAMES, TIME_CHOICES, type Choice, type Rules } from './game/rules';
import { codeFromUrl, normalizeCode, partyLink, setUrlCode } from './netcode/party';
import { createTransport, NetError } from './netcode/transport';
import { BOOTS, BUILDS, EYEWEAR, FACES, GLOVES, HELMETS, PACKS, PADS, SKINS, SLEEVES, CAMOS, CARDS, cardHtml, COLORS, CROSSHAIRS, DEFAULT_LOOK, EMBLEMS, FATIGUES, HEADGEAR, loadLook, RETICLES, reticleSvg, saveLook, VESTS, type Look } from './game/look';
import { matOffset } from './gfx/renderer';
import { escapeHtml, Hud } from './ui/hud';
import { LoadoutEditor } from './ui/loadout';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const transport = createTransport(params.get('net'));

interface Settings {
  sens: number; fov: number; volume: number; blur: boolean; dof: boolean;
  /** Minimap diameter in pixels (0 hides it), whether it turns with the view, and its range in metres. */
  mapSize: number; mapRotate: number; mapRange: number;
  /** Material resolution preset. */
  textures: TextureQuality;
  /** Frame rate cap; 0 draws every display refresh (up to 360 Hz and beyond). */
  fpsLimit: number;
  showFps: boolean;
  /** Rendering resolution as a fraction of the screen's, 0.5..1. */
  renderScale: number;
  /** On-screen controls: follow the device, or force on/off. */
  touch: 'auto' | 'on' | 'off';
  touchSens: number;
}
const DEFAULTS: Settings = { sens: 1, fov: 90, volume: 0.5, blur: true, dof: true, textures: 'high', fpsLimit: 0, showFps: false, renderScale: 1, touch: 'auto', touchSens: 1, mapSize: 190, mapRotate: 1, mapRange: 24 };
/** Phones start lighter: they have less GPU and memory than a desktop, and post effects cost the most. */
const PHONE_DEFAULTS: Partial<Settings> = { textures: 'medium', blur: false, dof: false, renderScale: 0.75, fov: 80 };
function loadSettings(): Settings {
  let s: Settings;
  let saved: Partial<Settings> | null = null;
  try { saved = JSON.parse(localStorage.getItem('gs.settings') ?? 'null'); } catch { /* storage may be blocked */ }
  s = { ...DEFAULTS, ...(saved ? {} : isTouchDevice() ? PHONE_DEFAULTS : {}), ...(saved ?? {}) };
  if (!(s.textures in TEXTURE_QUALITY)) s.textures = DEFAULTS.textures;
  if (!isFpsLimit(s.fpsLimit)) s.fpsLimit = 0;
  if (!['auto', 'on', 'off'].includes(s.touch)) s.touch = 'auto';
  s.renderScale = Math.min(1, Math.max(0.5, Number(s.renderScale) || 1));
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
  private lastFoot = 0;
  private third = 0;
  private screen = 'loading';
  private back = 'main';
  private last = performance.now();
  private lastSim = performance.now();
  private zoom = 1;
  /** Resolves when every procedural material layer is on the GPU. */
  materials: Promise<void> = Promise.resolve();
  /** This player's customization, and everyone's in the current party (by player id). */
  look: Look = loadLook();
  private looks = new Map<number, Look>();
  /** Small previews of each camo, cut from the generated textures. */
  private swatches = new Map<number, ImageData>();
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
    this.hud.lookOf = id => this.lookOf(id);
    this.resize();
    addEventListener('resize', () => this.resize());
    const tex = TEXTURE_QUALITY[this.settings.textures];
    const quality = { shadowSize: params.has('low') ? 1024 : this.settings.textures === 'ultra' ? 4096 : 2048, post: !params.has('low'), offscreen: params.has('offscreen'), textureSize: tex.size, anisotropy: tex.anisotropy };
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
    this.input.onUnlock = () => {
      document.body.classList.remove('touch-play');
      if (this.session && this.screen === 'none') this.show('pause');
    };

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
    this.materialStream = streamMaterials(this.renderer, this.sim, tex.size, (done, total, layer, data) => {
      this.keepSwatch(layer, data, tex.size);
      status(done < total ? `generating ${tex.label.toLowerCase()} textures ${done}/${total}` : `${tex.label} textures (${tex.size} px, ${tex.anisotropy}x filtering)`);
    });
    this.materials = this.materialStream.done;
  }

  private texText = '';
  private showRendererInfo(): void {
    const hz = this.meter.displayHz;
    $('renderer-info').textContent = [`Renderer: ${this.rendererName}`, hz ? `${hz} Hz display` : '', this.texText].filter(Boolean).join(' · ');
  }

  /** Keeps a 64 px preview of camo layers for the customize screen. */
  private keepSwatch(layer: number, data: Uint8Array, size: number): void {
    if (!CAMOS.some(c => c.layer === layer)) return;
    const level = Math.max(0, Math.log2(size / 64));
    const s = size >> level, off = matOffset(0, level, size);
    const px = new Uint8ClampedArray(data.subarray(off, off + s * s * 4));
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    this.swatches.set(layer, new ImageData(px, s, s));
    if (this.screen === 'customize') this.renderCustomize();
  }

  private lookOf(id: number): Look { return this.looks.get(id) ?? DEFAULT_LOOK; }
  private selfId(): number { return this.host ? 0 : this.guest ? this.guest.selfId : 0; }

  /** Applies a change from the customize screen: saved, shown at once, sent to the party. */
  private setLook(look: Look): void {
    this.look = look;
    saveLook(look);
    this.looks.set(this.selfId(), look);
    this.host?.setLook(look);
    this.guest?.setLook(look);
    this.hud.applyLook(look);
    this.renderCustomize();
  }

  private renderCustomize(): void {
    const l = this.look;
    const fill = (id: string, names: string[], value: number, offset = 0) => {
      const sel = $<HTMLSelectElement>(id);
      if (sel.options.length !== names.length + offset) {
        sel.replaceChildren(...(offset ? [new Option('Team colour', '0')] : []), ...names.map((n, i) => new Option(n, String(i + offset))));
      }
      sel.value = String(value);
    };
    fill('cz-vest', VESTS.map(v => v.name), l.vest, 1);
    fill('cz-fatigues', FATIGUES.map(f => f.name), l.fatigues);
    fill('cz-headgear', HEADGEAR, l.headgear);
    fill('cz-helmet', HELMETS.map(h => h.name), l.helmet);
    fill('cz-eyewear', EYEWEAR, l.eyewear);
    fill('cz-face', FACES, l.face);
    fill('cz-skin', SKINS.map(x => x.name), l.skin);
    fill('cz-build', BUILDS, l.build);
    fill('cz-sleeves', SLEEVES, l.sleeves);
    fill('cz-gloves', GLOVES.map(x => x.name), l.gloves);
    fill('cz-boots', BOOTS.map(x => x.name), l.boots);
    fill('cz-pads', PADS, l.pads);
    fill('cz-pack', PACKS, l.pack);
    fill('cz-camo', CAMOS.map(c => c.name), l.camo);
    fill('cz-reticle', RETICLES, l.reticle);
    fill('cz-reticleColor', COLORS.map(c => c.name), l.reticleColor);
    fill('cz-crosshair', CROSSHAIRS, l.crosshair);
    fill('cz-crosshairColor', COLORS.map(c => c.name), l.crosshairColor);
    fill('cz-card', CARDS.map(c => c.name), l.card);
    fill('cz-emblem', EMBLEMS.map(e => e.name), l.emblem);
    const sw = $<HTMLCanvasElement>('cz-camo-swatch');
    const ctx = sw.getContext('2d')!;
    const camo = CAMOS[l.camo];
    const img = camo.layer >= 0 ? this.swatches.get(camo.layer) : null;
    ctx.fillStyle = '#20252c';
    ctx.fillRect(0, 0, sw.width, sw.height);
    if (img) {
      const tmp = new OffscreenCanvas(img.width, img.height);
      tmp.getContext('2d')!.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, sw.width, sw.height);
    }
    $('cz-camo-note').textContent = camo.layer < 0 ? 'The gun\'s own finish.' : img ? '' : 'Generating texture...';
    $('cz-reticle-preview').innerHTML = reticleSvg(l.reticle, COLORS[l.reticleColor].css);
    $('cz-crosshair-preview').dataset.style = String(l.crosshair);
    $('cz-crosshair-preview').style.setProperty('--ch', COLORS[l.crosshairColor].css);
    $('cz-card-preview').innerHTML = cardHtml(l, escapeHtml(this.name() || 'Player'));
    const vest = l.vest ? VESTS[l.vest - 1].rgb : [1.0, 0.42, 0.12];
    $('cz-vest-swatch').style.background = `rgb(${vest.map(v => Math.round(Math.min(1, v) * 255)).join(',')})`;
  }

  private name(): string { return $<HTMLInputElement>('name').value.trim(); }

  /** Saves a new player name everywhere and tells the party. */
  private rename(raw: string): void {
    const name = raw.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
    for (const id of ['name', 'set-name', 'lobby-name']) $<HTMLInputElement>(id).value = name;
    try { localStorage.setItem('gs.name', name); } catch { /* ignore */ }
    if (!name) return;
    this.host?.setName(name);
    this.guest?.setName(name);
    if (!this.host && !this.guest) this.hud.setNames([{ id: 0, name }]);
  }

  private resize(): void {
    // ?low renders at half resolution for weak GPUs (and the automated browser tests).
    const dpr = Math.min(devicePixelRatio, 2) * (params.has('low') ? 0.5 : this.settings.renderScale);
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
    // One name, editable in three places (main menu, settings, lobby). Changing it in a party renames
    // you for everyone at once, even mid-match.
    const nameEls = ['name', 'set-name', 'lobby-name'].map(id => $<HTMLInputElement>(id));
    let saved = '';
    try { saved = localStorage.getItem('gs.name') ?? ''; } catch { /* ignore */ }
    for (const el of nameEls) {
      el.value = saved;
      el.onchange = () => this.rename(el.value);
    }

    const click = (id: string, fn: () => void) => { $(id).onclick = () => { this.sfx.unlock(); fn(); }; };
    click('btn-solo', () => this.startSolo());
    // Every button and menu control ticks.
    document.addEventListener('click', e => { if ((e.target as HTMLElement)?.closest?.('button, select, input[type=checkbox], summary')) this.sfx.ui(); }, true);
    click('btn-host', () => void this.hostParty());
    click('btn-join', () => {
      const code = normalizeCode($<HTMLInputElement>('join-code').value);
      if (!code) return this.error('Party codes are 6 letters and numbers.');
      void this.join(code);
    });
    $<HTMLInputElement>('join-code').onkeydown = e => { if (e.key === 'Enter') $('btn-join').click(); };
    click('btn-loadout', () => this.openLoadout('main'));
    click('btn-customize', () => this.openCustomize('main'));
    click('btn-lobby-customize', () => this.openCustomize('lobby'));
    click('btn-customize-done', () => this.show(this.back));
    for (const key of ['vest', 'fatigues', 'headgear', 'camo', 'reticle', 'reticleColor', 'crosshair', 'crosshairColor', 'card', 'emblem', 'helmet', 'eyewear', 'face', 'skin', 'build', 'sleeves', 'gloves', 'boots', 'pads', 'pack'] as (keyof Look)[]) {
      const sel = $<HTMLSelectElement>(`cz-${key}`);
      sel.onchange = () => this.setLook({ ...this.look, [key]: +sel.value });
    }
    this.hud.applyLook(this.look);
    click('btn-lobby-loadout', () => this.openLoadout('lobby'));
    click('btn-loadout-done', () => { if (this.editor.check()) this.show(this.back); });
    click('btn-loadout-reset', () => this.editor.reset());
    click('btn-binds-reset', () => { this.input.binds = defaultBinds(); saveBinds(this.input.binds); this.input.applyBinds(); this.renderBinds(); });
    this.renderBinds();
    click('btn-settings', () => this.openSettings('main'));
    click('btn-pause-settings', () => this.openSettings('pause'));
    click('btn-settings-done', () => this.show(this.back));
    click('btn-resume', () => this.resume());
    click('btn-switch-team', () => {
      const s = this.session;
      if (!s) return;
      const team = s.local()[this.sim.L.P.team];
      if (team === 0 || team === 1) s.switchTeam(1 - team);
    });
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
    // Match settings: only the host can change them; guests see them read-only.
    const fill = (id: string, choices: Choice[]) => { const el = $<HTMLSelectElement>(id); el.replaceChildren(...choices.map(c => new Option(c[1], String(c[0])))); };
    fill('rule-time', TIME_CHOICES);
    fill('rule-respawn', RESPAWN_CHOICES);
    fill('rule-health', HEALTH_CHOICES);
    fill('rule-round', ROUND_CHOICES);
    fill('rule-points', POINTS_CHOICES);
    const rule = (id: string, key: keyof Rules) => {
      const el = $<HTMLInputElement | HTMLSelectElement>(id);
      el.onchange = () => this.host?.setRules({ [key]: el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : +el.value });
    };
    rule('rule-time', 'timeLimit');
    rule('rule-score', 'scoreLimit');
    rule('rule-respawn', 'respawn');
    rule('rule-health', 'health');
    rule('rule-round', 'startRound');
    rule('rule-points', 'startPoints');
    rule('rule-ff', 'friendlyFire');
    rule('rule-hs', 'headshotsOnly');
    rule('rule-abilities', 'abilities');
    rule('rule-streaks', 'streaks');

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
    bind('set-scale', 'renderScale', () => { this.resize(); $('scale-value').textContent = `${Math.round(s.renderScale * 100)}%`; });
    $('scale-value').textContent = `${Math.round(s.renderScale * 100)}%`;
    const applyMap = () => {
      this.hud.minimap.settings = { size: s.mapSize, rotate: !!s.mapRotate, range: s.mapRange };
      document.documentElement.style.setProperty('--mm', `${s.mapSize}px`);
    };
    for (const [id, key] of [['set-mapsize', 'mapSize'], ['set-maprotate', 'mapRotate'], ['set-maprange', 'mapRange']] as const) {
      const el = $<HTMLSelectElement>(id);
      el.value = String(s[key]);
      el.onchange = () => { s[key] = +el.value; applyMap(); saveSettings(s); };
    }
    applyMap();
    bind('set-touchsens', 'touchSens', () => { if (this.input.touch) this.input.touch.sensitivity = s.touchSens; });
    const touchSel = $<HTMLSelectElement>('set-touch');
    touchSel.value = s.touch;
    touchSel.onchange = () => { s.touch = touchSel.value as Settings['touch']; saveSettings(s); this.applyTouchMode(); };
    this.applyTouchMode();

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

  private openCustomize(back: string): void { this.back = back; this.show('customize'); this.renderCustomize(); }
  private openLoadout(back: string): void { this.back = back; this.editor.close(); this.editor.render(); this.show('loadout'); }
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
    this.begin({ t: 'start', map: 0, mode: 0, seed, rules: defaultRules(0), players: [{ id: 0, team: 0, loadout: this.editor.loadout, look: this.look }] }, 0);
  }

  private async hostParty(): Promise<void> {
    this.error('');
    $('btn-host').textContent = 'Creating...';
    try {
      this.host = await HostLobby.create(transport, this.name() || 'Host', this.editor.loadout, this.sim.catalog.maps.length, this.look);
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
      this.guest = await GuestLobby.join(transport, code, this.name() || 'Guest', clientToken(), this.editor.loadout, this.look);
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
    for (const p of st.players) this.looks.set(p.id, p.look);
    const isHost = !!this.host;
    $('lobby-code').textContent = st.code;
    $<HTMLInputElement>('lobby-link').value = partyLink(st.code);
    $<HTMLSelectElement>('lobby-mode').value = String(st.mode);
    $<HTMLSelectElement>('lobby-map').value = String(st.map);
    $<HTMLSelectElement>('lobby-mode').disabled = !isHost;
    $<HTMLSelectElement>('lobby-map').disabled = !isHost;
    $('btn-start').hidden = !isHost;
    $('btn-ready').hidden = isHost;
    const info = MODES[st.mode];
    $('lobby-mode-desc').textContent = info.desc;
    this.renderRules(st.rules, st.mode, isHost);
    const selfId = this.host ? 0 : this.guest?.selfId;
    // In team modes players are listed by team; anyone can ask to switch sides, the host can move anyone.
    const row = (p: LobbyState['players'][number]) => {
      const team = info.teams && p.team >= 0 ? `<b class="team" style="--team:${TEAM_CSS[p.team]}">${TEAM_NAMES[p.team]}</b>` : '';
      const move = info.teams && (isHost || p.id === selfId) ? `<button data-team="${p.id}">Switch team</button>` : '';
      const admin = isHost && !p.host ? `<button data-kick="${p.id}">Kick</button><button data-ban="${p.id}">Ban</button>` : '';
      return `<li>${team}${cardHtml(p.look, escapeHtml(p.name), true)}<span></span><em>${p.host ? 'host' : p.ready ? 'ready' : 'not ready'}</em>${move}${admin}</li>`;
    };
    const players = info.teams ? [...st.players].sort((a, b) => a.team - b.team) : st.players;
    const list = $('lobby-players');
    list.innerHTML = players.map(row).join('');
    list.querySelectorAll<HTMLButtonElement>('[data-kick]').forEach(b => (b.onclick = () => this.host?.kick(+b.dataset.kick!)));
    list.querySelectorAll<HTMLButtonElement>('[data-ban]').forEach(b => (b.onclick = () => this.host?.ban(+b.dataset.ban!)));
    list.querySelectorAll<HTMLButtonElement>('[data-team]').forEach(b => (b.onclick = () => {
      const p = st.players.find(q => q.id === +b.dataset.team!);
      if (!p) return;
      if (this.host) this.host.setTeam(p.id, 1 - Math.max(0, p.team)); else this.guest?.setTeam(1 - Math.max(0, p.team));
    }));
    const waiting = st.players.filter(p => !p.host && !p.ready).length;
    const sides = info.teams ? ` · ${TEAM_NAMES[0]} ${st.players.filter(p => p.team === 0).length} v ${st.players.filter(p => p.team === 1).length} ${TEAM_NAMES[1]}` : '';
    $('lobby-status').textContent = `${st.players.length} / ${info.max} players${sides}${isHost && waiting ? ` · ${waiting} not ready` : ''}`;
    if (!isHost) $('btn-ready').textContent = st.players.find(p => p.id === this.guest?.selfId)?.ready ? 'Not ready' : 'Ready';
    const mine = st.players.find(p => p.id === (this.host ? 0 : this.guest?.selfId));
    const lobbyName = $<HTMLInputElement>('lobby-name');
    if (mine && document.activeElement !== lobbyName) lobbyName.value = mine.name;
  }

  /** Match settings panel: the controls that apply to this mode, read-only for guests. */
  private renderRules(r: Rules, mode: number, isHost: boolean): void {
    const info = MODES[mode];
    const show: Record<string, boolean> = {
      pvp: mode !== 0, score: mode !== 0 && mode !== 6, survival: mode === 0, teams: info.teams,
      abilities: mode !== 6, streaks: mode !== 0 && mode !== 6,
    };
    document.querySelectorAll<HTMLElement>('#lobby-rules [data-show]').forEach(el => (el.hidden = !show[el.dataset.show!]));
    const score = $<HTMLSelectElement>('rule-score');
    const choices = scoreChoices(mode);
    if (score.options.length !== choices.length || [...score.options].some((o, i) => o.value !== String(choices[i][0]))) score.replaceChildren(...choices.map(c => new Option(c[1], String(c[0]))));
    const set = (id: string, v: number | boolean) => {
      const el = $<HTMLInputElement | HTMLSelectElement>(id);
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v as boolean; else el.value = String(v);
      el.disabled = !isHost;
    };
    set('rule-time', r.timeLimit); set('rule-score', r.scoreLimit); set('rule-respawn', r.respawn); set('rule-health', r.health);
    set('rule-round', r.startRound); set('rule-points', r.startPoints);
    set('rule-ff', r.friendlyFire); set('rule-hs', r.headshotsOnly); set('rule-abilities', r.abilities); set('rule-streaks', r.streaks);
    $('rules-summary').textContent = rulesSummary(r, mode);
    $('rules-note').textContent = isHost ? (mode === 6 ? 'The ladder has 20 weapons; streaks and abilities are off.' : '') : 'Only the host can change match settings.';
  }

  /** The pause menu's roster: both teams with their scores (or everyone, in modes without teams). */
  private renderPauseTeams(): void {
    const s = this.session, snap = s?.snap;
    const box = $('pause-teams'), btn = $<HTMLButtonElement>('btn-switch-team');
    if (!s || !snap) { box.innerHTML = ''; btn.hidden = true; return; }
    const { P, H } = this.sim.L;
    const info = MODES[s.start.mode];
    const row = (r: Float32Array) => `<li class="${r[P.id] === s.selfId ? 'me' : ''}">${cardHtml(this.lookOf(r[P.id]), escapeHtml(this.hud.name_(r[P.id])), true)}<span></span><em>${r[P.kills]} kills · ${r[P.deaths]} deaths</em></li>`;
    const byScore = (a: Float32Array, b: Float32Array) => b[P.score] - a[P.score];
    let html: string;
    if (info?.teams) {
      const mine = s.local()[P.team];
      const scores = [snap.hdr[H.score_a], snap.hdr[H.score_b]];
      html = [0, 1].map(t => {
        const players = snap.players.filter(r => r[P.team] === t).sort(byScore);
        return `<div class="roster" style="--team:${TEAM_CSS[t]}"><h3>${TEAM_NAMES[t]}${t === mine ? ' (your team)' : ''}<b>${scores[t]}</b></h3><ul>${players.map(row).join('') || '<li class="empty">No players</li>'}</ul></div>`;
      }).join('');
      const count = (t: number) => snap.players.filter(r => r[P.team] === t).length;
      const fair = (mine === 0 || mine === 1) && count(1 - mine) + 1 - (count(mine) - 1) <= 1;
      // Only touch the button when something changed, so a click is never interrupted by a redraw.
      const label = mine === 0 || mine === 1 ? `Switch to ${TEAM_NAMES[1 - mine]}` : 'Switch team';
      const over = snap.hdr[H.phase] === 3;
      if (btn.hidden !== over) btn.hidden = over;
      if (btn.disabled === fair) btn.disabled = !fair;
      if (btn.textContent !== label) btn.textContent = label;
      btn.title = fair ? 'You respawn with your new team' : 'That would make the teams uneven';
    } else {
      html = `<div class="roster"><h3>${info?.name ?? 'Players'}</h3><ul>${[...snap.players].sort(byScore).map(row).join('')}</ul></div>`;
      btn.hidden = true;
    }
    if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  }

  /** The key bindings list in Settings: click one, then press the new key or mouse button. */
  private renderBinds(): void {
    const box = $('binds');
    box.replaceChildren();
    for (const a of ACTIONS) {
      const row = document.createElement('label');
      row.className = 'bind';
      row.textContent = a.label;
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.bind = a.id;
      b.textContent = keyName(this.input.binds[a.id]);
      b.onclick = e => {
        e.preventDefault();
        b.textContent = 'Press a key...';
        b.classList.add('listening');
        this.input.capturing = true;
        const done = (code: string | null) => {
          removeEventListener('keydown', onKey, true);
          removeEventListener('mousedown', onMouse, true);
          this.input.capturing = false;
          if (code) { rebind(this.input.binds, a.id, code); saveBinds(this.input.binds); this.input.applyBinds(); }
          this.renderBinds();
        };
        const onKey = (ev: KeyboardEvent) => { ev.preventDefault(); ev.stopPropagation(); done(ev.code === 'Escape' ? null : ev.code); };
        const onMouse = (ev: MouseEvent) => { ev.preventDefault(); ev.stopPropagation(); done(`Mouse${ev.button}`); };
        // Listen from the next tick so this very click is not taken as the new binding.
        setTimeout(() => { addEventListener('keydown', onKey, true); addEventListener('mousedown', onMouse, true); }, 0);
      };
      row.append(b);
      box.append(row);
    }
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
    for (const p of start.players) this.looks.set(p.id, p.look);
    this.looks.set(selfId, this.look);
    // Phones draw about half the grass and ivy; the ?low test switch draws a fifth.
    this.scene = new Scene(this.renderer, this.sim, session, id => this.lookOf(id), params.has('detail') ? +params.get('detail')! || 0 : params.has('low') ? 0.1 : document.body.classList.contains('touch') ? 0.5 : 1);
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
    if (this.input.touch) {
      // Phones: full screen and landscape where the browser allows it (needs this tap's gesture).
      void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
        .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
        .catch(() => {});
    }
    this.input.lock();
    document.body.classList.toggle('touch-play', this.input.touchEngaged);
  }

  /** Turns the on-screen controls on or off to match the setting and the device. */
  private applyTouchMode(): void {
    const on = this.settings.touch === 'on' || (this.settings.touch === 'auto' && isTouchDevice());
    if (on && !this.input.touch) {
      const t = new TouchControls(document.body);
      t.onPause = () => this.input.unlock();
      t.onScores = down => (this.input.scoreboard = down);
      this.input.touch = t;
    } else if (!on && this.input.touch) {
      this.input.touch.root.remove();
      this.input.touch = null;
    }
    if (this.input.touch) this.input.touch.sensitivity = this.settings.touchSens;
    document.body.classList.toggle('touch', on);
    $('controls-hint').textContent = on
      ? 'Left thumb: joystick (push all the way forward to sprint). Right thumb: drag to look; hold FIRE and drag to aim while shooting. AIM toggles aiming down sights.'
      : 'WASD move · Shift sprint · C slide · Space jump, hold to thrust · run along walls · Mouse fire/aim · R reload · F use · Q ability · G/E equipment · V melee · Z tonic · hold T third person · Tab scores (all rebindable in Settings)';
  }

  private sound(e: Float32Array): void {
    const { V } = this.sim.L;
    const s = this.session!;
    const cat = this.sim.catalog;
    /** The sound of weapon `w` firing, near or far. */
    const fire = (w: number, distant: boolean) => {
      const info = cat.weapons[w];
      if (!info) return;
      if (info.flags & WF.rocket) this.sfx.rocket(distant);
      else if (info.flags & WF.chain) this.sfx.energy();
      else {
        this.sfx.shot({ cls: info.cls, distant, suppressed: info.slug === 'vespa' || info.slug === 'bastion' });
        // Pump shotguns and bolt-action rifles are worked by hand after each shot.
        if (!distant && !info.auto && ((info.cls === 3 && info.mag > 2) || (info.cls === 5 && info.rpm <= 60))) this.sfx.cycle(info.cls);
      }
    };
    switch (e[0]) {
      case V.local:
        switch (e[1]) {
          case 1: fire(e[2], false); break;
          case 2: this.sfx.dry(); break;
          case 3: this.sfx.reload(cat.weapons[e[2]]?.reload ?? 2); break;
          case 4: this.sfx.swing(); break;
          case 5: this.sfx.swap(); break;
          case 10: this.sfx.slide(); break;
          case 13: this.sfx.toss(); break;
          case 6: case 11: this.sfx.jump(); break;
          case 7: this.sfx.land(); break;
          case 8: this.sfx.slide(); break;
          case 9: this.sfx.thrust(); break;
          case 12: this.sfx.jump(); break;
        }
        break;
      case V.shot: if (e[1] !== s.selfId) fire(e[2], true); break;
      case V.hit: if (e[1] === s.selfId) this.sfx.hit(e[4] > 0); break;
      case V.explode: if (e[5] !== 2) this.sfx.explode(); break;
      case V.buy: if (e[1] === s.selfId) this.sfx.buy(); break;
      case V.msg: if (e[2] === s.selfId && e[1] < 4) this.sfx.deny(); break;
      case V.round: this.sfx.round(); break;
      case V.powerup: if (e[5]) this.sfx.powerup(); break;
      case V.zattack: if (e[2] === s.selfId) { this.sfx.hurt(); this.sfx.maul(); } break;
      case V.spawn: if (Math.random() < 0.3) this.sfx.groan(); break;
      case V.zdeath: if (Math.random() < 0.6) this.sfx.corpse(); break;
      case V.melee: if (e[1] !== s.selfId) this.sfx.swing(); break;
      case V.door: this.sfx.door(); break;
      case V.power: this.sfx.power(); break;
      case V.barr: this.sfx.board(e[2] < 0); break;
      case V.crate: this.sfx.pickup(); break;
      case V.ability: this.sfx.ability(); break;
      case V.tonic: if (e[1] === s.selfId) this.sfx.tonic(); break;
      case V.streak: this.sfx.radio(); break;
      case V.pdown: this.sfx.down(); break;
      case V.pdeath: if (e[1] === s.selfId) this.sfx.down(); break;
      case V.revive: this.sfx.revive(); break;
      case V.quest: this.sfx.objective(true); break;
      case V.gameover: this.sfx.round(); break;
      case V.obj: {
        const mine = s.local()[this.sim.L.P.team];
        if (e[1] === 1 || e[1] === 2) this.sfx.objective(e[3] === mine);
        else if (e[1] === 3) this.sfx.objective(true);
        else if ((e[1] === 4 || e[1] === 5 || e[1] === 6) && e[2] === s.selfId) this.sfx.pickup();
        else if (e[1] === 7 && e[2] === s.selfId) this.sfx.deny();
        break;
      }
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
    // Footsteps follow the stride: one each time the walk cycle passes a footfall.
    if (me.length && me[P.life] === 0 && me[P['ctl.grounded']] && me[P['ctl.bob_amp']] > 0.25 && me[P['ctl.mode']] === 0) {
      const foot = Math.floor(me[P['ctl.bob_ph']] / Math.PI);
      if (foot !== this.lastFoot) { this.lastFoot = foot; this.sfx.step(!!me[P['ctl.sprinting']]); }
    }
    const view = s.view(this.settings.fov);
    // Third person while the key is held: the camera eases out over the right shoulder (stopping
    // short of walls) and back in again on release.
    this.third += ((this.input.thirdPerson ? 1 : 0) - this.third) * Math.min(1, dt * 9);
    if (this.third > 0.01) {
      const k = this.third;
      const dir = [Math.sin(view.yaw) * Math.cos(view.pitch), -Math.sin(view.pitch), Math.cos(view.yaw) * Math.cos(view.pitch)]; // backwards
      const right = [Math.cos(view.yaw), 0, -Math.sin(view.yaw)];
      const off = [dir[0] * 3.1 + right[0] * 0.55, dir[1] * 3.1 + 0.35, dir[2] * 3.1 + right[2] * 0.55];
      const len = Math.hypot(off[0], off[1], off[2]);
      const free = Math.max(0.3, s.game.raycast(view.pos, off.map(v => v / len), len + 0.3) - 0.3);
      const reach = (Math.min(len, free) / len) * k;
      view.pos = [view.pos[0] + off[0] * reach, view.pos[1] + off[1] * reach, view.pos[2] + off[2] * reach];
    }
    const frame = this.scene.build(view, dt, this.canvas.width / this.canvas.height, { fov: this.settings.fov, motionBlur: this.settings.blur, dof: this.settings.dof, third: this.third });
    this.renderer.render(frame);
    // The HUD is DOM text: refreshing it faster than 60 Hz costs time and shows nothing new.
    if (now - this.lastHud >= 16) {
      this.lastHud = now;
      // The full map shows while its key is held; the zoom key steps through the minimap ranges.
      this.hud.minimap.expanded = this.input.fullMap;
      if (this.input.mapZoom) {
        this.input.mapZoom = false;
        const ranges = [16, 24, 36, 55];
        this.settings.mapRange = ranges[(ranges.indexOf(this.settings.mapRange) + 1) % ranges.length];
        this.hud.minimap.settings.range = this.settings.mapRange;
        $<HTMLSelectElement>('set-maprange').value = String(this.settings.mapRange);
        saveSettings(this.settings);
      }
      this.hud.update(s, this.input.scoreboard, p => this.scene?.project(p) ?? null);
      if (this.screen === 'pause') this.renderPauseTeams();
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
