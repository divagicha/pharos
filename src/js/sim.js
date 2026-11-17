// Simulation core: the body table and its motion. Pure (no DOM, no GPU) so it runs under node --test.
//
// Contract
//   buildSystem(data)   start-up only. Turns src/data/system.json into typed arrays. Throws on malformed data
//                       (unknown parent/system, a child listed before its parent, a body with no radius).
//   stepSystem(S, t)    frame path, allocates nothing. Sets every body's position (km, relative to the origin of
//                       its own star system), its displacement since the previous call, and its world->local
//                       rotation, for simulation time t (seconds since epoch). Deterministic in t.
//   relToCamera(...)    camera-relative position in doubles; exact zero offset inside the camera's own system.
//   spinRows(...)       world->local rotation rows for an arbitrary spin angle (bodies animated off the sim clock).
//
// Axes: right-handed, +Y is the system's north. Orbits are counter-clockwise seen from +Y.
// A planet's orbit is referred to the ecliptic (XZ plane); a moon's to its parent's equator.
import { massKg, radiusKm, semiMajorKm, periodS, solveKepler, DAY } from './derive.js';

export const STAR = 0, ROCK = 1, TERRA = 2, GAS = 3, ICE = 4, COMET = 5;
const KIND = { star: STAR, rock: ROCK, terra: TERRA, gas: GAS, ice: ICE, comet: COMET };
const DEG = Math.PI / 180;

/** Stable pseudo-random number in [0, 1) from a string, for angles the data file leaves open. */
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function comb(a, ka, b, kb, c = [0, 0, 0], kc = 0) { return [a[0] * ka + b[0] * kb + c[0] * kc, a[1] * ka + b[1] * kb + c[1] * kc, a[2] * ka + b[2] * kb + c[2] * kc]; }
/** Two unit vectors e1, e2 perpendicular to unit n, with e1 x e2 = n. */
function planeBasis(n) {
  const ref = Math.abs(n[1]) > 0.999 ? [1, 0, 0] : [0, 1, 0];
  const e1 = Math.abs(n[1]) > 0.999 ? [1, 0, 0] : normalize(cross(ref, n));
  return [e1, cross(n, e1)];
}

/**
 * Orbit orientation from classical elements, in a reference plane with normal n.
 * Returns the unit vectors P (towards periapsis), Q (90 degrees ahead in the orbit), W (orbit normal) and N (ascending node).
 */
function orbitFrame(n, incl, node, argp) {
  const [e1, e2] = planeBasis(n);
  const N = comb(e1, Math.cos(node), e2, Math.sin(node));
  const M = comb(e1, -Math.sin(node), e2, Math.cos(node));
  const Mi = comb(M, Math.cos(incl), n, Math.sin(incl));
  const P = comb(N, Math.cos(argp), Mi, Math.sin(argp));
  const Q = comb(N, -Math.sin(argp), Mi, Math.cos(argp));
  return { P, Q, W: cross(N, Mi), N };
}

