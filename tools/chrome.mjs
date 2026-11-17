// One place that knows how to launch Chrome for WebGPU work on this project.
//
// On a hybrid-graphics laptop Chrome hands WebGPU the integrated GPU whatever powerPreference says;
// --force_high_performance_gpu is the switch that selects the discrete one (verified with tools/probe.mjs).
// Env:  CHROME_PATH=...  use a specific Chrome binary instead of the installed "chrome" channel
//       SOFT_GPU=1       software adapter (no dual-source blending there, so the body module will not compile)
//       NO_FORCE=1       leave the adapter choice to Chrome (on a hybrid laptop: the integrated GPU)
//       HEADED=1         show the window
//       CHROME_ARGS=...  extra switches, space separated
import { chromium } from 'playwright';

export function chromeArgs() {
  const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  if (process.env.SOFT_GPU === '1') args.push('--no-sandbox', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader');
  else if (process.env.NO_FORCE !== '1') args.push('--force_high_performance_gpu');
  args.push('--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows');
  args.push(...(process.env.CHROME_ARGS || '').split(' ').filter(Boolean));
  return args;
}

export async function launchChrome(extraArgs = []) {
  const opts = { headless: process.env.HEADED !== '1', args: [...chromeArgs(), ...extraArgs] };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH; else opts.channel = 'chrome';
  return chromium.launch(opts);
}
