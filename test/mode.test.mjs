import test from 'node:test';
import assert from 'node:assert/strict';
import { FLIGHT, CURSOR, AUTO_F, AUTO_C, TURNBACK, TOGGLE, TARGET, ARRIVE, CANCEL, BOUNDARY, step, legal, wantsPointerLock, isAutopilot, acceptsThrust } from '../src/js/mode.js';

const STATES = [FLIGHT, CURSOR, AUTO_F, AUTO_C, TURNBACK];
const EVENTS = [TOGGLE, TARGET, ARRIVE, CANCEL, BOUNDARY];

test('Space swaps free flight and cursor inspection, also in the middle of a warp', () => {
  assert.equal(step(FLIGHT, TOGGLE), CURSOR);
  assert.equal(step(CURSOR, TOGGLE), FLIGHT);
  assert.equal(step(AUTO_F, TOGGLE), AUTO_C);
  assert.equal(step(AUTO_C, TOGGLE), AUTO_F);
});

test('choosing a target starts the autopilot, and choosing another retargets it without leaving the warp', () => {
  assert.equal(step(FLIGHT, TARGET), AUTO_F);
  assert.equal(step(CURSOR, TARGET), AUTO_C);
  assert.equal(step(AUTO_F, TARGET), AUTO_F);
  assert.equal(step(AUTO_C, TARGET), AUTO_C);
});

test('a warp returns to the mode it started from, whether it arrives or is cancelled', () => {
  for (const ev of [ARRIVE, CANCEL]) {
    assert.equal(step(step(FLIGHT, TARGET), ev), FLIGHT);
    assert.equal(step(step(CURSOR, TARGET), ev), CURSOR);
  }
});

test('ARRIVE and CANCEL mean nothing outside a warp', () => {
  for (const s of [FLIGHT, CURSOR]) for (const ev of [ARRIVE, CANCEL]) {
    assert.equal(legal(s, ev), false);
    assert.equal(step(s, ev), s);
  }
});

test('the boundary takes the helm from every state except its own turn-back', () => {
  for (const s of [FLIGHT, CURSOR, AUTO_F, AUTO_C]) assert.equal(step(s, BOUNDARY), TURNBACK);
  assert.equal(legal(TURNBACK, BOUNDARY), false);
});

test('the turn-back cannot be fought: only arriving ends it, and it hands back free flight', () => {
  for (const ev of [TOGGLE, TARGET, CANCEL, BOUNDARY]) {
    assert.equal(legal(TURNBACK, ev), false);
    assert.equal(step(TURNBACK, ev), TURNBACK);
  }
  assert.equal(step(TURNBACK, ARRIVE), FLIGHT);
});

test('every state/event pair yields a known state, and illegal ones leave the state unchanged', () => {
  for (const s of STATES) for (const ev of EVENTS) {
    const n = step(s, ev);
    assert.ok(STATES.includes(n));
    if (!legal(s, ev)) assert.equal(n, s);
  }
});

test('derived predicates agree with the states', () => {
  assert.deepEqual(STATES.map(wantsPointerLock), [true, false, true, false, false]);
  assert.deepEqual(STATES.map(isAutopilot), [false, false, true, true, true]);
  assert.deepEqual(STATES.map(acceptsThrust), [true, true, false, false, false]);
});
