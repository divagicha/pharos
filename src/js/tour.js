// The six fixed poses and the scripted grand tour.
//
// Both are pure functions of their argument (a pose number, a tour time): nothing depends on what was shown
// before, so any moment of the tour can be captured on its own (?tt=) and always looks the same.
//
// A shot is a camera that rides with an anchor (a body, or a fixed point in the asteroid belt) on key-framed
// spherical coordinates: distance, azimuth from the direction of the anchor's star, elevation, then yaw, pitch
// and roll off the line to the anchor. Between two shots the camera warps: P = A(t) + (B(t) - A(t)) * u, where
// both shots are extended past their ends so the camera never stands still, u is the autopilot's exponential
// curve, and the path bows around anything in the way exactly as the autopilot's does.
//
// Contract
//   initTour(S, data)     once: resolve names, place the belt anchor
//   tourAt(t, S)          frame path, allocates nothing. Needs stepSystem(S, tourSimTime(t)) first. Sets the
//                         camera, flight.vel / flight.speed (the camera's own motion, without the anchor's
//                         orbital drift) and the `tour` fields below.
//   applyPose(n, S)       start-up: place the camera for pose n; returns the pose record (day, clock, sel, panel)
// A pose or shot marked `eq` is laid out in its body's equatorial frame instead of the ecliptic: azimuth still
// starts at the star's direction, but elevation is height above the equator (and the rings), which is level on screen.
import { cam, updateBasis } from './camera.js';
import { flight, viewPose, bodyFrame, placeView } from './flight.js';
import { warpFraction, warpExponent, warpLook, detour } from './autopilot.js';
import { quatLook, quatSlerp, smoothstep, clamp } from './math.js';
import { DAY } from './derive.js';

export const TOUR_SECONDS = 60;
export const TIME_RATE = 100;            // simulated seconds per second of real time
const TOUR_DAY = 3.2;                    // simulation epoch of the tour, in days
const CUT_OPEN_S = 1.4, CUT_CLOSE_S = 0.9;

/** What the tour wants shown besides the camera. */
export const tour = {
  sel: -1,          // body the HUD targets
  panel: false,     // telemetry panels up
  open: 0,          // cutaway opening, 0..1
  warp: 0,          // strength of the warp look
  eta: -1,          // seconds to the end of the current warp, -1 outside one
};

// Poses: view = [body, distance in radii, azimuth, elevation, yaw, pitch, roll] (degrees; see placeView).
export const POSES = {
  // 1 low orbit, 400 km up on the night side of the terminator, looking back over the limb at the rising star
  1: { view: ['pelagia', 1.062, 98, 10, -60, 5, -82], day: 3.2, clock: 30 },
  // 2 just above the ring plane and just outside the rings, the planet half lit and its shadow across the far rings
  2: { view: ['nivalis', 2.75, 86, 4.2, 2, 1, 0], eq: true, day: 3.2, clock: 30 },
  // 3 the host star's limb with its loops against the corona
  3: { view: ['pharos', 1.8, 40, 10, 32, 0, 0], day: 3.2, clock: 30 },
  // 4 a planet cut open, panels up, cursor mode
  4: { view: ['pelagia', 3.2, 52, 12, 0, 0, 0], day: 3.2, clock: 30, sel: 'pelagia', panel: true },
  // 5 a neighbouring star under inspection
  5: { view: ['caerulea', 4.5, 30, 8, 0, 0, 0], day: 3.2, clock: 30, sel: 'caerulea', panel: true },
  // 6 the ringed planet and its moons against the nebula, twenty years on, when the geometry lines up
  6: { view: ['nivalis', 6.4, -110, -5, -27, 1, 0], day: 7550.2, clock: 30 },
};

