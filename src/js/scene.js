// The body scene: one uniform block per body, filled every frame from the simulation, the sorted draw list,
// and the sprites that carry bodies too small to resolve. update() and draw() are in the frame path and
// allocate nothing.
//
// Draw order: sprites first, then bodies far to near; within one body
//   solid -> ring far half -> cloud shell -> atmosphere -> ring near half -> corona
// so each analytic limb blends over everything behind it and depth-tested transparents sort themselves.
import { B, BODY_FLOATS, BODY_SLOT_FLOATS, BODY_SLOT_BYTES, MAX_OCCLUDERS, MAX_LAYERS, put4 } from './layout.js';
import { displayRadii, MIN_LAYER } from './cutaway.js';
import { MATERIALS } from './looks.js';
import { STAR, GAS, ICE, relToCamera, spinRows } from './sim.js';
import { kelvinRGB } from './sky.js';
import { DEG, smoothstep, clamp } from './math.js';
import { lumSun, absMagBol } from './derive.js';
import { Corona } from './corona.js';

const OP_SOLID = 0, OP_RING_FAR = 1, OP_CLOUDS = 2, OP_ATMO = 3, OP_RING_NEAR = 4, OP_CORONA = 5;
const OPS_PER_BODY = 6;
const MIN_PIXELS = 0.3;          // a body whose largest bound is smaller than this on screen is not drawn
const SPRITE_FLOATS = 8;         // same layout as the background stars: dir.xyz, half-size px, rgb, unused
const LY_PER_KM = 1 / 9460730472580.8;
const TAU = Math.PI * 2;

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 9973) / 9973 * 100;
}

