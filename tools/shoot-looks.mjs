// Renders a close-up portrait for every headgear, face and eyewear option, used as the pictures on
// the customize screen's tiles.
//   npm run build && node tools/serve-pages.mjs 4180 & node tools/shoot-looks.mjs [outDir] [key=n ...]
// Writes <outDir>/<key>-<n>.jpg (default public/assets/look).
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'http://localhost:4180/grave-shift/';
const out = process.argv[2] ?? 'public/assets/look';
const only = process.argv.slice(3);
mkdirSync(out, { recursive: true });
// What each option is shown with, so the option itself stands out.
const BASE = { headgear: 4, face: 0, eyewear: 0, helmet: 0, skin: 1 };
const JOBS = [
  ...Array.from({ length: 9 }, (_, n) => ['headgear', n]),
  ...Array.from({ length: 7 }, (_, n) => ['face', n]),
  ...Array.from({ length: 5 }, (_, n) => ['eyewear', n]),
].filter(([k, n]) => !only.length || only.includes(`${k}=${n}`));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const size = +(process.env.SIZE ?? 256);
await Promise.all([0, 1, 2].map(async lane => {
  for (let j = lane; j < JOBS.length; j += 3) {
    const [key, n] = JOBS[j];
    const look = { ...BASE, [key]: n };
    // Night vision is shown on the helmet it mounts to.
    if (key === 'eyewear' && n === 3) look.headgear = 0;
    const q = new URLSearchParams({ renderer: 'webgl2', portrait: Object.entries(look).map(([k, v]) => `${k}=${v}`).join(',') });
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.log('error', key, n, e.message));
    await page.goto(`${SITE}?${q}`);
    await page.waitForFunction(() => window.app?.portrait, null, { timeout: 120000 });
    await page.evaluate(() => window.app.materials);
    await page.waitForFunction(() => window.app.shotUrl, null, { timeout: 1200000, polling: 500 });
    const url = await page.evaluate(() => window.app.shotUrl);
    writeFileSync(`${out}/${key}-${n}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
    console.log('shot', key, n);
    await page.close();
  }
}));
await browser.close();
