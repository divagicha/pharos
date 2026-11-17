// Cutaway geometry on the CPU. Pure: no DOM, no GPU.
//
// The shader removes the octant {x > a, y > a, z > a} of the unit sphere in a "cut frame" (src/cut.wgsl).
// This module builds that frame so the opening faces the camera, turns it when the user drags, and repeats
// the shader's ray classification for the cursor ray so the HUD can say which layer is under the pointer.
// traceCut here and in src/cut.wgsl must stay in step; test/hud.test.mjs pins the behaviour.
import { hyp } from './math.js';

export const HOLE = 0, SURFACE = 1, FACE = 2, CORE = 3;
/** No layer is drawn thinner than this fraction of the radius, in the cutaway or in the HUD column. */
export const MIN_LAYER = 0.012;

/**
 * Outer radii to draw for `count` layers listed from the centre out (the last is the surface, 1): the true
 * values, except that every layer keeps at least `min` of thickness. Writes out[0..count-1] and returns true
 * when any boundary had to move, so the HUD can say the column is not exactly to scale.
 */
export function displayRadii(outer, count, min, out) {
  let moved = false;
  out[count - 1] = 1;
  for (let k = count - 2; k >= 0; k--) {
    out[k] = Math.min(outer[k], out[k + 1] - min);
    if (out[k] < outer[k]) moved = true;
  }
  for (let k = 0; k < count - 1; k++) {
    const least = (k + 1) * min;
    if (out[k] < least) { out[k] = least; moved = true; }
  }
  return moved;
}

const S3 = 1 / Math.sqrt(3), S23 = Math.sqrt(2 / 3);

/**
 * World->cut rotation (rows X, Y, Z written to out[0..8]) whose removed octant opens towards `toCam`:
 * the octant's diagonal (1,1,1)/sqrt(3) maps onto the unit vector toCam, and one cut edge points along `up`
 * as nearly as it can, so the three faces sit symmetrically about the screen's vertical.
 */
export function cutFrame(out, toCam, up) {
  // e2 = up made perpendicular to toCam, e1 = e2 x toCam
  let ux = up[0], uy = up[1], uz = up[2];
  const d = ux * toCam[0] + uy * toCam[1] + uz * toCam[2];
  ux -= d * toCam[0]; uy -= d * toCam[1]; uz -= d * toCam[2];
  let ul = hyp(ux, uy, uz);
  if (ul < 1e-9) { ux = toCam[1]; uy = -toCam[0]; uz = 0; ul = hyp(ux, uy, uz) || 1; }
  ux /= ul; uy /= ul; uz /= ul;
  const ex = uy * toCam[2] - uz * toCam[1], ey = uz * toCam[0] - ux * toCam[2], ez = ux * toCam[1] - uy * toCam[0];
  // three axes 120 degrees apart around toCam, each at acos(1/sqrt 3) from it; angles chosen for a right-handed frame
  for (let k = 0; k < 3; k++) {
    const th = Math.PI / 2 + k * 2 * Math.PI / 3, c = Math.cos(th) * S23, s = Math.sin(th) * S23;
    out[k * 3] = toCam[0] * S3 + ex * c + ux * s;
    out[k * 3 + 1] = toCam[1] * S3 + ey * c + uy * s;
    out[k * 3 + 2] = toCam[2] * S3 + ez * c + uz * s;
  }
  return out;
}

/** Turn the cut frame (rows in m[0..8]) by `ang` radians about the world axis (ax, ay, az), in place. */
export function rotateFrame(m, ax, ay, az, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  for (let k = 0; k < 3; k++) {
    const x = m[k * 3], y = m[k * 3 + 1], z = m[k * 3 + 2];
    const dot = ax * x + ay * y + az * z;
    m[k * 3] = x * c + (ay * z - az * y) * s + ax * dot * t;
    m[k * 3 + 1] = y * c + (az * x - ax * z) * s + ay * dot * t;
    m[k * 3 + 2] = z * c + (ax * y - ay * x) * s + az * dot * t;
  }
  return m;
}

