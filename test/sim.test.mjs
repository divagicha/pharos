import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystem, stepSystem, relToCamera, STAR } from '../src/js/sim.js';

const load = () => JSON.parse(readFileSync(new URL('../src/data/system.json', import.meta.url), 'utf8'));
const v = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('every body is built and each orbiting body stays between periapsis and apoapsis', () => {
  const S = buildSystem(load());
  assert.equal(S.n, 18);
  for (const t of [0, 3600, 86400 * 37.5, 86400 * 4000]) {
    stepSystem(S, t);
    for (let i = 0; i < S.n; i++) {
      if (!S.hasOrbit[i]) { assert.equal(len(v(S.pos, i)), 0, S.id[i] + ' should sit at its system origin'); continue; }
      const p = S.parent[i];
      const r = len(p >= 0 ? sub(v(S.pos, i), v(S.pos, p)) : v(S.pos, i));
      const lo = S.a[i] * (1 - S.e[i]), hi = S.a[i] * (1 + S.e[i]);
      assert.ok(r >= lo * (1 - 1e-9) && r <= hi * (1 + 1e-9), `${S.id[i]} r=${r} outside [${lo}, ${hi}]`);
    }
  }
});

test('motion is periodic and deterministic in t', () => {
  const S = buildSystem(load());
  const i = S.index.get('pelagia'), T = 2 * Math.PI / S.meanMotion[i];
  stepSystem(S, 12345); const a = v(S.pos, i);
  stepSystem(S, 12345 + T); const b = v(S.pos, i);
  stepSystem(S, 12345); const c = v(S.pos, i);
  assert.ok(len(sub(a, b)) < 1e-3, 'one period later the planet is back');
  assert.deepEqual(a, c);
});

test('dpos is the displacement since the previous step, and zero on the first', () => {
  const S = buildSystem(load());
  const i = S.index.get('luma');
  stepSystem(S, 0);
  assert.deepEqual(v(S.dpos, i), [0, 0, 0]);
  const before = v(S.pos, i);
  stepSystem(S, 500);
  assert.ok(len(sub(sub(v(S.pos, i), before), v(S.dpos, i))) < 1e-6);
  assert.ok(len(v(S.dpos, i)) > 1000, 'a moon carried by its planet moves thousands of km in 500 s');
});

test('rotation matrices are orthonormal and right-handed, with row 1 the spin axis', () => {
  const S = buildSystem(load());
  stepSystem(S, 777777);
  for (let i = 0; i < S.n; i++) {
    const X = [S.rot[i * 9], S.rot[i * 9 + 1], S.rot[i * 9 + 2]], Y = [S.rot[i * 9 + 3], S.rot[i * 9 + 4], S.rot[i * 9 + 5]], Z = [S.rot[i * 9 + 6], S.rot[i * 9 + 7], S.rot[i * 9 + 8]];
    for (const [a, b, want] of [[X, X, 1], [Y, Y, 1], [Z, Z, 1], [X, Y, 0], [Y, Z, 0], [X, Z, 0]]) assert.ok(Math.abs(dot(a, b) - want) < 1e-12, S.id[i]);
    const XxY = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
    assert.ok(len(sub(XxY, Z)) < 1e-12);
    assert.ok(len(sub(Y, v(S.axis, i))) < 1e-15);
  }
});

test('tidally locked moons keep local +X towards their planet', () => {
  const S = buildSystem(load());
  for (const t of [0, 86400 * 3.3, 86400 * 400]) {
    stepSystem(S, t);
    for (const id of ['luma', 'pyre', 'rime', 'slate', 'firn', 'neve']) {
      const i = S.index.get(id), p = S.parent[i];
      const toParent = sub(v(S.pos, p), v(S.pos, i));
      const c = dot([S.rot[i * 9], S.rot[i * 9 + 1], S.rot[i * 9 + 2]], toParent) / len(toParent);
      assert.ok(c > Math.cos(2 * S.e[i] + 0.01), `${id} faces away by ${Math.acos(c)} rad`);   // libration of about 2e
    }
  }
});

test('a regular moon orbits in its planet\'s equatorial plane; the captured one is retrograde', () => {
  const S = buildSystem(load());
  stepSystem(S, 5e6);
  const nivalis = S.index.get('nivalis'), firn = S.index.get('firn'), serac = S.index.get('serac');
  const axis = v(S.axis, nivalis);
  const r = sub(v(S.pos, firn), v(S.pos, nivalis));
  assert.ok(Math.abs(dot(r, axis)) / len(r) < Math.sin(0.5 * Math.PI / 180), 'Firn stays within its 0.2 degree inclination');
  const orbitNormal = i => { const P = v(S.P, i), Q = v(S.Q, i); return [P[1] * Q[2] - P[2] * Q[1], P[2] * Q[0] - P[0] * Q[2], P[0] * Q[1] - P[1] * Q[0]]; };
  assert.ok(dot(orbitNormal(firn), axis) > 0.99);
  assert.ok(dot(orbitNormal(serac), axis) < 0, 'inclination above 90 degrees means a backwards orbit');
});

test('the binary circles its barycentre, which stays at the system origin', () => {
  const S = buildSystem(load());
  const a = S.index.get('dioscuri-a'), b = S.index.get('dioscuri-b');
  for (const t of [0, 1e5, 7e5]) {
    stepSystem(S, t);
    const pa = v(S.pos, a), pb = v(S.pos, b);
    const bary = [0, 1, 2].map(k => pa[k] * S.mass[a] + pb[k] * S.mass[b]);
    assert.ok(len(bary) / (S.mass[a] + S.mass[b]) < 1e-3);
    assert.ok(Math.abs(len(sub(pa, pb)) - 0.085 * S.K.AU_km) < 1);
  }
});

test('planets are lit by their system\'s star; stars by nothing', () => {
  const S = buildSystem(load());
  for (let i = 0; i < S.n; i++) {
    if (S.kind[i] === STAR) assert.equal(S.star[i], -1);
    else assert.equal(S.id[S.star[i]], 'pharos');
  }
});

test('relToCamera has an exactly zero inter-system term inside the camera\'s own system', () => {
  const S = buildSystem(load());
  stepSystem(S, 0);
  const m = S.index.get('metronome'), sys = S.sys[m];
  const out = relToCamera(S, m, sys, new Float64Array([350, 0, 0]), new Float64Array(3));
  assert.deepEqual([...out], [-350, 0, 0]);       // 27 light-years from the host, yet exact to the last bit
  const far = relToCamera(S, m, 0, new Float64Array(3), new Float64Array(3));
  assert.ok(Math.abs(len(far) / S.K.LY_km - 27.24) < 0.01);
});

test('malformed data is rejected with a message naming the body', () => {
  const bad1 = load(); bad1.bodies.find(b => b.id === 'luma').parent = 'nowhere';
  assert.throws(() => buildSystem(bad1), /luma/);
  const bad2 = load(); const i = bad2.bodies.findIndex(b => b.id === 'luma'); bad2.bodies.unshift(bad2.bodies.splice(i, 1)[0]);
  assert.throws(() => buildSystem(bad2), /luma/);
  const bad3 = load(); bad3.bodies[1].kind = 'blob';
  assert.throws(() => buildSystem(bad3), /ignis/);
});
