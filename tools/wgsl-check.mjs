#!/usr/bin/env node
// Compile every WGSL module with Chrome's own compiler (Tint) and create every pipeline listed in
// tools/modules.json, using the same descriptor code as the app (src/js/pipelines.js).
// Catches syntax, type, stage-interface, layout and blend-state errors; it does not render.
//
// Usage:  node tools/wgsl-check.mjs          check the readable sources
//         node tools/wgsl-check.mjs --min    check the minified text that ships in dist/index.html
// Env:    see tools/chrome.mjs (CHROME_PATH, SOFT_GPU, HEADED, CHROME_ARGS)
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { launchChrome } from './chrome.mjs';
import { loadModules, locate, minifyWGSL } from './wgsl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const min = process.argv.includes('--min');
const modules = loadModules(root);
const code = Object.fromEntries(Object.entries(modules).map(([k, v]) => [k, min ? minifyWGSL(v.code) : v.code]));

// The app's own pipeline builder, bundled so the page can call it.
const lib = await esbuild.build({
  entryPoints: [path.join(root, 'src/js/pipelines.js')], bundle: true, write: false, format: 'iife', globalName: 'PIPE', logLevel: 'warning',
});

const browser = await launchChrome();
let result;
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(here, 'blank.html')).href);
  await page.addScriptTag({ content: lib.outputFiles[0].text });
  result = await page.evaluate(async (code) => {
    const out = { adapter: null, missing: [], modules: {}, pipelines: [] };
    if (!navigator.gpu) { out.fatal = 'navigator.gpu is missing'; return out; }
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) { out.fatal = 'no WebGPU adapter'; return out; }
    out.adapter = { vendor: ad.info.vendor, architecture: ad.info.architecture, device: ad.info.device, description: ad.info.description };
    out.missing = PIPE.REQUIRED_FEATURES.filter(f => !ad.features.has(f));
    const feats = [...PIPE.REQUIRED_FEATURES, ...PIPE.OPTIONAL_FEATURES].filter(f => ad.features.has(f));
    const dev = await ad.requestDevice({ requiredFeatures: feats });
    const shaders = PIPE.createShaderModules(dev, code);
    for (const name in shaders) {
      const info = await shaders[name].getCompilationInfo();
      out.modules[name] = info.messages.map(x => ({ type: x.type, line: x.lineNum, col: x.linePos, message: x.message }));
    }
    const layouts = PIPE.createLayouts(dev);
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    for (const p of PIPE.PIPELINES) {
      dev.pushErrorScope('validation');
      let threw = null;
      try { await dev.createRenderPipelineAsync(PIPE.pipelineDescriptor(dev, p, shaders, layouts, canvasFormat)); } catch (e) { threw = String(e.message || e); }
      const err = await dev.popErrorScope();
      out.pipelines.push({ name: `${p.name} (${p.module}: ${p.vs} + ${p.fs})`, error: threw || (err ? err.message : null) });
    }
    return out;
  }, code);
} finally {
  await browser.close();
}

if (result.fatal) { console.error('FATAL: ' + result.fatal); process.exit(2); }
console.log('adapter: ' + JSON.stringify(result.adapter) + (min ? '  [minified WGSL]' : ''));
let bad = 0;
if (result.missing.length) { bad++; console.log('MISSING required features: ' + result.missing.join(', ')); }
for (const [name, msgs] of Object.entries(result.modules)) {
  const errs = msgs.filter(m => m.type === 'error');
  bad += errs.length;
  console.log(`module ${name}: ${errs.length ? errs.length + ' error(s)' : 'compiles'}${msgs.length - errs.length ? ', ' + (msgs.length - errs.length) + ' warning(s)' : ''}`);
  for (const m of msgs) console.log(`  ${m.type} ${min ? `${name}:${m.line}` : locate(modules[name], m.line)}:${m.col}  ${m.message}`);
}
for (const p of result.pipelines) {
  if (p.error) bad++;
  console.log(`pipeline ${p.name}: ${p.error ? 'FAILED\n  ' + p.error.split('\n').join('\n  ') : 'ok'}`);
}
process.exit(bad ? 1 : 0);