/**
 * Classify a ray against the cut unit sphere. pc = point where the ray enters the sphere, rc = unit direction,
 * both in the cut frame; a = cut offset (1 closed .. 0 open to the centre); r0 = radius of the innermost layer,
 * which stays a whole ball. Returns HOLE, SURFACE, FACE or CORE and writes the distance along the ray to hit[0]
 * and, for a FACE, the face axis (0, 1 or 2) to hit[1].
 */
export function traceCut(pc, rc, a, r0, hit) {
  hit[0] = 0; hit[1] = -1;
  if (pc[0] <= a || pc[1] <= a || pc[2] <= a) return SURFACE;
  let te = 1e9, ax = -1;
  if (rc[0] < 0) { const t = (a - pc[0]) / rc[0]; if (t < te) { te = t; ax = 0; } }
  if (rc[1] < 0) { const t = (a - pc[1]) / rc[1]; if (t < te) { te = t; ax = 1; } }
  if (rc[2] < 0) { const t = (a - pc[2]) / rc[2]; if (t < te) { te = t; ax = 2; } }
  const bb = pc[0] * rc[0] + pc[1] * rc[1] + pc[2] * rc[2];
  const dd = bb * bb - (pc[0] * pc[0] + pc[1] * pc[1] + pc[2] * pc[2] - r0 * r0);
  if (dd > 0) { const tk = -bb - Math.sqrt(dd); if (tk > 0 && tk < te) { hit[0] = tk; return CORE; } }
  if (ax < 0) return HOLE;
  const x = pc[0] + rc[0] * te, y = pc[1] + rc[1] * te, z = pc[2] + rc[2] * te;
  if (x * x + y * y + z * z >= 1) return HOLE;
  hit[0] = te; hit[1] = ax;
  return FACE;
}

/** Index of the layer containing radius r, given the outer radii of the layers in order (the last is 1). */
export function layerAt(r, outer, count) {
  for (let k = 0; k < count - 1; k++) { if (r < outer[k]) return k; }
  return count - 1;
}

const pc = new Float64Array(3), rc = new Float64Array(3), hit = new Float64Array(2);

/**
 * Which exposed layer of a cut-open body lies under a view ray: a cut face or the core ball. Returns -1 when
 * the ray misses the body, passes through the opening into space, or meets the uncut outer surface (pointing
 * at the outside of a planet highlights nothing).
 * @param {ArrayLike<number>} center  body centre relative to the camera (km)
 * @param {number} R        body radius (km)
 * @param {ArrayLike<number>} rd  unit ray direction (world)
 * @param {ArrayLike<number>} rows  world->cut rotation rows
 * @param {number} a        cut offset
 * @param {ArrayLike<number>} outer  outer radius fraction of each layer   @param {number} count  number of layers
 */
export function layerUnderRay(center, R, rd, rows, a, outer, count) {
  const b = -(center[0] * rd[0] + center[1] * rd[1] + center[2] * rd[2]);       // dot(o, rd) with o = -center
  const qx = -center[0] - b * rd[0], qy = -center[1] - b * rd[1], qz = -center[2] - b * rd[2];
  const h = R * R - (qx * qx + qy * qy + qz * qz);
  if (h <= 0 || b >= 0) return -1;
  const sh = Math.sqrt(h), px = qx - rd[0] * sh, py = qy - rd[1] * sh, pz = qz - rd[2] * sh;
  for (let k = 0; k < 3; k++) {
    pc[k] = (rows[k * 3] * px + rows[k * 3 + 1] * py + rows[k * 3 + 2] * pz) / R;
    rc[k] = rows[k * 3] * rd[0] + rows[k * 3 + 1] * rd[1] + rows[k * 3 + 2] * rd[2];
  }
  const kind = traceCut(pc, rc, a, outer[0], hit);
  if (kind === HOLE || kind === SURFACE) return -1;
  if (kind === CORE) return 0;                   // the hit lies exactly on the core's radius; do not let rounding pick the layer
  const x = pc[0] + rc[0] * hit[0], y = pc[1] + rc[1] * hit[0], z = pc[2] + rc[2] * hit[0];
  return layerAt(Math.sqrt(x * x + y * y + z * z), outer, count);
}
