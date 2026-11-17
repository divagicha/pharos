// Render pipelines, built from tools/modules.json. The page and tools/wgsl-check.mjs both call this file,
// so "npm run check" validates exactly the descriptors the app runs with.
//
// Manifest pipeline entry:
//   name      key the renderer looks the pipeline up by
//   module    WGSL module name; vs / fs are its entry points
//   groups    bind group layouts, in group order: "globals" | "body" | "loops" | "zone" | "sky" | "post"
//   depth     "write" (greater, write) | "test" (greater, read only) | "always" (no test, no write) | absent (no depth attachment)
//   blend     "premul" | "add" | "dsb" (dual source: dst = src0 + dst*src1) | absent (opaque)
//   target    "hdr" (rgba16float, default) | "canvas" | an explicit texture format (the noise bakes)
//   msaa      true = scene sample count, absent = 1
//   topology  default "triangle-strip"
//   buffers   vertex buffer layouts, passed through
import manifest from '../../tools/modules.json';

export const SCENE_SAMPLES = 4;
export const HDR_FORMAT = 'rgba16float';
export const DEPTH_FORMAT = 'depth32float';
export const REQUIRED_FEATURES = ['dual-source-blending'];
export const OPTIONAL_FEATURES = ['timestamp-query'];
export const PIPELINES = manifest.pipelines;

const VF = 3; // GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
const F = 2;  // GPUShaderStage.FRAGMENT
const uniform = (binding, visibility = VF) => ({ binding, visibility, buffer: { type: 'uniform' } });

const GROUP_ENTRIES = {
  globals: [uniform(0),
    { binding: 1, visibility: VF, texture: { viewDimension: '3d' } }, { binding: 2, visibility: VF, texture: { viewDimension: '3d' } },
    { binding: 3, visibility: VF, sampler: {} }],
  body: [uniform(0)],
  loops: [uniform(0, F)],
  zone: [uniform(0)],
  sky: [{ binding: 0, visibility: F, texture: { viewDimension: 'cube' } }, { binding: 1, visibility: F, sampler: {} }],
  post: [{ binding: 0, visibility: F, texture: {} }, { binding: 1, visibility: F, sampler: {} }, { binding: 2, visibility: F, texture: {} }],
};

const BLEND = {
  premul: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  add: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } },
  dsb: { color: { srcFactor: 'one', dstFactor: 'src1' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } },
};

const DEPTH = {
  write: { depthCompare: 'greater', depthWriteEnabled: true },
  test: { depthCompare: 'greater', depthWriteEnabled: false },
  always: { depthCompare: 'always', depthWriteEnabled: false },
};

/** One GPUBindGroupLayout per name in GROUP_ENTRIES. */
export function createLayouts(device) {
  const out = {};
  for (const name in GROUP_ENTRIES) out[name] = device.createBindGroupLayout({ label: name, entries: GROUP_ENTRIES[name] });
  return out;
}

/** Shader modules keyed by manifest module name. `code` maps module name to WGSL text. */
export function createShaderModules(device, code) {
  const out = {};
  for (const name in code) out[name] = device.createShaderModule({ label: name, code: code[name] });
  return out;
}

export function pipelineDescriptor(device, p, shaders, layouts, canvasFormat) {
  const target = { format: p.target === 'canvas' ? canvasFormat : p.target && p.target !== 'hdr' ? p.target : HDR_FORMAT };
  if (p.blend) target.blend = BLEND[p.blend];
  const desc = {
    label: p.name,
    layout: device.createPipelineLayout({ label: p.name, bindGroupLayouts: p.groups.map(g => layouts[g]) }),
    vertex: { module: shaders[p.module], entryPoint: p.vs, buffers: p.buffers || [] },
    fragment: { module: shaders[p.module], entryPoint: p.fs, targets: [target] },
    primitive: { topology: p.topology || 'triangle-strip', cullMode: p.cull || 'none' },
    multisample: { count: p.msaa ? SCENE_SAMPLES : 1 },
  };
  if (p.depth) desc.depthStencil = { format: DEPTH_FORMAT, ...DEPTH[p.depth] };
  return desc;
}

/** Create every pipeline in the manifest without blocking the main thread. Resolves to {name: GPURenderPipeline}. */
export async function createPipelines(device, shaders, layouts, canvasFormat) {
  const list = await Promise.all(PIPELINES.map(p => device.createRenderPipelineAsync(pipelineDescriptor(device, p, shaders, layouts, canvasFormat))));
  const out = {};
  PIPELINES.forEach((p, i) => { out[p.name] = list[i]; });
  return out;
}
