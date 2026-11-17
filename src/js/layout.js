// Float offsets into the uniform blocks declared in WGSL. The WGSL structs are the source of truth;
// test/layout.test.mjs parses them and fails if anything here disagrees.

/** struct Globals (src/common.wgsl): 8 x vec4f. */
export const G = { right: 0, up: 4, fwd: 8, res: 12, time: 16, post: 20, vel: 24, aux: 28 };
export const GLOBALS_FLOATS = 32;

/** struct Body (src/body.wgsl): 55 x vec4f = 880 bytes, one 1024-byte slot per body. */
export const B = {
  center: 0, rot0: 4, rot1: 8, rot2: 12, sun: 16, sunCol: 20,
  p0: 24, p1: 28, p2: 32, p3: 36, colA: 40, colB: 44, colC: 48, colD: 52,
  atm0: 56, atm1: 60, atm2: 64, atm3: 68,
  ring0: 72, ring1: 76, ring2: 80,
  occ: 84,
  cut0: 100, cut1: 104, cut2: 108, layR: 112, layC: 116, layP: 136,
  aur: 156, aurA: 160, aurB: 164,
  st: 168, sx: 192,
  bnd: 216,
};
export const BODY_FLOATS = 220;
export const BODY_SLOT_FLOATS = 256;
export const BODY_SLOT_BYTES = 1024;
export const MAX_OCCLUDERS = 4;
export const MAX_LAYERS = 5;
export const MAX_STORMS = 6;

/** struct Loops (src/corona.wgsl): 24 polylines of 9 points. */
export const L = { n: 0, par: 4, col: 100, bs: 196, pts: 292 };
export const LOOPS_FLOATS = 1156;
export const LOOPS_SLOT_BYTES = 4864;          // 4624 rounded up to the 256-byte uniform offset alignment
export const LOOPS_SLOT_FLOATS = LOOPS_SLOT_BYTES / 4;
export const MAX_LINES = 24;
export const LINE_POINTS = 9;

/** Write four floats at offset o. */
export function put4(a, o, x, y, z, w) { a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = w; }