export class Scene {
  /**
   * @param {GPUDevice} device
   * @param {{[name: string]: GPUBindGroupLayout}} layouts
   * @param {{[name: string]: GPURenderPipeline}} pipes
   * @param {object} S     simulation state from buildSystem()
   * @param {object} looks appearance table keyed by body id (src/js/looks.js)
   * @param {object} data  parsed system.json (rings, albedo, stellar temperatures)
   */
  constructor(device, layouts, pipes, S, looks, data) {
    const n = S.n;
    this.device = device; this.pipes = pipes; this.S = S;
    this.data = new Float32Array(n * BODY_SLOT_FLOATS);
    this.buf = device.createBuffer({ label: 'bodies', size: n * BODY_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bg = [];
    for (let i = 0; i < n; i++) {
      this.bg.push(device.createBindGroup({ layout: layouts.body, entries: [{ binding: 0, resource: { buffer: this.buf, offset: i * BODY_SLOT_BYTES, size: BODY_FLOATS * 4 } }] }));
    }
    this.rel = new Float64Array(n * 3);        // camera-relative centres (km)
    this.dist = new Float64Array(n);           // distance from the camera to each centre
    this.order = new Int32Array(n);            // body indices, far to near
    this.ops = new Uint8Array(n * OPS_PER_BODY);
    this.opBody = new Uint8Array(n * OPS_PER_BODY);
    this.nOps = 0;
    this.solidPipe = new Array(n);
    this.hasAtmo = new Uint8Array(n); this.hasRing = new Uint8Array(n); this.hasClouds = new Uint8Array(n); this.hasCorona = new Uint8Array(n);
    this.bound = new Float64Array(n);          // largest bounding radius, for culling
    this.coronaF = new Float64Array(n);        // corona bounding radius in body radii (0 = set by the generator)
    this.occ = new Int16Array(n * MAX_OCCLUDERS).fill(-1);
    this.gain = new Float64Array(n);           // star surface gain when the disc fills the view
    this.animSpin = new Float64Array(n);       // spin period on the animation clock (s); 0 = use the simulation
    this.albedo = new Float64Array(n);
    this.absMag = new Float64Array(n);         // stars: absolute bolometric magnitude
    this.spriteFloor = new Float64Array(n);    // minimum sprite brightness so the body can be found
    this.spriteCol = new Float32Array(n * 3);
    this.sprites = new Float32Array(n * SPRITE_FLOATS);
    this.spriteBuf = device.createBuffer({ label: 'sprites', size: this.sprites.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.nSprites = 0;
    this.only = -1;                            // debug: draw this body alone
    this.skip = { solid: false, ring: false, clouds: false, atmo: false, corona: false, sprites: false };
    this.rows = new Float64Array(9);
    this.layCount = new Uint8Array(n);         // interior layers of each body
    this.layOuter = [];                        // per body: outer radius of each layer as drawn (fractions of R)
    this.layWidened = new Uint8Array(n);       // 1 when a thin layer is drawn thicker than true scale
    for (let i = 0; i < n; i++) {
      this.order[i] = i;
      this.#initBody(i, looks[S.id[i]], data);
      this.#initLayers(i, looks[S.id[i]], data.bodies[i]);
    }
    this.#assignOccluders();
    this.corona = new Corona(device, layouts, S, looks, this.data);
  }

  /** Write the fields that never change and note which passes the body needs. */
  #initBody(i, look, data) {
    const S = this.S, d = this.data, o = i * BODY_SLOT_FLOATS, R = S.radius[i], src = data.bodies[i];
    if (!look) throw new Error(`looks.js has no entry for "${S.id[i]}"`);
    this.solidPipe[i] = this.pipes['solid_' + look.surf];
    if (!this.solidPipe[i]) throw new Error(`no pipeline for surface "${look.surf}" (${S.id[i]})`);
    d[o + B.rot0 + 3] = hashSeed(S.id[i]);
    put4(d, o + B.sunCol, 0, 0, 0, look.emissive || 0);
    if (S.star[i] >= 0) {                         // sunlight takes the star's colour, pulled part-way to white
      const c = kelvinRGB(data.bodies[S.star[i]].teffK, [0, 0, 0]);
      put4(d, o + B.sunCol, 1 + (c[0] - 1) * 0.6, 1 + (c[1] - 1) * 0.6, 1 + (c[2] - 1) * 0.6, look.emissive || 0);
    }
    for (const k of ['p0', 'p1', 'p2', 'p3', 'colA', 'colB', 'colC', 'colD']) { if (look[k]) d.set(look[k], o + B[k]); }
    put4(d, o + B.cut0, 1, 0, 0, 1); put4(d, o + B.cut1, 0, 1, 0, -1); put4(d, o + B.cut2, 0, 0, 1, 0);
    let top = R, shell = R;
    const a = look.atm;
    if (a) {
      const hR = a.hR ?? a.hRF * R, hM = a.hM ?? a.hMF * R;
      top = R + (a.top ?? a.topF * R);
      put4(d, o + B.atm0, top, hR, hM, a.g);
      put4(d, o + B.atm1, a.bR[0], a.bR[1], a.bR[2], a.bM);
      put4(d, o + B.atm2, a.abs[0], a.abs[1], a.abs[2], 1);
      put4(d, o + B.atm3, a.sky[0], a.sky[1], a.sky[2], 1.3 * Math.sqrt(R * hM));
      this.hasAtmo[i] = 1;
    } else {
      put4(d, o + B.atm0, R, 1, 1, 0);           // harmless values: strength 0 switches every atmosphere term off
      put4(d, o + B.atm3, 0, 0, 0, 1);
    }
    if (look.clouds) { shell = R + look.clouds; this.hasClouds[i] = 1; }
    (look.storms || []).forEach((s, k) => {        // [longitudeDeg, latitudeDeg, radiusDeg, ...four extras]
      const lon = s[0] * DEG, lat = s[1] * DEG, cl = Math.cos(lat);
      put4(d, o + B.st + k * 4, cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon), s[2] * DEG);
      put4(d, o + B.sx + k * 4, s[3] || 0, s[4] || 0, s[5] || 0, s[6] || 0);
    });
    const au = look.aurora;
    if (au) {
      const t = au.tilt * DEG;
      put4(d, o + B.aur, Math.sin(t), Math.cos(t), 0, au.intensity);
      put4(d, o + B.aurA, au.low[0], au.low[1], au.low[2], au.colat * DEG);
      put4(d, o + B.aurB, au.high[0], au.high[1], au.high[2], au.height);
      top = Math.max(top, R * (1 + au.height));
    }
    let outer = top;
    const ring = (data.rings || []).find(r => r.parent === S.id[i]);
    if (ring && look.ring) {
      put4(d, o + B.ring1, ring.outerRadii * R, look.ring.tau, hashSeed(ring.name), 1);
      put4(d, o + B.ring2, look.ring.albedo[0], look.ring.albedo[1], look.ring.albedo[2], look.ring.dust);
      d[o + B.ring0 + 3] = ring.innerRadii * R;
      this.hasRing[i] = 1;
      outer = Math.max(outer, ring.outerRadii * R);
    }
    let coronaR = R;
    const c = look.corona;
    if (c) {
      this.hasCorona[i] = 1;
      this.coronaF[i] = c.radius || 0;
      coronaR = R * (c.radius || 1);
      put4(d, o + B.p2, c.glow[0], c.glow[1], c.glow[2], c.glow[3]);
      put4(d, o + B.p3, c.core ? c.core[0] : 0, c.core ? c.core[1] : 0, 0, 0);
      put4(d, o + B.colD, c.color[0], c.color[1], c.color[2], 0);
      this.animSpin[i] = c.spinSeconds || 0;
      outer = Math.max(outer, coronaR);
    }
    put4(d, o + B.bnd, R, shell, top, coronaR);
    this.bound[i] = outer;

    // sprite: what the body looks like when it is smaller than a pixel
    this.gain[i] = look.gain || 0;
    this.albedo[i] = src.albedo ?? 0.3;
    const tint = look.tint || look.colA || [1, 1, 1];
    const tl = Math.max(0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2], 1e-3);
    for (let k = 0; k < 3; k++) this.spriteCol[i * 3 + k] = 1 + (tint[k] / tl - 1) * 0.8;
    if (S.kind[i] === STAR) this.absMag[i] = absMagBol(lumSun(src, S.K));
    else {
      const p = S.parent[i], moon = p >= 0 && S.kind[p] !== STAR;
      this.spriteFloor[i] = look.spriteFloor ?? (moon ? 0.16 : (S.kind[i] === GAS || S.kind[i] === ICE) ? 0.8 : R > 1000 ? 0.5 : 0.25);
    }
  }

  /** Interior layers for the cutaway: radii as drawn, colour and pattern of each (shared with the HUD). */
  #initLayers(i, look, src) {
    const d = this.data, o = i * BODY_SLOT_FLOATS, layers = src.layers || [], names = look.layers || [];
    if (layers.length < 1 || layers.length > MAX_LAYERS) throw new Error(`${src.id}: needs 1 to ${MAX_LAYERS} interior layers`);
    if (names.length !== layers.length) throw new Error(`looks.js: ${src.id} lists ${names.length} layer materials for ${layers.length} layers`);
    const outer = new Float64Array(MAX_LAYERS);
    this.layWidened[i] = displayRadii(layers.map(l => l.outer), layers.length, MIN_LAYER, outer) ? 1 : 0;
    this.layCount[i] = layers.length;
    this.layOuter.push(outer);
    for (let k = 0; k < 4; k++) d[o + B.layR + k] = k < layers.length - 1 ? outer[k] : 9;   // the last layer takes the rest
    names.forEach((name, k) => {
      const m = MATERIALS[name];
      if (!m) throw new Error(`looks.js: ${src.id} names unknown material "${name}"`);
      put4(d, o + B.layC + k * 4, m.c[0], m.c[1], m.c[2], m.e);
      put4(d, o + B.layP + k * 4, m.p[0], m.p[1], m.p[2], m.p[3]);
    });
  }