export function buildSystem(data) {
  const K = data.constants, list = data.bodies, n = list.length;
  const sysIdx = new Map(data.systems.map((s, i) => [s.id, i]));
  const idx = new Map(list.map((b, i) => [b.id, i]));
  const S = {
    n, nSys: data.systems.length, K,
    id: list.map(b => b.id), name: list.map(b => b.name), index: idx,
    kind: new Uint8Array(n), sys: new Uint8Array(n),
    parent: new Int16Array(n).fill(-1),          // body orbited, -1 for stars
    star: new Int16Array(n).fill(-1),            // star that lights the body, -1 for stars
    radius: new Float64Array(n), mass: new Float64Array(n),
    hasOrbit: new Uint8Array(n),
    a: new Float64Array(n), e: new Float64Array(n), meanMotion: new Float64Array(n), M0: new Float64Array(n),
    P: new Float64Array(n * 3), Q: new Float64Array(n * 3),
    axis: new Float64Array(n * 3), spinU: new Float64Array(n * 3), spinV: new Float64Array(n * 3),
    spinRate: new Float64Array(n), spin0: new Float64Array(n),
    pos: new Float64Array(n * 3), dpos: new Float64Array(n * 3),
    vdir: new Float64Array(n * 3),               // unit direction of orbital motion relative to the parent (zero if none)
    rot: new Float64Array(n * 9),                // rows X, Y (spin axis), Z of the world->local matrix
    sysPos: new Float64Array(data.systems.length * 3),
    time: NaN,
  };
  data.systems.forEach((s, i) => { for (let k = 0; k < 3; k++) S.sysPos[i * 3 + k] = s.posLy[k] * K.LY_km; });
  const put = (arr, i, v) => { arr[i * 3] = v[0]; arr[i * 3 + 1] = v[1]; arr[i * 3 + 2] = v[2]; };
  const get = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
  const systemStar = new Map();

  list.forEach((b, i) => {
    if (!(b.kind in KIND)) throw new Error(`system.json: ${b.id} has unknown kind "${b.kind}"`);
    if (!sysIdx.has(b.system)) throw new Error(`system.json: ${b.id} is in unknown system "${b.system}"`);
    S.kind[i] = KIND[b.kind];
    S.sys[i] = sysIdx.get(b.system);
    S.radius[i] = radiusKm(b, K);
    if (!(S.radius[i] > 0)) throw new Error(`system.json: ${b.id} has no radius`);
    S.mass[i] = massKg(b, K) ?? 0;
    if (S.kind[i] === STAR && !systemStar.has(b.system)) systemStar.set(b.system, i);

    let W = [0, 1, 0], N = [1, 0, 0], argp = 0;
    if (b.orbit) {
      if (!idx.has(b.parent)) throw new Error(`system.json: ${b.id} orbits unknown body "${b.parent}"`);
      const p = idx.get(b.parent);
      if (p >= i) throw new Error(`system.json: ${b.id} must be listed after its parent ${b.parent}`);
      const o = b.orbit;
      S.parent[i] = p;
      S.hasOrbit[i] = 1;
      S.a[i] = semiMajorKm(o, K);
      S.e[i] = o.e ?? 0;
      S.meanMotion[i] = 2 * Math.PI / periodS(S.a[i], S.mass[p] + S.mass[i], K);
      S.M0[i] = o.periDaysBeforeEpoch != null ? S.meanMotion[i] * o.periDaysBeforeEpoch * DAY : (o.phaseDeg ?? 0) * DEG;
      argp = (o.periDeg ?? hash01(b.id + ':peri') * 360) * DEG;
      const refNormal = S.kind[p] === STAR ? [0, 1, 0] : get(S.axis, p);
      const f = orbitFrame(refNormal, (o.incDeg ?? 0) * DEG, (o.nodeDeg ?? hash01(b.id + ':node') * 360) * DEG, argp);
      put(S.P, i, f.P); put(S.Q, i, f.Q);
      W = f.W; N = f.N;
    }
    S.star[i] = S.kind[i] === STAR ? -1 : systemStar.get(b.system) ?? -1;

    // spin: axis, a reference direction U in the equator, V = axis x U, angle = spin0 + spinRate * t
    let axis, U;
    const locked = !!b.tidallyLocked;
    if (S.kind[i] === STAR) {
      const t = 7 * DEG, az = hash01(b.id + ':tilt') * 2 * Math.PI;
      axis = normalize([Math.sin(t) * Math.cos(az), Math.cos(t), Math.sin(t) * Math.sin(az)]);
    } else if (locked || b.tiltDeg == null) {
      axis = W;
    } else {
      const t = b.tiltDeg * DEG, az = (b.tiltAzDeg ?? hash01(b.id + ':tilt') * 360) * DEG;
      axis = normalize(comb(W, Math.cos(t), get(S.P, i), Math.sin(t) * Math.cos(az), get(S.Q, i), Math.sin(t) * Math.sin(az)));
    }
    if (locked) {
      U = N;                                               // local +X faces the parent: angle = argp + M + pi
      S.spinRate[i] = S.meanMotion[i];
      S.spin0[i] = argp + S.M0[i] + Math.PI;
    } else {
      U = planeBasis(axis)[0];
      let period = 0;
      if (b.rotationHours) period = b.rotationHours * 3600;
      else if (b.rotationDays) period = b.rotationDays * DAY;
      else if (b.spinSeconds) period = b.spinSeconds;
      else if (b.spinOrbit) period = 2 * Math.PI / S.meanMotion[i] * b.spinOrbit[1] / b.spinOrbit[0];
      else period = 10 * 3600;
      S.spinRate[i] = 2 * Math.PI / period;
      S.spin0[i] = hash01(b.id + ':spin') * 2 * Math.PI;
    }
    put(S.axis, i, axis); put(S.spinU, i, U); put(S.spinV, i, cross(axis, U));
  });

  // close binaries: both stars circle the barycentre, which is the system origin
  for (const s of data.systems) {
    if (!s.binary) continue;
    const ia = idx.get(s.binary.a), ib = idx.get(s.binary.b);
    if (ia == null || ib == null) throw new Error(`system.json: binary in ${s.id} names an unknown star`);
    const sep = s.binary.separationAU * K.AU_km, mt = S.mass[ia] + S.mass[ib];
    const nMot = 2 * Math.PI / periodS(sep, mt, K);
    const f = orbitFrame([0, 1, 0], (s.binary.incDeg ?? 24) * DEG, hash01(s.id + ':node') * 2 * Math.PI, 0);
    for (const [i, frac, phase] of [[ia, S.mass[ib] / mt, 0], [ib, S.mass[ia] / mt, Math.PI]]) {
      S.hasOrbit[i] = 1; S.a[i] = sep * frac; S.e[i] = s.binary.e ?? 0; S.meanMotion[i] = nMot; S.M0[i] = phase;
      put(S.P, i, f.P); put(S.Q, i, f.Q);
    }
  }
  return S;
}

