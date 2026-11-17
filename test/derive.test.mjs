import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solveKepler, periodS, lumSun, massKg, radiusKm, semiMajorKm, gravityMs2, DAY } from '../src/js/derive.js';

const data = JSON.parse(readFileSync(new URL('../src/data/system.json', import.meta.url), 'utf8'));
const K = data.constants;
const body = id => data.bodies.find(b => b.id === id);

test('solveKepler satisfies E - e sin E = M across eccentricities, including near-parabolic', () => {
  let worst = 0;
  for (const e of [0, 0.004, 0.02, 0.1, 0.3, 0.31, 0.5, 0.8, 0.94, 0.97]) {
    for (let k = -400; k <= 400; k++) {
      const M = k / 400 * Math.PI * 0.999999;
      const E = solveKepler(M, e);
      worst = Math.max(worst, Math.abs(E - e * Math.sin(E) - M));
    }
    for (const M of [1e-9, 1e-6, 1e-4, 1e-3, 0.0106, -1e-5]) {   // right at periapsis, where the comet sits
      const E = solveKepler(M, e);
      worst = Math.max(worst, Math.abs(E - e * Math.sin(E) - M));
    }
  }
  assert.ok(worst < 1e-12, `worst residual ${worst}`);
});

test('solveKepler wraps the mean anomaly and is odd in M', () => {
  const e = 0.6;
  assert.ok(Math.abs(solveKepler(1.3 + 10 * Math.PI, e) - solveKepler(1.3, e)) < 1e-12);
  assert.ok(Math.abs(solveKepler(-0.7, e) + solveKepler(0.7, e)) < 1e-12);
});

test('derived values match the independent estimates recorded in the handoff', () => {
  const pharos = body('pharos'), pelagia = body('pelagia'), boreas = body('boreas');
  const Ms = massKg(pharos, K);
  assert.ok(Math.abs(lumSun(pharos, K) - 1.194) < 0.002);
  const P = periodS(semiMajorKm(pelagia.orbit, K), Ms + massKg(pelagia, K), K) / DAY;
  assert.ok(Math.abs(P - 402) < 0.5, `Pelagia period ${P} d`);
  const Pb = periodS(semiMajorKm(boreas.orbit, K), Ms + massKg(boreas, K), K) / (365.25 * DAY);
  assert.ok(Math.abs(Pb - 9.67) < 0.01, `Boreas period ${Pb} yr`);
  assert.ok(Math.abs(gravityMs2(massKg(pelagia, K), radiusKm(pelagia, K), K) - 10.37) < 0.01);
});

test('a comet orbit given by perihelion distance yields a = q / (1 - e)', () => {
  const o = body('wayfarer').orbit;
  assert.ok(Math.abs(semiMajorKm(o, K) / K.AU_km - 0.7 / 0.06) < 1e-9);
});
