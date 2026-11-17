// The HUD: DOM over the canvas. Everything is built once in the constructor, for every body; frame() only
// flips classes, writes interned strings into existing text nodes and moves labels through preallocated
// Typed OM values, so it allocates nothing of ours.
//
// Contract
//   new Hud(root, S, data, looks, scene, onHoverLayer)   builds the whole HUD under `root`
//   frame(st, cam, dt)    per frame; `st` is the hudState object below, filled by the caller.
//                         Needs scene.computeRel() to be current (labels follow the bodies).
import { NumField, lengthUnit, speedUnit } from './hudnum.js';
import { buildBody, el } from './hudpanels.js';
import { describe } from './telemetry.js';
import { STAR } from './sim.js';
import { CURSOR, AUTO_C } from './mode.js';

export const NOTE_NONE = 0, NOTE_HELM = 1, NOTE_EDGE = 2, NOTE_RETURN = 3;
const NOTE_TEXT = ['', 'Click to take the helm', 'Edge of the charted volume', 'Beyond the charted volume \u00b7 autopilot returning to Pharos'];
const MODE_TEXT = ['Free flight', 'Cursor inspection', 'Autopilot', 'Autopilot', 'Returning'];
const TOUR_TEXT = 'Grand tour';

/** What the HUD shows this frame. One object, created here, filled by the composition root. */
export const hudState = {
  visible: true,
  mode: 0, tour: false, locked: false, help: false,
  speed: 0,            // km/s
  altitude: 0,         // km above the nearest surface
  nearest: -1,         // body that surface belongs to
  throttle: 1,         // scroll-wheel speed factor
  focus: -1,           // body whose brief card is shown
  panel: -1,           // body whose full panels are shown
  hover: -1,           // highlighted interior layer of the panel body
  target: -1,          // selected body: bracket, name and range
  range: 0,            // km to its centre
  eta: -1,             // seconds left in a warp, -1 when there is none
  note: NOTE_NONE,
  w: 1, h: 1,          // viewport in CSS pixels
  refresh: false,      // update the numbers now instead of at the readout rate (captures)
};

const READOUT_SECONDS = 0.085;        // numbers change about twelve times a second: readable, and cheap
const MOON_LABEL_KM = 2.5e7;          // moons are named only from within their planet's neighbourhood
const PLANET_LABEL_KM = 3e10;         // planets and the comet: from anywhere in their system (200 AU)
const POINT_PX = 2.5;                 // under this radius a body is a point and gets a marker ring
const BIG_FRACTION = 0.16;            // over this fraction of the view height a body needs no label
// Parts of the view a label must not enter, in rem from the nearest corner: [width, height] of the flight
// readouts (top left), the target readouts (top right), the card (bottom left) and each panel column.
const KEEP_FLIGHT = [33, 12], KEEP_TARGET = [29, 10.5], KEEP_CARD = [38, 17], KEEP_PANEL = 33;

const HELP = [['W A S D', 'move'], ['Mouse', 'look'], ['Q E', 'roll'], ['R F', 'rise, sink'], ['Shift', 'boost'], ['Wheel', 'speed'],
  ['1\u20139', 'warp to a body'], ['Space', 'cursor or flight'], ['Click', 'select'], ['Tab', 'inspect']];

export class Hud {
  constructor(root, S, data, looks, scene, onHoverLayer) {
    this.root = root; this.S = S; this.scene = scene;
    const n = S.n;
    this.typed = !!(root.attributeStyleMap && window.CSSTranslate);
    this.acc = 1; this.rem = 16;
    this.shown = true; this.cursor = false; this.modeText = ''; this.note = -1; this.help = false;
    this.focus = -1; this.panel = -1; this.hover = -1; this.target = -2; this.nearest = -2; this.etaOn = false;
    this.velUnit = ''; this.altUnit = ''; this.rngUnit = '';

    this.#buildReadouts();
    this.bodies = []; this.rows = []; this.segs = [];
    data.bodies.forEach((b, i) => {
      const built = buildBody(describe(data, i), looks[b.id], scene.layOuter[i], scene.layWidened[i] === 1, b.key || 0, onHoverLayer, S.kind[i] === STAR);
      root.append(built.root);
      this.bodies.push(built.root); this.rows.push(built.layerRows); this.segs.push(built.layerSegs);
    });
    this.#buildLabels(data, looks);
  }

