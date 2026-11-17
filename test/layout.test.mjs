// Contract test for the JS <-> WGSL seam: the offsets in src/js/layout.js must match the structs the shaders declare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as layout from '../src/js/layout.js';

/** Parse `struct <name> { ... }` whose fields are all vec4f or array<vec4f, N>; returns {field: floatOffset} and the total. */
function structOffsets(file, name) {
  const src = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8').replace(/\/\/[^\n]*/g, '');
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(src);
  assert.ok(m, `struct ${name} not found in ${file}`);
  const offsets = {};
  let at = 0;
  for (const field of m[1].split(/,(?![^<]*>)/).map(s => s.trim()).filter(Boolean)) {
    const f = /^(\w+)\s*:\s*(vec4f|array<vec4f,\s*(\d+)>)$/.exec(field);
    assert.ok(f, `unexpected field "${field}" in ${name}: the layout tables assume vec4f or array<vec4f, N> only`);
    offsets[f[1]] = at;
    at += 4 * (f[3] ? +f[3] : 1);
  }
  return { offsets, total: at };
}

test('Globals offsets match common.wgsl', () => {
  const s = structOffsets('common.wgsl', 'Globals');
  assert.deepEqual(layout.G, s.offsets);
  assert.equal(layout.GLOBALS_FLOATS, s.total);
});

test('Body offsets match body.wgsl and fit the slot', () => {
  const s = structOffsets('body.wgsl', 'Body');
  assert.deepEqual(layout.B, s.offsets);
  assert.equal(layout.BODY_FLOATS, s.total);
  assert.ok(layout.BODY_FLOATS * 4 <= layout.BODY_SLOT_BYTES);
  assert.equal(layout.BODY_SLOT_BYTES % 256, 0, 'slots must respect minUniformBufferOffsetAlignment');
  assert.equal(layout.BODY_SLOT_FLOATS * 4, layout.BODY_SLOT_BYTES);
});

test('Loops offsets match corona.wgsl and fit the slot', () => {
  const s = structOffsets('corona.wgsl', 'Loops');
  assert.deepEqual(layout.L, s.offsets);
  assert.equal(layout.LOOPS_FLOATS, s.total);
  assert.ok(layout.LOOPS_FLOATS * 4 <= layout.LOOPS_SLOT_BYTES);
  assert.equal(layout.LOOPS_SLOT_BYTES % 256, 0);
  assert.equal((layout.L.pts - layout.L.bs) / 4, layout.MAX_LINES);
  assert.equal((layout.LOOPS_FLOATS - layout.L.pts) / 4, layout.MAX_LINES * layout.LINE_POINTS);
});

test('array capacities in layout.js match the WGSL array sizes', () => {
  const b = structOffsets('body.wgsl', 'Body').offsets;
  assert.equal((b.cut0 - b.occ) / 4, layout.MAX_OCCLUDERS);
  assert.equal((b.layP - b.layC) / 4, layout.MAX_LAYERS);
  assert.equal((b.sx - b.st) / 4, layout.MAX_STORMS);
});
