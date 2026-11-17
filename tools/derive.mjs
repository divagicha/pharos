#!/usr/bin/env node
// Print every quantity derived from the base parameters in src/data/system.json.
// Uses the same functions as the simulation and the HUD (src/js/derive.js, src/js/sim.js), so what this
// prints is what the page shows.
// Usage: node tools/derive.mjs
import { readFileSync } from 'node:fs';
import { massKg, radiusKm, lumSun, periodS, semiMajorKm, gravityMs2, densityGcm3, escapeKms, absMagBol, equilibriumK, DAY, YEAR } from '../src/js/derive.js';
import { buildSystem, stepSystem } from '../src/js/sim.js';

const data = JSON.parse(readFileSync(new URL('../src/data/system.json', import.meta.url), 'utf8'));
const K = data.constants;
const byId = Object.fromEntries(data.bodies.map(b => [b.id, b]));
const sysById = Object.fromEntries(data.systems.map(s => [s.id, s]));
const S = buildSystem(data);
stepSystem(S, 0);

const fmt = (x, d = 3) => x == null ? '-' : Math.abs(x) >= 1e5 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(d) : Number(x.toPrecision(d + 1)).toString();
const dur = s => s > 2 * YEAR ? fmt(s / YEAR) + ' yr' : s > 3 * DAY ? fmt(s / DAY) + ' d' : s > 300 ? fmt(s / 3600) + ' h' : fmt(s) + ' s';
const dist = (i, j) => Math.hypot(S.pos[i * 3] - S.pos[j * 3], S.pos[i * 3 + 1] - S.pos[j * 3 + 1], S.pos[i * 3 + 2] - S.pos[j * 3 + 2]);

data.bodies.forEach((b, i) => {
  const M = massKg(b, K), R = radiusKm(b, K);
  const out = [`radius ${fmt(R)} km`];
  if (M != null) out.push(`mass ${fmt(M)} kg`, `g ${fmt(gravityMs2(M, R, K))} m/s2`, `density ${fmt(densityGcm3(M, R))} g/cm3`, `v_esc ${fmt(escapeKms(M, R, K))} km/s`);
  if (b.kind === 'star') {
    const L = lumSun(b, K), p = sysById[b.system].posLy, dLy = Math.hypot(p[0], p[1], p[2]);
    out.push(`L ${fmt(L)} Lsun`, `M_bol ${fmt(absMagBol(L))}`);
    if (dLy > 0) out.push(`distance ${fmt(dLy)} ly`, `apparent mag from host ${fmt(absMagBol(L) + 5 * Math.log10(dLy / 3.26156 / 10))}`);
  }
  if (b.orbit) {
    const par = byId[b.parent], o = b.orbit, aKm = semiMajorKm(o, K);
    const P = periodS(aKm, massKg(par, K) + (M ?? 0), K);
    out.push(`a ${o.aKm != null ? fmt(aKm) + ' km' : fmt(aKm / K.AU_km) + ' AU'}`, `period ${dur(P)}`, `mean orbital speed ${fmt(2 * Math.PI * aKm / P)} km/s`);
    if (b.spinOrbit) out.push(`rotation ${dur(P * b.spinOrbit[1] / b.spinOrbit[0])} (${b.spinOrbit[0]}:${b.spinOrbit[1]} spin-orbit)`);
    if (b.albedo != null) {
      const star = S.star[i], host = byId[S.id[star]];
      const d = dist(i, star);                                // where the body actually is at epoch, not its mean distance
      out.push(`T_eq ${fmt(equilibriumK(host.teffK, radiusKm(host, K), d, b.albedo))} K at ${fmt(d / K.AU_km)} AU`);
    }
  }
  if (b.rotationHours) out.push(`rotation ${fmt(b.rotationHours)} h`);
  console.log(`${b.name.padEnd(12)} [${b.kind}]  ` + out.join(' | '));
});
for (const s of data.systems) {
  if (!s.binary) continue;
  const A = byId[s.binary.a], B = byId[s.binary.b], aKm = s.binary.separationAU * K.AU_km;
  console.log(`${s.id} binary: separation ${fmt(aKm)} km (${fmt(aKm / radiusKm(A, K))} radii of A), period ${dur(periodS(aKm, massKg(A, K) + massKg(B, K), K))}`);
}
for (const r of data.rings ?? []) console.log(`rings of ${r.parent}: ${fmt(r.innerRadii * radiusKm(byId[r.parent], K))} to ${fmt(r.outerRadii * radiusKm(byId[r.parent], K))} km`);

// The density each interior layer implies (its mass share over its share of the volume), in g/cm3: a check
// that the layer table is self-consistent. test/telemetry.test.mjs requires it to fall outward.
console.log('\nimplied layer densities (g/cm3):');
for (const b of data.bodies) {
  const M = massKg(b, K);
  if (M == null) continue;
  const V = 4 / 3 * Math.PI * radiusKm(b, K) ** 3;
  let inner = 0;
  const parts = b.layers.map(l => {
    const rho = l.massPct / 100 * M / ((l.outer ** 3 - inner ** 3) * V) * 1e-12;
    inner = l.outer;
    return `${l.name} ${fmt(rho, 2)}`;
  });
  console.log(`  ${b.name.padEnd(11)} ${parts.join(' | ')}`);
}
