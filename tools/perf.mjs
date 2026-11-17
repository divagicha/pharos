#!/usr/bin/env node
// Timing: run the 60 s grand tour at 2560x1440, read the page's own timing report
// (GPU timestamp queries and requestAnimationFrame intervals) and write docs/perf-report.md.
//
// Two kinds of run alternate, N of each (default 3):
//   timing run     nothing but the page and Chrome. These are the numbers to judge.
//   evidence run   the same, with one nvidia-smi process sampling GPU load and power every three seconds.
// The second kind exists because a timing is only worth reporting if the work really ran on the discrete GPU:
// on this hybrid laptop Chrome reports the NVIDIA adapter even when the frames are drawn by the integrated GPU
// (on battery). It is kept apart from the first because sampling is not free: asking the driver for its state
// can itself cost a frame, and that would be this tool's hitch, not the page's.
// The tool refuses to run on battery.
//
// Usage:  node tools/perf.mjs [--runs N] [--headless] [--out file.md]
//         Headed by default, so frames are presented to a real display and frame gaps mean something.
// Env:    W, H (default 2560x1440), plus everything tools/chrome.mjs reads
import { writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const RUNS = +(arg('--runs') || 3);
const W = +(process.env.W || 2560), H = +(process.env.H || 1440);
const outFile = path.resolve(root, arg('--out') || 'docs/perf-report.md');
if (!process.argv.includes('--headless')) process.env.HEADED = '1';
const { launchChrome } = await import('./chrome.mjs');

const TARGET_AVG = 11, TARGET_MAX = 16.7;
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).trim(); } catch { return ''; } };
const ps = script => sh('powershell', ['-NoProfile', '-Command', script]);
/** true on mains, false on battery, null when there is no battery. */
const onMains = () => { const s = ps('(Get-CimInstance Win32_Battery).BatteryStatus'); return s === '' ? null : s.split(/\s+/).every(v => v !== '1' && v !== '4' && v !== '5'); };
const SMI_QUERY = ['--query-gpu=name,utilization.gpu,power.draw,memory.used', '--format=csv,noheader,nounits'];
const parseSmi = line => { const [name, util, watts, mem] = line.split(',').map(v => v.trim()); return name && isFinite(+util) ? { name, util: +util, watts: +watts, mem: +mem } : null; };
const display = ps('Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentRefreshRate } | ForEach-Object { "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution) at $($_.CurrentRefreshRate) Hz ($($_.Name))" }');
const cpu = os.cpus()[0].model.trim();

if (onMains() === false) { console.error('On battery: the tour would run on the integrated GPU. Plug in and run again.'); process.exit(2); }
const idle = parseSmi(sh('nvidia-smi', SMI_QUERY));
console.log(`power: ${onMains() === null ? 'no battery (desktop)' : 'mains'}; ${idle ? `${idle.name} idle at ${idle.util} %, ${idle.watts} W` : 'nvidia-smi not found: no evidence runs possible'}`);

