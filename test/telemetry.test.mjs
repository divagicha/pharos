import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, fmt, chem, share, whole } from '../src/js/telemetry.js';
import { massKg, radiusKm } from '../src/js/derive.js';
import { LOOKS, MATERIALS, swatch } from '../src/js/looks.js';

const data = JSON.parse(readFileSync(new URL('../src/data/system.json', import.meta.url), 'utf8'));
const K = data.constants;
const of = id => describe(data, data.bodies.findIndex(b => b.id === id));
const row = (d, label) => { const r = d.rows.find(x => x[0] === label); assert.ok(r, `row "${label}" in ${d.name}: ${d.rows.map(x => x[0])}`); return r[1]; };
const T = '\u2009';

test('fmt: significant figures, grouped thousands, powers of ten', () => {
  assert.equal(fmt(6562.13, 4), '6562');
  assert.equal(fmt(737442, 6), `737${T}442`);
  assert.equal(fmt(737442, 4), `737${T}400`, 'whole digits beyond the significant figures are rounded away');
  assert.equal(fmt(222539), `223${T}000`); assert.equal(fmt(9996, 3), `10${T}000`);
  assert.equal(fmt(10.367), '10.4');
  assert.equal(fmt(0.0085, 2), '0.0085');
  assert.equal(fmt(1, 3), '1.00');
  assert.equal(fmt(0), '0');
  assert.equal(fmt(6.689e24), `6.69${T}\u00d7${T}10^{24}`);
  assert.equal(fmt(9.996e30), `1.00${T}\u00d7${T}10^{31}`, 'a mantissa that rounds to 10 carries into the exponent');
  assert.equal(fmt(4.2e-7, 2), `4.2${T}\u00d7${T}10^{\u22127}`);
  assert.equal(fmt(-12.5), '\u221212.5');
  assert.equal(fmt(NaN), '\u2013');
  assert.equal(whole(71308.6), `71${T}309`); assert.equal(whole(6562.13), '6562'); assert.equal(whole(23653800), '23.65 million');
});

test('chem marks the digits of a formula as subscripts and leaves words alone', () => {
  assert.equal(chem('N2'), 'N_{2}'); assert.equal(chem('H2O ice'), 'H_{2}O ice');
  assert.equal(chem('N2 + Ar'), 'N_{2} + Ar'); assert.equal(chem('dust and organics'), 'dust and organics');
});

