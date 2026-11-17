// The asteroid belt and the cosmic dust: both are lattices of instances wrapped around the camera
// (src/field.wgsl), so the GPU only ever sees small camera-relative numbers and the field is wherever the
// camera goes. update() and the draw methods are in the frame path and allocate nothing.
import { rng, smoothstep, clamp } from './math.js';

const ZONE_FLOATS = 28;            // struct Zone in field.wgsl: 7 x vec4f
const Z = { rock: 0, sun: 4, sunCol: 8, dustA: 12, dustB: 16, dustV: 20, dustP: 24 };
const ROCKS = 4096;
const ROCK_CELL = 1500;            // km: side of the asteroid lattice cell
const DUST = 1400;                 // grains per layer
const DUST_LAYERS = 56;            // lattice sizes 2^(k-6) km: 16 m up to about 100 light-years
const DUST_K0 = -6;
const DUST_TIME = 2.5;             // a grain takes about this long to cross its cell at the current speed
const SHUTTER = 0.018;             // s of motion drawn as one streak

/** Unit icosphere: positions (xyz per vertex) and 16-bit triangle indices, counter-clockwise seen from outside. */
function icosphere(subdivisions) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  verts = verts.map(norm);
  for (let s = 0; s < subdivisions; s++) {
    const mid = new Map(), next = [];
    const midpoint = (a, b) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      if (!mid.has(key)) { mid.set(key, verts.length); verts.push(norm([verts[a][0] + verts[b][0], verts[a][1] + verts[b][1], verts[a][2] + verts[b][2]])); }
      return mid.get(key);
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { positions: new Float32Array(verts.flat()), indices: new Uint16Array(faces.flat()) };
}

