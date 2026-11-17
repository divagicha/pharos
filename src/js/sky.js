// Sky resources: the background star catalogue (instanced points) and the nebula cubemap.
// Start-up only; nothing here runs per frame.
import { rng, clamp } from './math.js';
import { HDR_FORMAT } from './pipelines.js';
import { G, GLOBALS_FLOATS } from './layout.js';
import { createGlobalsBindGroup } from './noise.js';

export const STAR_COUNT = 30000;
export const STAR_FLOATS = 8;          // dir.xyz, half-size px, rgb, unused: matches the "stars" vertex layout (32 bytes)

// Galactic frame in world axes: N = pole of the band, C = direction of the galactic centre, T = N x C.
export const GAL_N = unit(0.42, 0.78, 0.46);
export const GAL_C = orthoUnit(GAL_N, 0.72, -0.05, -0.69);
export const GAL_T = [GAL_N[1] * GAL_C[2] - GAL_N[2] * GAL_C[1], GAL_N[2] * GAL_C[0] - GAL_N[0] * GAL_C[2], GAL_N[0] * GAL_C[1] - GAL_N[1] * GAL_C[0]];

function unit(x, y, z) { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; }
function orthoUnit(n, x, y, z) { const d = x * n[0] + y * n[1] + z * n[2]; return unit(x - d * n[0], y - d * n[1], z - d * n[2]); }

/**
 * Colour of a black body at temperature T (kelvin) as linear sRGB with luminance 1, written to o[i..i+2].
 * After Tanner Helland's fit to Mitchell Charity's table; good from about 1,500 K upward.
 */
