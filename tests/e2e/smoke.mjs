// End-to-end check of the built site, served the way GitHub Pages serves it.
//   node tools/serve-pages.mjs 4180 &  node tests/e2e/smoke.mjs http://localhost:4180/grave-shift/
// Set E2E_SKIP_PEERJS=1 where the public PeerJS broker is unreachable (offline sandboxes).
// Writes screenshots and a summary to e2e-results/. Exits non-zero if any check fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const SITE = process.argv[2] ?? 'http://localhost:4180/grave-shift/';
const OUT = 'e2e-results';
const skipPeer = process.env.E2E_SKIP_PEERJS === '1';
mkdirSync(OUT, { recursive: true });

const results = [];
/** Browser profiles opened by the current check; always closed afterwards so a failure cannot leave
 *  pages rendering in the background and starve the next check. */
let opened = [];
const only = process.env.E2E_ONLY;
const check = async (name, fn) => {
  if (only && !only.split('|').some(o => name.includes(o))) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, secs: (Date.now() - t0) / 1000 });
    console.log(`PASS ${name}`, detail ?? '');
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message ?? e).split('\n')[0], secs: (Date.now() - t0) / 1000 });
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  } finally {
    await Promise.all(opened.map(c => c.close().catch(() => {})));
    opened = [];
  }
};

