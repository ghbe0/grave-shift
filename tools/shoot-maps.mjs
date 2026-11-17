// Renders the menu panoramas and map-picker pictures from the built site.
//   npm run build && node tools/serve-pages.mjs 4180 & node tools/shoot-maps.mjs [map] [x y z yaw pitch]
// Writes public/assets/maps/<n>.jpg (wide panorama) and <n>-s.jpg (picker thumbnail).
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'http://localhost:4180/grave-shift/';
// Hand-picked cameras: [x, y, z, yaw, pitch, fov]; null = automatic (spawn, longest view).
const CAMS = JSON.parse(process.env.CAMS ?? 'null') ?? [null, null, [8, 2.3, 23, -1.5708, -0.03, 72], [8, 2.1, 25, -1.5708, -0.03, 72]];
const only = process.argv[2] !== undefined ? [+process.argv[2]] : CAMS.map((_, i) => i);
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
for (const m of only) {
  const cam = CAMS[m];
  const q = new URLSearchParams({ renderer: 'webgl2', shot: String(m) });
  if (cam) ['x', 'y', 'z', 'yaw', 'pitch', 'fov'].forEach((k, i) => cam[i] !== undefined && q.set(k, String(cam[i])));
  for (const [w, h, suffix, quality] of [[1600, 720, '', 72], [480, 270, '-s', 78]]) {
    q.set('q', String(quality / 100));
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    page.on('console', m => m.type() === 'error' && console.log('console:', m.text()));
    await page.goto(`${SITE}?${q}`);
    await page.waitForFunction(() => window.app?.shotView, null, { timeout: 120000 });
    await page.evaluate(() => window.app.materials);
    await page.waitForFunction(() => window.app.shotUrl, null, { timeout: 2400000, polling: 1000 });
    const url = await page.evaluate(() => window.app.shotUrl);
    writeFileSync(`public/assets/maps/${m}${suffix}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
    console.log('shot', m, suffix || 'wide', await page.evaluate(() => JSON.stringify(window.app.shotView)));
    await page.close();
  }
}
await browser.close();
