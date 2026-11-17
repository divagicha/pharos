// Keyboard, mouse and pointer-lock state. Handlers only write numbers into `input`; the frame loop reads
// and clears the accumulators. Nothing here allocates after start-up.

export const input = {
  // held axes, -1..1
  forward: 0, strafe: 0, lift: 0, roll: 0,
  boost: false,
  // accumulated since the last frame; the consumer zeroes them
  lookX: 0, lookY: 0, wheel: 0,
  // cursor position in CSS pixels and button state
  mouseX: 0, mouseY: 0, down: false, dragX: 0, dragY: 0, clicked: false,
  dragTotal: 0,                  // pixels travelled during the current or the last press
  locked: false,
  // one-shot key presses; the consumer zeroes them
  pressedDigit: 0, pressedTab: false, pressedSpace: false, pressedEscape: false,
  anyMove: false,
};

const K_W = 0, K_S = 1, K_A = 2, K_D = 3, K_Q = 4, K_E = 5, K_R = 6, K_F = 7, K_SHIFT = 8;
const held = new Uint8Array(9);

function keyIndex(code) {
  switch (code) {
    case 'KeyW': case 'ArrowUp': return K_W;
    case 'KeyS': case 'ArrowDown': return K_S;
    case 'KeyA': case 'ArrowLeft': return K_A;
    case 'KeyD': case 'ArrowRight': return K_D;
    case 'KeyQ': return K_Q;
    case 'KeyE': return K_E;
    case 'KeyR': return K_R;
    case 'KeyF': return K_F;
    case 'ShiftLeft': case 'ShiftRight': return K_SHIFT;
  }
  return -1;
}

function refreshAxes() {
  input.forward = held[K_W] - held[K_S];
  input.strafe = held[K_D] - held[K_A];
  input.roll = held[K_E] - held[K_Q];
  input.lift = held[K_R] - held[K_F];
  input.boost = held[K_SHIFT] === 1;
  input.anyMove = (held[K_W] | held[K_S] | held[K_A] | held[K_D] | held[K_Q] | held[K_E] | held[K_R] | held[K_F]) === 1;
}

function onKeyDown(e) {
  const k = keyIndex(e.code);
  if (k >= 0) { held[k] = 1; refreshAxes(); e.preventDefault(); return; }
  if (e.repeat) return;
  if (e.code === 'Tab') { input.pressedTab = true; e.preventDefault(); return; }
  if (e.code === 'Space') { input.pressedSpace = true; e.preventDefault(); return; }
  if (e.code === 'Escape') { input.pressedEscape = true; return; }
  const c = e.keyCode;
  if (c >= 49 && c <= 57) { input.pressedDigit = c - 48; e.preventDefault(); }
}
function onKeyUp(e) {
  const k = keyIndex(e.code);
  if (k >= 0) { held[k] = 0; refreshAxes(); }
}
function onBlur() { held.fill(0); refreshAxes(); input.down = false; }

function onMouseMove(e) {
  if (input.locked) { input.lookX += e.movementX; input.lookY += e.movementY; return; }
  if (input.down) { input.dragX += e.movementX; input.dragY += e.movementY; input.dragTotal += Math.abs(e.movementX) + Math.abs(e.movementY); }
  input.mouseX = e.clientX; input.mouseY = e.clientY;
}
function onMouseDown(e) { if (e.button === 0) { input.down = true; input.dragTotal = 0; input.mouseX = e.clientX; input.mouseY = e.clientY; } }
function onMouseUp(e) { if (e.button === 0 && input.down) { input.down = false; input.clicked = true; } }
function onWheel(e) { input.wheel += e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0; e.preventDefault(); }

let canvasEl = null;
function onLockChange() { input.locked = document.pointerLockElement === canvasEl; }

/** Wire the listeners. Call once. */
export function initInput(canvas) {
  canvasEl = canvas;
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', onBlur);
  addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerlockchange', onLockChange);
}

/** Ask for pointer lock (free flight). Must be called from a user gesture; failure is harmless. */
export function lockPointer() {
  if (!canvasEl || document.pointerLockElement === canvasEl) return;
  const p = canvasEl.requestPointerLock();
  if (p && p.catch) p.catch(() => {});
}
export function unlockPointer() { if (document.pointerLockElement) document.exitPointerLock(); }
