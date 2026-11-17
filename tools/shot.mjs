#!/usr/bin/env node
// Capture frames of dist/index.html in real Chrome on the discrete GPU.
//
// Usage:  node tools/shot.mjs <job> [<job> ...]
//   job = "<query>=><out.png>[@x,y,w,h]"       e.g.  "pose=1=>renders/pose-1.png"
//                                                    "pose=1=>renders/pose-1-crop-limb.png@900,300,640,360"
//   The query is appended to the page URL together with res=WxH. The page must set window.__ready.
//   Consecutive jobs with the same query reuse the loaded page (full frame, then crops).
// Env:  W, H      render size, default 2560x1440
//       TIMEOUT   ms to wait for window.__ready (default 90000)
//       VERBOSE=1 echo every console message from the page
//       plus everything tools/chrome.mjs reads (HEADED, CHROME_ARGS, ...)
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { launchChrome } from './chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = +(process.env.W || 2560), H = +(process.env.H || 1440);
const timeout = +(process.env.TIMEOUT || 90000);
const jobs = process.argv.slice(2).map(a => {
  const m = /^(.*?)=>(.*?)(?:@(\d+),(\d+),(\d+),(\d+))?$/.exec(a);
  if (!m) throw new Error('bad job: ' + a);
  return { query: m[1], out: path.resolve(root, m[2]), clip: m[3] ? { x: +m[3], y: +m[4], width: +m[5], height: +m[6] } : null };
});
if (!jobs.length) { console.error('no jobs; see the header of tools/shot.mjs'); process.exit(2); }

const browser = await launchChrome();
let failed = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning' || process.env.VERBOSE) console.log(`  [page ${t}] ${m.text()}`); });
  page.on('pageerror', e => console.log('  [page exception] ' + e.message));
  let lastQuery = null;
  for (const job of jobs) {
    const t0 = Date.now();
    if (job.query !== lastQuery) {
      const url = pathToFileURL(path.join(root, 'dist', 'index.html')).href + `?res=${W}x${H}&` + job.query;
      await page.goto(url);
      try {
        await page.waitForFunction(() => window.__ready === true || (window.__errors && window.__errors.length > 0), null, { timeout });
      } catch {
        console.log(`  TIMEOUT waiting for __ready: ${job.query}`);
        failed++;
      }
      lastQuery = job.query;
    }
    const st = await page.evaluate(() => ({ errors: window.__errors || [], info: window.__info || null }));
    for (const e of st.errors) console.log('  [page error] ' + e);
    if (st.errors.length) failed++;
    mkdirSync(path.dirname(job.out), { recursive: true });
    await page.screenshot({ path: job.out, clip: job.clip || undefined });
    console.log(`${path.relative(root, job.out)}  (${Date.now() - t0} ms)${st.info ? '  ' + JSON.stringify(st.info) : ''}`);
  }
} finally {
  // Chrome sometimes never acknowledges the close after a GPU-heavy session; do not let that hang the tool.
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
}
process.exit(failed ? 1 : 0);
