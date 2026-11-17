// What the HUD says about each body, as plain strings. Pure (no DOM, no GPU) and start-up only.
//
// Every figure that can be derived is derived here from the base parameters in src/data/system.json through
// src/js/derive.js, the same functions the simulation uses, so a panel can never contradict the motion on screen.
//
// Contract
//   describe(data, i) -> {
//     name, kind,                  display name and a short class label ("Terrestrial planet", "Blue supergiant")
//     blurb,                       one line of description (may be empty)
//     quick: [[label, value]],     the three or four figures of the brief card
//     rows:  [[label, value]],     the full physical / orbital / stellar table
//     layers: [{ name, material, massPct, share, inner, outer, depth }]   from the centre out; radii as fractions
//     mix: { title, basis, parts: [[label, percent]], pressure?: [label, value, note], temp?: { min, mean, max, note } } | null
//   }
//   Strings may carry two marks that the HUD renders: ^{..} superscript and _{..} subscript.
//   fmt(x, sig) formats a number: `sig` significant figures, thousands grouped by thin spaces, and
//   m \u00d7 10^{n} outside 0.001 .. 10 million.
import { massKg, radiusKm, lumSun, periodS, semiMajorKm, gravityMs2, densityGcm3, escapeKms, absMagBol, equilibriumK, DAY, YEAR } from './derive.js';

const THIN = '\u2009', TIMES = '\u00d7', DASH = '\u2013', DEGREE = '\u00b0';
const EARTH = '_{\u2295}', SUN = '_{\u2609}';
const G0 = 9.80665;

export function fmt(x, sig = 3) {
  if (!isFinite(x)) return DASH;
  if (x === 0) return '0';
  const ax = Math.abs(x);
  if (ax >= 1e7 || ax < 1e-3) {
    let e = Math.floor(Math.log10(ax)), m = x / 10 ** e;
    if (Math.abs(+m.toFixed(sig - 1)) >= 10) { m /= 10; e++; }
    return `${m.toFixed(sig - 1)}${THIN}${TIMES}${THIN}10^{${e < 0 ? '\u2212' + -e : e}}`;
  }
  const mag = Math.floor(Math.log10(ax)), decimals = Math.max(0, sig - 1 - mag);
  // more whole digits than significant figures: round them away too (222 539 to three figures is 223 000)
  const shown = mag >= sig ? Math.round(ax / 10 ** (mag - sig + 1)) * 10 ** (mag - sig + 1) : ax;
  const [int, frac] = shown.toFixed(decimals).split('.');
  const grouped = int.length > 4 ? int.replace(/\B(?=(\d{3})+$)/g, THIN) : int;
  return (x < 0 ? '\u2212' : '') + grouped + (frac ? '.' + frac : '');
}

/** A whole number with every digit kept (radii in km), grouped like fmt; from ten million up, in millions. */
export function whole(x) {
  const r = Math.round(x);
  return Math.abs(r) >= 1e7 ? `${fmt(r / 1e6, 4)} million` : fmt(r, String(Math.abs(r)).length);
}

/** Chemical formulae: digits after a letter become subscripts (N2 -> N_{2}). */
export function chem(s) { return s.replace(/([A-Za-z])(\d+)/g, '$1_{$2}'); }

const STAR_COLOUR = { O: 'Blue', B: 'Blue', A: 'White', F: 'Yellow-white', G: 'Yellow', K: 'Orange', M: 'Red' };

function kindLabel(b, parent) {
  if (b.kind === 'star') {
    if (b.variant === 'neutron') return 'Neutron star';
    const size = /\bI[ab]?\b/.test(b.spectral) ? 'supergiant' : /\bIII\b/.test(b.spectral) ? 'giant' : 'dwarf';
    return `${STAR_COLOUR[b.spectral[0]] || 'Main-sequence'} ${size}`;
  }
  if (b.kind === 'comet') return 'Comet';
  if (parent && parent.kind !== 'star') return `Moon of ${parent.name}`;
  return { terra: 'Terrestrial planet', gas: 'Gas giant', ice: 'Ice giant', rock: 'Rocky planet' }[b.kind];
}

function duration(seconds) {
  if (seconds < 120) return `${fmt(seconds, 4)} s`;
  if (seconds < 2 * DAY) return `${fmt(seconds / 3600, 3)} h`;
  if (seconds < 1.5 * YEAR) return `${fmt(seconds / DAY, 3)} d`;
  return `${fmt(seconds / YEAR, 3)} yr`;
}

/** A share of the whole in per cent: one decimal above 1 %, two significant figures below. */
export function share(pct) {
  const s = pct >= 1 ? pct.toFixed(1).replace(/\.0$/, '') : String(+pct.toPrecision(2));
  return `${s} %`;
}