export function kelvinRGB(T, o, i = 0) {
  const t = clamp(T, 1500, 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  r = Math.pow(clamp(r, 0, 255) / 255, 2.2); g = Math.pow(clamp(g, 0, 255) / 255, 2.2); b = Math.pow(clamp(b, 0, 255) / 255, 2.2);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  o[i] = r / y; o[i + 1] = g / y; o[i + 2] = b / y;
  return o;
}

/** Build the instance data for the background stars: denser towards the galactic band, power-law brightness. */
export function makeStarCatalogue() {
  const data = new Float32Array(STAR_COUNT * STAR_FLOATS);
  const r = rng(0x9e3779b1);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const rgb = [0, 0, 0];
  for (let i = 0; i < STAR_COUNT; i++) {
    let x, y, z;
    if (r() < 0.62) {                                   // disc population: thin and thick components, bulge towards the centre
      const lat = gauss() * (r() < 0.68 ? 0.085 : 0.26);
      let lon = (r() * 2 - 1) * Math.PI;
      if (r() < 0.42) lon *= r();
      const cl = Math.cos(lat), sl = Math.sin(lat), c = Math.cos(lon) * cl, s = Math.sin(lon) * cl;
      x = GAL_C[0] * c + GAL_T[0] * s + GAL_N[0] * sl;
      y = GAL_C[1] * c + GAL_T[1] * s + GAL_N[1] * sl;
      z = GAL_C[2] * c + GAL_T[2] * s + GAL_N[2] * sl;
    } else {                                            // halo population: uniform on the sphere
      z = r() * 2 - 1; const a = r() * 2 * Math.PI, q = Math.sqrt(1 - z * z);
      x = q * Math.cos(a); y = q * Math.sin(a);
    }
    const flux = Math.min(0.02 * Math.pow(1 - r(), -0.74), 12);     // N(>F) ~ F^-1.35
    const u = r();
    const T = u < 0.22 ? 3000 + 1600 * r() : u < 0.62 ? 4600 + 2000 * r() : u < 0.9 ? 6600 + 3400 * r() : 10000 + 18000 * r() * r();
    kelvinRGB(T, rgb);
    const k = 0.78;                                     // colour saturation of the points
    const o = i * STAR_FLOATS;
    data[o] = x; data[o + 1] = y; data[o + 2] = z;
    data[o + 3] = flux < 0.8 ? 2.5 : Math.min(2.5 + 2.6 * Math.log2(flux / 0.8 + 1), 13);
    data[o + 4] = (1 + (rgb[0] - 1) * k) * flux; data[o + 5] = (1 + (rgb[1] - 1) * k) * flux; data[o + 6] = (1 + (rgb[2] - 1) * k) * flux;
  }
  return data;
}

/**
 * The nebula cubemap. Created empty (faces cleared to a dim placeholder); the bake fills it in later.
 * @returns {{texture: GPUTexture, cubeView: GPUTextureView, faceViews: GPUTextureView[], size: number}}
 */
export function createSkyCube(device, size) {
  const texture = device.createTexture({
    label: 'nebula', size: [size, size, 6], format: HDR_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const faceViews = [];
  for (let f = 0; f < 6; f++) faceViews.push(texture.createView({ dimension: '2d', baseArrayLayer: f, arrayLayerCount: 1 }));
  const enc = device.createCommandEncoder();
  for (let f = 0; f < 6; f++) {
    enc.beginRenderPass({ colorAttachments: [{ view: faceViews[f], clearValue: [0.004, 0.005, 0.009, 1], loadOp: 'clear', storeOp: 'store' }] }).end();
  }
  device.queue.submit([enc.finish()]);
  return { texture, cubeView: texture.createView({ dimension: 'cube' }), faceViews, size };
}

// Cube face bases as [right, up, forward]: the direction of texel (u, v), v down, is forward + right*u - up*v.
// This is the standard cubemap layout, so the baked faces line up without seams.
const FACES = [
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]], [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
];
const FACE_SLOT_BYTES = 256;

/**
 * Bakes the nebula into the sky cubemap a few tiles at a time, so no single draw is long enough to stall the
 * GPU. Call step() once per frame until done is true. Start-up only.
 */
export class NebulaBaker {
  /**
   * @param {GPUDevice} device
   * @param {GPUBindGroupLayout} globalsLayout  the bake reuses struct Globals to describe each face
   * @param {GPURenderPipeline} pipeline         "nebula"
   * @param {{faceViews: GPUTextureView[], size: number}} cube
   * @param {object} noise  baked noise volumes (the nebula shader reads them through group 0)
   */
  constructor(device, globalsLayout, pipeline, cube, noise, tile = 256) {
    this.device = device; this.pipeline = pipeline; this.size = cube.size;
    this.tile = Math.min(tile, cube.size);
    this.perSide = Math.ceil(cube.size / this.tile);
    this.total = 6 * this.perSide * this.perSide;
    this.next = 0;
    const data = new Float32Array(6 * FACE_SLOT_BYTES / 4);
    FACES.forEach((f, i) => {
      const o = i * FACE_SLOT_BYTES / 4;
      data.set([...f[0], 1], o + G.right); data.set([...f[1], 1], o + G.up); data.set([...f[2], 0.001], o + G.fwd);
      data.set([cube.size, cube.size, 1 / cube.size, 1 / cube.size], o + G.res);
      data.set([...GAL_N, 0], o + G.vel); data.set([...GAL_C, 0], o + G.aux);
    });
    const buf = device.createBuffer({ label: 'nebula-faces', size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    this.bg = FACES.map((_, i) => createGlobalsBindGroup(device, globalsLayout, buf, i * FACE_SLOT_BYTES, GLOBALS_FLOATS * 4, noise));
    this.pass = cube.faceViews.map(view => ({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] }));
  }

  get done() { return this.next >= this.total; }
  /** Fraction baked so far, 0..1. */
  get progress() { return this.next / this.total; }

  /** Bake up to `count` more tiles. */
  step(count) {
    if (this.done) return;
    const enc = this.device.createCommandEncoder();
    for (let k = 0; k < count && !this.done; k++, this.next++) {
      const per = this.perSide * this.perSide, face = Math.floor(this.next / per), t = this.next % per;
      const x = (t % this.perSide) * this.tile, y = Math.floor(t / this.perSide) * this.tile;
      const pass = enc.beginRenderPass(this.pass[face]);
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bg[face]);
      pass.setScissorRect(x, y, Math.min(this.tile, this.size - x), Math.min(this.tile, this.size - y));
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
  }
}
