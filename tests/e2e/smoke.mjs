// End-to-end check of the built site, served the way GitHub Pages serves it.
//   node tools/serve-pages.mjs 4180 &  node tests/e2e/smoke.mjs http://localhost:4180/grave-shift/
// Set E2E_SKIP_PEERJS=1 where the public PeerJS broker is unreachable (offline sandboxes).
// Writes screenshots and a summary to e2e-results/. Exits non-zero if any check fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

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
  if (only && !name.includes(only)) return;
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

await check('site loads under the Pages sub-path with no errors or 404s', async () => {
  const page = await openPage('?low', 'main');
  const title = await page.title();
  const info = await page.textContent('#renderer-info');
  // A missing asset only shows up once a match loads models, so start one briefly.
  await page.evaluate(() => document.getElementById('btn-solo').click());
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
  await page.evaluate(() => document.getElementById('btn-solo').click());
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
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await engage(page);
  await waitRound(page);
  await shoot(page, 'solo-webgpu.png');
  const h = await hdr(page);
  assertClean(page);
  await page.context().close();
  if (h.renderer !== 'webgpu') throw new Error(`renderer is ${h.renderer}`);
  return h;
});

/**
 * Host + guest. The guest joins by opening the invite link. Over WebRTC they are separate browser
 * profiles, like two people; the offline transport (BroadcastChannel) only reaches pages in the
 * same profile, so there they share one.
 */
async function party(net) {
  const q = net === 'local' ? '?net=local&renderer=webgl2&low' : '?renderer=webgl2&low';
  const host = await openPage(q, `${net}-host`);
  const shared = net === 'local' ? host.context() : null;
  await host.fill('#name', 'Host');
  await host.click('#btn-host');
  await host.waitForSelector('#screen-lobby:not([hidden])', { timeout: 30000 });
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
  await guest.waitForSelector('#screen-lobby:not([hidden])', { timeout: 30000 });
  await guest.click('#btn-ready');
  await host.waitForFunction(() => document.querySelector('#lobby-players')?.textContent.includes('ready'), null, { timeout: 10000 });
  await host.click('#btn-start');
  await guest.waitForFunction(() => window.app.session?.snap, null, { timeout: 20000 });
  await engage(host);
  await engage(guest);
  // The guest walks forward; its position must reach the host and come back in snapshots.
  await guest.evaluate(() => { window.app.input.move = () => [0, 1]; });
  await waitRound(guest, 60000);
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
if (skipPeer) results.push({ name: 'party over WebRTC via the public PeerJS broker', ok: true, detail: 'skipped (E2E_SKIP_PEERJS=1)' });
else await check('party over WebRTC via the public PeerJS broker', () => party('peer'));

await browser.close();
writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
