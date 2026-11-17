import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInto, bufToString, NumField, lengthUnit, speedUnit } from '../src/js/hudnum.js';
import { cutFrame, rotateFrame, traceCut, layerAt, layerUnderRay, displayRadii, MIN_LAYER, HOLE, SURFACE, FACE, CORE } from '../src/js/cutaway.js';

const fmt = (cells, v, d, g) => bufToString(formatInto(new Uint16Array(cells), v, d, g));
const TS = '\u2009';

test('formatInto right-aligns, rounds and pads', () => {
  assert.equal(fmt(6, 0, 0, false), '     0');
  assert.equal(fmt(6, 42.4, 0, false), '    42');
  assert.equal(fmt(6, 42.5, 1, false), '  42.5');
  assert.equal(fmt(7, 3.14159, 3, false), '  3.142');
  assert.equal(fmt(6, -7.25, 1, false), '  -7.3');
  assert.equal(fmt(5, 0.004, 2, false), ' 0.00');
  assert.equal(fmt(5, 9.996, 2, false), '10.00', 'rounding carries into the integer part');
});

test('formatInto groups thousands with a thin space', () => {
  assert.equal(fmt(9, 384400, 0, true), `  384${TS}400`);
  assert.equal(fmt(11, 1234567.8, 1, true), `1${TS}234${TS}567.8`);
  assert.equal(fmt(5, 999, 0, true), '  999');
});

test('a value that does not fit, or is not a number, shows dashes instead of a wrong figure', () => {
  for (const s of [fmt(4, 123456, 0, false), fmt(4, NaN, 1, false), fmt(6, Infinity, 0, true), fmt(3, -1234, 0, false)]) {
    assert.ok([...s].every(ch => ch === '\u2013'), JSON.stringify(s));
  }
});

test('NumField touches only the cells that changed', () => {
  const writes = [];
  const doc = {
    createElement: () => ({ appendChild() {}, classList: { toggle() {} } }),
    createTextNode: () => { const node = { _d: ' ' }; Object.defineProperty(node, 'data', { get() { return this._d; }, set(v) { this._d = v; writes.push(v); } }); return node; },
  };
  const f = new NumField({ appendChild() {} }, 6, doc);
  f.set(1234, 0, false);
  assert.equal(f.nodes.map(n => n.data).join(''), '  1234');
  writes.length = 0;
  f.set(1235, 0, false);
  assert.deepEqual(writes, ['5'], 'one digit changed, one node written');
  f.set(1235, 0, false);
  assert.deepEqual(writes, ['5'], 'no change, no write');
});

test('NumField gives the decimal point and the thousands gap a narrow cell, and takes it back', () => {
  const doc = {
    createElement: () => { const span = { appendChild() {}, narrow: false, className: '' }; span.classList = { toggle(name, on) { assert.equal(name, 'n'); span.narrow = on; } }; return span; },
    createTextNode: () => ({ data: ' ' }),
  };
  const f = new NumField({ appendChild() {} }, 9, doc);
  const shape = () => f.spans.map(s => s.narrow ? 'n' : '-').join('');
  f.set(12345.5, 1, true);
  assert.equal(f.nodes.map(n => n.data).join(''), ` 12${TS}345.5`);
  assert.equal(shape(), '---n---n-');
  f.set(999, 0, true);
  assert.equal(f.nodes.map(n => n.data).join(''), '      999');
  assert.equal(shape(), '---------', 'cells that held a gap or a point are full width again');
  f.set(1234.5, 1, false);
  assert.equal(shape(), '-------n-');
});

test('units scale with magnitude and reuse interned labels', () => {
  assert.equal(lengthUnit(412.34).label, 'km'); assert.equal(lengthUnit(412.34).decimals, 1);
  assert.equal(lengthUnit(384400).decimals, 0);
  assert.equal(lengthUnit(1.6e8).label, 'AU'); assert.ok(Math.abs(lengthUnit(149597870.7).value - 1) < 1e-12);
  assert.equal(lengthUnit(3.7e13).label, 'ly');
  assert.equal(speedUnit(7.8).label, 'km/s');
  assert.equal(speedUnit(3e6).label, 'c'); assert.ok(Math.abs(speedUnit(299792.458 * 20).value - 20) < 1e-9);
  assert.equal(speedUnit(9.46e12).label, 'ly/s');
});

// ---------------------------------------------------------------- cutaway ----
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const row = (m, k) => [m[k * 3], m[k * 3 + 1], m[k * 3 + 2]];
const unitv = v => { const l = Math.hypot(...v); return v.map(x => x / l); };

test('cutFrame is a right-handed rotation whose removed octant opens towards the camera', () => {
  for (const [toCam, up] of [[[0, 0, 1], [0, 1, 0]], [unitv([1, 2, -3]), [0, 1, 0]], [[0, 1, 0], [0, 1, 0]], [unitv([-4, 0.2, 1]), unitv([0.3, 1, 0.1])]]) {
    const m = cutFrame(new Float64Array(9), toCam, up);
    const X = row(m, 0), Y = row(m, 1), Z = row(m, 2);
    for (const [a, b, want] of [[X, X, 1], [Y, Y, 1], [Z, Z, 1], [X, Y, 0], [Y, Z, 0], [X, Z, 0]]) assert.ok(Math.abs(dot(a, b) - want) < 1e-12);
    const det = dot(X, [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]]);
    assert.ok(Math.abs(det - 1) < 1e-12, 'determinant ' + det);
    // the camera direction, expressed in the cut frame, is the octant's diagonal
    const c = [dot(X, toCam), dot(Y, toCam), dot(Z, toCam)];
    for (const v of c) assert.ok(Math.abs(v - 1 / Math.sqrt(3)) < 1e-12);
  }
});

