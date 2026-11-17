import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { warpFraction, warpExponent, standoff, begin, update, auto } from '../src/js/autopilot.js';
import { cam, updateBasis } from '../src/js/camera.js';
import { switchSystem } from '../src/js/flight.js';
import { buildSystem, stepSystem } from '../src/js/sim.js';

const data = JSON.parse(readFileSync(new URL('../src/data/system.json', import.meta.url), 'utf8'));

test('warpFraction runs monotonically from 0 to 1 and its complement is exact near the end', () => {
  const rem = [0];
  for (const k of [6, 12, 20, 34]) {
    assert.equal(warpFraction(0, k, rem), 0);
    assert.equal(warpFraction(1, k, rem), 1);
    assert.equal(rem[0], 0);
    assert.ok(Math.abs(warpFraction(0.5, k, rem) - 0.5) < 1e-12);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const u = warpFraction(i / 1000, k, rem);
      assert.ok(u >= prev, `not monotonic at s=${i / 1000}, k=${k}`);
      assert.ok(Math.abs(u + rem[0] - 1) < 1e-12);
      prev = u;
    }
    // one part in a thousand before arrival the complement is still a clean small number, not 1 - 0.99999...
    warpFraction(0.999, k, rem);
    assert.ok(rem[0] > 0 && rem[0] < 1e-2);
    const direct = 0.5 * Math.expm1(2 * k * 0.001) / Math.expm1(k);
    assert.ok(Math.abs(rem[0] - direct) <= 1e-11 * direct, 'the complement keeps its relative precision');
  }
});

test('warpExponent grows with the scale ratio and stays within its bounds', () => {
  assert.equal(warpExponent(10, 100), 6);
  assert.ok(warpExponent(1.5e8, 2e4) > warpExponent(1e6, 2e4));
  assert.equal(warpExponent(1e300, 1), 34);
  // With the fitted exponent the last eighth of the trip (in real time, after the smoothstep ease) is spent
  // within about one arrival distance of the end, for a hop between planets and for 27 light-years alike.
  const rem = [0];
  const ease = x => x * x * (3 - 2 * x);
  for (const [trip, arrive] of [[1.5e8, 2.1e4], [3.7e13, 3.3e6], [2.6e14, 350]]) {
    const k = warpExponent(trip, arrive);
    warpFraction(ease(0.88), k, rem);
    assert.ok(rem[0] * trip < 1.5 * arrive, `trip ${trip}: ${rem[0] * trip} km left with 12% of the time to go`);
    warpFraction(ease(0.5), k, rem);
    assert.ok(rem[0] * trip > 100 * arrive, 'but half-way through it is still far away');
  }
});

test('standoff: planets at 3.2 radii, stars at 4.5, the pulsar at 30', () => {
  const S = buildSystem(data);
  const i = id => S.index.get(id);
  assert.ok(Math.abs(standoff(S, i('pelagia'), 0) / S.radius[i('pelagia')] - 3.2) < 1e-12);
  assert.ok(Math.abs(standoff(S, i('pharos'), 0) / S.radius[i('pharos')] - 4.5) < 1e-12);
  assert.ok(Math.abs(standoff(S, i('metronome'), 1.337) / S.radius[i('metronome')] - 30) < 1e-12);
});

test('a warp ends at the standing distance, looking at the target, even across star systems', () => {
  const S = buildSystem(data);
  stepSystem(S, 0);
  for (const [fromId, toId] of [['pelagia', 'nivalis'], ['nivalis', 'ignis'], ['pelagia', 'metronome'], ['metronome', 'pharos']]) {
    const from = S.index.get(fromId), to = S.index.get(toId);
    cam.sys = S.sys[from];
    cam.pos[0] = S.pos[from * 3] + S.radius[from] * 4; cam.pos[1] = S.pos[from * 3 + 1]; cam.pos[2] = S.pos[from * 3 + 2];
    cam.q.set([0, 0, 0, 1]); updateBasis();
    const stand = standoff(S, to, toId === 'metronome' ? 1.337 : 0);
    begin(S, to, 4, stand);
    let arrived = false, t = 0, frames = 0;
    while (!arrived && frames < 2000) {
      t += 0.016 * 100; stepSystem(S, t);                 // the target keeps moving at the default time rate
      arrived = update(S, 0.016); frames++;
      switchSystem(S);                                    // as the frame loop does: re-base on the nearest system
      assert.ok(cam.pos.every(Number.isFinite) && cam.q.every(Number.isFinite));
    }
    assert.ok(arrived, `${fromId} -> ${toId} never arrived`);
    assert.equal(auto.active, false);
    // express the camera in the target's system and measure
    const s = S.sys[to] * 3, c = cam.sys * 3;
    const rel = [0, 1, 2].map(k => S.sysPos[s + k] - S.sysPos[c + k] + S.pos[to * 3 + k] - cam.pos[k]);
    const d = Math.hypot(...rel);
    assert.ok(Math.abs(d - stand) < stand * 1e-6, `${fromId} -> ${toId}: parked at ${d} km, wanted ${stand}`);
    const facing = (rel[0] * cam.fwd[0] + rel[1] * cam.fwd[1] + rel[2] * cam.fwd[2]) / d;
    assert.ok(facing > 0.999999, `${toId} is ${Math.acos(Math.min(1, facing))} rad off centre`);
  }
});

test('a path that would cut through the star is bowed around it', () => {
  const S = buildSystem(data);
  stepSystem(S, 0);
  const star = S.index.get('pharos'), to = S.index.get('ignis');
  // start diametrically opposite the target, so the straight line passes through the star
  cam.sys = 0;
  for (let k = 0; k < 3; k++) cam.pos[k] = -S.pos[to * 3 + k] * 3;
  cam.q.set([0, 0, 0, 1]); updateBasis();
  begin(S, to, 5, standoff(S, to, 0));
  let closest = Infinity, arrived = false;
  for (let f = 0; f < 4000 && !arrived; f++) {
    arrived = update(S, 0.004);
    closest = Math.min(closest, Math.hypot(cam.pos[0] - S.pos[star * 3], cam.pos[1] - S.pos[star * 3 + 1], cam.pos[2] - S.pos[star * 3 + 2]));
  }
  assert.ok(arrived);
  assert.ok(closest > S.radius[star] * 2.5, `passed ${closest / S.radius[star]} radii from the star's centre`);
});
