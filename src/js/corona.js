// CPU generators for the glowing polylines drawn by fs_corona: coronal loops and flare jets on stars,
// beams and dipole field lines on the pulsar, ion and dust tails on the comet.
// One Loops uniform slot per emitting body; update() is in the frame path and allocates nothing.
//
// Contract with the shader (struct Loops, src/corona.wgsl): per polyline `par` = intensity, width at the
// start (km), width at the end (km), flow-pattern frequency; `col` = rgb, flow speed; `bs` = bounding sphere
// relative to the body centre; nine points `pts` = xyz relative to the body centre (km), w = intensity scale.
import { L, LOOPS_FLOATS, LOOPS_SLOT_BYTES, LOOPS_SLOT_FLOATS, MAX_LINES, LINE_POINTS, B, BODY_SLOT_FLOATS, MAX_STORMS } from './layout.js';
import { hyp } from './math.js';

const STAR = 0, PULSAR = 1, COMET = 2;
const TYPE = { star: STAR, pulsar: PULSAR, comet: COMET };
const TAU = Math.PI * 2;
const fract = x => x - Math.floor(x);

export class Corona {
  /**
   * @param {GPUDevice} device
   * @param {{[name: string]: GPUBindGroupLayout}} layouts
   * @param {object} S        simulation state
   * @param {object} looks    appearance table; bodies with a `corona` entry become emitters
   * @param {Float32Array} bodyData  the scene's body blocks (rotation rows and active regions are read from it,
   *                                 flare levels and the comet's bounding radius are written to it)
   */
  constructor(device, layouts, S, looks, bodyData) {
    this.device = device; this.S = S; this.bodyData = bodyData;
    this.emitters = [];
    this.slotOf = new Int16Array(S.n).fill(-1);
    for (let i = 0; i < S.n; i++) {
      const c = looks[S.id[i]].corona;
      if (!c) continue;
      const loops = c.loops || [1, 0.8, 0.5];
      const e = {
        body: i, type: TYPE[c.type], slot: this.emitters.length,
        r: loops[0], g: loops[1], b: loops[2],
        period: new Float32Array(MAX_STORMS), phase: new Float32Array(MAX_STORMS),
        regions: c.type === 'star' ? (looks[S.id[i]].storms || []).length : 0,
        spin: c.spinSeconds || 0,
      };
      for (let k = 0; k < MAX_STORMS; k++) {                   // each region flares on its own 20-45 s cycle
        const h = Math.sin((i * 31 + k * 17 + 3) * 12.9898) * 43758.5453;
        e.period[k] = 20 + 25 * fract(h); e.phase[k] = fract(h * 1.618);
      }
      this.slotOf[i] = e.slot;
      this.emitters.push(e);
    }
    const n = Math.max(1, this.emitters.length);
    this.data = new Float32Array(n * LOOPS_SLOT_FLOATS);
    this.buf = device.createBuffer({ label: 'loops', size: n * LOOPS_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bg = [];
    for (let k = 0; k < n; k++) {
      this.bg.push(device.createBindGroup({ layout: layouts.loops, entries: [{ binding: 0, resource: { buffer: this.buf, offset: k * LOOPS_SLOT_BYTES, size: LOOPS_FLOATS * 4 } }] }));
    }
    this.w = new Float64Array(3);                 // scratch
  }

  /** Bind group for body i's polylines, or null when the body emits none. */
  bindGroup(i) { const s = this.slotOf[i]; return s < 0 ? null : this.bg[s]; }

  /** Regenerate every emitter's polylines for animation time `clock` (s) and upload. */
  update(clock) {
    for (let k = 0; k < this.emitters.length; k++) {
      const e = this.emitters[k];
      this.base = e.slot * LOOPS_SLOT_FLOATS;
      this.count = 0;
      if (e.type === STAR) this.#star(e, clock); else if (e.type === PULSAR) this.#pulsar(e); else this.#comet(e, clock);
      this.data[this.base + L.n] = this.count;
    }
    this.device.queue.writeBuffer(this.buf, 0, this.data);
  }

  /** Start polyline number this.count; returns the float offset of its first point. */
  #begin(intensity, w0, w1, freq, r, g, b, flow) {
    const d = this.data, i = this.count, o = this.base;
    d[o + L.par + i * 4] = intensity; d[o + L.par + i * 4 + 1] = w0; d[o + L.par + i * 4 + 2] = w1; d[o + L.par + i * 4 + 3] = freq;
    d[o + L.col + i * 4] = r; d[o + L.col + i * 4 + 1] = g; d[o + L.col + i * 4 + 2] = b; d[o + L.col + i * 4 + 3] = flow;
    return o + L.pts + i * LINE_POINTS * 4;
  }

  /**
   * Finish the polyline: the radius of the capsule about its chord (first point to last) that holds every
   * point with three widths to spare. The shader tests the view ray against that capsule before doing any work.
   */
  #end() {
    const d = this.data, i = this.count, o = this.base, p = o + L.pts + i * LINE_POINTS * 4, e = p + (LINE_POINTS - 1) * 4;
    const ux = d[e] - d[p], uy = d[e + 1] - d[p + 1], uz = d[e + 2] - d[p + 2], uu = ux * ux + uy * uy + uz * uz;
    let cx = 0, cy = 0, cz = 0, r2 = 0;
    for (let j = 0; j < LINE_POINTS; j++) {
      const x = d[p + j * 4] - d[p], y = d[p + j * 4 + 1] - d[p + 1], z = d[p + j * 4 + 2] - d[p + 2];
      const s = uu > 0 ? Math.min(Math.max((x * ux + y * uy + z * uz) / uu, 0), 1) : 0;
      const ex = x - ux * s, ey = y - uy * s, ez = z - uz * s;
      r2 = Math.max(r2, ex * ex + ey * ey + ez * ez);
      cx += d[p + j * 4]; cy += d[p + j * 4 + 1]; cz += d[p + j * 4 + 2];
    }
    const w = Math.max(d[o + L.par + i * 4 + 1], d[o + L.par + i * 4 + 2]);
    const q = o + L.bs + i * 4;
    d[q] = cx / LINE_POINTS; d[q + 1] = cy / LINE_POINTS; d[q + 2] = cz / LINE_POINTS;
    d[q + 3] = (Math.sqrt(r2) + w * 6.5) * 1.15;               // out to where the soft sheath (2.5 widths) has died away, plus a margin: the shader's closest approach is approximate
    this.count++;
  }

