#!/usr/bin/env node
// Temporal stability of the 1/60 s triplets captured by tools/capture.mjs (renders/trip-TTT.T-crop-a|b|c.png).
//
// For each triplet this counts "flicker" pixels: ones whose middle frame differs from both neighbours by more
// than FLICK grey levels while the neighbours agree with each other to within CALM. Motion moves a pixel
// steadily one way, so it does not count; sparkle, crawling edges and popping do. It also prints the mean
// change per frame, which is simply how fast the picture is moving.
//
// Usage:  node tools/flicker.mjs [renders]
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { readPNG } from './png.mjs';

const dir = path.resolve(process.argv[2] || 'renders');
const FLICK = 24, CALM = 8;
const stems = [...new Set(readdirSync(dir).filter(f => /^trip-.*-crop-a\.png$/.test(f)).map(f => f.replace(/-crop-a\.png$/, '')))].sort();
if (!stems.length) { console.error('no triplet crops in ' + dir); process.exit(2); }
let worst = 0;
console.log('triplet        mean change/frame   flicker pixels   worst 16x16 block');
for (const stem of stems) {
  const [a, b, c] = ['a', 'b', 'c'].map(k => readPNG(path.join(dir, `${stem}-crop-${k}.png`)));
  const n = a.width * a.height, ch = a.channels, bw = Math.ceil(a.width / 16), blocks = new Uint16Array(bw * Math.ceil(a.height / 16));
  let change = 0, flick = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const la = a.data[o] + a.data[o + 1] + a.data[o + 2], lb = b.data[o] + b.data[o + 1] + b.data[o + 2], lc = c.data[o] + c.data[o + 1] + c.data[o + 2];
    change += Math.abs(lb - la) + Math.abs(lc - lb);
    if (Math.abs(la - lc) < CALM * 3 && Math.abs(lb - la) > FLICK * 3 && Math.abs(lb - lc) > FLICK * 3) {
      flick++;
      blocks[((i / a.width | 0) >> 4) * bw + ((i % a.width) >> 4)]++;
    }
  }
  const block = Math.max(...blocks), pct = flick / n * 100;
  worst = Math.max(worst, pct);
  console.log(`${stem.padEnd(14)} ${(change / (n * 6)).toFixed(2).padStart(10)} levels ${String(flick).padStart(9)} (${pct.toFixed(3)} %) ${String(block).padStart(8)} of 256`);
}
console.log(`\nworst triplet: ${worst.toFixed(3)} % of pixels flicker`);
