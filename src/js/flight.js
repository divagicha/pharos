// Camera motion: free flight, co-moving with nearby bodies, the altitude floor and system switching.
// Everything here is in the frame path and allocates nothing.
import { cam, updateBasis, rotateLocal } from './camera.js';
import { STAR } from './sim.js';
import { quatLook, quatMul, quatAxisAngle, quatNorm, smoothstep, DEG } from './math.js';

export const flight = {
  nearest: -1,            // index of the body whose surface is closest
  altitude: 1e30,         // km above that surface
  speed: 0,               // km/s actually flown this frame
  throttle: new Float64Array(3),   // smoothed local-axis command: right, up, forward
  vel: new Float64Array(3),        // the camera's own velocity this frame, world axes (km/s), without co-moving drift
  ceiling: 1e30,                   // cap on the altitude used for speed (set while inside the asteroid belt)
};

const MIN_ALT_FRACTION = 0.01;     // keep the camera above 1.01 R
const LOOK_SENS = 0.0016;          // radians per pixel of mouse travel
const ROLL_RATE = 1.2;             // radians per second

/** Find the nearest surface. Needs scene.computeRel() first. */
export function findNearest(scene, S) {
  let best = -1, alt = 1e30;
  for (let i = 0; i < S.n; i++) {
    const a = scene.dist[i] - S.radius[i];
    if (a < alt) { alt = a; best = i; }
  }
  flight.nearest = best; flight.altitude = alt;
}

/**
 * Carry the camera along with whatever it is near, so planets do not leave at orbital speed.
 * cam.pos += w_moon*dPos_moon + (1 - w_moon)*w_planet*dPos_planet, each weight falling smoothly from 1 inside
 * a body's neighbourhood to 0 outside it. Needs scene.computeRel() from before the bodies moved or after; the
 * weights change slowly either way.
 */
export function coMove(scene, S) {
  let wm = 0, im = -1, wp = 0, ip = -1;
  for (let i = 0; i < S.n; i++) {
    if (!S.hasOrbit[i]) continue;
    const p = S.parent[i];
    const isMoon = p >= 0 && S.kind[p] !== STAR;
    const reach = Math.max(S.radius[i] * (isMoon ? 12 : 60), 3000);
    const w = 1 - smoothstep(reach, reach * 2, scene.dist[i]);
    if (isMoon) { if (w > wm) { wm = w; im = i; } } else if (w > wp) { wp = w; ip = i; }
  }
  const kp = (1 - wm) * wp;
  if (im >= 0) { cam.pos[0] += wm * S.dpos[im * 3]; cam.pos[1] += wm * S.dpos[im * 3 + 1]; cam.pos[2] += wm * S.dpos[im * 3 + 2]; }
  if (ip >= 0) { cam.pos[0] += kp * S.dpos[ip * 3]; cam.pos[1] += kp * S.dpos[ip * 3 + 1]; cam.pos[2] += kp * S.dpos[ip * 3 + 2]; }
}

/** Free flight from the input state. Speed scales with height above the nearest surface. */
export function fly(dt, input) {
  if (input.locked) rotateLocal(-input.lookX * LOOK_SENS, -input.lookY * LOOK_SENS, 0);
  input.lookX = 0; input.lookY = 0;
  if (input.roll !== 0) rotateLocal(0, 0, input.roll * ROLL_RATE * dt);
  if (input.wheel !== 0) { cam.speedFactor = Math.min(64, Math.max(1 / 64, cam.speedFactor * Math.pow(1.2, -input.wheel))); input.wheel = 0; }
  const th = flight.throttle, k = 1 - Math.exp(-dt * 7);
  th[0] += (input.strafe - th[0]) * k; th[1] += (input.lift - th[1]) * k; th[2] += (input.forward - th[2]) * k;
  const speed = 0.25 * cam.speedFactor * (input.boost ? 10 : 1) * Math.max(Math.min(flight.altitude, flight.ceiling), 20);
  const v = flight.vel;
  v[0] = (cam.right[0] * th[0] + cam.up[0] * th[1] + cam.fwd[0] * th[2]) * speed;
  v[1] = (cam.right[1] * th[0] + cam.up[1] * th[1] + cam.fwd[1] * th[2]) * speed;
  v[2] = (cam.right[2] * th[0] + cam.up[2] * th[1] + cam.fwd[2] * th[2]) * speed;
  cam.pos[0] += v[0] * dt; cam.pos[1] += v[1] * dt; cam.pos[2] += v[2] * dt;
  flight.speed = speed * Math.sqrt(th[0] * th[0] + th[1] * th[1] + th[2] * th[2]);
}

/** Push the camera back out if it has gone below the altitude floor of the nearest body. Needs a fresh computeRel(). */
export function keepAbove(scene, S) {
  const i = flight.nearest;
  if (i < 0) return;
  const floor = S.radius[i] * (1 + MIN_ALT_FRACTION), d = scene.dist[i];
  if (d >= floor || d <= 0) return;
  const k = (floor - d) / d;                    // move away from the centre along the radius
  cam.pos[0] -= scene.rel[i * 3] * k; cam.pos[1] -= scene.rel[i * 3 + 1] * k; cam.pos[2] -= scene.rel[i * 3 + 2] * k;
}