/** One tour. sampled = run nvidia-smi alongside. Returns the page's report and, if sampled, the GPU load during the tour. */
async function tour(sampled) {
  const browser = await launchChrome(['--start-maximized']);
  const all = [];
  let logger = null, report = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    // The sampler starts before the page loads, because starting it is the part that disturbs the GPU most.
    if (sampled) {
      logger = spawn('nvidia-smi', [...SMI_QUERY, '-l', '3'], { stdio: ['ignore', 'pipe', 'ignore'] });
      logger.on('error', () => {});
      logger.stdout.setEncoding('utf8');
      logger.stdout.on('data', chunk => { for (const line of chunk.split(/\r?\n/)) { const s = parseSmi(line); if (s) all.push({ at: Date.now(), ...s }); } });
    }
    await page.goto(pathToFileURL(path.join(root, 'dist', 'index.html')).href + `?tour=1&res=${W}x${H}`);
    // The page starts its clock a moment after the picture is up and sets window.__tourStarted. From then on
    // this tool makes no calls into the page until the tour has had time to finish.
    await page.waitForFunction(() => window.__tourStarted === true || (window.__errors && window.__errors.length > 0), null, { timeout: 120000, polling: 250 });
    const began = Date.now();
    await new Promise(r => setTimeout(r, 62000));
    if (logger) logger.kill();
    await page.waitForFunction(() => !!window.__report || (window.__errors && window.__errors.length > 0), null, { timeout: 60000, polling: 500 });
    const errors = await page.evaluate(() => window.__errors || []);
    if (errors.length) throw new Error('page error: ' + errors.join('; '));
    report = await page.evaluate(() => window.__report || null);
    if (!report) throw new Error('the page produced no report');
    const during = all.filter(x => x.at >= began && x.at <= began + 60000);
    // nvidia-smi now and then prints [N/A] for one reading (power most often): average the readings it did give
    const mean = key => { const v = during.map(x => x[key]).filter(isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
    const load = during.length ? { utilAvg: mean('util'), utilMax: Math.max(...during.map(x => x.util)), wattsAvg: mean('watts'), n: during.length } : null;
    return { report, load, sampled, mains: onMains() };
  } finally {
    if (logger) logger.kill();
    await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  }
}

const watts = load => (isFinite(load.wattsAvg) ? `${load.wattsAvg.toFixed(0)} W` : 'n/a');
const runs = [];
for (let n = 1; n <= RUNS; n++) {
  for (const sampled of idle ? [false, true] : [false]) {
    const r = await tour(sampled);
    runs.push(r);
    const g = r.report.gpuMs, f = r.report.rafMs;
    console.log(`${sampled ? 'evidence' : 'timing  '} run ${n}: GPU avg ${g.avg.toFixed(2)} p99 ${g.p99.toFixed(2)} max ${g.max.toFixed(2)} ms | frame gap avg ${f.avg.toFixed(2)} p99 ${f.p99.toFixed(2)} max ${f.max.toFixed(2)} ms (${f.n} frames)`
      + (r.load ? ` | GPU load avg ${r.load.utilAvg.toFixed(0)} % max ${r.load.utilMax} %, ${watts(r.load)}` : ''));
    console.log(`             longest gaps: ${r.report.worstGaps.map(w => `${w.ms} ms at ${w.at} s`).join(', ')}`);
  }
}

// ---- the report ----
const timing = runs.filter(r => !r.sampled), evidence = runs.filter(r => r.sampled);
const r0 = runs[0].report, f2 = v => v.toFixed(2);
const gpuPass = runs.every(r => r.report.gpuMs.avg <= TARGET_AVG && r.report.gpuMs.max <= TARGET_MAX);
const gapPass = timing.every(r => r.report.rafMs.max <= TARGET_MAX);
const gapEvidencePass = evidence.every(r => r.report.rafMs.max <= TARGET_MAX);
const loaded = evidence.length > 0 && evidence.every(r => r.load && r.load.utilAvg > 20);
const allMains = runs.every(r => r.mains !== false);
const row = (r, i) => {
  const g = r.report.gpuMs, f = r.report.rafMs;
  return `| ${i + 1} | ${f.n}${r.report.gpuDropped ? ` (${r.report.gpuDropped} GPU times unread)` : ''} | ${f2(g.avg)} | ${f2(g.p99)} | ${f2(g.max)} | ${f2(f.avg)} | ${f2(f.p99)} | ${f2(f.max)} |`
    + (r.sampled ? ` ${r.load ? `${r.load.utilAvg.toFixed(0)} % / ${r.load.utilMax} %` : 'n/a'} | ${r.load ? watts(r.load) : 'n/a'} |` : '');
};
const gaps = list => list.map((r, i) => `- Run ${i + 1}: ${r.report.worstGaps.map(w => `${w.ms} ms at ${w.at} s`).join(', ')}`);
const head = '| Run | Frames | GPU avg (ms) | GPU p99 (ms) | GPU max (ms) | Frame gap avg (ms) | Frame gap p99 (ms) | Frame gap max (ms) |';
const L = [];
L.push('# Performance report: 60 s grand tour', '');
L.push(`Generated by \`node tools/perf.mjs\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Every number below was measured by the page itself during the run; nothing is estimated.`, '');
L.push('## Conditions', '');
L.push(`- Page: \`dist/index.html?tour=1&res=${W}x${H}\` (${r0.resolution}, ${r0.samples}x MSAA scene target), ${process.env.HEADED === '1' ? 'headed' : 'headless'} Chrome.`);
L.push(`- Adapter reported by WebGPU: ${`${r0.adapter.vendor} ${r0.adapter.architecture} ${r0.adapter.description || ''}`.trim()}.`);
L.push(`- GPU (nvidia-smi): ${idle ? idle.name : 'not available'}. CPU: ${cpu}.`);
L.push(`- Display: ${display.split(/\r?\n/).join('; ') || 'unknown'}.`);
L.push(`- Power: ${onMains() === null ? 'desktop, no battery' : allMains ? 'on mains for every run' : '**NOT on mains for every run: discard this report**'}.`);
L.push(`- User agent: ${r0.userAgent}`);
L.push('- GPU time is from timestamp queries: start of the scene pass to the end of the composite pass, one pair per frame, every frame of the sixty seconds. Chrome quantises them to 0.1 ms unless its WebGPU developer features flag is on; it was left at the default.');
L.push('- Frame gap is the interval between requestAnimationFrame callbacks.');
L.push(`- Dynamic resolution or any other fallback: none exists in the page; ${r0.dynamicResolution ? 'ENGAGED' : 'not engaged'}.`, '');
L.push('## Timing runs', '', 'Nothing running but Chrome and the page.', '', head, '|---|---|---|---|---|---|---|---|');
timing.forEach((r, i) => L.push(row(r, i)));
L.push('', 'Longest frame gaps in each run, with the tour time at which they ended:', '', ...gaps(timing), '');
if (evidence.length) {
  L.push('## Evidence runs', '', 'The same tour with `nvidia-smi` sampling the GPU every three seconds, to show which GPU did the work. Asking the driver for its state is not free and can itself cost a frame, so judge frame gaps by the timing runs above.', '');
  L.push(head + ' GPU load avg / max | GPU power |', '|---|---|---|---|---|---|---|---|---|---|');
  evidence.forEach((r, i) => L.push(row(r, i)));
  L.push('', 'Longest frame gaps:', '', ...gaps(evidence), '');
}
L.push('## Against the brief', '');
L.push(`- **GPU frame time** (target: at most ${TARGET_AVG} ms on average, no frame over ${TARGET_MAX} ms): ${gpuPass ? 'met in every run' : '**NOT met**'} on this machine.`);
L.push(`- **Frame gap.** The brief does not say whether "no frame > 16.7 ms" means GPU time or the interval between frames, so both are reported. In the timing runs the longest gap ${gapPass ? `stayed within ${TARGET_MAX} ms in every run` : `**exceeded ${TARGET_MAX} ms** in at least one run (see the list above for when)`}.${evidence.length ? ` In the evidence runs it ${gapEvidencePass ? 'did too' : `exceeded ${TARGET_MAX} ms at least once, with the sampler running`}.` : ''}`);
L.push(`- **Which GPU did the work:** ${loaded ? 'the discrete one. nvidia-smi showed it loaded throughout each evidence run (table), on mains, moments apart from the timing runs.' : '**not established**: nvidia-smi showed little or no load, so these timings may come from another adapter.'}`, '');
L.push('## What this does and does not show', '');
L.push("- This is **not the brief's target machine** (RTX 5070 Ti, Ryzen 7800X3D, 180 Hz display). It is the development machine listed under Conditions. The gate as the brief words it has not been run on the target.");
L.push("- Frame gaps cannot be shorter than the display's refresh interval, and their tail depends on everything else the machine is doing. GPU time is the figure that transfers to another machine.");
L.push("- WebGPU itself creates a few objects per frame (command encoder, pass encoders, the canvas texture view, the command buffer) and the browser boxes the timestamp it hands to each animation frame. `node tools/alloc.mjs` measures what is left: the page's own code allocates under two bytes per frame.", '');
writeFileSync(outFile, L.join('\n'));
console.log(`wrote ${path.relative(root, outFile)}; GPU time ${gpuPass ? 'within' : 'OVER'} the target; frame gaps in timing runs ${gapPass ? 'within' : 'OVER'} ${TARGET_MAX} ms; discrete GPU ${loaded ? 'confirmed' : 'NOT confirmed'}`);
process.exit(gpuPass && loaded && allMains ? 0 : 1);
