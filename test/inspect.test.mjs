import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorRay, pickBody } from '../src/js/pick.js';
import { inspect, select, togglePanel, updateInspect } from '../src/js/inspect.js';

const cam = { fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], tanX: Math.tan(0.6), tanY: Math.tan(0.4) };
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };

/** A stand-in for Scene: bodies given as [x, y, z, radius], camera at the origin. */
function fakeScene(bodies, layers = [0.3, 0.7, 1]) {
  const n = bodies.length;
  const scene = {
    rel: new Float64Array(n * 3), dist: new Float64Array(n), cuts: new Map(),
    layOuter: bodies.map(() => Float64Array.from(layers)), layCount: new Uint8Array(n).fill(layers.length),
    setCut(i, rows, a, hover, air) { this.cuts.set(i, { rows: [...rows], a, hover, air }); },
  };
  bodies.forEach((b, i) => { scene.rel.set(b.slice(0, 3), i * 3); scene.dist[i] = Math.hypot(b[0], b[1], b[2]); });
  return { scene, S: { n, radius: Float64Array.from(bodies.map(b => b[3])) } };
}

test('cursorRay: the centre of the view is the forward axis; corners follow the field of view', () => {
  const r = cursorRay(cam, 800, 450, 1600, 900, [0, 0, 0]);
  assert.deepEqual(r.map(v => +v.toFixed(12)), [0, 0, -1]);
  const c = cursorRay(cam, 1600, 0, 1600, 900, [0, 0, 0]);       // top-right corner
  assert.ok(Math.abs(c[0] / -c[2] - cam.tanX) < 1e-12 && Math.abs(c[1] / -c[2] - cam.tanY) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...c) - 1) < 1e-12);
});

test('pickBody: a disc the ray enters wins, nearest first; otherwise the closest miss within tolerance', () => {
  const rpp = 0.0005;
  const { scene, S } = fakeScene([[0, 0, -1000, 100], [0, 0, -400, 10], [300, 0, -1000, 1], [0, 0, 500, 200]]);
  assert.equal(pickBody(scene, S, [0, 0, -1], rpp, 16), 1, 'the moon in front of the planet');
  assert.equal(pickBody(scene, S, unit([60, 0, -1000]), rpp, 16), 0, 'beside the moon: the planet');
  // 1.2 km to the side of a 1 km body 1044 km away: a miss of well under 16 px
  assert.equal(pickBody(scene, S, unit([302.2, 0, -1000]), rpp, 16), 2);
  assert.equal(pickBody(scene, S, unit([330, 0, -1000]), rpp, 16), -1, 'too far from the marker');
  assert.equal(pickBody(scene, S, [0, 0, 1], rpp, 16), 3, 'a body behind the first ray is in front of this one');
  assert.equal(pickBody(scene, S, unit([0, 1, 0.01]), rpp, 16), -1, 'empty sky');
});

function reset() { inspect.sel = -1; inspect.panel = false; inspect.body = -1; inspect.open = 0; inspect.hover = -1; inspect.hoverHud = -1; inspect.forced = -1; inspect.follow = false; }

test('the cutaway opens on the selected body, lifts the atmosphere first, and closes again', () => {
  reset();
  const { scene, S } = fakeScene([[0, 0, -30000, 6000]]);
  togglePanel(0);
  assert.equal(inspect.sel, 0); assert.equal(inspect.panel, true);
  updateInspect(0.35, scene, S, cam, 0, 0, null);
  const early = scene.cuts.get(0);
  assert.ok(early.a < 1 && early.a > 0.7, 'a ' + early.a);
  assert.ok(early.air < 1 && early.air > 0.7, 'the air has started to thin: ' + early.air);
  // the opening faces the camera, bar the small artistic turn: its diagonal is within 35 degrees of the view axis
  const diag = [0, 1, 2].map(k => (early.rows[k] + early.rows[3 + k] + early.rows[6 + k]) / Math.sqrt(3));
  assert.ok(diag[2] > Math.cos(35 * Math.PI / 180), 'diagonal ' + diag);
  for (let k = 0; k < 10; k++) updateInspect(0.2, scene, S, cam, 0, 0, null);
  assert.equal(inspect.open, 1);
  assert.equal(scene.cuts.get(0).a, 0); assert.equal(scene.cuts.get(0).air, 0.7, 'an open body keeps most of its air');
  togglePanel(0);
  assert.equal(inspect.panel, false);
  updateInspect(0.2, scene, S, cam, 0, 0, null);
  assert.ok(scene.cuts.get(0).a > 0 && inspect.body === 0, 'closing, not snapped shut');
  for (let k = 0; k < 10; k++) updateInspect(0.2, scene, S, cam, 0, 0, null);
  assert.equal(inspect.body, -1);
  assert.deepEqual(scene.cuts.get(0), { rows: [1, 0, 0, 0, 1, 0, 0, 0, 1], a: 1, hover: -1, air: 1 }, 'fully restored');
});

