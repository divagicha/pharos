// The static parts of the HUD, built once at start-up for every body: the brief card and the full telemetry
// panels (internal structure column, atmosphere or composition bar, physical / orbital / stellar rows).
// Nothing here runs per frame, so strings, closures and array methods are fine.
//
// Contract
//   buildBody(desc, look, outer, widened, key, onHoverLayer) -> { root, layerRows, layerSegs }
//     desc      describe() result from telemetry.js
//     look      the body's entry in LOOKS (layer materials, accent colour)
//     outer     layer radii as drawn in the cutaway (so the column and the 3D section agree)
//     widened   true when a thin layer is drawn thicker than true scale (the panel then says so)
//     key       number key that warps to the body, or 0
//     onHoverLayer(k)  called with a layer index while the pointer is over its row, and with -1 when it leaves
//   layerRows[k] and layerSegs[k] are the row and the column segment of layer k (centre = 0), for highlighting.
import { swatch } from './looks.js';

const SVG = 'http://www.w3.org/2000/svg';
const COLUMN_REM = 24;                 // height of the core-sample column
const UNITS = 10;                      // SVG units per rem

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function svg(tag, attrs) {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

/** Append text to parent, turning the marks ^{..} and _{..} into <sup> and <sub>. */
export function rich(parent, text) {
  const re = /([\^_])\{([^}]*)\}/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    parent.append(el(m[1] === '^' ? 'sup' : 'sub', '', m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
  return parent;
}

function heading(title, aside) {
  const h = el('h3', '', title);
  if (aside) h.append(el('span', '', aside));
  return h;
}

/** Brief card: name, class, one line of description and the few figures worth knowing at a glance. */
function card(desc, key) {
  const c = el('div', 'cd');
  const nm = el('div', 'nm', desc.name);
  if (key) nm.append(el('i', '', `key ${key}`));
  c.append(nm, el('div', 'kd', desc.kind));
  if (desc.blurb) c.append(el('p', '', desc.blurb));
  const q = el('div', 'qk');
  for (const [label, value] of desc.quick) {
    const cell = el('div');
    cell.append(el('span', '', label), rich(el('b'), value));
    q.append(cell);
  }
  c.append(q);
  const hint = el('div', 'hint');
  hint.append(el('kbd', '', 'Tab'), ' composition, structure and full telemetry');
  c.append(hint);
  return c;
}

/**
 * Internal structure as a core sample: a column from the surface (top) to the centre (bottom), to scale by
 * radius, each layer joined by a leader line to its name, share of the body's mass, material and depth.
 */
function structure(desc, look, outer, widened, onHoverLayer, rows, segs) {
  const sec = el('section', 'pn st');
  sec.append(heading('Internal structure', 'share of mass'));
  const n = desc.layers.length, H = COLUMN_REM * UNITS, rowH = COLUMN_REM / n;
  const box = el('div', 'core');
  box.style.height = COLUMN_REM + 'rem';
  const art = svg('svg', { viewBox: `0 0 64 ${H}`, preserveAspectRatio: 'none', class: 'col' });
  for (let j = 0; j < n; j++) {                       // j counts down from the surface
    const k = n - 1 - j, lay = desc.layers[k];
    const top = (1 - outer[k]) * H, bottom = (1 - (k ? outer[k - 1] : 0)) * H, mid = (top + bottom) / 2;
    const rowMid = (j + 0.5) * rowH * UNITS;
    const seg = svg('rect', { x: 4, y: top.toFixed(2), width: 26, height: Math.max(bottom - top, 0.5).toFixed(2), fill: swatch(look.layers[k]) });
    art.append(seg, svg('path', { d: `M30 ${mid.toFixed(1)} H38 L52 ${rowMid.toFixed(1)} H64`, class: 'lead' }));
    const row = el('div', 'lay');
    row.style.top = j * rowH + 'rem';
    row.style.height = rowH + 'rem';
    const line = el('div', 'ln');
    const sw = el('i', 'sw');
    sw.style.background = swatch(look.layers[k]);
    line.append(sw, el('b', '', lay.name), el('em', '', lay.share));
    row.append(line, el('p', '', lay.material), rich(el('small'), lay.depth));
    row.addEventListener('pointerenter', () => onHoverLayer(k));
    row.addEventListener('pointerleave', () => onHoverLayer(-1));
    box.append(row);
    rows[k] = row; segs[k] = seg;
  }
  art.append(svg('rect', { x: 4, y: 0, width: 26, height: H, class: 'frame' }));
  box.prepend(art);
  sec.append(box);
  sec.append(el('p', 'nt', widened
    ? 'Column to scale by radius, surface at the top. Layers thinner than 1.2 % of the radius are drawn at 1.2 %, here and in the cutaway.'
    : 'Column to scale by radius, surface at the top.'));
  return sec;
}

const GAS_COLOURS = {
  'N_{2}': '#5b8def', 'O_{2}': '#58d6c0', Ar: '#b79cf0', 'H_{2}O': '#4fc3f7', 'CO_{2}': '#f2a65a', 'H_{2}': '#efe0ae', H: '#efe0ae',
  He: '#f0a35e', 'CH_{4}': '#7fd98a', 'NH_{3}': '#d98ad0', 'SO_{2}': '#f2d24f', 'S_{2}': '#e58a3c', CO: '#c2c8cf', trace: '#6f7c88',
};
const SPARE_COLOURS = ['#8fb4ff', '#f2c14f', '#7fd9c0', '#e58aa0', '#aeb8c4', '#c9a0ff'];

/** Atmosphere (by volume) or bulk composition (by mass): one stacked bar, a legend, pressure and temperature. */
function mixture(desc) {
  const mix = desc.mix, sec = el('section', 'pn mx');
  if (!mix) {
    sec.append(heading('Atmosphere'), el('p', 'nt', 'No appreciable atmosphere: the surface is open to space.'));
    return sec;
  }
  sec.append(heading(mix.title, mix.basis));
  const bar = el('div', 'bar'), legend = el('ul', 'lg');
  mix.parts.forEach(([label, pct], k) => {
    const colour = GAS_COLOURS[label] || SPARE_COLOURS[k % SPARE_COLOURS.length];
    const part = el('i');
    part.style.flexGrow = pct;
    part.style.background = colour;
    bar.append(part);
    const item = el('li'), sw = el('i', 'sw');
    sw.style.background = colour;
    item.append(sw, rich(el('span'), label), el('b', '', `${pct < 1 ? pct : pct.toFixed(1)} %`));
    legend.append(item);
  });
  sec.append(bar, legend);
  if (mix.pressure) {
    const kv = el('div', 'kv');
    kv.append(el('span', '', mix.pressure[0]), el('b', '', mix.pressure[1]));
    sec.append(kv);
    if (mix.pressure[2]) sec.append(el('p', 'nt', mix.pressure[2]));
  }
  if (mix.temp) sec.append(temperature(mix.temp));
  return sec;
}

function temperature(t) {
  const box = el('div', 'tk'), at = ((t.mean - t.min) / (t.max - t.min) * 100).toFixed(1) + '%';
  const kv = el('div', 'kv');
  kv.append(el('span', '', 'Temperature'), el('b', '', `${t.min} to ${t.max} K`));
  const rail = el('div', 'rail'), mark = el('i');
  mark.style.left = at;
  rail.append(mark);
  const scale = el('div', 'sc');
  const lo = el('span', '', `${t.min} K min`), mean = el('span', 'mean', `${t.mean} K mean`), hi = el('span', '', `${t.max} K max`);
  mean.style.left = at;
  scale.append(lo, mean, hi);
  box.append(kv, rail, scale);
  if (t.note) box.append(el('p', 'nt', t.note));
  return box;
}

function table(desc, isStar) {
  const sec = el('section', 'pn dt');
  sec.append(heading(isStar ? 'Stellar data' : 'Physical and orbital data'));
  const list = el('dl');
  for (const [label, value] of desc.rows) {
    const row = el('div');
    row.append(el('dt', '', label), rich(el('dd'), value));
    list.append(row);
  }
  sec.append(list);
  return sec;
}

export function buildBody(desc, look, outer, widened, key, onHoverLayer, isStar) {
  const root = el('div', 'bd');
  root.style.setProperty('--accent', look.accent);
  const layerRows = [], layerSegs = [];
  const left = el('div', 'pl'), head = el('header');
  head.append(el('div', 'nm', desc.name), el('div', 'kd', desc.kind));
  if (desc.blurb) head.append(el('p', '', desc.blurb));
  left.append(head, structure(desc, look, outer, widened, onHoverLayer, layerRows, layerSegs));
  const right = el('div', 'pr');
  right.append(mixture(desc), table(desc, isStar));
  root.append(card(desc, key), left, right);
  return { root, layerRows, layerSegs };
}
