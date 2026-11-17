// Camera state. Position is kept in doubles, in kilometres, relative to the origin of one star system
// (cam.sys); the GPU only ever sees camera-relative float32 vectors. Orientation is a quaternion with
// camera-local axes +X right, +Y up, -Z forward (right-handed world).
import { quatMul, quatAxisAngle, quatNorm, quatRotate, DEG } from './math.js';

export const cam = {
  sys: 0,
  pos: new Float64Array(3),
  q: new Float64Array([0, 0, 0, 1]),
  right: new Float64Array([1, 0, 0]),
  up: new Float64Array([0, 1, 0]),
  fwd: new Float64Array([0, 0, -1]),
  tanY: Math.tan(26 * DEG),      // half of the vertical field of view
  tanX: 1,                       // set from the aspect ratio on resize
  near: 0.001,                   // km
  speedFactor: 1,                // scroll-wheel multiplier on the base flight speed
};

const dq = new Float64Array(4);

/** Refresh right/up/fwd from the quaternion. Call after any change to cam.q. */
export function updateBasis() {
  quatRotate(cam.right, cam.q, 1, 0, 0);
  quatRotate(cam.up, cam.q, 0, 1, 0);
  quatRotate(cam.fwd, cam.q, 0, 0, -1);
}

/** Turn the camera about its own axes (radians): yaw about up, pitch about right, roll about forward. */
export function rotateLocal(yaw, pitch, roll) {
  if (yaw !== 0) quatMul(cam.q, cam.q, quatAxisAngle(dq, 0, 1, 0, yaw));
  if (pitch !== 0) quatMul(cam.q, cam.q, quatAxisAngle(dq, 1, 0, 0, pitch));
  if (roll !== 0) quatMul(cam.q, cam.q, quatAxisAngle(dq, 0, 0, -1, roll));
  quatNorm(cam.q, cam.q);
  updateBasis();
}

export function setAspect(width, height) { cam.tanX = cam.tanY * width / height; }