/** A depth in km: to the kilometre from 100 km down, so the deepest figure is the radius the table shows. */
const km = x => (x >= 100 ? whole(x) : fmt(x));

function layerRows(b, R) {
  const big = R >= 2e6;                    // a supergiant: millions of km read better than powers of ten
  return b.layers.map((l, k) => {
    const inner = k ? b.layers[k - 1].outer : 0;
    return { name: l.name, material: l.material, massPct: l.massPct, share: share(l.massPct), inner, outer: l.outer,
      depth: big ? `${fmt((1 - l.outer) * R / 1e6)} ${DASH} ${fmt((1 - inner) * R / 1e6)} million km deep`
        : `${km((1 - l.outer) * R)} ${DASH} ${km((1 - inner) * R)} km deep` };
  });
}

function massValue(M, K, isStar) {
  const kg = `${fmt(M)} kg`;
  if (isStar) return `${fmt(M / K.Msun_kg)} M${SUN} \u00b7 ${kg}`;
  if (M > 0.05 * K.Mjup_kg) return `${fmt(M / K.Mjup_kg)} Jupiter masses \u00b7 ${fmt(M / K.Mearth_kg)} M${EARTH}`;
  return `${fmt(M / K.Mearth_kg, M < 0.01 * K.Mearth_kg ? 2 : 3)} M${EARTH} \u00b7 ${kg}`;
}

function describeStar(data, i) {
  const b = data.bodies[i], K = data.constants;
  const M = massKg(b, K), R = radiusKm(b, K), L = lumSun(b, K), g = gravityMs2(M, R, K);
  const sys = data.systems.find(s => s.id === b.system);
  const ly = Math.hypot(...sys.posLy);
  const distance = ly === 0 ? 'Host star of this system' : `${fmt(ly)} ly from ${data.bodies[0].name}`;
  const lum = `${fmt(L)} L${SUN}`;
  const rows = [
    ['Spectral class', b.spectral],
    ['Evolutionary stage', b.stage],
    ['Luminosity', `${lum} \u00b7 bolometric magnitude ${fmt(absMagBol(L))}`],
    ['Surface temperature', `${fmt(b.teffK, 4)} K`],
    ['Distance', distance],
    ['Mass', massValue(M, K, true)],
    ['Radius', R < 1000 ? `${fmt(R)} km` : `${fmt(R / K.Rsun_km)} R${SUN} \u00b7 ${whole(R)} km`],
    ['Surface gravity', `${fmt(g)} m/s^{2} \u00b7 log g ${fmt(Math.log10(g * 100))}`],
    ['Mean density', `${fmt(densityGcm3(M, R))} g/cm^{3}`],
    ['Age', b.ageGyr != null ? `${fmt(b.ageGyr, 2)} billion years` : `${fmt(b.ageMyr, 2)} million years`],
  ];
  if (b.feH != null) rows.push(['Metallicity', `[Fe/H] ${b.feH > 0 ? '+' : b.feH < 0 ? '\u2212' : ''}${Math.abs(b.feH).toFixed(2)}`]);
  if (b.spinSeconds) rows.push(['Spin period', `${fmt(b.spinSeconds, 4)} s`]);
  else if (b.rotationDays) rows.push(['Rotation', `${fmt(b.rotationDays)} d`]);
  if (b.magneticFieldTesla) rows.push(['Magnetic field', `${fmt(b.magneticFieldTesla, 2)} T`]);
  if (sys.binary) {
    const other = data.bodies.find(o => o.id === (sys.binary.a === b.id ? sys.binary.b : sys.binary.a));
    const P = periodS(sys.binary.separationAU * K.AU_km, M + massKg(other, K), K);
    rows.push(['Companion', `${other.name} \u00b7 ${fmt(sys.binary.separationAU, 2)} AU apart \u00b7 orbit ${duration(P)}`]);
  }
  return {
    name: b.name, kind: kindLabel(b, null), blurb: '',
    quick: [['Class', b.spectral], ['Luminosity', lum], ['Surface', `${fmt(b.teffK, 4)} K`], ly === 0 ? ['Role', 'Host star'] : ['Distance', `${fmt(ly)} ly`]],
    rows, layers: layerRows(b, R),
    mix: { title: 'Composition', basis: b.composition.basis, parts: b.composition.parts.map(p => [chem(p[0]), p[1]]) },
  };
}

