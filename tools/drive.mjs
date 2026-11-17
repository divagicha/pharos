#!/usr/bin/env node
// Drive the page the way a person would (keys, mouse, clicks) and check that it responds: mode changes, the
// autopilot arriving, selection, the panel and cutaway, hover, and the turn-back at the edge of the charted
// volume. Needs the dev build (npm run build:dev): it reads state through window.__dbg, which the minified
// build does not have.
//
// Usage:  node tools/drive.mjs [--shots]     --shots also writes renders/dev/drive-*.png
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { launchChrome } from './chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv.includes('--shots');
const W = +(process.env.W || 1600), H = +(process.env.H || 900);
const browser = await launchChrome();
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  [page error] ' + m.text()); });
  page.on('pageerror', e => { console.log('  [page exception] ' + e.message); failed++; });
  await page.goto(pathToFileURL(path.join(root, 'dist', 'index.html')).href + '?neb=256');
  await page.waitForFunction(() => window.__ready === true || (window.__errors && window.__errors.length > 0), null, { timeout: 90000 });
  const state = () => page.evaluate(() => {
    const d = window.__dbg, i = d.inspect.sel;
    return {
      mode: d.control.mode, sel: i >= 0 ? d.S.id[i] : null, panel: d.inspect.panel, open: d.inspect.open, hover: d.inspect.hover,
      nearest: d.S.id[d.flight.nearest], altitude: d.flight.altitude, auto: d.auto.active, edge: d.control.edge,
      dist: i >= 0 ? d.scene.dist[i] / d.S.radius[i] : -1, sys: d.cam.sys, errors: window.__errors.length,
      focus: d.hudState.focus >= 0 ? d.S.id[d.hudState.focus] : null, note: d.hudState.note, speed: d.flight.speed,
    };
  });
  const snap = async name => { if (shots) { mkdirSync(path.join(root, 'renders/dev'), { recursive: true }); await page.screenshot({ path: path.join(root, 'renders/dev', `drive-${name}.png`) }); } };
  const until = (fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

  let s = await state();
  check(s.mode === 0 && s.nearest === 'pelagia' && s.sel === null && s.focus === 'pelagia', 'starts in free flight beside Pelagia: nothing selected, its card shown', JSON.stringify(s));
  check(s.note === 1, 'offers the helm until the pointer is captured');

  // ---- number key: lock on and warp ----
  await page.keyboard.press('Digit5');
  await page.waitForTimeout(300);
  s = await state();
  check(s.mode === 2 && s.sel === 'nivalis' && s.auto, 'key 5 selects Nivalis and starts the autopilot', `mode ${s.mode}`);
  await page.waitForTimeout(2500);
  await snap('warp');
  const arrived = await until(() => !window.__dbg.auto.active);
  s = await state();
  check(arrived && s.mode === 0 && s.nearest === 'nivalis' && Math.abs(s.dist - 3.2) < 0.05, 'arrives 3.2 radii from Nivalis and hands back the helm', `dist ${s.dist.toFixed(3)} R, mode ${s.mode}`);
  check(s.focus === 'nivalis', 'the card shows the body it arrived at');
  await snap('arrived');

  // ---- a movement key cancels a warp ----
  await page.keyboard.press('Digit4');
  await page.waitForTimeout(600);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(150);
  await page.keyboard.up('KeyW');
  s = await state();
  check(s.mode === 0 && !s.auto && s.sel === 'boreas', 'W cancels the warp to Boreas and keeps the selection', `mode ${s.mode}`);

  // ---- Space: cursor mode; click a body; Tab: panel and cutaway; hover; drag; Escape ----
  await page.keyboard.press('Digit5');
  await page.waitForTimeout(100);
  s = await state();
  check(s.auto, 'key 5 again goes back to the parking point even from close by');
  await until(() => !window.__dbg.auto.active);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  s = await state();
  check(s.mode === 1, 'Space switches to cursor inspection', `mode ${s.mode}`);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1900);
  s = await state();
  check(s.panel && s.open === 1 && s.sel === 'nivalis', 'Tab opens the panel and the cutaway fully', `open ${s.open}`);
  await page.mouse.move(W / 2 + 20, H / 2 + 10);
  await page.waitForTimeout(200);
  s = await state();
  check(s.hover >= 0, 'pointing into the opening highlights a layer', `layer ${s.hover}`);
  await snap('cutaway-hover');
  const before = await page.evaluate(() => Array.from(window.__dbg.inspect.rows));
  await page.mouse.down();
  await page.mouse.move(W / 2 + 140, H / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => Array.from(window.__dbg.inspect.rows));
  s = await state();
  check(Math.max(...after.map((v, k) => Math.abs(v - before[k]))) > 0.1 && s.sel === 'nivalis' && !s.auto, 'dragging turns the cutaway and is not taken for a click', JSON.stringify({ d: after.map((v, k) => +(v - before[k]).toFixed(3)), sel: s.sel, auto: s.auto, mode: s.mode }));
  // hovering a row of the panel highlights that layer in 3D
  const row = await page.evaluate(() => { const r = document.querySelector('.bd.full .lay'); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(row.x, row.y);
  await page.waitForTimeout(200);
  s = await state();
  check(s.hover === 2, 'hovering the top row of the panel highlights the outermost layer', `layer ${s.hover}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  s = await state();
  check(!s.panel && s.open === 0, 'Escape closes the panel and the cutaway', `open ${s.open}`);

  // ---- click a moon's marker in cursor mode ----
  const firn = await page.evaluate(() => {
    const d = window.__dbg, i = d.S.index.get('firn'), p = i * 3, r = d.scene.rel, c = d.cam;
    const z = r[p] * c.fwd[0] + r[p + 1] * c.fwd[1] + r[p + 2] * c.fwd[2];
    return { z, x: innerWidth / 2 + (r[p] * c.right[0] + r[p + 1] * c.right[1] + r[p + 2] * c.right[2]) / z * innerWidth / 2 / c.tanX,
      y: innerHeight / 2 - (r[p] * c.up[0] + r[p + 1] * c.up[1] + r[p + 2] * c.up[2]) / z * innerHeight / 2 / c.tanY };
  });
  if (firn.z > 0 && firn.x > 5 && firn.x < W - 5 && firn.y > 5 && firn.y < H - 5) {
    await page.mouse.click(firn.x + 3, firn.y + 2);
    await page.waitForTimeout(300);
    s = await state();
    check(s.sel === 'firn' && s.mode === 3, 'clicking a moon selects it and warps there from cursor mode', `sel ${s.sel}, mode ${s.mode}`);
    const there = await until(() => !window.__dbg.auto.active);
    s = await state();
    check(there && s.mode === 1 && s.nearest === 'firn', 'and returns to cursor mode on arrival', `mode ${s.mode}, nearest ${s.nearest}`);
  } else console.log('skip  Firn is not in view from here, so the click test did not run');

  // ---- another star: 9 is the pulsar, 27 light-years away ----
  await page.keyboard.press('Digit9');
  const far = await until(() => !window.__dbg.auto.active, null, 30000);
  s = await state();
  check(far && s.nearest === 'metronome' && s.sys === 4 && Math.abs(s.dist - 30) < 0.5, 'warps 27 ly to the pulsar and parks 30 radii out', `dist ${s.dist.toFixed(2)} R, system ${s.sys}`);
  await snap('pulsar');

  // ---- the edge of the charted volume: put the camera 84 ly out, flying outward ----
  await page.evaluate(() => { const d = window.__dbg, ly = 9460730472580.8; d.cam.sys = 0; d.cam.pos[0] = 84 * ly; d.cam.pos[1] = 0; d.cam.pos[2] = 0; });
  await page.waitForTimeout(200);
  s = await state();
  check(s.edge > 0.3 && s.edge < 0.8 && s.note === 2, 'the picture fades and a notice appears near the edge', `edge ${s.edge.toFixed(2)}, note ${s.note}`);
  await snap('edge');
  await page.evaluate(() => { const d = window.__dbg, ly = 9460730472580.8; d.cam.pos[0] = 87 * ly; });
  await page.waitForTimeout(300);
  s = await state();
  check(s.mode === 4 && s.auto && s.sel === 'pharos' && s.note === 3, 'past it the autopilot takes the helm and heads home', `mode ${s.mode}, note ${s.note}`);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(200);
  await page.keyboard.up('KeyW');
  s = await state();
  check(s.mode === 4 && s.auto, 'and cannot be cancelled');
  const home = await until(() => !window.__dbg.auto.active, null, 30000);
  s = await state();
  check(home && s.nearest === 'pharos' && s.edge === 0 && s.sys === 0, 'arrives back at Pharos', `nearest ${s.nearest}, edge ${s.edge}`);
  check(s.errors === 0, 'no page errors', `${s.errors}`);
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall interaction checks passed');
process.exit(failed ? 1 : 0);
