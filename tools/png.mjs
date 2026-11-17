// Minimal PNG reader for the capture tools: enough to measure screenshots (8-bit RGB / RGBA, non-interlaced,
// which is what Chrome writes). No dependencies.
//
//   node tools/png.mjs <file.png> [...]     print size, mean luminance and the largest pure-black block
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

/** @returns {{width: number, height: number, channels: number, data: Buffer}} rows top to bottom */
export function readPNG(file) {
  const b = readFileSync(file);
  let p = 8, width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; colorType = d[9]; interlace = d[12]; }
    else if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace) throw new Error(`${file}: unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat)), data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? data[dst + x - channels] : 0, up = y ? data[dst - stride + x] : 0, ul = (y && x >= channels) ? data[dst - stride + x - channels] : 0;
      let r;
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + up; else if (f === 3) r = v + ((a + up) >> 1);
      else { const q = a + up - ul, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - ul); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul); }
      data[dst + x] = r & 255;
    }
  }
  return { width, height, channels, data };
}

/** Mean of (r+g+b)/3 over the image, 0..255. */
export function meanLuma(im) {
  let s = 0;
  for (let i = 0; i < im.data.length; i += im.channels) s += im.data[i] + im.data[i + 1] + im.data[i + 2];
  return s / (im.width * im.height * 3);
}

/**
 * Size of the largest axis-aligned square made only of pure-black pixels, in pixels per side.
 * A lit scene never produces one; a NaN that reached the bloom chain does (it tone-maps to exact zero).
 */
export function largestBlackSquare(im) {
  const { width: w, height: h, channels: c, data } = im;
  let prev = new Uint16Array(w + 1), cur = new Uint16Array(w + 1), best = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * c;
      cur[x + 1] = (data[o] | data[o + 1] | data[o + 2]) === 0 ? Math.min(prev[x], prev[x + 1], cur[x]) + 1 : 0;
      if (cur[x + 1] > best) best = cur[x + 1];
    }
    const t = prev; prev = cur; cur = t;
  }
  return best;
}

/** Mean absolute difference per channel between two images of the same size, 0..255. */
export function meanAbsDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('images differ in size');
  let s = 0, n = 0;
  for (let i = 0, j = 0; i < a.data.length; i += a.channels, j += b.channels) {
    s += Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
    n += 3;
  }
  return s / n;
}

if (process.argv[1] && process.argv[1].endsWith('png.mjs')) {
  for (const f of process.argv.slice(2)) {
    const im = readPNG(f);
    console.log(`${f}: ${im.width}x${im.height}  mean ${meanLuma(im).toFixed(2)}  largest black square ${largestBlackSquare(im)} px`);
  }
}