test('every body is described, and every layer has a material style', () => {
  data.bodies.forEach((b, i) => {
    const d = describe(data, i);
    assert.equal(d.name, b.name);
    assert.ok(d.kind && d.quick.length >= 3 && d.rows.length >= 5, b.id);
    assert.equal(d.layers.length, b.layers.length);
    assert.equal(d.layers[0].inner, 0); assert.equal(d.layers.at(-1).outer, 1);
    const look = LOOKS[b.id];
    assert.equal(look.layers.length, b.layers.length, `${b.id}: one material per layer`);
    for (const m of look.layers) { assert.ok(MATERIALS[m], `${b.id}: material ${m}`); assert.match(swatch(m), /^rgb\(\d+,\d+,\d+\)$/); }
    assert.match(look.accent, /^#[0-9a-f]{6}$/);
    for (const [label, value] of [...d.rows, ...d.quick]) assert.ok(label && value && !/NaN|undefined|Infinity/.test(value), `${b.id} ${label}: ${value}`);
  });
});

test('a planet shows what the brief asks for, with derived values that match the physics', () => {
  const d = of('pelagia');
  assert.equal(d.kind, 'Terrestrial planet');
  const M = 1.12 * K.Mearth_kg, R = 1.03 * K.Rearth_km, g = K.G_km3_kg_s2 * M / (R * R) * 1000;
  assert.ok(row(d, 'Surface gravity').startsWith(fmt(g) + ' m/s^{2}'), row(d, 'Surface gravity'));
  assert.ok(row(d, 'Mass').startsWith('1.12 M'));
  assert.ok(row(d, 'Radius').startsWith('6562 km'));
  const P = 2 * Math.PI * Math.sqrt((1.08 * K.AU_km) ** 3 / (K.G_km3_kg_s2 * (1.04 * K.Msun_kg + M)));
  assert.equal(row(d, 'Orbital period'), `${fmt(P / 86400)} d`);
  assert.deepEqual(d.mix.parts.slice(0, 2), [['N_{2}', 76.4], ['O_{2}', 21.8]]);
  assert.equal(d.mix.basis, 'by volume');
  assert.deepEqual(d.mix.pressure.slice(0, 2), ['Surface pressure', '1.08 bar']);
  assert.deepEqual([d.mix.temp.min, d.mix.temp.mean, d.mix.temp.max], [208, 289, 318]);
  assert.equal(d.layers[3].name, 'Crust');
  assert.equal(d.layers[3].depth, '0 \u2013 23.0 km deep');
  assert.equal(d.layers[3].share, '0.5 %'); assert.equal(d.layers[2].share, '67.1 %');
  assert.equal(share(30), '30 %'); assert.equal(share(0.001), '0.001 %'); assert.equal(share(1.999), '2 %');
  assert.ok(Math.abs(d.layers.reduce((s, l) => s + l.massPct, 0) - 100) < 1e-9);
});

test('a star shows class, luminosity, temperature, distance and stage', () => {
  const d = of('caerulea');
  assert.equal(d.kind, 'Blue supergiant');
  assert.equal(row(d, 'Spectral class'), 'B1 Ia');
  const L = 34 ** 2 * (21500 / K.Tsun_K) ** 4;
  assert.ok(row(d, 'Luminosity').startsWith(fmt(L) + ' L'), row(d, 'Luminosity'));
  assert.equal(row(d, 'Surface temperature'), `21${T}500 K`);
  assert.equal(row(d, 'Distance'), `${fmt(Math.hypot(-22.4, 32.0, -50.56))} ly from Pharos`);
  assert.match(row(d, 'Evolutionary stage'), /supergiant/);
  assert.deepEqual(of('pharos').quick.at(-1), ['Role', 'Host star']);
  assert.equal(of('pharos').kind, 'Yellow dwarf'); assert.equal(of('cinnabar').kind, 'Red dwarf');
  assert.equal(of('metronome').kind, 'Neutron star');
  assert.match(row(of('dioscuri-a'), 'Companion'), /^Dioscuri B \u00b7 0\.085 AU apart \u00b7 orbit /);
});

test('interior tables are self-consistent: shares sum to 100 % and implied density falls outward', () => {
  for (const b of data.bodies) {
    const sum = b.layers.reduce((s, l) => s + l.massPct, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9, `${b.id}: mass shares sum to ${sum}`);
    const M = massKg(b, K);
    if (M == null) continue;                                    // the comet has no mass in the data
    const V = 4 / 3 * Math.PI * radiusKm(b, K) ** 3;
    let inner = 0, last = Infinity;
    for (const l of b.layers) {
      assert.ok(l.outer > inner && l.outer <= 1, `${b.id} ${l.name}: radii must increase to 1`);
      const rho = l.massPct / 100 * M / ((l.outer ** 3 - inner ** 3) * V) * 1e-12;      // g/cm3
      assert.ok(rho < last, `${b.id} ${l.name}: implied density ${rho.toPrecision(3)} g/cm3 is not below the layer under it (${last.toPrecision(3)})`);
      last = rho; inner = l.outer;
    }
    // the outermost solid or liquid layer of a rocky or icy body cannot be lighter than ice or methane-nitrogen frost
    if (b.kind === 'rock' || b.kind === 'terra') assert.ok(last > 0.85, `${b.id}: outer layer implies ${last.toPrecision(3)} g/cm3`);
  }
});

test('moons, giants and the comet get the rows that apply to them', () => {
  assert.equal(of('luma').kind, 'Moon of Pelagia');
  assert.equal(row(of('luma'), 'Rotation'), 'Tidally locked to Pelagia');
  assert.equal(of('luma').mix, null, 'no atmosphere, no composition table');
  assert.ok(row(of('boreas'), 'Gravity at 1 bar'));
  assert.equal(of('boreas').mix.pressure[0], 'Reference pressure');
  assert.match(row(of('ignis'), 'Rotation'), /3:2 spin-orbit resonance/);
  assert.equal(of('ignis').mix.pressure[1], '4.0 mbar');
  const c = of('wayfarer');
  assert.equal(c.kind, 'Comet');
  assert.equal(row(c, 'Perihelion'), '0.70 AU');
  assert.ok(!c.rows.some(r => r[0] === 'Mass'), 'the data gives the comet no mass, so none is shown');
  assert.equal(c.mix.title, 'Composition');
});
