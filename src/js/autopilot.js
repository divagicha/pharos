// Autopilot warp: carries the camera from where it is to a standing point beside a (moving) body.
//
// Path: P = A + (B(t) - A)*u(s). u leaves A exponentially and arrives at B exponentially, so the camera spends
// its time near both ends and crosses the gulf between in a blink; the destination stays small until late
// and then grows smoothly. The exponent k is fitted to the ratio of trip length to arrival distance, which is
// what lets one curve serve a hop between moons and a jump of thirty light-years alike.
//
// begin() runs on a key press or a click; update() is in the frame path and allocates nothing.
import { cam, updateBasis } from './camera.js';
import { STAR } from './sim.js';
import { quatLook, quatSlerp, smoothstep, hyp, DEG } from './math.js';

export const auto = {
  active: false,
  target: -1,            // body index
  t: 0, duration: 5,     // seconds
  warp: 0,               // 0..1: strength of the warp look (streaks, colour fringing)
  k: 12,
  A: new Float64Array(3), sysA: 0,          // start, relative to the origin of system sysA
  offset: new Float64Array(3),              // standing point relative to the target's centre
  bend: new Float64Array(3), bendAt: 0.5,   // sideways detour around a body in the way, and where along the path
  qA: new Float64Array(4),
};

const B = new Float64Array(3), Ac = new Float64Array(3), f = new Float64Array(3), qL = new Float64Array(4);
const UP = new Float64Array([0, 1, 0]);

/**
 * Fraction of the way from A to B at eased time s in [0, 1], and its complement, for exponent k.
 * Returns u; the complement 1 - u is written to `out[0]` computed without cancellation, so the last metres
 * of an interstellar trip are as precise as the first.
 */
export function warpFraction(s, k, out) {
  const den = Math.expm1(k);
  if (s < 0.5) { const u = 0.5 * Math.expm1(2 * k * s) / den; out[0] = 1 - u; return u; }
  const r = 0.5 * Math.expm1(2 * k * (1 - s)) / den;
  out[0] = r;
  return 1 - r;
}

/** Exponent that makes the last tenth or so of the trip happen within one arrival distance of the end. */
export function warpExponent(tripKm, arriveKm) { return Math.min(34, Math.max(6, Math.log(Math.max(tripKm / arriveKm, 1)) + 1.5)); }

/** How far from the centre of body i the autopilot parks, in km. */
export function standoff(S, i, spinSeconds) {
  if (S.kind[i] !== STAR) return S.radius[i] * 3.2;
  return S.radius[i] * (spinSeconds > 0 ? 30 : 4.5);
}

const rem = [0];

/**
 * Start a warp to body i.
 * @param {object} S simulation state   @param {number} i target body   @param {number} seconds trip duration
 * @param {number} standKm distance from the target's centre to park at
 */
