#!/usr/bin/env node
// Contact sheet: capture several views of dist/index.html small and lay them out in one labelled image,
// for composing poses and checking the tour at a glance. Development aid; the critic gets full frames.
//
// Usage:  node tools/sheet.mjs <out.png> <query> [<query> ...]
//         node tools/sheet.mjs <out.png> --tour <from> <to> <step> [extra query]    tour times, by seeking one page
// Env:    CW, CH   size of each cell's render (default 1280x720; shown at half size)
//         COLS     cells per row (default 3)
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { launchChrome } from './chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CW = +(process.env.CW || 1280), CH = +(process.env.CH || 720), COLS = +(process.env.COLS || 3);
const [out, ...rest] = process.argv.slice(2);
if (!out || !rest.length) { console.error('usage: see the header of tools/sheet.mjs'); process.exit(2); }
const base = pathToFileURL(path.join(root, 'dist', 'index.html')).href + `?res=${CW}x${CH}&neb=512&`;
const ready = () => window.__ready === true || (window.__errors && window.__errors.length > 0);

const browser = await launchChrome();
const cells = [];
try {
  const ctx = await browser.newContext({ viewport: { width: CW, height: CH }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  [page exception] ' + e.message));
  const grab = async label => {
    const errors = await page.evaluate(() => window.__errors || []);
    for (const e of errors) console.log('  [page error] ' + e);
    cells.push({ label, data: (await page.screenshot({ type: 'jpeg', quality: 88 })).toString('base64') });
  };
  if (rest[0] === '--tour') {
    const from = +rest[1], to = +rest[2], step = +rest[3], extra = rest[4] ? '&' + rest[4] : '';
    await page.goto(base + `tt=${from}${extra}`);
    await page.waitForFunction(ready, null, { timeout: 90000 });
    for (let t = from; t <= to + 1e-9; t += step) {
      if (t > from) { await page.evaluate(v => window.__seek(v), t); await page.waitForFunction(ready, null, { timeout: 30000 }); }
      await grab(`t = ${t.toFixed(2)} s`);
    }
  } else {
    for (const q of rest) {
      await page.goto(base + q);
      await page.waitForFunction(ready, null, { timeout: 90000 });
      await grab(q);
    }
  }
  // lay the cells out in a page of their own and photograph it
  const w = CW / 2, h = CH / 2, rows = Math.ceil(cells.length / COLS);
  const sheet = await ctx.newPage();
  await sheet.setViewportSize({ width: COLS * w, height: rows * (h + 22) });
  await sheet.setContent(`<body style="margin:0;background:#111;font:13px Consolas,monospace;color:#ddd;display:flex;flex-wrap:wrap">`
    + cells.map(c => `<div style="width:${w}px"><img src="data:image/jpeg;base64,${c.data}" width="${w}" height="${h}" style="display:block"><div style="height:22px;line-height:22px;padding-left:6px;white-space:nowrap;overflow:hidden">${c.label.replace(/&/g, '&amp;')}</div></div>`).join('')
    + `</body>`);
  mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
  await sheet.screenshot({ path: path.resolve(root, out) });
  console.log(`${out}: ${cells.length} cells`);
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
}