test('rotateFrame keeps the frame orthonormal and turns it by the angle asked', () => {
  const m = cutFrame(new Float64Array(9), [0, 0, 1], [0, 1, 0]);
  const before = row(m, 0);
  rotateFrame(m, 0, 1, 0, 0.7);
  const after = row(m, 0);
  assert.ok(Math.abs(dot(row(m, 0), row(m, 1))) < 1e-12 && Math.abs(dot(row(m, 0), row(m, 0)) - 1) < 1e-12);
  // the component of the row perpendicular to the axis turned by 0.7 rad
  const perp = v => [v[0], 0, v[2]];
  const cosang = dot(perp(before), perp(after)) / (Math.hypot(...perp(before)) * Math.hypot(...perp(after)));
  assert.ok(Math.abs(Math.acos(cosang) - 0.7) < 1e-9);
});

test('traceCut: closed body is all surface; an open one shows faces, the core ball and the hole', () => {
  const hit = new Float64Array(2), d = 1 / Math.sqrt(3);
  const enter = (ox, oy) => {               // ray along -(1,1,1) through a point offset from the diagonal
    const o = [d * 3 + ox, d * 3 + oy, d * 3 - ox - oy], rc = [-d, -d, -d];
    const b = dot(o, rc), q = o.map((v, k) => v - b * rc[k]), h = 1 - dot(q, q);
    return h > 0 ? { pc: q.map((v, k) => v - rc[k] * Math.sqrt(h)), rc } : null;
  };
  const centre = enter(0, 0);
  assert.equal(traceCut(centre.pc, centre.rc, 1, 0.2, hit), SURFACE, 'a = 1: nothing is cut away');
  assert.equal(traceCut(centre.pc, centre.rc, 0, 0.2, hit), CORE, 'looking straight into the opening meets the core ball');
  assert.ok(Math.abs(hit[0] - (1 - 0.2)) < 1e-9, 'at one radius minus the core radius along the ray');
  const side = enter(0.25, -0.1);
  assert.equal(traceCut(side.pc, side.rc, 0, 0.05, hit), FACE);
  assert.ok(hit[1] >= 0 && hit[1] <= 2 && hit[0] > 0);
  // a ray grazing through the corner of the octant near the surface leaves without touching anything
  const pc = [0.62, 0.62, 0.47], rc = unitv([1, -1, 0.02]);
  assert.equal(traceCut(pc, rc, 0.4, 0.05, hit), HOLE);
});

test('layerAt and layerUnderRay agree with the layer radii', () => {
  const outer = [0.2, 0.55, 0.99, 1], n = 4;
  assert.equal(layerAt(0.1, outer, n), 0); assert.equal(layerAt(0.3, outer, n), 1);
  assert.equal(layerAt(0.9, outer, n), 2); assert.equal(layerAt(0.995, outer, n), 3);
  const toCam = unitv([0.3, 0.2, 1]), rows = cutFrame(new Float64Array(9), toCam, [0, 1, 0]);
  const R = 6000, center = toCam.map(v => -v * 20000), rd = toCam.map(v => -v);
  assert.equal(layerUnderRay(center, R, rd, rows, 1, outer, n), -1, 'closed: nothing is exposed');
  assert.equal(layerUnderRay(center, R, rd, rows, 0, outer, n), 0, 'open, dead centre: the core');
  assert.equal(layerUnderRay(center, R, unitv([1, 0, 0]), rows, 0, outer, n), -1, 'a ray that misses the body');
  // sweep across the opening: every hit names a real layer, and at least the core, a middle layer and the crust appear
  const seen = new Set();
  const right = unitv([toCam[2], 0, -toCam[0]]);
  for (let k = -60; k <= 60; k++) {
    const dir = unitv(rd.map((v, j) => v + right[j] * k * 0.005));
    const l = layerUnderRay(center, R, dir, rows, 0, outer, n);
    assert.ok(l >= -1 && l < n);
    seen.add(l);
  }
  assert.ok(seen.has(0) && seen.has(1) && seen.has(2) && seen.has(-1), [...seen].join(','));
});

test('displayRadii keeps true radii and widens only layers thinner than the minimum', () => {
  const out = new Float64Array(5);
  assert.equal(displayRadii([0.55, 0.97, 1], 3, MIN_LAYER, out), false);
  assert.deepEqual([...out.subarray(0, 3)], [0.55, 0.97, 1]);
  // a crust of 0.6 % of the radius is drawn at the minimum; the boundary below it is untouched
  assert.equal(displayRadii([0.19, 0.545, 0.994, 1], 4, MIN_LAYER, out), true);
  assert.deepEqual([...out.subarray(0, 4)].map(v => +v.toFixed(6)), [0.19, 0.545, 0.988, 1]);
  // two thin layers stacked: both get the minimum
  assert.equal(displayRadii([0.5, 0.995, 0.999, 1], 4, MIN_LAYER, out), true);
  assert.ok(Math.abs(out[2] - 0.988) < 1e-12 && Math.abs(out[1] - 0.976) < 1e-12 && out[0] === 0.5);
  // a tiny core is widened from the inside
  displayRadii([0.001, 0.5, 1], 3, MIN_LAYER, out);
  assert.ok(Math.abs(out[0] - MIN_LAYER) < 1e-12);
  for (let k = 1; k < 3; k++) assert.ok(out[k] - out[k - 1] >= MIN_LAYER - 1e-12);
});