test('selecting another body closes the first at once; only one body is ever cut open', () => {
  reset();
  const { scene, S } = fakeScene([[0, 0, -30000, 6000], [9000, 0, -30000, 1000]]);
  togglePanel(0);
  inspect.forced = 1;
  updateInspect(0, scene, S, cam, 0, 0, null);
  assert.equal(scene.cuts.get(0).a, 0, 'forced: fully open at once');
  inspect.forced = -1;
  select(1);
  assert.equal(inspect.panel, false, 'a new selection starts with the panel closed');
  togglePanel(1);
  updateInspect(0.1, scene, S, cam, 0, 0, null);
  assert.equal(scene.cuts.get(0).a, 1, 'the first body is whole again');
  assert.equal(inspect.body, 1);
  assert.ok(scene.cuts.get(1).a < 1);
});

test('hover: the cursor ray names the exposed layer; a HUD row takes precedence; dragging turns the frame', () => {
  reset();
  const { scene, S } = fakeScene([[0, 0, -30000, 6000]]);
  togglePanel(0);
  inspect.forced = 1;
  updateInspect(0, scene, S, cam, 0, 0, null);
  const before = [...inspect.rows];
  // straight down the opening's diagonal: the core ball
  const diag = [0, 1, 2].map(k => -(before[k] + before[3 + k] + before[6 + k]));
  const centre = [0, 0, -30000];
  const target = centre.map((c, k) => c - diag[k] / Math.sqrt(3) * 6000 * 0.2);     // a point on the diagonal, inside the core
  updateInspect(0, scene, S, cam, 0, 0, unit(target));
  assert.equal(inspect.hover, 0, 'the core');
  assert.equal(scene.cuts.get(0).hover, 0);
  inspect.hoverHud = 2;
  updateInspect(0, scene, S, cam, 0, 0, unit(target));
  assert.equal(inspect.hover, 2, 'the row under the pointer wins');
  inspect.hoverHud = -1;
  updateInspect(0, scene, S, cam, 0, 0, unit([0, 1, 0]));
  assert.equal(inspect.hover, -1, 'a ray that misses');
  updateInspect(0, scene, S, cam, 50, 0, null);
  assert.ok(Math.abs(inspect.rows[0] - before[0]) > 0.01, 'the frame turned');
  const X = inspect.rows.subarray(0, 3), Y = inspect.rows.subarray(3, 6);
  assert.ok(Math.abs(X[0] * Y[0] + X[1] * Y[1] + X[2] * Y[2]) < 1e-12, 'and stayed orthogonal');
});

test('scripted use: the opening follows inspect.forced and, with follow, keeps facing a moving camera', () => {
  reset();
  const { scene, S } = fakeScene([[0, 0, -30000, 6000]]);
  togglePanel(0);
  inspect.forced = 0.5; inspect.follow = true;
  updateInspect(0.016, scene, S, cam, 0, 0, null);
  assert.equal(inspect.open, 0.5);
  assert.equal(scene.cuts.get(0).a, 0.5, 'smoothstep(0.5) is 0.5');
  const first = [...inspect.rows];
  scene.rel.set([30000, 0, 0]);                    // the camera has swung a quarter of the way round the body
  updateInspect(0.016, scene, S, cam, 0, 0, null);
  assert.ok(Math.abs(inspect.rows[0] - first[0]) > 0.1, 'the frame was re-aimed');
  inspect.forced = 0;
  updateInspect(0.016, scene, S, cam, 0, 0, null);
  assert.equal(scene.cuts.get(0).a, 1, 'forced shut');
});
