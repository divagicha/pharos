// Device acquisition and the render targets that depend on the canvas size.
// Everything here runs at start-up or on resize, never in the frame path.
import { HDR_FORMAT, DEPTH_FORMAT, REQUIRED_FEATURES, OPTIONAL_FEATURES } from './pipelines.js';

export const BLOOM_LEVELS = 5;

/**
 * Acquire the adapter and device and configure the canvas.
 * @returns {Promise<{device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, hasTimestamps: boolean, info: object}>}
 * @throws {Error} with a message fit to show the user when WebGPU or a required feature is missing.
 */
export async function initGPU(canvas, onError) {
  if (!navigator.gpu) throw new Error('This browser has no WebGPU.\nPharos needs a recent Chrome or Edge with hardware acceleration on.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter was found.\nCheck that hardware acceleration is enabled.');
  const missing = REQUIRED_FEATURES.filter(f => !adapter.features.has(f));
  if (missing.length) throw new Error('This GPU lacks a WebGPU feature Pharos needs: ' + missing.join(', '));
  const requiredFeatures = [...REQUIRED_FEATURES, ...OPTIONAL_FEATURES.filter(f => adapter.features.has(f))];
  const device = await adapter.requestDevice({ requiredFeatures });
  device.addEventListener('uncapturederror', e => onError('GPU: ' + e.error.message));
  device.lost.then(l => onError('GPU device lost: ' + l.message));
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const i = adapter.info || {};
  return {
    device, context, format,
    hasTimestamps: device.features.has('timestamp-query'),
    info: { vendor: i.vendor || '', architecture: i.architecture || '', device: i.device || '', description: i.description || '' },
  };
}

/**
 * Size-dependent textures: the multisampled scene target, its depth buffer, the resolved HDR image
 * and the bloom chain (level 0 is half resolution).
 */
export class Targets {
  constructor(device, samples) {
    this.device = device;
    this.samples = samples;
    this.width = 0; this.height = 0;
    this.textures = [];
    this.sceneView = null;      // what the scene pass draws into (multisampled when samples > 1)
    this.resolveView = null;    // single-sample HDR result; null when samples == 1 (sceneView is the result)
    this.hdrView = null;        // the single-sample HDR image the post chain reads
    this.depthView = null;
    this.bloomViews = new Array(BLOOM_LEVELS).fill(null);
    this.bloomW = new Int32Array(BLOOM_LEVELS);
    this.bloomH = new Int32Array(BLOOM_LEVELS);
  }

  /** Recreate everything for a new size. Returns false when the size did not change. */
  resize(width, height) {
    if (width === this.width && height === this.height) return false;
    for (const t of this.textures) t.destroy();
    this.textures.length = 0;
    this.width = width; this.height = height;
    const dev = this.device;
    const tex = (label, w, h, format, sampleCount, usage) => {
      const t = dev.createTexture({ label, size: [w, h], format, sampleCount, usage });
      this.textures.push(t);
      return t.createView();
    };
    const RT = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    this.hdrView = tex('hdr', width, height, HDR_FORMAT, 1, RT | TB);
    if (this.samples > 1) {
      this.sceneView = tex('scene-ms', width, height, HDR_FORMAT, this.samples, RT);
      this.resolveView = this.hdrView;
    } else {
      this.sceneView = this.hdrView;
      this.resolveView = null;
    }
    this.depthView = tex('depth', width, height, DEPTH_FORMAT, this.samples, RT);
    let w = width, h = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      this.bloomW[i] = w; this.bloomH[i] = h;
      this.bloomViews[i] = tex('bloom' + i, w, h, HDR_FORMAT, 1, RT | TB);
    }
    return true;
  }
}
