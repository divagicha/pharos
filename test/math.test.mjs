import test from 'node:test';
import assert from 'node:assert/strict';
import { quatLook, quatRotate, quatMul, quatAxisAngle, quatSlerp, norm3, cross3, rng } from '../src/js/math.js';

const close = (a, b, eps = 1e-12) => a.every((x, i) => Math.abs(x - b[i]) < eps);

test('quatLook: -Z maps to forward, +Y to an up vector in the plane of the hint, +X = forward x up', () => {
  const r = rng(7);
  for (let k = 0; k < 200; k++) {
    const f = norm3([0, 0, 0], [r() - 0.5, r() - 0.5, r() - 0.5]);
    const hint = norm3([0, 0, 0], [r() - 0.5, r() - 0.5, r() - 0.5]);
    const q = quatLook(new Float64Array(4), f, hint);
    const fwd = quatRotate([0, 0, 0], q, 0, 0, -1), up = quatRotate([0, 0, 0], q, 0, 1, 0), right = quatRotate([0, 0, 0], q, 1, 0, 0);
    assert.ok(close(fwd, f, 1e-9));
    assert.ok(up[0] * hint[0] + up[1] * hint[1] + up[2] * hint[2] > -1e-9, 'up leans towards the hint');
    assert.ok(close(right, cross3([0, 0, 0], f, up), 1e-9), 'right-handed camera frame');
  }
});

test('quatLook survives a forward vector parallel to the up hint', () => {
  for (const f of [[0, 1, 0], [0, -1, 0], [1, 0, 0]]) {
    const q = quatLook(new Float64Array(4), f, f);
    assert.ok(close(quatRotate([0, 0, 0], q, 0, 0, -1), f, 1e-9));
    assert.ok(q.every(Number.isFinite));
  }
});

test('quatMul composes rotations right to left', () => {
  const a = quatAxisAngle(new Float64Array(4), 0, 1, 0, Math.PI / 2);   // +Z -> +X
  const b = quatAxisAngle(new Float64Array(4), 1, 0, 0, Math.PI / 2);   // +Y -> +Z
  const ab = quatMul(new Float64Array(4), a, b);                        // b first, then a: +Y -> +Z -> +X
  assert.ok(close(quatRotate([0, 0, 0], ab, 0, 1, 0), [1, 0, 0]));
});

test('quatSlerp hits both endpoints and takes the short way round', () => {
  const a = quatAxisAngle(new Float64Array(4), 0, 1, 0, 0.2), b = quatAxisAngle(new Float64Array(4), 0, 1, 0, 1.0);
  const nb = b.map(x => -x);                                             // same rotation, opposite sign
  assert.ok(close([...quatSlerp(new Float64Array(4), a, b, 0)], [...a]));
  assert.ok(close([...quatSlerp(new Float64Array(4), a, b, 1)], [...b]));
  const mid = quatSlerp(new Float64Array(4), a, nb, 0.5), want = quatAxisAngle(new Float64Array(4), 0, 1, 0, 0.6);
  assert.ok(close([...mid], [...want], 1e-9) || close([...mid], [...want].map(x => -x), 1e-9));
});

test('rng is deterministic and uniform enough', () => {
  const a = rng(42), b = rng(42);
  let sum = 0;
  for (let i = 0; i < 10000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); sum += x; }
  assert.ok(Math.abs(sum / 10000 - 0.5) < 0.02);
});
