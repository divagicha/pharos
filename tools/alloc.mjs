#!/usr/bin/env node
// Where does the page allocate while it runs? Samples the JS heap with Chrome's allocation profiler during
// free flight, during an autopilot warp and during the tour, and lists the functions that allocated, in
// bytes per frame.
//
// The brief asks for no per-frame allocations (no GC stutter). Three things allocate every frame whatever the
// page does, and the profiler charges them to whoever is on the stack:
//   - the browser boxes the timestamp it hands to the requestAnimationFrame callback, and keeps its own
//     bookkeeping for the callback: charged to `frame` (the callback) or to the engine's own entries in
//     brackets. An EMPTY animation-frame loop measures 4 to 16 bytes per frame this way.
//   - WebGPU creates a command encoder, pass encoders, the canvas texture view and a command buffer:
//     charged to `render` (and to `step` while the nebula bakes at start-up).
//   - this tool's own page.evaluate calls (serialize, evaluate, jsonValue).
// Anything else above a few bytes per frame is ours to fix.
//
// Usage:  node tools/alloc.mjs          needs the dev build (npm run build:dev): the minified build has no names
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { launchChrome } from './chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'dist', 'index.html')).href;
const SECONDS = +(process.env.SECONDS || 12);
const PLATFORM = /^(render|step|\(.*\)|serialize\w*|innerSerialize|evaluate|_?jsonValue\w*|UtilityScript|count)$/;
const CALLBACK_LIMIT = 32, OURS_LIMIT = 8;       // bytes per frame

/** Flatten a sampling profile into [function, bytes] pairs. */
function bySite(node, into = new Map()) {
  const f = node.callFrame, name = `${f.functionName || '(anonymous)'}${f.lineNumber >= 0 && f.url ? `:${f.lineNumber + 1}` : ''}`;
  if (node.selfSize > 0) into.set(name, (into.get(name) || 0) + node.selfSize);
  for (const c of node.children || []) bySite(c, into);
  return into;
}

const browser = await launchChrome();
let bad = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const sample = async (label, query, act) => {
    await page.goto(url + query);
    await page.waitForFunction(() => window.__ready === true || (window.__errors && window.__errors.length > 0), null, { timeout: 90000 });
    await page.evaluate(() => { let c = 0; (function count() { c++; requestAnimationFrame(count); })(); window.__count = () => c; });
    await page.waitForTimeout(6000);                       // let the start-up fade, the first batches and the JIT settle
    if (act) await act();
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512 });
    const f0 = await page.evaluate(() => window.__count());
    await page.waitForTimeout(SECONDS * 1000);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const frames = await page.evaluate(() => window.__count()) - f0;
    const sites = [...bySite(profile.head)].sort((a, b) => b[1] - a[1]);
    const total = sites.reduce((s, x) => s + x[1], 0);
    let ours = 0;
    console.log(`\n${label}: ${frames} frames, ${(total / frames).toFixed(1)} bytes per frame sampled in all`);
    for (const [name, bytes] of sites) {
      const fn = name.split(':')[0], per = bytes / frames;
      const kind = PLATFORM.test(fn) ? 'platform' : fn === 'frame' ? 'callback' : 'ours';
      if (kind === 'ours') ours += bytes;
      const over = (kind === 'ours' && per > OURS_LIMIT) || (kind === 'callback' && per > CALLBACK_LIMIT);
      if (over) bad++;
      if (per >= 0.5) console.log(`  ${per.toFixed(1).padStart(6)} B/frame  ${name.padEnd(28)} ${kind}${over ? '   <-- over the limit' : ''}`);
    }
    console.log(`  our own functions, the callback aside: ${(ours / frames).toFixed(1)} bytes per frame`);
  };
  await sample('free flight, HUD live', '?neb=256');
  await sample('autopilot warp to Nivalis and back', '?neb=256', async () => {
    await page.keyboard.press('Digit5');
    setTimeout(() => page.keyboard.press('Digit3').catch(() => {}), 6500);
  });
  await sample('tour in real time', '?neb=256&tour=1');
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
}
console.log(bad ? `\n${bad} site(s) over the limit` : `\nnothing of ours above ${OURS_LIMIT} bytes per frame; the callback within ${CALLBACK_LIMIT}`);
process.exit(bad ? 1 : 0);
