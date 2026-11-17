import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystem, stepSystem, relToCamera } from '../src/js/sim.js';
import { cam } from '../src/js/camera.js';
import { flight } from '../src/js/flight.js';
import { tour, initTour, tourAt, tourSimTime, applyPose, POSES, TOUR_SECONDS } from '../src/js/tour.js';

const data = JSON.parse(readFileSync(new URL('../src/data/system.json', import.meta.url), 'utf8'));
const S = buildSystem(data);
initTour(S, data);

/** Camera state at tour time t, with the bodies where they are at that time. */
function at(t) {
  stepSystem(S, tourSimTime(t));
  tourAt(t, S);
  return { sys: cam.sys, pos: [...cam.pos], q: [...cam.q], sel: tour.sel, panel: tour.panel, open: tour.open, warp: tour.warp, eta: tour.eta, speed: flight.speed };
}
/** Distance from the camera to the centre of body i, in that body's radii. */
function radiiFrom(i) {
  const r = relToCamera(S, i, cam.sys, cam.pos, [0, 0, 0]);
  return Math.hypot(r[0], r[1], r[2]) / S.radius[i];
}

test('the tour is a pure function of its time: any moment can be visited in any order', () => {
  const a = at(22.7), b = at(51.3), c = at(5.2);
  at(40);
  assert.deepEqual(at(22.7), a);
  assert.deepEqual(at(5.2), c);
  assert.deepEqual(at(51.3), b);
});

test('the camera never enters a body and its orientation stays a unit quaternion', () => {
  for (let t = 0; t <= TOUR_SECONDS; t += 0.05) {
    const s = at(t);
    assert.ok(Math.abs(Math.hypot(...s.q) - 1) < 1e-9, `t=${t}: |q| = ${Math.hypot(...s.q)}`);
    for (let i = 0; i < S.n; i++) {
      if (S.sys[i] !== s.sys) continue;
      assert.ok(radiiFrom(i) > 1.02, `t=${t.toFixed(2)}: ${radiiFrom(i).toFixed(3)} radii from the centre of ${S.id[i]}`);
    }
  }
});

test('the path is continuous: no jump at the joins between shots and warps, or when the system changes', () => {
  let prev = at(0), prevNear = Infinity;
  for (let t = 0.002; t <= TOUR_SECONDS; t += 0.002) {
    const s = at(t);
    // express the previous position in the current system, then measure the step against the speed either side
    const o = s.sys * 3, p = prev.sys * 3;
    const step = Math.hypot(...[0, 1, 2].map(k => s.pos[k] - (prev.pos[k] + S.sysPos[p + k] - S.sysPos[o + k])));
    // a warp accelerates hard, so allow several times the mean; and the camera rides with its anchor, whose
    // orbital motion (up to about 80 km/s, a hundred times faster on the tour's clock) is not part of its own speed
    const allowed = Math.max(s.speed, prev.speed) * 0.002 * 6 + 1 + 80 * 100 * 0.002;
    assert.ok(step <= allowed, `t=${t.toFixed(3)}: moved ${step.toExponential(3)} km in 2 ms at ${s.speed.toExponential(3)} km/s`);
    prev = s;
  }
});

test('warps are announced, and the cutaway opens and shuts inside one shot', () => {
  let warps = 0, inWarp = false, opened = false, closedAgain = false, maxOpen = 0;
  for (let t = 0; t <= TOUR_SECONDS; t += 0.02) {
    const s = at(t);
    if (s.warp > 0.2 && !inWarp) { warps++; inWarp = true; }
    if (s.warp === 0) inWarp = false;
    if (s.warp > 0) assert.ok(s.eta > 0 && s.eta < 4, `t=${t}: a warp shows the time to arrival`);
    assert.ok(s.open >= 0 && s.open <= 1);
    if (s.open > 0) { assert.equal(S.id[s.sel], 'pelagia'); assert.equal(s.warp, 0, 'never mid-warp'); opened = true; }
    if (s.panel) assert.ok(s.open > 0, 'panels only while the body is cut open');
    if (opened && s.open === 0) closedAgain = true;
    maxOpen = Math.max(maxOpen, s.open);
  }
  assert.equal(warps, 8, 'eight warps between nine shots');
  assert.ok(opened && closedAgain && maxOpen === 1, 'the cutaway opens fully and closes');
  assert.equal(at(TOUR_SECONDS).warp, 0, 'the tour ends at rest on its last shot');
});

test('the tour visits the star, every planet, the belt, the comet and another system', () => {
  const seen = new Set();
  let belt = false;
  for (let t = 0; t <= TOUR_SECONDS; t += 0.25) {
    const s = at(t);
    if (s.warp > 0) continue;
    if (s.sel >= 0) seen.add(S.id[s.sel]); else belt = true;
    if (s.sel >= 0) assert.ok(radiiFrom(s.sel) < 1.2e6, `t=${t}: the shot stays with ${S.id[s.sel]}`);
  }
  for (const id of ['pharos', 'ignis', 'pelagia', 'wayfarer', 'boreas', 'nivalis', 'metronome']) assert.ok(seen.has(id), id);
  assert.ok(belt, 'the asteroid belt');
});

test('the six poses place the camera outside their bodies, looking at something', () => {
  assert.deepEqual(Object.keys(POSES), ['1', '2', '3', '4', '5', '6']);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    stepSystem(S, POSES[n].day * 86400);
    const pose = applyPose(n, S), i = S.index.get(pose.view[0]);
    assert.ok(Math.abs(radiiFrom(i) - pose.view[1]) < 1e-6, `pose ${n}: ${radiiFrom(i)} radii`);
    assert.ok(Math.abs(Math.hypot(...cam.q) - 1) < 1e-9);
    if (pose.panel) assert.equal(pose.sel, pose.view[0], `pose ${n}: the panel belongs to the body in view`);
  }
  assert.ok(POSES[4].panel && POSES[5].panel, 'poses 4 and 5 show the inspection panels');
  assert.throws(() => applyPose(7, S), /poses 1 to 6/);
});
