#!/usr/bin/env node
// Build the single self-contained dist/index.html.
//   - WGSL modules are concatenated per tools/modules.json (same loader as the checker) and minified.
//   - src/js/main.js is bundled with esbuild; shaders arrive through the virtual module "virtual:shaders".
//   - CSS and JS are inlined into src/index.html. No external requests of any kind.
//
// Usage:  node tools/build.mjs          minified build, prints the size
//         node tools/build.mjs --dev    unminified, readable shader line numbers
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { loadModules, minifyWGSL } from './wgsl.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');

const shaderPlugin = {
  name: 'pharos-shaders',
  setup(build) {
    build.onResolve({ filter: /^virtual:shaders$/ }, () => ({ path: 'shaders', namespace: 'pharos' }));
    build.onLoad({ filter: /.*/, namespace: 'pharos' }, () => {
      const mods = loadModules(root);
      const body = Object.entries(mods)
        .map(([name, m]) => `export const ${name} = ${JSON.stringify(dev ? m.code : minifyWGSL(m.code))};`)
        .join('\n');
      return { contents: body, loader: 'js' };
    });
  },
};

// The data file carries notes for humans; the page only needs the numbers and labels.
const dataPlugin = {
  name: 'pharos-data',
  setup(build) {
    build.onLoad({ filter: /system\.json$/ }, args => {
      const data = JSON.parse(readFileSync(args.path, 'utf8'));
      delete data.note;
      return { contents: JSON.stringify(data), loader: 'json' };
    });
  },
};

const js = await esbuild.build({
  entryPoints: [path.join(root, 'src/js/main.js')],
  bundle: true, write: false, format: 'iife', target: 'chrome130',
  minify: !dev, legalComments: 'none', charset: 'utf8',
  define: { DEV: String(dev) },
  plugins: [shaderPlugin, dataPlugin],
  logLevel: 'warning',
});
const css = await esbuild.transform(readFileSync(path.join(root, 'src/style.css'), 'utf8'), { loader: 'css', minify: !dev });

const code = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let html = readFileSync(path.join(root, 'src/index.html'), 'utf8');
if (!html.includes('/*CSS*/') || !html.includes('/*JS*/')) throw new Error('src/index.html must contain /*CSS*/ and /*JS*/ placeholders');
if (!dev) html = html.replace(/>\s+</g, '><').replace(/\n\s*/g, '');
html = html.replace('/*CSS*/', () => css.code.trim()).replace('/*JS*/', () => code.trim());

mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'index.html');
writeFileSync(out, html);
const bytes = Buffer.byteLength(html);
console.log(`dist/index.html  ${dev ? '(dev, unminified) ' : ''}${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB), gzip ${gzipSync(html).length} bytes`);
