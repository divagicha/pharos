#!/usr/bin/env node
// Report which WebGPU adapter Chrome hands out on this machine, for each power preference,
// plus the features and limits the renderer cares about. Console twin of tools/probe.html.
//
// Usage:  node tools/probe.mjs            (launch settings come from tools/chrome.mjs)
//         NO_FORCE=1 node tools/probe.mjs  show what Chrome picks without --force_high_performance_gpu
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { chromeArgs } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = chromeArgs().filter(a => !(process.env.NO_FORCE === '1' && a === '--force_high_performance_gpu'));
const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1', args });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(here, 'blank.html')).href);
  const out = await page.evaluate(async () => {
    const WANT = ['timestamp-query', 'dual-source-blending', 'rg11b10ufloat-renderable', 'float32-filterable', 'float32-blendable', 'depth-clip-control'];
    const res = { userAgent: navigator.userAgent, canvasFormat: navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : null, adapters: [] };
    if (!navigator.gpu) return res;
    for (const pref of [undefined, 'low-power', 'high-performance']) {
      const ad = await navigator.gpu.requestAdapter(pref ? { powerPreference: pref } : {});
      if (!ad) { res.adapters.push({ pref: pref || 'default', none: true }); continue; }
      const i = ad.info || {};
      res.adapters.push({
        pref: pref || 'default', vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
        fallback: i.isFallbackAdapter,
        features: Object.fromEntries(WANT.map(n => [n, ad.features.has(n)])),
        limits: {
          maxTextureDimension2D: ad.limits.maxTextureDimension2D,
          maxUniformBufferBindingSize: ad.limits.maxUniformBufferBindingSize,
          minUniformBufferOffsetAlignment: ad.limits.minUniformBufferOffsetAlignment,
          maxColorAttachmentBytesPerSample: ad.limits.maxColorAttachmentBytesPerSample,
        },
      });
    }
    return res;
  });
  console.log('chrome args: ' + args.join(' '));
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