/** Re-base the camera position on whichever star system's origin is now nearest. */
export function switchSystem(S) {
  let best = cam.sys, bd = cam.pos[0] * cam.pos[0] + cam.pos[1] * cam.pos[1] + cam.pos[2] * cam.pos[2];
  const c = cam.sys * 3;
  for (let k = 0; k < S.nSys; k++) {
    if (k === cam.sys) continue;
    const x = cam.pos[0] - (S.sysPos[k * 3] - S.sysPos[c]), y = cam.pos[1] - (S.sysPos[k * 3 + 1] - S.sysPos[c + 1]), z = cam.pos[2] - (S.sysPos[k * 3 + 2] - S.sysPos[c + 2]);
    const d = x * x + y * y + z * z;
    if (d < bd) { bd = d; best = k; }
  }
  if (best === cam.sys) return;
  const b = best * 3;
  cam.pos[0] -= S.sysPos[b] - S.sysPos[c]; cam.pos[1] -= S.sysPos[b + 1] - S.sysPos[c + 1]; cam.pos[2] -= S.sysPos[b + 2] - S.sysPos[c + 2];
  cam.sys = best;
}

const dir = new Float64Array(3), fw = new Float64Array(3), turn = new Float64Array(4);
const centre = new Float64Array(3), sun = new Float64Array(3), north = new Float64Array(3);

/**
 * A camera pose `distKm` from a point, aimed at it.
 *   c      the point
 *   s      direction azimuth is measured from (need not be unit, nor lie in the reference plane)
 *   n      unit normal of the reference plane: the system's north, or a body's spin axis for its equatorial frame
 * Azimuth turns about n starting from s, elevation lifts out of the plane, and n is "up" on screen. Yaw (right),
 * pitch (up) and roll (clockwise), in degrees and in that order, then turn the view off-centre.
 * Writes the position to outPos and the orientation to outQ; allocates nothing.
 */
export function viewPose(c, s, n, distKm, azDeg, elDeg, yawDeg, pitchDeg, rollDeg, outPos, outQ) {
  const d = s[0] * n[0] + s[1] * n[1] + s[2] * n[2];
  let sx = s[0] - n[0] * d, sy = s[1] - n[1] * d, sz = s[2] - n[2] * d;      // s brought into the plane
  let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (sl < 1e-12) { sx = n[1]; sy = -n[0]; sz = 0; sl = Math.sqrt(sx * sx + sy * sy) || 1; if (sl === 1 && sx === 0 && sy === 0) sx = 1; }
  sx /= sl; sy /= sl; sz /= sl;
  const tx = n[1] * sz - n[2] * sy, ty = n[2] * sx - n[0] * sz, tz = n[0] * sy - n[1] * sx;   // n x s: 90 degrees of azimuth
  const az = azDeg * DEG, el = elDeg * DEG, ce = Math.cos(el), ca = ce * Math.cos(az), sa = ce * Math.sin(az), se = Math.sin(el);
  dir[0] = ca * sx + sa * tx + se * n[0]; dir[1] = ca * sy + sa * ty + se * n[1]; dir[2] = ca * sz + sa * tz + se * n[2];
  outPos[0] = c[0] + dir[0] * distKm; outPos[1] = c[1] + dir[1] * distKm; outPos[2] = c[2] + dir[2] * distKm;
  fw[0] = -dir[0]; fw[1] = -dir[1]; fw[2] = -dir[2];
  quatLook(outQ, fw, n);
  if (yawDeg) quatMul(outQ, outQ, quatAxisAngle(turn, 0, 1, 0, -yawDeg * DEG));
  if (pitchDeg) quatMul(outQ, outQ, quatAxisAngle(turn, 1, 0, 0, pitchDeg * DEG));
  if (rollDeg) quatMul(outQ, outQ, quatAxisAngle(turn, 0, 0, -1, rollDeg * DEG));
  return quatNorm(outQ, outQ);
}

/**
 * The frame poses of body i are laid out in: its centre, the direction of its star (+X for a star) and the
 * reference normal: the system's north, or the body's spin axis when `equatorial` is set (so a ring plane is level).
 */
export function bodyFrame(S, i, equatorial, c, s, n) {
  const p = i * 3, st = S.star[i];
  c[0] = S.pos[p]; c[1] = S.pos[p + 1]; c[2] = S.pos[p + 2];
  if (st >= 0) { s[0] = S.pos[st * 3] - c[0]; s[1] = S.pos[st * 3 + 1] - c[1]; s[2] = S.pos[st * 3 + 2] - c[2]; }
  else { s[0] = 1; s[1] = 0; s[2] = 0; }
  if (equatorial) { n[0] = S.axis[p]; n[1] = S.axis[p + 1]; n[2] = S.axis[p + 2]; }
  else { n[0] = 0; n[1] = 1; n[2] = 0; }
}

/**
 * Put the camera `dist` radii from the centre of body i and aim it at the body.
 * Azimuth is measured from the direction of the body's star (0 = full phase, 90 = terminator, 180 = night side),
 * or from +X for a star; elevation from the ecliptic, or from the body's equator when `equatorial` is set.
 * See viewPose for the other angles.
 */
export function placeView(S, i, dist, azDeg, elDeg, yawDeg, pitchDeg, rollDeg, equatorial) {
  bodyFrame(S, i, !!equatorial, centre, sun, north);
  cam.sys = S.sys[i];
  viewPose(centre, sun, north, S.radius[i] * dist, azDeg, elDeg, yawDeg, pitchDeg, rollDeg || 0, cam.pos, cam.q);
  updateBasis();
}
