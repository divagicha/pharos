// Interaction: turns input into mode transitions (mode.js), flies the camera (free flight or autopilot), keeps
// it inside the charted volume and tells the HUD what to show. Everything after initControl() is in the frame
// path and allocates nothing.
//
// Contract
//   initControl(S, data, looks)     once: number keys, parking distances, the home body
//   handleInput(S, scene, w, h, radPerPixel)   consume this frame's key presses and clicks
//   advance(dt, S, scene)           move the camera; leaves scene.computeRel() current
//   fillHud(S, scene, w, h, interactive)       write hudState for this frame
//   control.edge                    0 inside the charted volume .. 1 at its edge: the caller fades the picture by it
import { cam } from './camera.js';
import { input, lockPointer, unlockPointer } from './input.js';
import { FLIGHT, TURNBACK, TOGGLE, TARGET, ARRIVE, CANCEL, BOUNDARY, legal, step, wantsPointerLock, isAutopilot } from './mode.js';
import { auto, begin as autoBegin, update as autoUpdate, cancel as autoCancel, standoff } from './autopilot.js';
import { flight, findNearest, coMove, fly, keepAbove, switchSystem } from './flight.js';
import { inspect, select, togglePanel } from './inspect.js';
import { cursorRay, pickBody } from './pick.js';
import { hudState, NOTE_NONE, NOTE_HELM, NOTE_EDGE, NOTE_RETURN } from './hud.js';
import { smoothstep, clamp } from './math.js';

const PICK_PX = 18;               // a click this close to a body's edge selects it
const CLICK_SLOP_PX = 5;          // a press that travels further is a drag, not a click
const ARRIVED = 1.5;              // within this many parking distances a body is "here": select it without a warp
const NEARBY = 2.5;               // within this many parking distances its card appears unasked
const EDGE_FROM_LY = 76, EDGE_LY = 88, TURN_AT = 0.8;   // the helm softens from 76 ly out; at 80% of the way to 88 the autopilot turns back
const TURNBACK_SECONDS = 9;

export const control = {
  mode: FLIGHT,
  ray: new Float64Array(3),       // unit view ray through the cursor
  hasCursor: false,               // the pointer is free, so `ray` means something
  dragX: 0, dragY: 0,             // this frame's drag on the open cutaway, in pixels
  edge: 0,
};

const keyBody = new Int16Array(10).fill(-1);
let standKm = null, home = 0, lyKm = 1, wasLocked = false;

export function initControl(S, data, looks) {
  standKm = new Float64Array(S.n);
  lyKm = data.constants.LY_km;
  data.bodies.forEach((b, i) => {
    const look = looks[b.id];
    standKm[i] = look.standKm || standoff(S, i, look.corona ? look.corona.spinSeconds || 0 : 0);
    if (b.key >= 1 && b.key <= 9) keyBody[b.key] = i;
  });
  home = keyBody[1] >= 0 ? keyBody[1] : 0;
}

/** Where the autopilot parks beside body i, in km from its centre. */
export function parkingKm(i) { return standKm[i]; }

function dispatch(event) {
  if (!legal(control.mode, event)) return false;
  control.mode = step(control.mode, event);
  return true;
}

/** Ask for, or give up, the pointer according to the mode. Call from a key or click path. */
export function syncPointerLock() { if (wantsPointerLock(control.mode)) lockPointer(); else unlockPointer(); }

/** The browser took the pointer back (Esc): carry on in cursor mode instead of a flight mode nobody can steer. */
function trackPointerLock() {
  if (wasLocked && !input.locked && wantsPointerLock(control.mode)) dispatch(TOGGLE);
  wasLocked = input.locked;
}

/** A trip takes longer the more orders of magnitude it covers, within a few seconds either way; a hop back to the parking point is brisk. */
function tripSeconds(distKm, standKm) {
  const ratio = distKm / standKm;
  return ratio < 3 ? 2.2 : clamp(3.4 + 0.24 * Math.log(ratio), 3.5, 8);
}

/**
 * Select body i and warp to it. A click on a body the camera is already beside only selects it (the view the
 * player has composed is left alone); a number key always goes to the parking point and faces the body.
 */
function target(S, scene, i, always) {
  select(i);
  if (!always && !isAutopilot(control.mode) && scene.dist[i] < standKm[i] * ARRIVED) return;
  if (!dispatch(TARGET)) return;
  autoBegin(S, i, tripSeconds(scene.dist[i], standKm[i]), standKm[i]);
}