  #readout(parent, label, cells) {
    const row = el('div', 'ro');
    const value = el('span', 'v'), unit = el('span', 'u');
    row.append(el('span', 'k', label), value, unit);
    parent.append(row);
    const text = document.createTextNode('');
    unit.append(text);
    return { row, field: new NumField(value, cells, document), unit: text };
  }

  #buildReadouts() {
    const root = this.root;
    const flt = el('div', 'flt');
    this.modeNode = document.createTextNode('');
    const md = el('div', 'md');
    md.append(this.modeNode);
    flt.append(md);
    this.vel = this.#readout(flt, 'Velocity', 9);
    this.alt = this.#readout(flt, 'Altitude', 9);
    this.nearNode = document.createTextNode('');
    const over = el('span', 'of');
    over.append(this.nearNode);
    this.alt.row.append(over);
    const small = el('div', 'ro sm');
    const thr = el('span', 'v');
    small.append(el('span', 'k', 'Throttle'), thr, el('span', 'x t', '\u00d7'), el('span', 'k', 'Sim time'), el('span', 'x', '100\u00d7'));
    this.thr = new NumField(thr, 5, document);
    flt.append(small);

    const tg = el('div', 'tg');
    this.tgEl = tg;
    this.tgNode = document.createTextNode('');
    const name = el('div', 'nm');
    name.append(this.tgNode);
    tg.append(el('div', 'k', 'Target'), name);
    this.rng = this.#readout(tg, 'Range', 9);
    this.eta = this.#readout(tg, 'Arrival in', 5);
    this.eta.unit.data = 's';
    this.eta.row.classList.add('eta');

    this.noteNode = document.createTextNode('');
    this.noteEl = el('div', 'note');
    this.noteEl.append(this.noteNode);
    this.helpEl = el('div', 'help');
    for (const [key, what] of HELP) { const item = el('span'); item.append(el('kbd', '', key), what); this.helpEl.append(item); }
    this.bracket = el('div', 'br');
    for (let k = 0; k < 4; k++) this.bracket.append(el('i'));
    root.append(flt, tg, this.noteEl, this.helpEl, el('div', 'ret'), this.bracket);
    this.brOn = false;
    if (this.typed) {
      this.brX = CSS.px(0); this.brY = CSS.px(0); this.brS = CSS.px(0);
      this.brT = new CSSTransformValue([new CSSTranslate(this.brX, this.brY)]);
    }
  }

  #buildLabels(data, looks) {
    const S = this.S, n = S.n;
    this.labels = []; this.vis = new Uint8Array(n); this.pt = new Uint8Array(n); this.selLabel = -1;
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.sr = new Float32Array(n);
    this.px = new Float32Array(n).fill(-1e9); this.py = new Float32Array(n).fill(-1e9);
    this.want = new Uint8Array(n); this.front = new Uint8Array(n);
    this.tx = []; this.ty = []; this.tv = [];
    this.moonOf = new Int16Array(n).fill(-1); this.twin = new Int16Array(n).fill(-1);
    const layer = el('div', 'lbs');
    for (let i = 0; i < n; i++) {
      const p = S.parent[i];
      if (p >= 0 && S.kind[p] !== STAR) this.moonOf[i] = p;
      if (S.kind[i] === STAR) { for (let j = 0; j < i; j++) { if (S.kind[j] === STAR && S.sys[j] === S.sys[i]) { this.twin[i] = j; break; } } }
      const lb = el('div', 'lb'), text = el('span', '', S.name[i]);
      lb.style.setProperty('--accent', looks[S.id[i]].accent);
      if (data.bodies[i].key) text.append(el('b', '', String(data.bodies[i].key)));
      lb.append(el('i'), text);
      layer.append(lb);
      this.labels.push(lb);
      if (this.typed) {
        const x = CSS.px(0), y = CSS.px(0);
        this.tx.push(x); this.ty.push(y); this.tv.push(new CSSTransformValue([new CSSTranslate(x, y)]));
      }
    }
    this.root.append(layer);
  }

  frame(st, cam, dt) {
    if (st.visible !== this.shown) { this.shown = st.visible; this.root.classList.toggle('off', !st.visible); }
    if (!st.visible) return;
    this.#modes(st);
    this.acc += dt;
    if (this.acc >= READOUT_SECONDS || st.refresh) { this.acc = 0; this.#numbers(st); }
    this.#bodies(st);
    this.#project(st, cam);
    this.#labels(st);
    this.#bracket(st);
  }

  #modes(st) {
    const cursor = st.mode === CURSOR || st.mode === AUTO_C;
    if (cursor !== this.cursor) { this.cursor = cursor; this.root.classList.toggle('cursor', cursor); }
    const text = st.tour ? TOUR_TEXT : MODE_TEXT[st.mode];
    if (text !== this.modeText) { this.modeText = text; this.modeNode.data = text; }
    if (st.note !== this.note) {
      this.note = st.note;
      if (st.note !== NOTE_NONE) this.noteNode.data = NOTE_TEXT[st.note];
      this.noteEl.classList.toggle('on', st.note !== NOTE_NONE);
    }
    if (st.help !== this.help) { this.help = st.help; this.helpEl.classList.toggle('on', st.help); }
  }

  #numbers(st) {
    let u = speedUnit(st.speed);
    this.vel.field.set(u.value, u.decimals, true);
    if (u.label !== this.velUnit) { this.velUnit = u.label; this.vel.unit.data = u.label; }
    u = lengthUnit(st.altitude);
    this.alt.field.set(u.value, u.decimals, true);
    if (u.label !== this.altUnit) { this.altUnit = u.label; this.alt.unit.data = u.label; }
    if (st.nearest !== this.nearest) { this.nearest = st.nearest; this.nearNode.data = st.nearest >= 0 ? this.S.name[st.nearest] : ''; }
    this.thr.set(st.throttle, 2, false);

    if (st.target !== this.target) {
      this.target = st.target;
      this.tgEl.classList.toggle('on', st.target >= 0);
      if (st.target >= 0) this.tgNode.data = this.S.name[st.target];
    }
    if (st.target < 0) return;
    u = lengthUnit(st.range);
    this.rng.field.set(u.value, u.decimals, true);
    if (u.label !== this.rngUnit) { this.rngUnit = u.label; this.rng.unit.data = u.label; }
    const etaOn = st.eta >= 0;
    if (etaOn !== this.etaOn) { this.etaOn = etaOn; this.eta.row.classList.toggle('on', etaOn); }
    if (etaOn) this.eta.field.set(st.eta, 1, false);
  }

  /** Show the card of the focus body, or the full panels of the panel body, and the highlighted layer. */
  #bodies(st) {
    if (st.focus !== this.focus) {
      if (this.focus >= 0) this.bodies[this.focus].classList.remove('on');
      if (st.focus >= 0) this.bodies[st.focus].classList.add('on');
      this.focus = st.focus;
    }
    if (st.panel !== this.panel || st.hover !== this.hover) {
      this.#highlight(this.panel, this.hover, false);
      if (st.panel !== this.panel) {
        if (this.panel >= 0) this.bodies[this.panel].classList.remove('full');
        if (st.panel >= 0) this.bodies[st.panel].classList.add('full');
        this.root.classList.toggle('inspecting', st.panel >= 0);
        this.panel = st.panel;
      }
      this.hover = st.hover;
      this.#highlight(this.panel, this.hover, true);
    }
  }

  #highlight(body, layer, on) {
    if (body < 0 || layer < 0 || layer >= this.rows[body].length) return;
    this.rows[body][layer].classList.toggle('hot', on);
    this.segs[body][layer].classList.toggle('hot', on);
    this.bodies[body].classList.toggle('picking', on);
  }

  /** Screen position and radius of every body that may carry a label. */
  #project(st, cam) {
    const S = this.S, rel = this.scene.rel, dist = this.scene.dist, w = st.w, h = st.h;
    const kx = 0.5 * w / cam.tanX, ky = 0.5 * h / cam.tanY, want = this.want;
    this.rem = Math.min(Math.max(h / 90, 11), 26);                 // the stylesheet's rem: 1/90 of the view height, clamped
    for (let i = 0; i < S.n; i++) {
      const p = i * 3;
      const z = rel[p] * cam.fwd[0] + rel[p + 1] * cam.fwd[1] + rel[p + 2] * cam.fwd[2];
      want[i] = 0;
      this.front[i] = z > 0 ? 1 : 0;
      if (z <= 0) continue;
      const inv = 1 / z;
      this.sx[i] = 0.5 * w + (rel[p] * cam.right[0] + rel[p + 1] * cam.right[1] + rel[p + 2] * cam.right[2]) * inv * kx;
      this.sy[i] = 0.5 * h - (rel[p] * cam.up[0] + rel[p + 1] * cam.up[1] + rel[p + 2] * cam.up[2]) * inv * ky;
      this.sr[i] = S.radius[i] * inv * ky;
      const reach = S.kind[i] === STAR ? Infinity : this.moonOf[i] >= 0 ? MOON_LABEL_KM : PLANET_LABEL_KM;
      if (dist[i] < reach && this.sr[i] < BIG_FRACTION * h && this.#clear(this.sx[i], this.sy[i], st)) want[i] = 1;
    }
    // a moon lost against its planet, the second star of a close pair, anything behind the nearest body: no label
    const near = st.nearest;
    if (near >= 0 && near === st.focus) want[near] = 0;
    for (let i = 0; i < S.n; i++) {
      if (!want[i]) continue;
      const m = this.moonOf[i] >= 0 ? this.moonOf[i] : this.twin[i];
      if (m >= 0 && this.#within(i, m, this.sr[m] + 34)) { want[i] = 0; continue; }
      if (near >= 0 && near !== i && dist[i] > dist[near] && this.#within(i, near, this.sr[near])) want[i] = 0;
    }
  }

  /** True when a label at (x, y) would be inside the view and clear of the HUD's fixed blocks. */
  #clear(x, y, st) {
    const w = st.w, h = st.h, rem = this.rem;
    if (x < 0 || x > w - 6 * rem || y < 1.5 * rem || y > h) return false;
    if (y < KEEP_FLIGHT[1] * rem && x < KEEP_FLIGHT[0] * rem) return false;
    if (st.target >= 0 && y < KEEP_TARGET[1] * rem && x > w - KEEP_TARGET[0] * rem) return false;
    if (st.panel >= 0) return x > KEEP_PANEL * rem && x < w - KEEP_PANEL * rem;
    return !(st.focus >= 0 && y > h - KEEP_CARD[1] * rem && x < KEEP_CARD[0] * rem);
  }

  #within(i, j, px) {
    const dx = this.sx[i] - this.sx[j], dy = this.sy[i] - this.sy[j];
    return dx * dx + dy * dy < px * px;
  }

  #labels(st) {
    const labels = this.labels, vis = this.vis, pt = this.pt;
    for (let i = 0; i < labels.length; i++) {
      const on = this.want[i];
      if (on !== vis[i]) { vis[i] = on; labels[i].classList.toggle('on', on === 1); }
      if (!on) continue;
      const r = this.sr[i], point = r < POINT_PX ? 1 : 0;
      if (point !== pt[i]) { pt[i] = point; labels[i].classList.toggle('pt', point === 1); }
      const off = point ? 0 : r * 0.72;
      this.#move(i, this.sx[i] + off, this.sy[i] - off);
    }
    if (st.target !== this.selLabel) {
      if (this.selLabel >= 0) labels[this.selLabel].classList.remove('sel');
      if (st.target >= 0) labels[st.target].classList.add('sel');
      this.selLabel = st.target;
    }
  }

  #move(i, x, y) {
    if (Math.abs(x - this.px[i]) < 0.05 && Math.abs(y - this.py[i]) < 0.05) return;
    this.px[i] = x; this.py[i] = y;
    if (this.typed) {
      this.tx[i].value = x; this.ty[i].value = y;
      this.labels[i].attributeStyleMap.set('transform', this.tv[i]);
    } else {
      this.labels[i].style.transform = `translate(${x}px,${y}px)`;      // browsers without Typed OM: one string per move
    }
  }

  /** Corner brackets around the selected body while it is small enough to need pointing out. */
  #bracket(st) {
    const t = st.target;
    const on = t >= 0 && this.typed && this.front[t] === 1 && this.sr[t] < 0.08 * st.h
      && this.sx[t] > -50 && this.sx[t] < st.w + 50 && this.sy[t] > -50 && this.sy[t] < st.h + 50;
    if (on !== this.brOn) { this.brOn = on; this.bracket.classList.toggle('on', on); }
    if (!on) return;
    const half = Math.max(this.sr[t] + 12, 20);
    this.brX.value = this.sx[t] - half; this.brY.value = this.sy[t] - half; this.brS.value = half * 2;
    this.bracket.attributeStyleMap.set('transform', this.brT);
    this.bracket.attributeStyleMap.set('width', this.brS);
    this.bracket.attributeStyleMap.set('height', this.brS);
  }
}