const browser = await chromium.launch({
  args: [
    // Software WebGPU and WebGL so the test runs on machines without a GPU.
    '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    // Let two tabs on one machine connect over WebRTC without resolving mDNS host candidates.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

/**
 * Opens the site in a fresh browser profile (own localStorage), or in `ctx` if given, collecting
 * console errors and failed requests.
 */
async function openPage(query = '', name = 'page', ctx = null) {
  if (!ctx) {
    ctx = await browser.newContext({ viewport: { width: 1024, height: 576 } });
    opened.push(ctx);
  }
  const page = await ctx.newPage();
  // Software rendering on CI machines is slow; give every wait room.
  page.setDefaultTimeout(90000);
  page.problems = [];
  page.on('console', m => { if (m.type() === 'error') page.problems.push(`${name} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', e => page.problems.push(`${name} pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) page.problems.push(`${name} HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', r => { if (!r.url().includes('peerjs')) page.problems.push(`${name} request failed ${r.url()} ${r.failure()?.errorText}`); });
  await page.goto(SITE + query);
  await page.waitForSelector('#screen-main:not([hidden])', { timeout: 90000 });
  return page;
}
const assertClean = page => { if (page.problems.length) throw new Error(page.problems.slice(0, 5).join(' | ')); };

/** Lets a headless page play: pretend the pointer is locked and close the menus. */
const engage = page => page.evaluate(() => {
  const a = window.app;
  Object.defineProperty(a.input, 'locked', { get: () => true, configurable: true });
  a.input.lock = () => {};
  a.show('none');
});
const hdr = page => page.evaluate(() => {
  const a = window.app, s = a.session, H = a.sim.L.H;
  if (!s?.snap) return null;
  const h = s.snap.hdr;
  return { round: h[H.round], phase: h[H.phase], players: h[H.n_players], zombies: s.zombies().length, renderer: a.renderer.kind };
});
const waitRound = (page, timeout = 60000) => page.waitForFunction(() => {
  const a = window.app, s = a.session; return s?.snap && s.snap.hdr[a.sim.L.H.round] >= 1 && s.zombies().length > 0;
}, null, { timeout, polling: 250 });

async function shoot(page, file) {
  // WebGPU canvases are not captured by headless screenshots, so read the frame back and overlay it.
  // Then stop drawing: a screenshot waits for the page to produce a frame, and software-rendered
  // frames are slow enough to time it out.
  // The readback comes from the next rendered frame, so take it before stopping the render loop.
  await page.evaluate(async () => {
    const r = window.app.renderer;
    const stop = () => { window.app.frame = () => {}; };
    if (!r.capture) return stop();
    const img = await Promise.race([r.capture(), new Promise((_, no) => setTimeout(() => no(new Error('WebGPU frame readback timed out')), 60000))]);
    stop();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
    document.body.insertBefore(c, document.body.firstChild);
  });
  await page.screenshot({ path: `${OUT}/${file}`, timeout: 120000 });
}

/** Main menu -> solo setup (defaults: Survival) -> loadout -> deploy. */
async function playSolo(page) {
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForSelector('#screen-solo:not([hidden])');
  await page.evaluate(() => document.getElementById('btn-solo-go').click());
  await page.waitForSelector('#screen-loadout:not([hidden])');
  await page.evaluate(() => document.getElementById('btn-loadout-done').click());
}

await check('site loads under the Pages sub-path with no errors or 404s', async () => {
  const page = await openPage('?low', 'main');
  const title = await page.title();
  const info = await page.textContent('#renderer-info');
  // A missing asset only shows up once a match loads models, so start one briefly.
  await playSolo(page);
  await page.waitForFunction(() => window.app.session?.snap, null, { timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.app.frame = () => {}; });
  await page.screenshot({ path: `${OUT}/menu-and-hud.png`, timeout: 120000 });
  assertClean(page);
  await page.context().close();
  return `${title} · ${info}`;
});

await check('solo survival on WebGL2: round starts and zombies spawn', async () => {
  const page = await openPage('?renderer=webgl2&low', 'webgl2');
  await playSolo(page);
  await engage(page);
  await waitRound(page);
  await page.waitForTimeout(1500);
  await shoot(page, 'solo-webgl2.png');
  const h = await hdr(page);
  assertClean(page);
  await page.context().close();
  if (h.renderer !== 'webgl2') throw new Error(`renderer is ${h.renderer}`);
  return h;
});

await check('solo survival on WebGPU (software adapter)', async () => {
  const page = await openPage('?renderer=webgpu&offscreen&low', 'webgpu');
  await playSolo(page);
  await engage(page);
  await waitRound(page);
  await shoot(page, 'solo-webgpu.png');
  const h = await hdr(page);
  assertClean(page);
  await page.context().close();
  if (h.renderer !== 'webgpu') throw new Error(`renderer is ${h.renderer}`);
  return h;
});

await check('settings: texture quality, frame rate cap and FPS counter', async () => {
  const page = await openPage('?renderer=webgl2&low', 'settings');
  await page.evaluate(() => window.app.materials);
  await page.click('#btn-settings');
  const texOptions = await page.$$eval('#set-tex option', o => o.map(x => x.value));
  if (texOptions.join() !== 'low,medium,high,ultra') throw new Error(`texture options ${texOptions}`);
  // The frame rate menu is built around the refresh rate measured on the menus: the default (0)
  // is labelled with it, and only caps below it are offered.
  const hz = await page.evaluate(() => window.app.meter.displayHz);
  const fpsOptions = await page.$$eval('#set-fps option', o => o.map(x => ({ value: +x.value, label: x.textContent })));
  if (!hz) throw new Error('display refresh rate was not detected on the menu');
  if (fpsOptions[0].value !== 0 || !fpsOptions[0].label.includes(`${hz} Hz`)) throw new Error(`default option ${JSON.stringify(fpsOptions[0])}`);
  if (fpsOptions.slice(1).some(o => o.value >= hz)) throw new Error(`offers caps the ${hz} Hz display cannot show: ${fpsOptions.map(o => o.value)}`);
  if (await page.inputValue('#set-fps') !== '0') throw new Error('frame rate does not default to the display rate');
  if (await page.evaluate(() => localStorage.getItem('gs.displayHz')) !== String(hz)) throw new Error('detected rate not remembered');
  // Low textures: the GPU arrays are rebuilt at 128 px and every layer is regenerated at that size.
  await page.click('#set-tex + .picker [data-v="low"]');
  await page.waitForFunction(() => /Low textures/.test(document.getElementById('tex-status').textContent), null, { timeout: 60000 });
  const size = await page.evaluate(() => window.app.renderer.matSize);
  if (size !== 128) throw new Error(`material size ${size}`);
  await page.click('#set-fps + .picker [data-v="30"]');
  await page.check('#set-showfps');
  await page.click('#btn-settings-done');
  // Play with a 30 fps cap: rendered frames must stay at or under the cap.
  await playSolo(page);
  await engage(page);
  await page.waitForFunction(() => window.app.session?.snap, null, { timeout: 30000 });
  const before = await page.evaluate(() => window.app.meter.fps);
  await page.waitForTimeout(3000);
  const fps = await page.evaluate(() => window.app.meter.fps);
  const counter = await page.textContent('#fps');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gs.settings')));
  if (fps > 31.5) throw new Error(`rendering at ${fps.toFixed(1)} fps with a 30 cap`);
  if (!/fps/.test(counter ?? '') || await page.isHidden('#fps')) throw new Error('FPS counter not shown');
  if (saved.textures !== 'low' || saved.fpsLimit !== 30 || saved.showFps !== true) throw new Error(`settings not saved: ${JSON.stringify(saved)}`);
  assertClean(page);
  return { displayHz: hz, fpsOptions: fpsOptions.map(o => o.value), materialSize: size, fps: +fps.toFixed(1), counter, firstSample: +before.toFixed(1) };
});

await check('phone: touch joystick, look, fire, pause', async () => {
  // A phone in landscape with real touch input (Chrome DevTools touch events, so pointer events
  // arrive exactly as from a finger). Waits are on conditions, not times: software rendering can
  // delay input delivery by seconds.
  const ctx = await browser.newContext({ ...devices['Pixel 7 landscape'] });
  opened.push(ctx);
  const page = await ctx.newPage();
  page.problems = [];
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => page.problems.push(`phone pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') page.problems.push(`phone console: ${m.text().slice(0, 200)}`); });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  await page.goto(`${SITE}?renderer=webgl2&low`);
  await page.waitForSelector('#screen-main:not([hidden])');
  const setup = await page.evaluate(() => ({ touch: document.body.classList.contains('touch'), textures: window.app.settings.textures, scale: window.app.settings.renderScale }));
  if (!setup.touch) throw new Error('phone not detected as a touch device');
  await page.tap('#btn-solo');
  await page.tap('#btn-solo-go');
  await page.tap('#btn-loadout-done');
  await page.waitForFunction(() => window.app.session?.snap && window.app.input.touchEngaged && !document.getElementById('touch').hidden);
  const me = () => page.evaluate(() => {
    const a = window.app, s = a.session, P = a.sim.L.P, m = s.local();
    return { x: m[P['ctl.pos']], z: m[P['ctl.pos'] + 2], yaw: s.yaw, ammo: m[P[`arms.guns${m[P['arms.cur']]}.ammo`]] };
  });
  const start = await me();
  // Joystick: push fully forward and hold until the player has moved, then lift.
  await touch('touchStart', [[150, 260, 1]]);
  await touch('touchMove', [[150, 180, 1]]);
  await page.waitForFunction(([x, z]) => { const a = window.app, P = a.sim.L.P, m = a.session.local(); return Math.hypot(m[P['ctl.pos']] - x, m[P['ctl.pos'] + 2] - z) > 1.5; }, [start.x, start.z]);
  await touch('touchEnd', []);
  await page.waitForFunction(() => window.app.input.touch.axis[1] === 0);
  // Look: drag on the right of the screen.
  const vp = page.viewportSize();
  const yaw0 = (await me()).yaw;
  await touch('touchStart', [[vp.width * 0.55, 80, 2]]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[vp.width * 0.55 + i * 12, 80, 2]]);
  await touch('touchEnd', []);
  await page.waitForFunction(y => Math.abs(window.app.session.yaw - y) > 0.1, yaw0);
  // Fire: one tap fires one shot.
  const fire = await page.locator('.tb-fire').boundingBox();
  const ammo0 = (await me()).ammo;
  await touch('touchStart', [[fire.x + fire.width / 2, fire.y + fire.height / 2, 3]]);
  await touch('touchEnd', []);
  await page.waitForFunction(a0 => { const a = window.app, P = a.sim.L.P, m = a.session.local(); return m[P[`arms.guns${m[P['arms.cur']]}.ammo`]] < a0; }, ammo0);
  // Pause.
  const pause = await page.locator('.tb-pause').boundingBox();
  await touch('touchStart', [[pause.x + 20, pause.y + 20, 4]]);
  await touch('touchEnd', []);
  await page.waitForFunction(() => window.app.screen === 'pause' && document.getElementById('touch').hidden);
  const end = await me();
  await page.evaluate(() => { window.app.frame = () => {}; });
  await page.screenshot({ path: `${OUT}/phone.png`, timeout: 120000 });
  if (page.problems.length) throw new Error(page.problems.slice(0, 3).join(' | '));
  return { ...setup, moved: +Math.hypot(end.x - start.x, end.z - start.z).toFixed(1), turned: +(end.yaw - yaw0).toFixed(2), ammo: `${ammo0} -> ${end.ammo}` };
});

/**
 * Host + guest. The guest joins by opening the invite link. Over WebRTC they are separate browser
 * profiles, like two people; the offline transport (BroadcastChannel) only reaches pages in the
 * same profile, so there they share one.
 */
/** Waits for the lobby; if it never shows, fails with whatever error the page is displaying. */
async function reachLobby(page, who) {
  try {
    // Entering a party opens the loadout first; carry on into the lobby.
    await page.waitForSelector('#screen-loadout:not([hidden]), #screen-lobby:not([hidden])', { timeout: 60000 });
    if (await page.isVisible('#screen-loadout')) await page.click('#btn-loadout-done');
    await page.waitForSelector('#screen-lobby:not([hidden])', { timeout: 60000 });
  } catch {
    const shown = (await page.textContent('#main-error').catch(() => '')) || 'no error on screen';
    throw new Error(`${who} never reached the lobby (page shows: "${shown}")`);
  }
}

async function party(net) {
  const q = net === 'local' ? '?net=local&renderer=webgl2&low' : '?renderer=webgl2&low';
  const host = await openPage(q, `${net}-host`);
  const shared = net === 'local' ? host.context() : null;
  await host.fill('#name', 'Host');
  await host.click('#btn-host');
  await reachLobby(host, 'host');
  const code = await host.textContent('#lobby-code');
  const link = await host.inputValue('#lobby-link');
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error(`bad code ${code}`);
  if (link !== `${SITE}?party=${code}`) throw new Error(`invite link is ${link}`);

  // The invite link with the debug switches kept, so the guest uses the same transport.
  // A shared profile also shares the saved name, which would make the invite link auto-join as "Host".
  if (shared) await host.evaluate(() => localStorage.removeItem('gs.name'));
  const guest = await openPage(`${q}&party=${code}`, `${net}-guest`, shared);
  if ((await guest.inputValue('#join-code')) !== code) throw new Error('?party= did not fill the code');
  await guest.fill('#name', 'Guest');
  await guest.click('#btn-join');
  await reachLobby(guest, 'guest');
  await guest.click('#btn-ready');
  await host.waitForFunction(() => document.querySelector('#lobby-players')?.textContent.includes('ready'), null, { timeout: 10000 });
  await host.click('#btn-start');
  await guest.waitForFunction(() => window.app.session?.snap, null, { timeout: 20000 });
  await engage(host);
  await engage(guest);
  // The guest walks forward; its position must reach the host and come back in snapshots.
  await guest.evaluate(() => { window.app.input.move = () => [0, 1]; });
  await waitRound(guest, 150000);
  await guest.waitForTimeout(2000);
  const g = await guest.evaluate(() => {
    const a = window.app, s = a.session, P = a.sim.L.P;
    const auth = s.snap.players.find(p => p[P.id] === s.selfId), me = s.local();
    return { gap: Math.hypot(me[P['ctl.pos']] - auth[P['ctl.pos']], me[P['ctl.pos'] + 2] - auth[P['ctl.pos'] + 2]), moved: Math.hypot(auth[P['ctl.vel']], auth[P['ctl.vel'] + 2]) > 0.5 || auth[P.ack] > 60 };
  });
  await shoot(guest, `party-${net}-guest.png`);
  const h = await hdr(guest);
  assertClean(host);
  assertClean(guest);
  await host.context().close();
  if (!shared) await guest.context().close();
  if (h.players !== 2) throw new Error(`guest sees ${h.players} players`);
  if (!g.moved) throw new Error('host never applied the guest\'s input');
  if (g.gap > 3) throw new Error(`prediction is ${g.gap.toFixed(1)} m from the host`);
  return { code, ...h, predictionGap: +g.gap.toFixed(2) };
}

await check('party over the same-browser transport (offline)', () => party('local'));

await check('team mode: match settings, teams, objectives and the pause roster', async () => {
  const q = '?net=local&renderer=webgl2&low';
  const host = await openPage(q, 'team-host');
  await host.fill('#name', 'Host');
  await host.click('#btn-host');
  await reachLobby(host, 'host');
  const code = await host.textContent('#lobby-code');
  await host.evaluate(() => localStorage.removeItem('gs.name'));
  const guest = await openPage(`${q}&party=${code}`, 'team-guest', host.context());
  await guest.fill('#name', 'Guest');
  await guest.click('#btn-join');
  await reachLobby(guest, 'guest');
  // Domination with a custom score limit; the guest sees the settings but cannot change them.
  await host.click('#lobby-mode + .picker [data-v="3"]');
  await host.click('#rule-score + .picker [data-v="100"]');
  await host.check('#rule-ff');
  await guest.waitForFunction(() => document.getElementById('rule-score').value === '100' && document.getElementById('rule-ff').checked, null, { timeout: 60000 });
  if (!(await guest.isDisabled('#rule-score'))) throw new Error('a guest can edit match settings');
  const summary = await guest.textContent('#rules-summary');
  const teams = await host.$$eval('#lobby-players .team', els => els.map(e => e.textContent));
  if (teams.join() !== 'Crimson,Cobalt') throw new Error(`lobby teams: ${teams}`);
  await guest.click('#btn-ready');
  await host.waitForFunction(() => document.querySelector('#lobby-players')?.textContent.includes('ready'), null, { timeout: 60000 });
  await host.click('#btn-start');
  await guest.waitForFunction(() => window.app.session?.snap, null, { timeout: 120000 });
  await engage(host);
  await engage(guest);
  // Three zones on the map, team scores on screen, opposite teams on the two machines.
  await guest.waitForFunction(() => document.querySelectorAll('#objective .zone').length === 3 && document.querySelectorAll('#objective .side').length === 2, null, { timeout: 120000 });
  const side = page => page.evaluate(() => { const a = window.app; return { team: a.session.local()[a.sim.L.P.team], limit: a.session.snap.hdr[a.sim.L.H.score_limit] }; });
  const [hs, gs] = [await side(host), await side(guest)];
  if (hs.team === gs.team || ![0, 1].includes(hs.team) || ![0, 1].includes(gs.team)) throw new Error(`teams ${hs.team} and ${gs.team}`);
  if (gs.limit !== 100) throw new Error(`score limit on the guest is ${gs.limit}`);
  // Esc menu: both rosters; with one player a side, switching would be unfair, so the button is off.
  await guest.evaluate(() => window.app.show('pause'));
  await guest.waitForFunction(() => document.querySelectorAll('#pause-teams .roster').length === 2, null, { timeout: 60000 });
  const roster = await guest.evaluate(() => document.getElementById('pause-teams').innerText.replace(/\s+/g, ' '));
  if (!/Crimson/i.test(roster) || !/Cobalt/i.test(roster) || !roster.includes('Host') || !roster.includes('Guest')) throw new Error(`pause roster: ${roster}`);
  if (!(await guest.isDisabled('#btn-switch-team'))) throw new Error('switching to make it 2 v 0 should be disabled');
  assertClean(host);
  assertClean(guest);
  return { summary, hostTeam: hs.team, guestTeam: gs.team, roster: roster.slice(0, 80) };
});
if (skipPeer) results.push({ name: 'party over WebRTC via the public PeerJS broker', ok: true, detail: 'skipped (E2E_SKIP_PEERJS=1)' });
else await check('party over WebRTC via the public PeerJS broker', async () => {
  try {
    return await party('peer');
  } catch (e) {
    // The broker is a free public service: retry once with fresh browsers before calling it a failure.
    console.log(`  first attempt failed (${e?.message?.split('\n')[0]}); retrying once`);
    await Promise.all(opened.map(c => c.close().catch(() => {})));
    opened = [];
    return await party('peer');
  }
});

await browser.close();
writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