// Shots, in order. keys: [time, distance, azimuth, elevation, yaw, pitch, roll]; distance is in radii of the
// anchor body, or in km for a shot marked `km`. The gaps between shots are the warps.
// The curve through the keys takes its slope at each key from the neighbours on both sides, so a key that is
// followed by a large change needs a second key close behind it to hold the curve level before it (Pelagia at
// 18.6 s: without it the pull-back to 3.2 radii dragged the whole low-orbit pass down onto the altitude floor).
const SHOTS = [
  { at: 'pharos', keys: [[0, 2.5, 30, 8, 22, 2, 0], [4.0, 1.9, 50, 11, 30, 2, 0]] },
  { at: 'ignis', keys: [[6.8, 1.45, 128, 8, 28, -2, 0], [11.0, 1.3, 152, 5, 33, -3, 0]] },
  { at: 'pelagia', keys: [[13.8, 1.068, 59, 13, 0, 61, 0], [18.3, 1.062, 74, 13, 0, 62, 0], [18.6, 1.075, 74.4, 13, 0, 60, 0], [20.0, 3.2, 60, 12, 0, 0, 0], [25.0, 3.2, 55, 12, 0, 0, 0]], cut: [20.3, 24.7] },
  { at: 'belt', km: true, keys: [[27.8, 2600, 96, 4, 80, 0, 0], [32.0, 2600, 122, 3, 82, 1, 5]] },
  { at: 'wayfarer', km: true, keys: [[34.5, 4.6e6, 84, 14, 34, 0, 0], [37.5, 3.6e6, 92, 11, 36, 0, 0]] },
  { at: 'boreas', keys: [[40.3, 3.3, 56, 8, 0, 0, 0], [44.8, 2.5, 74, 5, 6, 0, 0]] },
  { at: 'nivalis', eq: true, keys: [[47.6, 2.95, 60, 3.6, 0, 0.5, 0], [52.4, 2.8, 92, -3.2, 4, 1, 0]] },
  { at: 'metronome', keys: [[55.4, 34, 30, 20, 0, 0, 0], [58.0, 26, 44, 16, 0, 0, 0]] },
  { at: 'nivalis', eq: true, keys: [[60.0, 6.2, 42, 9, 0, 0, 0], [64.0, 6.0, 46, 9, 0, 0, 0]] },
];
const BELT_ANGLE = 1.9;                  // where on the belt's circle the fly-through happens (radians)

const N_PAR = 6;
const par = new Float64Array(N_PAR);
const pA = new Float64Array(3), pB = new Float64Array(3), qA = new Float64Array(4), qB = new Float64Array(4), qL = new Float64Array(4);
const anchor = new Float64Array(3), bend = new Float64Array(3), aim = new Float64Array(3), prev = new Float64Array(3), prevQ = new Float64Array(4);
const UP = new Float64Array([0, 1, 0]), rem = [0], sunDir = new Float64Array(3), north = new Float64Array(3);

export function tourSimTime(t) { return TOUR_DAY * DAY + t * TIME_RATE; }
export function tourClock(t) { return 30 + t; }

export function initTour(S, data) {
  const K = data.constants, R = data.belt.majorAU * K.AU_km;
  for (const shot of SHOTS) {
    shot.body = shot.at === 'belt' ? -1 : S.index.get(shot.at);
    if (shot.body === undefined) throw new Error(`tour: unknown body "${shot.at}"`);
    shot.sys = shot.body >= 0 ? S.sys[shot.body] : 0;
    shot.point = [R * Math.cos(BELT_ANGLE), 0, R * Math.sin(BELT_ANGLE)];
    shot.t0 = shot.keys[0][0]; shot.t1 = shot.keys[shot.keys.length - 1][0];
  }
}

/** Slope of parameter p at key j: the average slope of the two neighbouring spans, one-sided at the ends. */
function slope(keys, j, p) {
  const a = Math.max(j - 1, 0), b = Math.min(j + 1, keys.length - 1);
  return (keys[b][p] - keys[a][p]) / (keys[b][0] - keys[a][0]);
}

/** Key-framed parameters at time t into `par`: a smooth curve through the keys, continued in a straight line beyond them. */
function evalKeys(keys, t) {
  const n = keys.length;
  if (t <= keys[0][0] || t >= keys[n - 1][0]) {
    const j = t <= keys[0][0] ? 0 : n - 1, dt = t - keys[j][0];
    for (let p = 0; p < N_PAR; p++) par[p] = keys[j][p + 1] + slope(keys, j, p + 1) * dt;
    return;
  }
  let j = 0;
  while (t >= keys[j + 1][0]) j++;
  const h = keys[j + 1][0] - keys[j][0], s = (t - keys[j][0]) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  for (let p = 1; p <= N_PAR; p++) {
    par[p - 1] = h00 * keys[j][p] + h10 * h * slope(keys, j, p) + h01 * keys[j + 1][p] + h11 * h * slope(keys, j + 1, p);
  }
}

/** Pose of one shot at time t. Writes the camera position, orientation and the anchor's centre; returns the distance to the anchor (km). */
function shotPose(shot, t, S, pos, q, centre) {
  evalKeys(shot.keys, t);
  let unit = 1;
  if (shot.body >= 0) {
    bodyFrame(S, shot.body, !!shot.eq, centre, sunDir, north);
    if (!shot.km) unit = S.radius[shot.body];
  } else {
    centre[0] = shot.point[0]; centre[1] = shot.point[1]; centre[2] = shot.point[2];
    sunDir[0] = -centre[0]; sunDir[1] = -centre[1]; sunDir[2] = -centre[2];
    north[0] = 0; north[1] = 1; north[2] = 0;
  }
  const dist = Math.max(par[0], shot.km ? 1 : 1.03) * unit;
  viewPose(centre, sunDir, north, dist, par[1], par[2], par[3], par[4], par[5], pos, q);
  return dist;
}

