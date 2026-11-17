// Inspection: which body is selected, whether its telemetry panel is open, and its cutaway: the opening
// animation, the cut frame (turned to face the camera when it opens, then turned by dragging) and the layer
// under the cursor. No DOM, no GPU: the scene is reached through setCut(), so this runs under node --test.
//
// Contract
//   select(i)            choose body i (-1 for none). Choosing a different body closes the panel.
//   togglePanel(focus)   Tab: open the panel and cutaway on `focus`, or close them. Nothing happens for focus < 0.
//   updateInspect(...)   frame path, allocates nothing. Animates, applies the drag, finds the hovered layer and
//                        writes the result to the scene. At most one body is cut open at a time; a body that
//                        loses the panel closes first (or at once, when another body takes over).
//   Scripted use (fixed poses, the tour): set inspect.forced to the opening wanted, 0..1 (it then overrides the
//   animation in both directions), and inspect.follow to keep the opening turned towards the camera; the result
//   is then a function of those inputs alone.
import { cutFrame, rotateFrame, layerUnderRay } from './cutaway.js';
import { smoothstep } from './math.js';

const OPEN_SECONDS = 1.4, CLOSE_SECONDS = 0.8;
const DRAG_RAD_PER_PX = 0.006;
const TURN_YAW = 0.38, TURN_PITCH = -0.26;      // the opening starts a little off the view axis, so the three faces differ
const HOVER_FROM = 0.5;                         // fraction open before the cursor can pick out a layer
const AIR_THINNING = 0.3;                       // how much of its atmosphere an open body gives up, so the limb haze does not veil the faces
const CLOSED = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export const inspect = {
  sel: -1,                       // selected body, -1 for none
  panel: false,                  // the telemetry panel and cutaway are wanted open on `sel`
  body: -1,                      // body whose cutaway is open or still closing, -1 for none
  open: 0,                       // 0 closed .. 1 fully open
  hover: -1,                     // highlighted layer of `body`, -1 for none (3D cursor or HUD row)
  hoverHud: -1,                  // layer row under the pointer in the HUD panel; written by the HUD
  rows: new Float64Array(9),     // world->cut rotation
  forced: -1,                    // >= 0: the opening is set to this value instead of animating
  follow: false,                 // re-face the camera every frame instead of only when the cutaway opens
};
const toCam = new Float64Array(3), centre = new Float64Array(3);

export function select(i) {
  if (i === inspect.sel) return;
  inspect.sel = i; inspect.panel = false; inspect.hoverHud = -1;
}

export function togglePanel(focus) {
  if (inspect.panel) { inspect.panel = false; inspect.hoverHud = -1; return; }
  if (focus < 0) return;
  inspect.sel = focus; inspect.panel = true;
}

/** Turn the opening of body i towards the camera. */
function faceCamera(scene, cam, i) {
  const p = i * 3, inv = -1 / scene.dist[i];
  toCam[0] = scene.rel[p] * inv; toCam[1] = scene.rel[p + 1] * inv; toCam[2] = scene.rel[p + 2] * inv;
  cutFrame(inspect.rows, toCam, cam.up);
  rotateFrame(inspect.rows, cam.up[0], cam.up[1], cam.up[2], TURN_YAW);
  rotateFrame(inspect.rows, cam.right[0], cam.right[1], cam.right[2], TURN_PITCH);
}

/**
 * @param {number} dt        seconds
 * @param {object} scene     needs rel, dist, layOuter, layCount and setCut(i, rows, a, hover, air); computeRel() must be current
 * @param {{radius: Float64Array}} S
 * @param {object} cam       camera basis (up, right)
 * @param {number} dragX     pixels dragged this frame while the cutaway is grabbed (0 when it is not)
 * @param {number} dragY
 * @param {ArrayLike<number>|null} ray  unit view ray through the cursor, or null when there is no cursor
 */
export function updateInspect(dt, scene, S, cam, dragX, dragY, ray) {
  const want = inspect.panel ? inspect.sel : -1;
  if (inspect.body >= 0 && inspect.body !== want && (want >= 0 || inspect.open <= 0)) {
    scene.setCut(inspect.body, CLOSED, 1, -1, 1);
    inspect.body = -1; inspect.open = 0;
  }
  if (want >= 0 && inspect.body < 0) { inspect.body = want; inspect.open = 0; faceCamera(scene, cam, want); }
  const i = inspect.body;
  if (i < 0) { inspect.hover = -1; return; }
  if (inspect.follow) faceCamera(scene, cam, i);

  const goal = want === i ? 1 : 0;
  if (inspect.forced >= 0) inspect.open = inspect.forced;
  else if (goal > inspect.open) inspect.open = Math.min(1, inspect.open + dt / OPEN_SECONDS);
  else if (goal < inspect.open) inspect.open = Math.max(0, inspect.open - dt / CLOSE_SECONDS);
  if (dragX !== 0) rotateFrame(inspect.rows, cam.up[0], cam.up[1], cam.up[2], dragX * DRAG_RAD_PER_PX);
  if (dragY !== 0) rotateFrame(inspect.rows, cam.right[0], cam.right[1], cam.right[2], dragY * DRAG_RAD_PER_PX);

  const a = 1 - smoothstep(0, 1, inspect.open);
  let hover = inspect.hoverHud;
  if (hover < 0 && ray && inspect.open > HOVER_FROM) {
    const p = i * 3;
    centre[0] = scene.rel[p]; centre[1] = scene.rel[p + 1]; centre[2] = scene.rel[p + 2];
    hover = layerUnderRay(centre, S.radius[i], ray, inspect.rows, a, scene.layOuter[i], scene.layCount[i]);
  }
  inspect.hover = goal === 1 ? hover : -1;
  if (goal === 0 && inspect.open <= 0) { scene.setCut(i, CLOSED, 1, -1, 1); inspect.body = -1; return; }
  // the air thins during the first part of the opening; the clouds stay and are cut along with the surface
  scene.setCut(i, inspect.rows, a, inspect.hover, 1 - AIR_THINNING * smoothstep(0, 0.55, inspect.open));
}
