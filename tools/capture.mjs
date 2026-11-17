#!/usr/bin/env node
// Capture the frames used for visual review, into renders/:
//   pose-N.png, pose-N.jpg     the six fixed poses, 2560x1440
//   pose-N-crop-<what>.png     native-resolution crops of each pose (limbs, ring edges, star fields, HUD text)
//   tour-TTT.T.jpg             the tour every 0.5 s
//   trip-TTT.T-a|b|c.jpg       three consecutive frames 1/60 s apart at moments chosen for risk
//   trip-TTT.T-crop-a|b|c.png  the centre of each of those frames at native resolution
// Full frames for viewing are JPEG (quality 92): an image viewer that receives a PNG of several megabytes
// reduces it to a palette, which looks like banding that is not in the render. The PNGs are the record.
//
// Usage:  node tools/capture.mjs [poses] [tour] [trips]      (default: all three)
// Env:    W, H (default 2560x1440), plus everything tools/chrome.mjs reads
// Uses dist/index.html as built: run npm run build first for the deliverable.
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { launchChrome } from './chrome.mjs';
import { readPNG, meanLuma } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = +(process.env.W || 2560), H = +(process.env.H || 1440);
const want = process.argv.slice(2);
const doing = what => want.length === 0 || want.includes(what);
const out = path.join(root, 'renders');
const base = pathToFileURL(path.join(root, 'dist', 'index.html')).href + `?res=${W}x${H}&`;
const ready = () => window.__ready === true || (window.__errors && window.__errors.length > 0);

// Native-resolution crops per pose: [name, x, y, width, height] in frame pixels at 2560x1440.
const CROPS = {
  1: [['limb', 980, 380, 800, 450], ['lights', 1100, 560, 800, 450], ['lights-east', 1700, 480, 800, 450], ['hud', 0, 0, 800, 450], ['card', 0, 1000, 800, 440]],
  2: [['ring-near', 880, 560, 800, 450], ['ring-far', 1560, 300, 800, 450], ['limb', 900, 60, 800, 450], ['limb-left', 300, 620, 800, 450], ['hud', 0, 0, 800, 450]],
  3: [['limb', 900, 500, 800, 450], ['surface', 300, 560, 800, 450], ['loops', 900, 990, 800, 450], ['streamers', 1600, 300, 800, 450], ['hud', 0, 0, 800, 450]],
  4: [['cut', 1040, 420, 800, 450], ['panel-left', 0, 150, 640, 700], ['panel-right', 1920, 100, 640, 780], ['limb', 780, 880, 800, 450]],
  5: [['cut', 1040, 380, 800, 450], ['panel-left', 0, 150, 640, 620], ['panel-right', 1920, 100, 640, 700], ['corona', 1700, 760, 800, 450]],
  6: [['rings', 1300, 560, 800, 450], ['nebula', 300, 200, 800, 450], ['stars', 300, 860, 800, 450], ['hud', 0, 0, 800, 450]],
};
// Moments for the 1/60 s triplets: boiling granulation, lava, a warp, low orbit, the cutaway, asteroids, the
// comet, storms, the ring-plane crossing, the rings from below, the pulsar and a warp exit.
const TRIPS = [2.0, 9.0, 12.4, 15.5, 17.5, 22.5, 30.0, 36.0, 42.5, 49.9, 51.6, 56.5, 59.4];

const stamp = t => t.toFixed(1).padStart(5, '0');
let failed = 0;
const browser = await launchChrome();
try {
  mkdirSync(out, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  [page exception] ' + e.message); failed++; });
  const settle = async what => {
    try { await page.waitForFunction(ready, null, { timeout: 120000 }); } catch { console.log(`  TIMEOUT: ${what}`); failed++; }
    const errors = await page.evaluate(() => window.__errors || []);
    for (const e of errors) { console.log(`  [page error] ${e}`); failed++; }
  };
  const clean = prefix => { for (const f of readdirSync(out)) { if (f.startsWith(prefix) && /\.(png|jpg)$/.test(f)) rmSync(path.join(out, f)); } };
  const shot = (name, clip) => page.screenshot({ path: path.join(out, name), clip });
  const view = name => page.screenshot({ path: path.join(out, name), type: 'jpeg', quality: 92 });
  const mid = { x: (W - 800) / 2, y: (H - 450) / 2, width: 800, height: 450 };

  if (doing('poses')) {
    clean('pose-');
    for (let n = 1; n <= 6; n++) {
      await page.goto(base + `pose=${n}`);
      await settle(`pose ${n}`);
      await shot(`pose-${n}.png`);
      await view(`pose-${n}.jpg`);
      for (const [name, x, y, width, height] of CROPS[n]) await shot(`pose-${n}-crop-${name}.png`, { x, y, width, height });
      const luma = meanLuma(readPNG(path.join(out, `pose-${n}.png`)));
      console.log(`pose-${n}.png  mean luminance ${luma.toFixed(1)}${luma < 1 ? '  BLACK FRAME' : ''}`);
      if (luma < 1) failed++;
    }
  }
  if (doing('tour') || doing('trips')) {
    await page.goto(base + 'tt=0');
    await settle('tour start');
    const seek = async t => { await page.evaluate(v => window.__seek(v), t); await settle(`tour ${t}`); };
    if (doing('tour')) {
      clean('tour-');
      for (let k = 0; k <= 120; k++) { const t = k * 0.5; await seek(t); await view(`tour-${stamp(t)}.jpg`); }
      console.log('tour: 121 frames');
    }
    if (doing('trips')) {
      clean('trip-');
      for (const t of TRIPS) {
        for (const [k, letter] of ['a', 'b', 'c'].entries()) {
          await seek(t + k / 60);
          await view(`trip-${stamp(t)}-${letter}.jpg`);
          await shot(`trip-${stamp(t)}-crop-${letter}.png`, mid);
        }
      }
      console.log(`trips: ${TRIPS.length} triplets`);
    }
  }
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
}
process.exit(failed ? 1 : 0);