export class Field {
  /**
   * @param {GPUDevice} device
   * @param {{[name: string]: GPUBindGroupLayout}} layouts
   * @param {{[name: string]: GPURenderPipeline}} pipes
   * @param {object} S     simulation state (the belt circles the first system's star)
   * @param {{majorAU: number, minorAU: number}} belt
   */
  constructor(device, layouts, pipes, S, belt) {
    this.device = device; this.pipes = pipes;
    this.major = belt.majorAU * S.K.AU_km; this.minor = belt.minorAU * S.K.AU_km;
    this.zone = new Float32Array(ZONE_FLOATS);
    this.zoneBuf = device.createBuffer({ label: 'zone', size: ZONE_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bg = device.createBindGroup({ layout: layouts.zone, entries: [{ binding: 0, resource: { buffer: this.zoneBuf } }] });
    const vb = (label, data, usage = GPUBufferUsage.VERTEX) => {
      const b = device.createBuffer({ label, size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const mesh = icosphere(3);
    this.meshBuf = vb('rock-mesh', mesh.positions);
    this.indexBuf = vb('rock-index', mesh.indices, GPUBufferUsage.INDEX);
    this.indexCount = mesh.indices.length;

    const r = rng(0xa57e801d), rocks = new Float32Array(ROCKS * 8);
    for (let i = 0; i < ROCKS; i++) {
      const o = i * 8;
      rocks[o] = r(); rocks[o + 1] = r(); rocks[o + 2] = r();
      rocks[o + 3] = Math.min(1.5 * Math.pow(1 - r(), -0.55), 40);          // km: many pebbles, a few mountains
      const z = r() * 2 - 1, a = r() * 2 * Math.PI, q = Math.sqrt(1 - z * z);
      rocks[o + 4] = q * Math.cos(a); rocks[o + 5] = q * Math.sin(a); rocks[o + 6] = z;
      rocks[o + 7] = r() * 97;
    }
    this.rockBuf = vb('rocks', rocks);
    const dust = new Float32Array(DUST * 4);
    for (let i = 0; i < DUST * 4; i++) dust[i] = r();
    this.dustBuf = vb('dust', dust);

    this.acc = new Float64Array(DUST_LAYERS * 3);     // camera position modulo each dust cell size
    this.mask = 0;                                    // 0 outside the belt .. 1 deep inside it
    this.dustOn = false;
  }

  /**
   * @param {object} cam     camera (position in km relative to its system, basis vectors, system index)
   * @param {Float64Array} vel  the camera's own flight velocity in world axes (km/s), without co-moving drift
   * @param {number} dt      frame time (s)
   * @param {number} clock   animation clock (s)
   * @param {number} altitude  km above the nearest surface: sets how fast "fast" is
   * @param {number} warp    0..1, lengthens the streaks
   */
  update(cam, vel, dt, clock, altitude, warp) {
    const z = this.zone, p = cam.pos;
    // ---- asteroid belt: a torus about the first system's origin, in its equatorial plane ----
    let mask = 0;
    if (cam.sys === 0) {
      const rho = Math.sqrt(p[0] * p[0] + p[2] * p[2]) - this.major;
      mask = 1 - smoothstep(0.55 * this.minor, this.minor, Math.sqrt(rho * rho + p[1] * p[1]));
    }
    this.mask = mask;
    for (let k = 0; k < 3; k++) { const f = p[k] / ROCK_CELL; z[Z.rock + k] = f - Math.floor(f); }
    z[Z.rock + 3] = ROCK_CELL;
    const sl = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) || 1;
    // a warp leaves the rocks behind before they can be seen as anything but black shapes against the sky
    z[Z.sun] = -p[0] / sl; z[Z.sun + 1] = -p[1] / sl; z[Z.sun + 2] = -p[2] / sl; z[Z.sun + 3] = mask * (1 - smoothstep(0.12, 0.55, warp));
    z[Z.sunCol] = 1.04; z[Z.sunCol + 1] = 0.99; z[Z.sunCol + 2] = 0.93; z[Z.sunCol + 3] = clock;

    // ---- dust: every lattice size keeps its own wrapped position, advanced by the flight velocity ----
    const acc = this.acc;
    for (let k = 0; k < DUST_LAYERS; k++) {
      const L = Math.pow(2, k + DUST_K0), o = k * 3;
      for (let a = 0; a < 3; a++) { const v = acc[o + a] + vel[a] * dt / L; acc[o + a] = v - Math.floor(v); }
    }
    const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
    const moving = smoothstep(0.01, 0.06, speed / Math.max(altitude, 20));     // nothing to convey when hovering
    this.dustOn = moving > 0;
    if (this.dustOn) {
      const kf = clamp(Math.log2(Math.max(speed * DUST_TIME, 1e-9)) - DUST_K0, 0, DUST_LAYERS - 1.001);
      const k0 = Math.floor(kf), w = kf - k0;
      for (let a = 0; a < 3; a++) { z[Z.dustA + a] = acc[k0 * 3 + a]; z[Z.dustB + a] = acc[(k0 + 1) * 3 + a]; }
      z[Z.dustA + 3] = Math.pow(2, k0 + DUST_K0); z[Z.dustB + 3] = Math.pow(2, k0 + 1 + DUST_K0);
      const sh = SHUTTER * (1 + 5 * warp);
      z[Z.dustV] = (cam.right[0] * vel[0] + cam.right[1] * vel[1] + cam.right[2] * vel[2]) * sh;
      z[Z.dustV + 1] = (cam.up[0] * vel[0] + cam.up[1] * vel[1] + cam.up[2] * vel[2]) * sh;
      z[Z.dustV + 2] = (cam.fwd[0] * vel[0] + cam.fwd[1] * vel[1] + cam.fwd[2] * vel[2]) * sh;
      z[Z.dustV + 3] = (1 - w) * moving;
      z[Z.dustP] = w * moving; z[Z.dustP + 1] = 1.15; z[Z.dustP + 2] = 0.55;
    }
    this.device.queue.writeBuffer(this.zoneBuf, 0, z);
  }

  /** Asteroid meshes: opaque, depth-written. Draw before the bodies. */
  drawOpaque(pass) {
    if (this.mask <= 0) return;
    pass.setPipeline(this.pipes.rocks);
    pass.setBindGroup(1, this.bg);
    pass.setVertexBuffer(0, this.meshBuf);
    pass.setVertexBuffer(1, this.rockBuf);
    pass.setIndexBuffer(this.indexBuf, 'uint16');
    pass.drawIndexed(this.indexCount, ROCKS);
  }

  /** Asteroids too small to mesh, then the dust. Draw after the bodies. */
  drawTransparent(pass) {
    if (this.mask > 0) {
      pass.setPipeline(this.pipes.rocks_far);
      pass.setBindGroup(1, this.bg);
      pass.setVertexBuffer(0, this.rockBuf);
      pass.draw(4, ROCKS);
    }
    if (this.dustOn) {
      pass.setBindGroup(1, this.bg);
      pass.setVertexBuffer(0, this.dustBuf);
      pass.setPipeline(this.pipes.dustA);
      pass.draw(4, DUST);
      pass.setPipeline(this.pipes.dustB);
      pass.draw(4, DUST);
    }
  }
}
