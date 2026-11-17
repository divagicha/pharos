// The two baked noise volumes that replace per-pixel hash noise (src/bake.wgsl writes them, vnoise() and
// noised() in src/common.wgsl read them). Baking them costs a few milliseconds once; reading them turns
// eight hashes and an interpolation into a single filtered texture fetch.
// Start-up only.
export const NOISE_SIZE = 128;

/**
 * Create and bake both volumes.
 * @param {GPUDevice} device
 * @param {{bakeV: GPURenderPipeline, bakeG: GPURenderPipeline}} pipes
 * @returns {{value: GPUTextureView, gradient: GPUTextureView, sampler: GPUSampler}}
 */
export function createNoise(device, pipes) {
  const make = (label, format) => device.createTexture({
    label, size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE], dimension: '3d', format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const value = make('noise-value', 'r16float').createView();
  const gradient = make('noise-gradient', 'rgba16float').createView();
  const enc = device.createCommandEncoder();
  for (const [view, pipeline] of [[value, pipes.bakeV], [gradient, pipes.bakeG]]) {
    for (let z = 0; z < NOISE_SIZE; z++) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, depthSlice: z, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.draw(3, 1, 0, z);                       // the slice index reaches the shader as the instance index
      pass.end();
    }
  }
  device.queue.submit([enc.finish()]);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
  return { value, gradient, sampler };
}

/** Bind group for group 0: the Globals uniform block plus the noise volumes. */
export function createGlobalsBindGroup(device, layout, buffer, offset, size, noise) {
  return device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer, offset, size } },
      { binding: 1, resource: noise.value },
      { binding: 2, resource: noise.gradient },
      { binding: 3, resource: noise.sampler },
    ],
  });
}
