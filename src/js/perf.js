// Frame timing: GPU time from timestamp queries (start of the first pass to the end of the last)
// and the requestAnimationFrame interval. Both go into preallocated logs.
//
// Timestamps are read back in batches: frame i of a batch writes queries 2i and 2i+1 of one large query set,
// which is resolved, copied out and mapped once every BATCH frames, so reading costs one promise per batch,
// not per frame. (Resolving per frame is not possible: resolve offsets must be multiples of 256 bytes.)
const BATCH = 128;
const READERS = 4;

export class FrameTimer {
  /** @param {GPUDevice} device  @param {boolean} hasTimestamps  @param {number} capacity frames kept in the logs */
  constructor(device, hasTimestamps, capacity = 1 << 16) {
    this.device = device;
    this.enabled = hasTimestamps;
    this.gpuMs = new Float32Array(capacity);    // GPU time per frame (ms), in arrival order
    this.gpuCount = 0;
    this.frameMs = new Float32Array(capacity);  // requestAnimationFrame intervals (ms)
    this.frameCount = 0;
    this.lastGpuMs = 0;
    this.batchAvgMs = 0;                       // mean and worst GPU time of the most recent batch of frames
    this.batchMaxMs = 0;
    this.batches = 0;
    this.dropped = 0;                            // recorded frames whose GPU time could not be read
    this.recording = false;
    this.slot = 0;
    this.flags = new Uint8Array(BATCH);          // 1 for each frame of the current batch that is being recorded
    this.unread = 0;                            // recorded frames whose GPU time has not been read back yet
    if (!hasTimestamps) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: BATCH * 2 });
    this.beginWrites = { querySet: this.querySet, beginningOfPassWriteIndex: 0 };
    this.endWrites = { querySet: this.querySet, endOfPassWriteIndex: 1 };
    this.resolveBuf = device.createBuffer({ size: BATCH * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readers = [];
    for (let i = 0; i < READERS; i++) {
      const buf = device.createBuffer({ size: BATCH * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const reader = { buf, busy: false, flags: new Uint8Array(BATCH), onMapped: null };
      reader.onMapped = () => this.#read(reader);
      this.readers.push(reader);
    }
    this.pending = null;
  }

  /** Attach the begin/end timestamps to the first and last render pass descriptors of the frame. */
  attach(firstPass, lastPass) {
    if (!this.enabled) return;
    firstPass.timestampWrites = this.beginWrites;
    lastPass.timestampWrites = this.endWrites;
  }

  /** Call once per frame before the first pass begins: selects this frame's pair of queries. */
  begin() {
    if (!this.enabled) return;
    this.beginWrites.beginningOfPassWriteIndex = this.slot * 2;
    this.endWrites.endOfPassWriteIndex = this.slot * 2 + 1;
    this.flags[this.slot] = this.recording ? 1 : 0;
    if (this.recording) this.unread++;
  }

  /** Call once per frame after the last pass has ended and before encoder.finish(). */
  resolve(encoder) {
    if (!this.enabled) return;
    this.slot++;
    if (this.slot < BATCH) return;
    this.slot = 0;
    encoder.resolveQuerySet(this.querySet, 0, BATCH * 2, this.resolveBuf, 0);
    let reader = null;
    for (let i = 0; i < READERS; i++) { if (!this.readers[i].busy) { reader = this.readers[i]; break; } }
    if (!reader) { this.#forget(this.flags); return; }     // every reader is still mapped: drop this batch
    encoder.copyBufferToBuffer(this.resolveBuf, 0, reader.buf, 0, BATCH * 16);
    reader.busy = true;
    reader.flags.set(this.flags);
    this.pending = reader;
  }

  /** Call once per frame after queue.submit(). */
  afterSubmit() {
    const reader = this.pending;
    if (!reader) return;
    this.pending = null;
    reader.buf.mapAsync(GPUMapMode.READ).then(reader.onMapped);
  }

  /** Record one requestAnimationFrame interval. */
  frame(intervalMs) {
    if (this.recording && this.frameCount < this.frameMs.length) this.frameMs[this.frameCount++] = intervalMs;
  }

  start() { this.gpuCount = 0; this.frameCount = 0; this.unread = 0; this.dropped = 0; this.recording = true; }
  stop() { this.recording = false; }
  /** True once every recorded frame's GPU time has been read back (or given up on). Keep rendering until then. */
  get settled() { return !this.enabled || this.unread === 0; }

  #forget(flags) {
    for (let i = 0; i < BATCH; i++) { if (flags[i]) { this.unread--; this.dropped++; } }
  }

  #read(reader) {
    const u = new Uint32Array(reader.buf.getMappedRange());   // pairs of u64 nanoseconds, read as lo/hi words: no BigInt
    let sum = 0, max = 0, n = 0;
    for (let i = 0; i < BATCH; i++) {
      const ms = ((u[i * 4 + 3] - u[i * 4 + 1]) * 4294967296 + (u[i * 4 + 2] - u[i * 4])) * 1e-6;
      const wanted = reader.flags[i] === 1;
      if (wanted) this.unread--;
      if (!(ms >= 0 && ms < 1000)) { if (wanted) this.dropped++; continue; }   // a wrapped or unwritten pair
      this.lastGpuMs = ms;
      sum += ms; n++; if (ms > max) max = ms;
      if (wanted && this.gpuCount < this.gpuMs.length) this.gpuMs[this.gpuCount++] = ms;
    }
    if (n > 0) { this.batchAvgMs = sum / n; this.batchMaxMs = max; this.batches++; }
    reader.buf.unmap();
    reader.busy = false;
  }
}

/**
 * The k longest entries of a frame-interval log with the time (s) at which each ended, counted from the start
 * of the log: where in the run the hitches were. Not for the frame path.
 */
export function worst(log, n, k) {
  const out = [];
  let t = 0;
  for (let i = 0; i < n; i++) { t += log[i]; out.push({ at: +(t / 1000).toFixed(2), ms: +log[i].toFixed(1) }); }
  return out.sort((a, b) => b.ms - a.ms).slice(0, k).sort((a, b) => a.at - b.at);
}

/** Average, 99th percentile and maximum of the first n entries of a log. Not for the frame path (it sorts a copy). */
export function summarise(log, n) {
  if (n === 0) return { n: 0, avg: 0, p99: 0, max: 0 };
  const s = Float32Array.from(log.subarray(0, n)).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return { n, avg: sum / n, p99: s[Math.min(n - 1, Math.ceil(n * 0.99) - 1)], max: s[n - 1] };
}