export function handleInput(S, scene, w, h, radPerPixel) {
  trackPointerLock();
  if (input.pressedSpace && dispatch(TOGGLE)) syncPointerLock();
  const digit = input.pressedDigit;
  if (digit > 0 && keyBody[digit] >= 0) target(S, scene, keyBody[digit], true);
  const cursorMode = !wantsPointerLock(control.mode);
  control.hasCursor = cursorMode && !input.locked;
  if (control.hasCursor) cursorRay(cam, input.mouseX, input.mouseY, w, h, control.ray);
  if (input.clicked && control.hasCursor && input.dragTotal < CLICK_SLOP_PX) {
    const i = pickBody(scene, S, control.ray, radPerPixel, PICK_PX);
    if (i >= 0) target(S, scene, i, false);
  }
  if (input.pressedTab) togglePanel(hudState.focus);
  if (input.pressedEscape && cursorMode) { if (inspect.panel) togglePanel(-1); else select(-1); }
  if (input.anyMove && dispatch(CANCEL)) autoCancel();
  const grab = control.hasCursor && input.down && inspect.panel;
  control.dragX = grab ? input.dragX : 0; control.dragY = grab ? input.dragY : 0;
  input.dragX = 0; input.dragY = 0;
  input.pressedSpace = false; input.pressedTab = false; input.pressedEscape = false; input.pressedDigit = 0; input.clicked = false;
}

function flyFree(dt, S, scene) {
  scene.computeRel(cam);
  coMove(scene, S);
  findNearest(scene, S);
  fly(dt, input);
  switchSystem(S);
  scene.computeRel(cam);
  findNearest(scene, S);
  keepAbove(scene, S);
  scene.computeRel(cam);
}

function flyAutopilot(dt, S, scene) {
  const x = cam.pos[0], y = cam.pos[1], z = cam.pos[2];
  const arrived = autoUpdate(S, dt);
  if (dt > 0) {
    const v = flight.vel, inv = 1 / dt;
    v[0] = (cam.pos[0] - x) * inv; v[1] = (cam.pos[1] - y) * inv; v[2] = (cam.pos[2] - z) * inv;
    flight.speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  }
  switchSystem(S);
  scene.computeRel(cam);
  findNearest(scene, S);
  input.lookX = 0; input.lookY = 0; input.wheel = 0;       // the autopilot steers; do not let the mouse pile up a turn
  if (arrived && dispatch(ARRIVE)) syncPointerLock();
}

/**
 * The charted volume has no wall. Past EDGE_FROM_LY from the host star the helm goes soft (outward motion is
 * taken back in proportion) while the caller fades the picture; near EDGE_LY the autopilot turns for home.
 */
function applyBoundary(dt, S, scene) {
  const c = cam.sys * 3;
  const x = S.sysPos[c] + cam.pos[0], y = S.sysPos[c + 1] + cam.pos[1], z = S.sysPos[c + 2] + cam.pos[2];
  const r = Math.sqrt(x * x + y * y + z * z);
  control.edge = smoothstep(EDGE_FROM_LY * lyKm, EDGE_LY * lyKm, r);
  if (control.edge <= 0 || isAutopilot(control.mode)) return;
  const v = flight.vel, out = (v[0] * x + v[1] * y + v[2] * z) / r;
  if (out > 0) {
    const k = out * dt * control.edge / r;
    cam.pos[0] -= x * k; cam.pos[1] -= y * k; cam.pos[2] -= z * k;
    scene.computeRel(cam);
  }
  if (control.edge < TURN_AT || !dispatch(BOUNDARY)) return;
  select(home);
  autoBegin(S, home, TURNBACK_SECONDS, standKm[home]);
}

export function advance(dt, S, scene) {
  if (isAutopilot(control.mode)) flyAutopilot(dt, S, scene); else flyFree(dt, S, scene);
  applyBoundary(dt, S, scene);
}

function nearby(scene, i) { return i >= 0 && scene.dist[i] < standKm[i] * NEARBY; }

/** The body the HUD describes: the warp target, the open panel's body, a selection close by, whatever is close by, else the selection. */
function focusBody(scene) {
  if (auto.active) return auto.target;
  const sel = inspect.sel;
  if (inspect.panel || nearby(scene, sel)) return sel;
  return nearby(scene, flight.nearest) ? flight.nearest : sel;
}

export function fillHud(S, scene, w, h, interactive) {
  const st = hudState, sel = inspect.sel;
  st.mode = control.mode; st.locked = input.locked;
  st.speed = flight.speed; st.altitude = flight.altitude; st.nearest = flight.nearest; st.throttle = cam.speedFactor;
  st.focus = focusBody(scene);
  st.panel = inspect.panel ? sel : -1;
  st.hover = inspect.hover;
  st.target = sel;
  st.range = sel >= 0 ? scene.dist[sel] : 0;
  st.eta = auto.active ? Math.max(auto.duration - auto.t, 0) : -1;
  st.help = interactive && !input.locked && !inspect.panel;
  st.note = control.mode === TURNBACK ? NOTE_RETURN : control.edge > 0.02 ? NOTE_EDGE
    : interactive && control.mode === FLIGHT && !input.locked ? NOTE_HELM : NOTE_NONE;
  st.w = w; st.h = h;
}
