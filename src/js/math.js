// Vector and quaternion helpers. Every function writes into a caller-supplied array and allocates nothing,
// so all of them are safe in the frame path. Vectors are [x, y, z]; quaternions are [x, y, z, w].
// Output may alias an input unless a function says otherwise.

export const DEG = Math.PI / 180;

export function set3(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; }
export function copy3(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }
export function add3(o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; }
export function sub3(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; }
export function scale3(o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; }
/** o = a + b*s */
export function addScaled3(o, a, b, s) { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; }
export function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function len3(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
/** Length of (x, y, z). Use this in the frame path: Math.hypot allocates inside the engine. */
export function hyp(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }
export function cross3(o, a, b) {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  o[0] = x; o[1] = y; o[2] = z; return o;
}
/** Normalise in place of o; a zero vector becomes +Y so callers never see NaN. */
export function norm3(o, a) {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (l < 1e-300) { o[0] = 0; o[1] = 1; o[2] = 0; return o; }
  const s = 1 / l; o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o;
}
export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
export function sat(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function smoothstep(a, b, x) { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); }

export function quatIdentity(o) { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; }
export function quatAxisAngle(o, x, y, z, ang) {
  const s = Math.sin(ang * 0.5);
  o[0] = x * s; o[1] = y * s; o[2] = z * s; o[3] = Math.cos(ang * 0.5); return o;
}
/** o = a * b (apply b first, then a). */
export function quatMul(o, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = aw * bx + ax * bw + ay * bz - az * by;
  o[1] = aw * by - ax * bz + ay * bw + az * bx;
  o[2] = aw * bz + ax * by - ay * bx + az * bw;
  o[3] = aw * bw - ax * bx - ay * by - az * bz;
  return o;
}
export function quatNorm(o, a) {
  const s = 1 / Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
  o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; o[3] = a[3] * s; return o;
}
/** Rotate vector (x, y, z) by unit quaternion q. */
export function quatRotate(o, q, x, y, z) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o[0] = x + qw * tx + (qy * tz - qz * ty);
  o[1] = y + qw * ty + (qz * tx - qx * tz);
  o[2] = z + qw * tz + (qx * ty - qy * tx);
  return o;
}
/** Spherical interpolation along the shorter arc. o may alias a or b. */
export function quatSlerp(o, a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let c = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka = 1 - t, kb = t;
  if (c < 0.9995) {
    const th = Math.acos(c), s = 1 / Math.sin(th);
    ka = Math.sin((1 - t) * th) * s; kb = Math.sin(t * th) * s;
  }
  o[0] = a[0] * ka + bx * kb; o[1] = a[1] * ka + by * kb; o[2] = a[2] * ka + bz * kb; o[3] = a[3] * ka + bw * kb;
  return quatNorm(o, o);
}
/**
 * Quaternion for a camera whose forward axis is f and whose up axis is as close to upHint as possible.
 * Camera-local axes: +X right, +Y up, -Z forward (right-handed). f must be unit length.
 */
export function quatLook(o, f, upHint) {
  // right = f x up, then up = right x f
  let rx = f[1] * upHint[2] - f[2] * upHint[1], ry = f[2] * upHint[0] - f[0] * upHint[2], rz = f[0] * upHint[1] - f[1] * upHint[0];
  let rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rl < 1e-9) {                                   // f is parallel to the hint: fall back to f x X, or f x Z when f is along X
    rx = 0; ry = f[2]; rz = -f[1];
    if (ry * ry + rz * rz < 1e-12) { rx = f[1]; ry = -f[0]; rz = 0; }
    rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  }
  rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * f[2] - rz * f[1], uy = rz * f[0] - rx * f[2], uz = rx * f[1] - ry * f[0];
  // rotation matrix columns: right, up, back (= -f)
  const m00 = rx, m10 = ry, m20 = rz, m01 = ux, m11 = uy, m21 = uz, m02 = -f[0], m12 = -f[1], m22 = -f[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    o[3] = 0.25 * s; o[0] = (m21 - m12) / s; o[1] = (m02 - m20) / s; o[2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    o[3] = (m21 - m12) / s; o[0] = 0.25 * s; o[1] = (m01 + m10) / s; o[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    o[3] = (m02 - m20) / s; o[0] = (m01 + m10) / s; o[1] = 0.25 * s; o[2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    o[3] = (m10 - m01) / s; o[0] = (m02 + m20) / s; o[1] = (m12 + m21) / s; o[2] = 0.25 * s;
  }
  return quatNorm(o, o);
}

/** Deterministic 32-bit PRNG (mulberry32). Returns a function producing floats in [0, 1). Start-up use only. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