  /**
   * Cutaway state of body i. rows = world->cut rotation (9 numbers, rows X, Y, Z); a = cut offset, 1 closed to
   * 0 open to the centre; hover = highlighted layer or -1; air = strength of the atmosphere, 1 in full (an open
   * body gives some of it up; its clouds stay and are cut with the surface). Takes effect at the next update().
   */
  setCut(i, rows, a, hover, air) {
    const d = this.data, o = i * BODY_SLOT_FLOATS;
    put4(d, o + B.cut0, rows[0], rows[1], rows[2], a);
    put4(d, o + B.cut1, rows[3], rows[4], rows[5], hover);
    put4(d, o + B.cut2, rows[6], rows[7], rows[8], 0);
    if (this.hasAtmo[i]) d[o + B.atm2 + 3] = air;
  }

  /** Up to four shadow casters per body: its planet, its moons, then its sibling moons (largest first). */
  #assignOccluders() {
    const S = this.S;
    for (let i = 0; i < S.n; i++) {
      if (S.kind[i] === STAR) continue;
      const list = [];
      const p = S.parent[i];
      if (p >= 0 && S.kind[p] !== STAR) list.push(p);
      for (let j = 0; j < S.n; j++) { if (S.parent[j] === i) list.push(j); }
      if (p >= 0 && S.kind[p] !== STAR) {
        const sib = [];
        for (let j = 0; j < S.n; j++) { if (j !== i && S.parent[j] === p) sib.push(j); }
        sib.sort((a, b) => S.radius[b] - S.radius[a]);
        list.push(...sib);
      }
      for (let k = 0; k < MAX_OCCLUDERS && k < list.length; k++) this.occ[i * MAX_OCCLUDERS + k] = list[k];
    }
  }

  /** Camera-relative centre and distance of every body. Call whenever the camera or the bodies have moved. */
  computeRel(cam) {
    const S = this.S, rel = this.rel;
    for (let i = 0; i < S.n; i++) {
      relToCamera(S, i, cam.sys, cam.pos, rel, i * 3);
      this.dist[i] = Math.sqrt(rel[i * 3] * rel[i * 3] + rel[i * 3 + 1] * rel[i * 3 + 1] + rel[i * 3 + 2] * rel[i * 3 + 2]);
    }
  }

  /**
   * Fill the per-frame fields, regenerate the corona lines and sprites, sort far to near, build the draw list
   * and upload. Needs computeRel() first. clock = animation time in seconds.
   */
  update(radPerPixel, clock) {
    const S = this.S, d = this.data, rel = this.rel, pos = S.pos, n = S.n;
    for (let i = 0; i < n; i++) {
      const o = i * BODY_SLOT_FLOATS, p = i * 3;
      d[o + B.center] = rel[p]; d[o + B.center + 1] = rel[p + 1]; d[o + B.center + 2] = rel[p + 2]; d[o + B.center + 3] = S.radius[i];
      let rot = S.rot, r = i * 9;
      if (this.animSpin[i] > 0) { rot = spinRows(S, i, TAU * clock / this.animSpin[i], this.rows); r = 0; }
      d[o + B.rot0] = rot[r]; d[o + B.rot0 + 1] = rot[r + 1]; d[o + B.rot0 + 2] = rot[r + 2];
      d[o + B.rot1] = rot[r + 3]; d[o + B.rot1 + 1] = rot[r + 4]; d[o + B.rot1 + 2] = rot[r + 5];
      d[o + B.rot2] = rot[r + 6]; d[o + B.rot2 + 1] = rot[r + 7]; d[o + B.rot2 + 2] = rot[r + 8];
      const s = S.star[i];
      if (s >= 0) {
        const sx = pos[s * 3] - pos[p], sy = pos[s * 3 + 1] - pos[p + 1], sz = pos[s * 3 + 2] - pos[p + 2];
        const inv = 1 / Math.sqrt(sx * sx + sy * sy + sz * sz);
        d[o + B.sun] = sx * inv; d[o + B.sun + 1] = sy * inv; d[o + B.sun + 2] = sz * inv;
        d[o + B.sun + 3] = Math.asin(Math.min(1, S.radius[s] * inv));
      } else if (this.gain[i] > 0) {
        // a star that is small on screen must be blinding; one that fills the view must show its surface
        const ang = Math.asin(Math.min(1, S.radius[i] / this.dist[i]));
        const far = 29 * (1 - smoothstep(0.004, 0.12, ang));
        d[o + B.p1] = this.gain[i] * (1 + far);
        if (this.animSpin[i] === 0) d[o + B.p3 + 2] = far;        // the corona keeps a glare round a distant star (not the pulsar's beams)
      }
      for (let k = 0; k < MAX_OCCLUDERS; k++) {
        const j = this.occ[i * MAX_OCCLUDERS + k], q = o + B.occ + k * 4;
        if (j < 0) { d[q + 3] = 0; continue; }
        d[q] = pos[j * 3] - pos[p]; d[q + 1] = pos[j * 3 + 1] - pos[p + 1]; d[q + 2] = pos[j * 3 + 2] - pos[p + 2]; d[q + 3] = S.radius[j];
      }
      if (this.hasRing[i]) { d[o + B.ring0] = rot[r + 3]; d[o + B.ring0 + 1] = rot[r + 4]; d[o + B.ring0 + 2] = rot[r + 5]; }
    }
    this.corona.update(clock);
    for (let i = 0; i < n; i++) {                                 // generators may have resized their bounds
      if (this.hasCorona[i] && this.coronaF[i] === 0) this.bound[i] = Math.max(this.bound[i], d[i * BODY_SLOT_FLOATS + B.bnd + 3]);
    }
    this.#fillSprites(radPerPixel);
    this.#sort();
    this.#buildOps(radPerPixel);
    this.device.queue.writeBuffer(this.buf, 0, d);
    this.device.queue.writeBuffer(this.spriteBuf, 0, this.sprites, 0, Math.max(1, this.nSprites) * SPRITE_FLOATS);
  }

  /**
   * One point sprite per body that is under about a pixel across. Its light is what the disc would deliver
   * (emission or reflected sunlight times the disc's area in pixels), never less than a floor that keeps the
   * body findable, and it fades out as the disc resolves and the solid pass takes over.
   */
  #fillSprites(radPerPixel) {
    const S = this.S, d = this.data, sp = this.sprites, rel = this.rel;
    let k = 0;
    for (let i = 0; i < S.n; i++) {
      if (this.only >= 0 && i !== this.only) continue;
      const dist = this.dist[i];
      const angPx = S.radius[i] / (dist * radPerPixel);
      const resolved = smoothstep(0.5, 1.4, angPx);
      if (resolved >= 1) continue;
      const o = i * BODY_SLOT_FLOATS, p = i * 3, inv = 1 / dist;
      let I;
      if (S.kind[i] === STAR) {
        const peak = Math.min(d[o + B.p1] * Math.PI * angPx * angPx / 2.65, 60);
        const mag = this.absMag[i] + 5 * Math.log10(Math.max(dist * LY_PER_KM / 3.26156, 1e-12) / 10);
        I = Math.max(peak, 1.5 + 2.5 * clamp(1 - mag / 8, 0, 1.5));
      } else {
        const phase = 0.5 - 0.5 * (d[o + B.sun] * rel[p] + d[o + B.sun + 1] * rel[p + 1] + d[o + B.sun + 2] * rel[p + 2]) * inv;
        const peak = this.albedo[i] * phase * Math.PI * angPx * angPx / 2.65;
        const reach = this.spriteFloor[i] < 0.2 ? 6e7 : 6e11;     // moons only show near their planet; planets system-wide
        I = Math.max(peak, this.spriteFloor[i] * (0.2 + 0.8 * phase) * (1 - smoothstep(reach, reach * 3, dist)));
      }
      I *= 1 - resolved;
      if (I < 0.004) continue;
      const q = k * SPRITE_FLOATS;
      sp[q] = rel[p] * inv; sp[q + 1] = rel[p + 1] * inv; sp[q + 2] = rel[p + 2] * inv;
      sp[q + 3] = clamp(2.5 + 2.4 * Math.log2(1 + I * 2), 2.5, 16);
      sp[q + 4] = this.spriteCol[p] * I; sp[q + 5] = this.spriteCol[p + 1] * I; sp[q + 6] = this.spriteCol[p + 2] * I;
      k++;
    }
    this.nSprites = this.skip.sprites ? 0 : k;
  }

  /** Insertion sort of body indices by distance, far to near. The order changes little between frames. */
  #sort() {
    const order = this.order, dist = this.dist, n = order.length;
    for (let a = 1; a < n; a++) {
      const v = order[a], key = dist[v];
      let b = a - 1;
      while (b >= 0 && dist[order[b]] < key) { order[b + 1] = order[b]; b--; }
      order[b + 1] = v;
    }
  }

  #buildOps(radPerPixel) {
    const ops = this.ops, body = this.opBody, off = this.skip;
    let k = 0;
    for (let a = 0; a < this.order.length; a++) {
      const i = this.order[a];
      if (this.only >= 0 && i !== this.only) continue;
      if (this.bound[i] / (this.dist[i] * radPerPixel) < MIN_PIXELS) continue;
      if (!off.solid) { ops[k] = OP_SOLID; body[k++] = i; }
      if (this.hasRing[i] && !off.ring) { ops[k] = OP_RING_FAR; body[k++] = i; }
      if (this.hasClouds[i] && !off.clouds) { ops[k] = OP_CLOUDS; body[k++] = i; }
      if (this.hasAtmo[i] && !off.atmo) { ops[k] = OP_ATMO; body[k++] = i; }
      if (this.hasRing[i] && !off.ring) { ops[k] = OP_RING_NEAR; body[k++] = i; }
      if (this.hasCorona[i] && !off.corona) { ops[k] = OP_CORONA; body[k++] = i; }
    }
    this.nOps = k;
  }

  /** Issue the draw calls. Group 0 (globals) must already be bound. */
  draw(pass) {
    const P = this.pipes;
    if (this.nSprites > 0) {
      pass.setPipeline(P.stars);
      pass.setVertexBuffer(0, this.spriteBuf);
      pass.draw(4, this.nSprites);
    }
    let current = null;
    for (let k = 0; k < this.nOps; k++) {
      const i = this.opBody[k];
      let pipe, instance = 0;
      switch (this.ops[k]) {
        case OP_SOLID: pipe = this.solidPipe[i]; break;
        case OP_RING_FAR: pipe = P.ring; break;
        case OP_CLOUDS: pipe = P.clouds; instance = 1; break;
        case OP_ATMO: pipe = P.atmo; instance = 2; break;
        case OP_RING_NEAR: pipe = P.ring; instance = 1; break;
        default: pipe = P.corona; instance = 3; pass.setBindGroup(2, this.corona.bindGroup(i));
      }
      if (pipe !== current) { pass.setPipeline(pipe); current = pipe; }
      pass.setBindGroup(1, this.bg[i]);
      pass.draw(4, 1, 0, instance);
    }
  }
}