/** Advance every body to simulation time t (seconds). Parents precede children in the table, so one pass suffices. */
export function stepSystem(S, t) {
  const first = S.time !== S.time;                         // NaN before the first step
  const pos = S.pos, dpos = S.dpos, P = S.P, Q = S.Q, rot = S.rot, axis = S.axis, spinU = S.spinU, spinV = S.spinV;
  for (let i = 0; i < S.n; i++) {
    const o = i * 3;
    let x = 0, y = 0, z = 0;
    if (S.hasOrbit[i]) {
      const e = S.e[i], a = S.a[i];
      const E = solveKepler(S.M0[i] + S.meanMotion[i] * t, e);
      const u = a * (Math.cos(E) - e), v = a * Math.sqrt(1 - e * e) * Math.sin(E);
      x = P[o] * u + Q[o] * v; y = P[o + 1] * u + Q[o + 1] * v; z = P[o + 2] * u + Q[o + 2] * v;
      // velocity is along dr/dE = -a sin E P + a sqrt(1 - e^2) cos E Q
      const du = -Math.sin(E), dv = Math.sqrt(1 - e * e) * Math.cos(E), dl = 1 / Math.sqrt(du * du + dv * dv);
      S.vdir[o] = (P[o] * du + Q[o] * dv) * dl; S.vdir[o + 1] = (P[o + 1] * du + Q[o + 1] * dv) * dl; S.vdir[o + 2] = (P[o + 2] * du + Q[o + 2] * dv) * dl;
      const p = S.parent[i];
      if (p >= 0) { x += pos[p * 3]; y += pos[p * 3 + 1]; z += pos[p * 3 + 2]; }
    }
    dpos[o] = first ? 0 : x - pos[o]; dpos[o + 1] = first ? 0 : y - pos[o + 1]; dpos[o + 2] = first ? 0 : z - pos[o + 2];
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;

    let ang = S.spin0[i] + S.spinRate[i] * t;
    ang -= 2 * Math.PI * Math.floor(ang / (2 * Math.PI));
    const c = Math.cos(ang), s = Math.sin(ang), r = i * 9;
    const Xx = spinU[o] * c + spinV[o] * s, Xy = spinU[o + 1] * c + spinV[o + 1] * s, Xz = spinU[o + 2] * c + spinV[o + 2] * s;
    const Yx = axis[o], Yy = axis[o + 1], Yz = axis[o + 2];
    rot[r] = Xx; rot[r + 1] = Xy; rot[r + 2] = Xz;
    rot[r + 3] = Yx; rot[r + 4] = Yy; rot[r + 5] = Yz;
    rot[r + 6] = Xy * Yz - Xz * Yy; rot[r + 7] = Xz * Yx - Xx * Yz; rot[r + 8] = Xx * Yy - Xy * Yx;   // Z = X x Y
  }
  S.time = t;
}

/**
 * Position of body i relative to a camera at camPos in system camSys, written to out[o..o+2] (doubles, km).
 * The inter-system offset is exactly zero when the body is in the camera's own system.
 */
export function relToCamera(S, i, camSys, camPos, out, o = 0) {
  const s = S.sys[i] * 3, c = camSys * 3, p = i * 3;
  out[o] = (S.sysPos[s] - S.sysPos[c]) + S.pos[p] - camPos[0];
  out[o + 1] = (S.sysPos[s + 1] - S.sysPos[c + 1]) + S.pos[p + 1] - camPos[1];
  out[o + 2] = (S.sysPos[s + 2] - S.sysPos[c + 2]) + S.pos[p + 2] - camPos[2];
  return out;
}

/**
 * World->local rotation rows of body i for spin angle ang (radians), written to out[o..o+8] as X, Y (axis), Z.
 * stepSystem uses the simulation clock; the pulsar is spun from the animation clock instead so its 1.3 s
 * period stays readable at any time rate.
 */
export function spinRows(S, i, ang, out, o = 0) {
  const p = i * 3, c = Math.cos(ang), s = Math.sin(ang);
  const Xx = S.spinU[p] * c + S.spinV[p] * s, Xy = S.spinU[p + 1] * c + S.spinV[p + 1] * s, Xz = S.spinU[p + 2] * c + S.spinV[p + 2] * s;
  const Yx = S.axis[p], Yy = S.axis[p + 1], Yz = S.axis[p + 2];
  out[o] = Xx; out[o + 1] = Xy; out[o + 2] = Xz;
  out[o + 3] = Yx; out[o + 4] = Yy; out[o + 5] = Yz;
  out[o + 6] = Xy * Yz - Xz * Yy; out[o + 7] = Xz * Yx - Xx * Yz; out[o + 8] = Xx * Yy - Xy * Yx;
  return out;
}