function orbitRows(b, parent, star, K, rows) {
  const o = b.orbit, a = semiMajorKm(o, K), M = massKg(b, K) ?? 0;
  const period = periodS(a, massKg(parent, K) + M, K);
  const far = a > 0.01 * K.AU_km;
  rows.push(['Orbital period', duration(period)]);
  if (o.qAU != null) {
    rows.push(['Perihelion', `${fmt(o.qAU, 2)} AU`], ['Aphelion', `${fmt(a * (1 + o.e) / K.AU_km)} AU`]);
  } else {
    rows.push(['Semi-major axis', `${far ? fmt(a / K.AU_km) + ' AU' : fmt(a, 3) + ' km'} from ${parent.name}`]);
  }
  rows.push(['Eccentricity', fmt(o.e ?? 0, 2)],
    ['Inclination', `${fmt(o.incDeg ?? 0, 2)}${DEGREE} to ${parent.kind === 'star' ? 'the ecliptic' : `${parent.name}'s equator`}`]);
  if (b.tidallyLocked) rows.push(['Rotation', `Tidally locked to ${parent.name}`]);
  else if (b.spinOrbit) rows.push(['Rotation', `${duration(period * b.spinOrbit[1] / b.spinOrbit[0])} \u00b7 ${b.spinOrbit[0]}:${b.spinOrbit[1]} spin-orbit resonance`]);
  else if (b.rotationHours) rows.push(['Rotation', `${fmt(b.rotationHours)} h`]);
  if (b.tiltDeg != null) rows.push(['Axial tilt', `${fmt(b.tiltDeg, 2)}${DEGREE}`]);
  return period;
}

function describeWorld(data, i) {
  const b = data.bodies[i], K = data.constants, byId = id => data.bodies.find(o => o.id === id);
  const parent = byId(b.parent), star = parent.kind === 'star' ? parent : byId(parent.parent);
  const M = massKg(b, K), R = radiusKm(b, K);
  const giant = b.kind === 'gas' || b.kind === 'ice';
  const rows = [], quick = [];
  if (M != null) rows.push(['Mass', massValue(M, K, false)]);
  rows.push(['Radius', R > 0.2 * K.Rearth_km ? `${whole(R)} km \u00b7 ${fmt(R / K.Rearth_km)} R${EARTH}` : `${fmt(R)} km`]);
  quick.push([b.kind === 'comet' ? 'Nucleus' : 'Radius', `${R >= 1000 ? whole(R) : fmt(R)} km`]);
  if (M != null) {
    const g = gravityMs2(M, R, K);
    rows.push([giant ? 'Gravity at 1 bar' : 'Surface gravity', `${fmt(g)} m/s^{2} \u00b7 ${fmt(g / G0)} g`],
      ['Mean density', `${fmt(densityGcm3(M, R))} g/cm^{3}`],
      ['Escape velocity', `${fmt(escapeKms(M, R, K))} km/s`]);
    quick.push(['Gravity', `${fmt(g)} m/s^{2}`]);
  }
  const period = orbitRows(b, parent, star, K, rows);
  quick.push(['Orbit', duration(period)]);
  // sunlight depends on the distance from the star: a moon's is its planet's
  const sunDist = parent.kind === 'star' ? semiMajorKm(b.orbit, K) : semiMajorKm(parent.orbit, K);
  if (b.kind === 'comet') {
    quick.push(['Perihelion', `${fmt(b.orbit.qAU, 2)} AU`], ['Eccentricity', fmt(b.orbit.e, 2)]);
    rows.push(['Albedo', fmt(b.albedo, 2)]);
  } else {
    const teq = equilibriumK(star.teffK, radiusKm(star, K), sunDist, b.albedo);
    rows.push(['Equilibrium temp.', `${Math.round(teq)} K at albedo ${fmt(b.albedo, 2)}`]);
    quick.push(b.atmosphere ? ['Mean temp', `${Math.round(b.atmosphere.tempK.mean)} K`] : ['Equilibrium', `${Math.round(teq)} K`]);
  }
  return { name: b.name, kind: kindLabel(b, parent), blurb: b.blurb || '', quick, rows, layers: layerRows(b, R), mix: worldMix(b) };
}

function worldMix(b) {
  const at = b.atmosphere;
  if (at) {
    const p = at.surfacePressureBar;
    return {
      title: 'Atmosphere', basis: 'by volume', parts: at.gases.map(g => [chem(g[0]), g[1]]),
      pressure: [at.pressureNote ? 'Reference pressure' : 'Surface pressure', p < 0.1 ? `${fmt(p * 1000, 2)} mbar` : `${fmt(p)} bar`, at.pressureNote || ''],
      temp: { min: at.tempK.min, mean: at.tempK.mean, max: at.tempK.max, note: at.tempK.note || '' },
    };
  }
  if (b.composition) return { title: 'Composition', basis: b.composition.basis, parts: b.composition.parts.map(p => [chem(p[0]), p[1]]) };
  return null;
}

export function describe(data, i) {
  return data.bodies[i].kind === 'star' ? describeStar(data, i) : describeWorld(data, i);
}