  /** Body-local vector to world axes (rotation rows are world vectors of the local axes). */
  #toWorld(body, lx, ly, lz) {
    const d = this.bodyData, o = body * BODY_SLOT_FLOATS, w = this.w;
    w[0] = d[o + B.rot0] * lx + d[o + B.rot1] * ly + d[o + B.rot2] * lz;
    w[1] = d[o + B.rot0 + 1] * lx + d[o + B.rot1 + 1] * ly + d[o + B.rot2 + 1] * lz;
    w[2] = d[o + B.rot0 + 2] * lx + d[o + B.rot1 + 2] * ly + d[o + B.rot2 + 2] * lz;
    return w;
  }

  /** Three nested arches over each active region; while a region flares its top loop swells and a jet shoots out. */
  #star(e, clock) {
    const bd = this.bodyData, d = this.data, o = e.body * BODY_SLOT_FLOATS, R = this.S.radius[e.body];
    for (let r = 0; r < e.regions; r++) {
      const so = o + B.st + r * 4, xo = o + B.sx + r * 4;
      const cx = bd[so], cy = bd[so + 1], cz = bd[so + 2], rad = bd[so + 3];
      const u = fract(clock / e.period[r] + e.phase[r]);
      const level = u < 0.03 ? u / 0.03 : u < 0.34 ? Math.exp(-(u - 0.03) / 0.07) : 0;
      bd[xo] = level;                                           // the surface shader flashes the footpoints
      const el = hyp(cz, cx, 0) || 1, ex = cz / el, ez = -cx / el;          // east = Y x c
      const nx = cy * ez, ny = cz * ex - cx * ez, nz = -cy * ex;                 // north = c x east
      const sep = bd[xo + 2] * rad;
      for (let k = 0; k < 3 && this.count < MAX_LINES; k++) {
        const half = sep * (0.75 + 0.45 * k);
        const h = rad * (0.9 + 0.9 * k) * (k === 2 ? 1 + 0.7 * level : 1);
        const lean = ((k - 1) * 0.3 + 0.22 * Math.sin(bd[xo + 3] * 3.7 + k * 2.3)) * rad;
        const width = R * rad * 0.05 * (1 + 0.3 * k);
        const p = this.#begin((1.7 - 0.35 * k) * (1 + (k === 2 ? 4 : 1.2) * level), width * 1.25, width * 0.7, 5 + k, e.r, e.g, e.b, 0.35 + 0.1 * k);
        for (let j = 0; j < LINE_POINTS; j++) {
          const s = j / (LINE_POINTS - 1), t = s * 2 - 1, arch = Math.sin(Math.PI * s);
          let lx = cx + ex * half * t + nx * lean * arch, ly = cy + ny * lean * arch, lz = cz + ez * half * t + nz * lean * arch;
          const rr = R * (1 + h * Math.pow(arch, 0.7)) / hyp(lx, ly, lz);
          const w = this.#toWorld(e.body, lx * rr, ly * rr, lz * rr);
          d[p + j * 4] = w[0]; d[p + j * 4 + 1] = w[1]; d[p + j * 4 + 2] = w[2]; d[p + j * 4 + 3] = 0.22 + 0.78 * (1 - arch) * (1 - arch);
        }
        this.#end();
      }
      if (level > 0.02 && this.count < MAX_LINES) {             // ejecta
        const ext = Math.min(1, u / 0.30), len = R * (0.25 + 1.6 * ext);
        const p = this.#begin(7.0 * level, R * rad * 0.10, R * rad * 0.55, 9, 1, 0.90, 0.74, 2.5);
        for (let j = 0; j < LINE_POINTS; j++) {
          const s = j / (LINE_POINTS - 1), rr = R * 1.01 + len * s, bend = R * 0.06 * s * s;
          const w = this.#toWorld(e.body, cx * rr + ex * bend, cy * rr, cz * rr + ez * bend);
          d[p + j * 4] = w[0]; d[p + j * 4 + 1] = w[1]; d[p + j * 4 + 2] = w[2]; d[p + j * 4 + 3] = 1 - 0.8 * s;
        }
        this.#end();
      }
    }
  }

  /** Two beams along the magnetic axis (st[0] in the body frame) and six dipole field lines, r = L sin^2(theta). */
  #pulsar(e) {
    const bd = this.bodyData, d = this.data, o = e.body * BODY_SLOT_FLOATS, R = this.S.radius[e.body];
    const mx = bd[o + B.st], my = bd[o + B.st + 1], mz = bd[o + B.st + 2];
    const al = hyp(mz, mx, 0) || 1, ax = mz / al, az = -mx / al;            // a = Y x m (perpendicular to m)
    const bx = my * az, by = mz * ax - mx * az, bz = -my * ax;                  // b = m x a
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const p = this.#begin(1.5, R * 0.6, R * 8, 16, 0.42, 0.60, 1.0, 9);
      for (let j = 0; j < LINE_POINTS; j++) {
        const s = j / (LINE_POINTS - 1), rr = R * (1.3 + 75 * Math.pow(s, 1.6)) * sgn;
        const w = this.#toWorld(e.body, mx * rr, my * rr, mz * rr);
        d[p + j * 4] = w[0]; d[p + j * 4 + 1] = w[1]; d[p + j * 4 + 2] = w[2]; d[p + j * 4 + 3] = 1 - 0.92 * s;
      }
      this.#end();
    }
    const t0 = 0.36;
    for (let k = 0; k < 6; k++) {
      const phi = k * TAU / 6, c = Math.cos(phi), sn = Math.sin(phi);
      const qx = ax * c + bx * sn, qy = by * sn, qz = az * c + bz * sn, Lr = R * (7 + 3 * (k & 1));
      const p = this.#begin(0.45, R * 0.16, R * 0.16, 7, 0.70, 0.50, 1.0, 1.2);
      for (let j = 0; j < LINE_POINTS; j++) {
        const th = t0 + (Math.PI - 2 * t0) * j / (LINE_POINTS - 1), st = Math.sin(th), rr = Lr * st * st, ct = Math.cos(th);
        const w = this.#toWorld(e.body, (mx * ct + qx * st) * rr, (my * ct + qy * st) * rr, (mz * ct + qz * st) * rr);
        d[p + j * 4] = w[0]; d[p + j * 4 + 1] = w[1]; d[p + j * 4 + 2] = w[2]; d[p + j * 4 + 3] = 0.5 + 0.5 * st;
      }
      this.#end();
    }
  }

  /** A straight, kinked ion tail pointing away from the star and a wider dust tail curving back along the orbit. */
  #comet(e, clock) {
    const S = this.S, d = this.data, i = e.body, s0 = S.star[i];
    let ax = S.pos[i * 3] - S.pos[s0 * 3], ay = S.pos[i * 3 + 1] - S.pos[s0 * 3 + 1], az = S.pos[i * 3 + 2] - S.pos[s0 * 3 + 2];
    const dist = hyp(ax, ay, az);
    ax /= dist; ay /= dist; az /= dist;                         // anti-sunward
    const vx = S.vdir[i * 3], vy = S.vdir[i * 3 + 1], vz = S.vdir[i * 3 + 2];
    let px = ay * vz - az * vy, py = az * vx - ax * vz, pz = ax * vy - ay * vx;   // sideways, for the kinks
    const pl = hyp(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
    const activity = Math.min(3, Math.pow(S.K.AU_km / dist, 1.5));              // tails grow towards the star
    const Li = 9.0e6 * activity, Ld = 5.5e6 * activity;
    // ion tail: three thin rays, straight down the solar wind, fanning by a degree or two, knots drifting along them
    for (let k = 0; k < 3; k++) {
      const side = (k - 1) * 0.022, gain = k === 1 ? 0.85 : 0.42;
      const p = this.#begin(gain, 900, Li * (k === 1 ? 0.0045 : 0.0028), 13 + 4 * k, 0.30, 0.60, 1.0, 2.6 + 0.5 * k);
      for (let j = 0; j < LINE_POINTS; j++) {
        const s = j / (LINE_POINTS - 1), kink = Li * (0.010 * s * Math.sin(s * 9 + clock * 0.5 + k * 2.1) + side * s);
        d[p + j * 4] = ax * Li * s + px * kink; d[p + j * 4 + 1] = ay * Li * s + py * kink; d[p + j * 4 + 2] = az * Li * s + pz * kink;
        d[p + j * 4 + 3] = Math.pow(1 - s, 0.7);
      }
      this.#end();
    }
    // dust tail: grains lag behind the nucleus along its orbit, the heavier ones more, so the tail is a curved fan
    for (let k = 0; k < 5; k++) {
      const curve = 0.35 + 0.24 * k, len = Ld * (1 - 0.09 * k);
      const p = this.#begin(0.26 - 0.03 * k, 3000, len * 0.085, 5, 1.0, 0.90, 0.72, 0.5);
      for (let j = 0; j < LINE_POINTS; j++) {
        const s = j / (LINE_POINTS - 1);
        const dx = ax - vx * curve * s, dy = ay - vy * curve * s, dz = az - vz * curve * s;
        const dl = len * s / hyp(dx, dy, dz);
        d[p + j * 4] = dx * dl; d[p + j * 4 + 1] = dy * dl; d[p + j * 4 + 2] = dz * dl; d[p + j * 4 + 3] = 1 - s;
      }
      this.#end();
    }
    this.bodyData[i * BODY_SLOT_FLOATS + B.bnd + 3] = Math.max(Li, Ld) * 1.05;   // the corona pass must cover the tails
  }
}