/** Cutaway opening of a shot at time t: a ramp up after cut[0] and down to zero at cut[1]. */
function cutOpening(shot, t) {
  if (!shot.cut) return 0;
  return clamp((t - shot.cut[0]) / CUT_OPEN_S, 0, 1) - clamp((t - (shot.cut[1] - CUT_CLOSE_S)) / CUT_CLOSE_S, 0, 1);
}

/** Camera position (relative to the returned system's origin) and orientation at tour time t; also fills `tour`. */
function tourPose(t, S, pos, q) {
  let k = 0;
  while (k < SHOTS.length - 1 && t >= SHOTS[k + 1].t0) k++;
  const a = SHOTS[k];
  if (t <= a.t1 || k === SHOTS.length - 1) {
    shotPose(a, t, S, pos, q, anchor);
    tour.sel = a.body; tour.warp = 0; tour.eta = -1;
    tour.open = cutOpening(a, t); tour.panel = tour.open > 0 && t < a.cut[1] - CUT_CLOSE_S;
    return a.sys;
  }
  const b = SHOTS[k + 1];
  const raw = (t - a.t1) / (b.t0 - a.t1), s = smoothstep(0, 1, raw);
  shotPose(a, t, S, pA, qA, anchor);
  const stand = shotPose(b, t, S, pB, qB, anchor);
  // everything in A's frame for the first half of the trip and in B's for the second, so the near end is exact
  const oa = a.sys * 3, ob = b.sys * 3;
  const dx = S.sysPos[ob] - S.sysPos[oa], dy = S.sysPos[ob + 1] - S.sysPos[oa + 1], dz = S.sysPos[ob + 2] - S.sysPos[oa + 2];
  const ex = pB[0] + dx - pA[0], ey = pB[1] + dy - pA[1], ez = pB[2] + dz - pA[2];
  const u = warpFraction(s, warpExponent(Math.sqrt(ex * ex + ey * ey + ez * ez), stand), rem);
  let g = 0;
  if (a.sys === b.sys) {
    const at = detour(S, a.sys, pA[0], pA[1], pA[2], pB[0], pB[1], pB[2], bend);
    g = u < at ? smoothstep(0, at, u) : 1 - smoothstep(at, 1, u);
  }
  const first = s < 0.5;
  if (first) { pos[0] = pA[0] + ex * u; pos[1] = pA[1] + ey * u; pos[2] = pA[2] + ez * u; }
  else { pos[0] = pB[0] - ex * rem[0]; pos[1] = pB[1] - ey * rem[0]; pos[2] = pB[2] - ez * rem[0]; }
  if (g > 0) { pos[0] += bend[0] * g; pos[1] += bend[1] * g; pos[2] += bend[2] * g; }
  // A's view, then the destination dead ahead, then B's view
  aim[0] = anchor[0] + (first ? dx : 0) - pos[0]; aim[1] = anchor[1] + (first ? dy : 0) - pos[1]; aim[2] = anchor[2] + (first ? dz : 0) - pos[2];
  const al = Math.sqrt(aim[0] * aim[0] + aim[1] * aim[1] + aim[2] * aim[2]) || 1;
  aim[0] /= al; aim[1] /= al; aim[2] /= al;
  quatLook(qL, aim, UP);
  quatSlerp(q, qA, qL, smoothstep(0, 0.35, raw));
  quatSlerp(q, q, qB, smoothstep(0.68, 1, raw));
  tour.sel = b.body; tour.warp = warpLook(raw); tour.eta = b.t0 - t; tour.open = 0; tour.panel = false;
  return first ? a.sys : b.sys;
}

const STEP = 1 / 240;                    // the camera's own velocity is the change of pose over this interval

export function tourAt(t, S) {
  const s0 = tourPose(t - STEP, S, prev, prevQ);
  const sys = tourPose(t, S, cam.pos, cam.q);
  cam.sys = sys;
  updateBasis();
  const o = sys * 3, p = s0 * 3, v = flight.vel;
  for (let k = 0; k < 3; k++) v[k] = (cam.pos[k] - (prev[k] + S.sysPos[p + k] - S.sysPos[o + k])) / STEP;
  flight.speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function applyPose(n, S) {
  const pose = POSES[n];
  if (!pose) throw new Error(`?pose=${n}: there are poses 1 to ${Object.keys(POSES).length}`);
  const v = pose.view;
  placeView(S, S.index.get(v[0]), v[1], v[2], v[3], v[4], v[5], v[6], pose.eq);
  return pose;
}