export function begin(S, i, seconds, standKm) {
  auto.active = true; auto.target = i; auto.t = 0; auto.duration = seconds;
  auto.A[0] = cam.pos[0]; auto.A[1] = cam.pos[1]; auto.A[2] = cam.pos[2]; auto.sysA = cam.sys;
  auto.qA[0] = cam.q[0]; auto.qA[1] = cam.q[1]; auto.qA[2] = cam.q[2]; auto.qA[3] = cam.q[3];
  targetPoint(S, i, B);                                  // target centre relative to the camera's system
  // direction from the target back towards the camera
  let dx = cam.pos[0] - B[0], dy = cam.pos[1] - B[1], dz = cam.pos[2] - B[2];
  const dist = hyp(dx, dy, dz) || 1;
  dx /= dist; dy /= dist; dz /= dist;
  const s = S.star[i];
  if (s >= 0) {
    // a planet or moon: park on the day side with the terminator in view, on whichever side the camera comes from
    let sx = S.pos[s * 3] - S.pos[i * 3], sy = S.pos[s * 3 + 1] - S.pos[i * 3 + 1], sz = S.pos[s * 3 + 2] - S.pos[i * 3 + 2];
    const sl = hyp(sx, sy, sz); sx /= sl; sy /= sl; sz /= sl;
    let tx = sz, tz = -sx;                               // UP x sun: sideways in the orbital plane
    const tl = hyp(tx, tz, 0) || 1; tx /= tl; tz /= tl;
    const side = dx * tx + dz * tz < 0 ? -1 : 1;
    const az = 52 * DEG, el = 12 * DEG, ce = Math.cos(el);
    dx = ce * (Math.cos(az) * sx + Math.sin(az) * tx * side);
    dy = ce * Math.cos(az) * sy + Math.sin(el);
    dz = ce * (Math.cos(az) * sz + Math.sin(az) * tz * side);
    const dl = hyp(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
  }
  auto.offset[0] = dx * standKm; auto.offset[1] = dy * standKm; auto.offset[2] = dz * standKm;
  auto.k = warpExponent(dist, standKm);
  planDetour(S, i);
}

/** Centre of body i relative to the origin of the camera's current system. */
function targetPoint(S, i, out) {
  const s = S.sys[i] * 3, c = cam.sys * 3;
  out[0] = S.sysPos[s] - S.sysPos[c] + S.pos[i * 3];
  out[1] = S.sysPos[s + 1] - S.sysPos[c + 1] + S.pos[i * 3 + 1];
  out[2] = S.sysPos[s + 2] - S.sysPos[c + 2] + S.pos[i * 3 + 2];
  return out;
}

/**
 * If the straight line from a to b (points relative to the origin of system `sys`) grazes a body of that system,
 * return how to bow the path around it: writes the sideways offset (km) to bend[0..2] and returns the fraction
 * of the way along at which it should peak. With nothing in the way the offset is zero. Allocates nothing.
 */
export function detour(S, sys, ax, ay, az, bx, by, bz, bend) {
  bend[0] = 0; bend[1] = 0; bend[2] = 0;
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const len2 = ex * ex + ey * ey + ez * ez;
  let worst = 0, at = 0.5;
  if (len2 <= 0) return at;
  for (let j = 0; j < S.n; j++) {
    if (S.sys[j] !== sys) continue;
    const px = S.pos[j * 3] - ax, py = S.pos[j * 3 + 1] - ay, pz = S.pos[j * 3 + 2] - az;
    const u = (px * ex + py * ey + pz * ez) / len2;
    if (u <= 0.02 || u >= 0.98) continue;                // the ends are handled by the standing distance
    let cx = ex * u - px, cy = ey * u - py, cz = ez * u - pz;   // from the body to the closest point of the path
    const d = hyp(cx, cy, cz), clear = S.radius[j] * (S.kind[j] === STAR ? 3.5 : 2.2);
    const need = clear - d;
    if (need <= worst) continue;
    worst = need; at = u;
    if (d < 1e-6) { cx = 0; cy = 1; cz = 0; } else { cx /= d; cy /= d; cz /= d; }
    bend[0] = cx * need; bend[1] = cy * need; bend[2] = cz * need;
  }
  return at;
}

/** Plan the detour for the trip that begin() has just set up (bodies of the camera's own system only). */
function planDetour(S, target) {
  targetPoint(S, target, B);
  auto.bendAt = detour(S, cam.sys, cam.pos[0], cam.pos[1], cam.pos[2], B[0] + auto.offset[0], B[1] + auto.offset[1], B[2] + auto.offset[2], auto.bend);
}

/** Strength of the warp look (streaks, colour fringing) at fraction `raw` of a trip: 0 at both ends. */
export function warpLook(raw) {
  return Math.pow(Math.sin(Math.PI * raw), 0.6) * smoothstep(0.0, 0.15, raw) * (1 - smoothstep(0.85, 1, raw));
}

/**
 * Advance the warp by dt seconds and place the camera. Returns true on the frame it arrives.
 * Call after the bodies have been stepped for this frame.
 */
export function update(S, dt) {
  if (!auto.active) return false;
  auto.t += dt;
  const raw = Math.min(1, auto.t / auto.duration), s = smoothstep(0, 1, raw);
  const u = warpFraction(s, auto.k, rem);
  // both ends in the frame of the system the camera is in now
  const c = cam.sys * 3, a = auto.sysA * 3;
  Ac[0] = auto.A[0] + S.sysPos[a] - S.sysPos[c]; Ac[1] = auto.A[1] + S.sysPos[a + 1] - S.sysPos[c + 1]; Ac[2] = auto.A[2] + S.sysPos[a + 2] - S.sysPos[c + 2];
  targetPoint(S, auto.target, B);
  const bx = B[0] + auto.offset[0], by = B[1] + auto.offset[1], bz = B[2] + auto.offset[2];
  // a bump that is zero at both ends and peaks where the detour is needed
  const g = u < auto.bendAt ? smoothstep(0, auto.bendAt, u) : 1 - smoothstep(auto.bendAt, 1, u);
  if (s < 0.5) {
    cam.pos[0] = Ac[0] + (bx - Ac[0]) * u; cam.pos[1] = Ac[1] + (by - Ac[1]) * u; cam.pos[2] = Ac[2] + (bz - Ac[2]) * u;
  } else {
    cam.pos[0] = bx + (Ac[0] - bx) * rem[0]; cam.pos[1] = by + (Ac[1] - by) * rem[0]; cam.pos[2] = bz + (Ac[2] - bz) * rem[0];
  }
  cam.pos[0] += auto.bend[0] * g; cam.pos[1] += auto.bend[1] * g; cam.pos[2] += auto.bend[2] * g;
  // turn towards the target early in the trip, then hold it centred
  f[0] = B[0] - cam.pos[0]; f[1] = B[1] - cam.pos[1]; f[2] = B[2] - cam.pos[2];
  const fl = hyp(f[0], f[1], f[2]) || 1;
  f[0] /= fl; f[1] /= fl; f[2] /= fl;
  quatLook(qL, f, UP);
  quatSlerp(cam.q, auto.qA, qL, smoothstep(0, 0.32, raw));
  updateBasis();
  auto.warp = warpLook(raw);
  if (raw >= 1) { auto.active = false; auto.warp = 0; return true; }
  return false;
}

/** Abandon the warp where the camera is. */
export function cancel() { auto.active = false; auto.warp = 0; }
