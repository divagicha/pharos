// Camera mode state machine (contract 6). Pure: no DOM, no GPU, tested under node --test.
//
// States
//   FLIGHT    free flight, pointer locked: WASD + mouse look
//   CURSOR    cursor inspection: pointer free, click a body to select it, drag to turn the cutaway
//   AUTO_F    autopilot warp that began in FLIGHT and returns to it
//   AUTO_C    autopilot warp that began in CURSOR and returns to it
//   TURNBACK  the system boundary has taken the helm and is flying the camera home; terminal until it arrives
//
// Events
//   TOGGLE    Space: swap free flight and cursor inspection
//   TARGET    a body was chosen (number key or click): start, or retarget, the autopilot
//   ARRIVE    the autopilot reached its destination
//   CANCEL    a movement key was pressed during a warp
//   BOUNDARY  the camera crossed the edge of the playable volume
//
// Transition table. Anything not listed is illegal and leaves the state unchanged; step() reports that by
// returning the same state, and legal() lets callers ask first. TURNBACK accepts ARRIVE only, so a player
// cannot fight the turn-back.
export const FLIGHT = 0, CURSOR = 1, AUTO_F = 2, AUTO_C = 3, TURNBACK = 4;
export const TOGGLE = 0, TARGET = 1, ARRIVE = 2, CANCEL = 3, BOUNDARY = 4;
export const STATE_NAMES = ['FLIGHT', 'CURSOR', 'AUTO_F', 'AUTO_C', 'TURNBACK'];

const NONE = -1;
//                    TOGGLE    TARGET    ARRIVE    CANCEL    BOUNDARY
const TABLE = [
  /* FLIGHT   */ [CURSOR,   AUTO_F,   NONE,     NONE,     TURNBACK],
  /* CURSOR   */ [FLIGHT,   AUTO_C,   NONE,     NONE,     TURNBACK],
  /* AUTO_F   */ [AUTO_C,   AUTO_F,   FLIGHT,   FLIGHT,   TURNBACK],
  /* AUTO_C   */ [AUTO_F,   AUTO_C,   CURSOR,   CURSOR,   TURNBACK],
  /* TURNBACK */ [NONE,     NONE,     FLIGHT,   NONE,     NONE],
];

/** True when `event` is allowed in `state`. */
export function legal(state, event) { return TABLE[state][event] !== NONE; }

/** Next state, or the same state when the event is illegal there. */
export function step(state, event) {
  const next = TABLE[state][event];
  return next === NONE ? state : next;
}

/** The pointer should be locked (mouse look) in these states. */
export function wantsPointerLock(state) { return state === FLIGHT || state === AUTO_F; }
/** The autopilot, not the player, is moving the camera. */
export function isAutopilot(state) { return state === AUTO_F || state === AUTO_C || state === TURNBACK; }
/** The player's thrust keys are honoured. */
export function acceptsThrust(state) { return state === FLIGHT || state === CURSOR; }
