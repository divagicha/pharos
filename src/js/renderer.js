// Frame encoding: scene pass (sky, stars, the sorted draw list), bloom chain, composite to the canvas.
// Pass descriptors and bind groups are built once (and again on resize) and only patched per frame.
// Our own code allocates nothing in render(); WebGPU itself creates the encoder, pass encoders,
// the canvas texture view and the command buffer each frame, which cannot be avoided.
import { BLOOM_LEVELS } from './gpu.js';
import { createGlobalsBindGroup } from './noise.js';

export const GLOBALS_FLOATS = 32;      // struct Globals in common.wgsl: 8 x vec4f

export class Renderer {
  /**
   * @param {{device: GPUDevice, context: GPUCanvasContext}} gpu
   * @param {{[name: string]: GPURenderPipeline}} pipes   from createPipelines()
   * @param {{[name: string]: GPUBindGroupLayout}} layouts from createLayouts()
   * @param {import('./gpu.js').Targets} targets
   * @param {import('./perf.js').FrameTimer} timer
   * @param {{value: GPUTextureView, gradient: GPUTextureView, sampler: GPUSampler}} noise  baked noise volumes
   */
  constructor(gpu, pipes, layouts, targets, timer, noise) {
    this.device = gpu.device;
    this.context = gpu.context;
    this.pipes = pipes;
    this.layouts = layouts;
    this.targets = targets;
    this.timer = timer;

    this.globals = new Float32Array(GLOBALS_FLOATS);
    this.globalsBuf = this.device.createBuffer({ label: 'globals', size: GLOBALS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.globalsBG = createGlobalsBindGroup(this.device, layouts.globals, this.globalsBuf, 0, GLOBALS_FLOATS * 4, noise);
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // sky resources, supplied by setSky()
    this.skyBG = null;
    this.starBuf = null;
    this.starCount = 0;

    // scene content, set by the composition root: bodies (draw) and the wrapped fields (drawOpaque / drawTransparent)
    this.scene = null;
    this.field = null;

    this.scenePass = {
      colorAttachments: [{ view: null, resolveTarget: undefined, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    };
    this.downPass = []; this.downBG = [];
    this.upPass = []; this.upBG = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.downPass.push({ colorAttachments: [{ view: null, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
      this.downBG.push(null);
    }
    for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
      this.upPass.push({ colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }] });
      this.upBG.push(null);
    }
    this.compPass = { colorAttachments: [{ view: null, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] };
    this.compBG = null;
    this.timer.attach(this.scenePass, this.compPass);
    this.submitList = [null];
  }

  /** Cubemap view for the sky pass and the instance buffer for the star points. */
  setSky(cubeView, starData, starFloats) {
    const dev = this.device;
    const cubeSampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.skyBG = dev.createBindGroup({ layout: this.layouts.sky, entries: [{ binding: 0, resource: cubeView }, { binding: 1, resource: cubeSampler }] });
    this.starBuf = dev.createBuffer({ label: 'stars', size: starData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.starBuf, 0, starData);
    this.starCount = starData.length / starFloats;
  }

  /** Rebuild everything that points at size-dependent textures. Call after targets.resize() returned true. */
  rebuild() {
    const t = this.targets, dev = this.device;
    const ca = this.scenePass.colorAttachments[0];
    ca.view = t.sceneView;
    ca.resolveTarget = t.resolveView || undefined;
    ca.storeOp = t.resolveView ? 'discard' : 'store';
    this.scenePass.depthStencilAttachment.view = t.depthView;
    const post = (a, b) => dev.createBindGroup({
      layout: this.layouts.post,
      entries: [{ binding: 0, resource: a }, { binding: 1, resource: this.sampler }, { binding: 2, resource: b }],
    });
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? t.hdrView : t.bloomViews[i - 1];
      this.downPass[i].colorAttachments[0].view = t.bloomViews[i];
      this.downBG[i] = post(src, src);
    }
    for (let i = 0; i < BLOOM_LEVELS - 1; i++) {
      this.upPass[i].colorAttachments[0].view = t.bloomViews[i];
      this.upBG[i] = post(t.bloomViews[i + 1], t.bloomViews[i + 1]);
    }
    this.compBG = post(t.hdrView, t.bloomViews[0]);
  }

  /** Encode and submit one frame. this.globals must already hold this frame's values. */
  render() {
    const dev = this.device, P = this.pipes;
    dev.queue.writeBuffer(this.globalsBuf, 0, this.globals);
    this.timer.begin();
    const enc = dev.createCommandEncoder();

    let pass = enc.beginRenderPass(this.scenePass);
    pass.setBindGroup(0, this.globalsBG);
    pass.setPipeline(P.sky);
    pass.setBindGroup(1, this.skyBG);
    pass.draw(3);
    pass.setPipeline(P.stars);
    pass.setVertexBuffer(0, this.starBuf);
    pass.draw(4, this.starCount);
    if (this.field) this.field.drawOpaque(pass);
    if (this.scene) this.scene.draw(pass);
    if (this.field) this.field.drawTransparent(pass);
    pass.end();

    for (let i = 0; i < BLOOM_LEVELS; i++) {
      pass = enc.beginRenderPass(this.downPass[i]);
      pass.setPipeline(i === 0 ? P.down0 : P.down);
      pass.setBindGroup(0, this.globalsBG);
      pass.setBindGroup(1, this.downBG[i]);
      pass.draw(3);
      pass.end();
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      pass = enc.beginRenderPass(this.upPass[i]);
      pass.setPipeline(P.up);
      pass.setBindGroup(0, this.globalsBG);
      pass.setBindGroup(1, this.upBG[i]);
      pass.draw(3);
      pass.end();
    }

    this.compPass.colorAttachments[0].view = this.context.getCurrentTexture().createView();
    pass = enc.beginRenderPass(this.compPass);
    pass.setPipeline(P.comp);
    pass.setBindGroup(0, this.globalsBG);
    pass.setBindGroup(1, this.compBG);
    pass.draw(3);
    pass.end();

    this.timer.resolve(enc);
    this.submitList[0] = enc.finish();
    dev.queue.submit(this.submitList);
    this.submitList[0] = null;
    this.timer.afterSubmit();
  }
}
