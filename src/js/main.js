// Composition root: acquires the device, builds every resource once, wires the modules together
// and runs the frame loop. No other module constructs its own collaborators.
import { body, sky, post, field as fieldCode, bake } from 'virtual:shaders';
import DATA from '../data/system.json';
import { P, CAPTURE, TOURING } from './params.js';
import { initGPU, Targets } from './gpu.js';
import { createLayouts, createShaderModules, createPipelines, SCENE_SAMPLES } from './pipelines.js';
import { Renderer } from './renderer.js';
import { FrameTimer, summarise, worst } from './perf.js';
import { makeStarCatalogue, createSkyCube, NebulaBaker, STAR_FLOATS } from './sky.js';
import { cam, updateBasis, setAspect, rotateLocal } from './camera.js';
import { quatLook, DEG } from './math.js';
import { input, initInput } from './input.js';
import { buildSystem, stepSystem } from './sim.js';
import { Scene } from './scene.js';
import { Field } from './field.js';
import { createNoise } from './noise.js';
import { LOOKS } from './looks.js';
import { flight, findNearest, placeView } from './flight.js';
import { auto } from './autopilot.js';
import { G } from './layout.js';
import { DAY } from './derive.js';
import { CURSOR, wantsPointerLock } from './mode.js';
import { control, initControl, handleInput, advance, fillHud, syncPointerLock } from './control.js';
import { inspect, select, updateInspect } from './inspect.js';
import { cursorRay } from './pick.js';
import { Hud, hudState } from './hud.js';
import { tour, initTour, tourAt, tourSimTime, tourClock, applyPose, TOUR_SECONDS, TIME_RATE } from './tour.js';

const canvas = document.getElementById('c');
const msgEl = document.getElementById('msg');
window.__errors = [];
window.__ready = false;

function reportError(text) {
  if (window.__errors.length < 20) window.__errors.push(String(text));
  console.error(text);
}
function fail(e) {
  reportError(e && e.message ? e.message : e);
  msgEl.textContent = e && e.message ? e.message : String(e);
}
addEventListener('error', e => reportError('JS: ' + e.message));
addEventListener('unhandledrejection', e => reportError('JS: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

let gpu = null, renderer = null, targets = null, timer = null, scene = null, field = null, S = null, baker = null, hud = null;
// The loop's running numbers live in one typed array: a module-level `let` holding a non-integer is boxed
// afresh on every assignment, which would be a small allocation per frame.
const N = new Float64Array(8);
const FADE = 0;                    // master fade: the scene comes up from black once the nebula is baked
const LAST = 1;                    // time of the previous frame (ms)
const CLOCK = 2;                   // animation clock (s): clouds, storms, granulation, pulsar
const SIM = 3;                     // simulation time (s since epoch): orbits and spins
const WARP = 4;                    // strength of the warp look this frame
const TOUR = 5;                    // tour time (s)
const SEEK = 6;                    // capture: a tour time asked for through window.__seek, or -1
N[TOUR] = P.tt >= 0 ? P.tt : 0; N[SEEK] = -1;
let framesSinceReady = 0;          // frames rendered fully faded in since the last capture request
let sizeDirty = true;
let posed = false;                 // a fixed pose: both clocks stand still, so every capture of it is the same instant
let settle = 0;                    // frames drawn fully faded in before the tour's clock starts
let tourState = 0;                 // 0 waiting for the fade, 1 running, 2 collecting the last GPU times, 3 reported
const readyAfter = P.frames > 0 ? P.frames : 6;

function applySize() {
  sizeDirty = false;
  let w, h;
  if (P.resW > 0) { w = P.resW; h = P.resH; } else {
    const dpr = window.devicePixelRatio || 1;
    w = Math.max(1, Math.round(canvas.clientWidth * dpr)); h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  if (targets.resize(w, h)) { renderer.rebuild(); setAspect(w, h); }
}

function fillGlobals() {
  const g = renderer.globals, w = targets.width, h = targets.height;
  g[G.right] = cam.right[0]; g[G.right + 1] = cam.right[1]; g[G.right + 2] = cam.right[2]; g[G.right + 3] = cam.tanX;
  g[G.up] = cam.up[0]; g[G.up + 1] = cam.up[1]; g[G.up + 2] = cam.up[2]; g[G.up + 3] = cam.tanY;
  g[G.fwd] = cam.fwd[0]; g[G.fwd + 1] = cam.fwd[1]; g[G.fwd + 2] = cam.fwd[2]; g[G.fwd + 3] = cam.near;
  g[G.res] = w; g[G.res + 1] = h; g[G.res + 2] = 1 / w; g[G.res + 3] = 1 / h;
  g[G.time] = N[CLOCK]; g[G.time + 1] = 2 * cam.tanY / h; g[G.time + 2] = N[WARP]; g[G.time + 3] = h / 1440;
  g[G.post] = Math.pow(2, P.exp); g[G.post + 1] = 0.14; g[G.post + 2] = N[FADE] * (1 - 0.9 * control.edge); g[G.post + 3] = 1;
}

/** Bake the nebula a few tiles per frame, then fade the picture in. Returns true once it is fully up. */
function stepFade(dt) {
  if (!baker.done) { baker.step(CAPTURE || TOURING ? 16 : 4); return false; }
  N[FADE] = CAPTURE || TOURING ? 1 : Math.min(1, N[FADE] + dt / 1.2);
  return N[FADE] >= 1;
}

/** A person (or nobody) at the controls: input, flight or autopilot, the boundary. */
function stepInteractive(dt) {
  if (!P.freeze && !posed) { N[CLOCK] += dt; N[SIM] += dt * TIME_RATE; }
  stepSystem(S, N[SIM]);
  handleInput(S, scene, canvas.clientWidth, canvas.clientHeight, renderer.globals[G.time + 1]);
  advance(dt, S, scene);
  N[WARP] = auto.warp;
  fillHud(S, scene, canvas.clientWidth, canvas.clientHeight, !CAPTURE);
  hudState.refresh = CAPTURE;
  return dt;
}

/** The scripted tour: everything is a function of tour time. Returns the time step the wrapped fields should take. */
function stepTour(dt, up) {
  let step = 0;
  if (N[SEEK] >= 0) { step = N[SEEK] - N[TOUR]; N[TOUR] = N[SEEK]; N[SEEK] = -1; }
  else if (tourState === 1) { step = dt; N[TOUR] = Math.min(N[TOUR] + dt, TOUR_SECONDS); }
  if (P.tour) runTourClock(up);
  N[CLOCK] = tourClock(N[TOUR]); N[SIM] = tourSimTime(N[TOUR]);
  stepSystem(S, N[SIM]);
  tourAt(N[TOUR], S);
  scene.computeRel(cam);
  findNearest(scene, S);
  N[WARP] = tour.warp;
  inspect.sel = tour.sel; inspect.panel = tour.panel; inspect.forced = tour.open; inspect.follow = true;
  fillHud(S, scene, canvas.clientWidth, canvas.clientHeight, false);
  hudState.tour = true; hudState.focus = tour.sel; hudState.eta = tour.eta; hudState.refresh = !P.tour;
  return step;
}

/** Start the measured run when the picture is up; stop it after sixty seconds; report when the GPU times are all in. */
function runTourClock(up) {
  // the clock starts a moment after the picture is up, so the last of the start-up work is not timed as tour
  if (tourState === 0 && up && ++settle > 45) { tourState = 1; timer.start(); window.__tourStarted = true; }
  else if (tourState === 1 && N[TOUR] >= TOUR_SECONDS) { tourState = 2; timer.stop(); }
  else if (tourState === 2 && timer.settled) { tourState = 3; report(); }
}

function report() {
  const gpuMs = summarise(timer.gpuMs, timer.gpuCount), raf = summarise(timer.frameMs, timer.frameCount);
  const r = {
    adapter: gpu.info, resolution: `${targets.width}x${targets.height}`, samples: targets.samples, userAgent: navigator.userAgent,
    seconds: TOUR_SECONDS, frames: raf.n, gpuFrames: gpuMs.n, gpuDropped: timer.dropped, timestamps: gpu.hasTimestamps,
    gpuMs, rafMs: raf, worstGaps: worst(timer.frameMs, timer.frameCount, 8), dynamicResolution: false,
  };
  window.__report = r;
  const f = v => v.toFixed(2).padStart(7);
  const text = `GRAND TOUR  ${r.seconds} s  ${r.resolution}  ${r.frames} frames\n\n`
    + `             average     99th      max   (ms)\n`
    + `GPU time     ${f(gpuMs.avg)}  ${f(gpuMs.p99)}  ${f(gpuMs.max)}   ${gpuMs.n} frames timed\n`
    + `frame gap    ${f(raf.avg)}  ${f(raf.p99)}  ${f(raf.max)}\n\n`
    + `${r.adapter.vendor} ${r.adapter.architecture} ${r.adapter.description || ''}`;
  console.log(text);
  const box = document.createElement('pre');
  box.id = 'rep';
  box.textContent = text;
  document.body.append(box);
}

function frame(now) {
  requestAnimationFrame(frame);
  const interval = N[LAST] ? now - N[LAST] : 16.7;
  N[LAST] = now;
  timer.frame(interval);
  const dt = Math.min(interval, 100) * 0.001;
  if (sizeDirty) applySize();
  const up = stepFade(dt);
  const fieldDt = TOURING ? stepTour(dt, up) : stepInteractive(dt);

  const ray = control.hasCursor ? control.ray : null;
  updateInspect(dt, scene, S, cam, control.dragX, control.dragY, ray);
  hudState.hover = inspect.hover;
  field.update(cam, flight.vel, fieldDt, N[CLOCK], flight.altitude, N[WARP]);
  flight.ceiling = field.mask > 0 ? 400 + (1 - field.mask) * 1e9 : 1e30;   // the belt would streak past unseen otherwise

  fillGlobals();
  scene.update(renderer.globals[G.time + 1], N[CLOCK]);
  renderer.render();
  hud.frame(hudState, cam, dt);

  if (up && ++framesSinceReady === readyAfter) {
    window.__info.gpuMs = timer.batchAvgMs; window.__info.gpuMaxMs = timer.batchMaxMs; window.__info.batches = timer.batches;
    window.__info.tourT = TOURING ? N[TOUR] : -1;
    window.__ready = true;
  }
}

/** Camera, clocks and HUD state at start-up, from the pose or the development parameters. */
function placeStart() {
  const AU = DATA.constants.AU_km;
  const pose = P.pose > 0 ? (stepSystem(S, 0), applyPose(P.pose, S)) : null;
  if (pose) {
    posed = true;
    N[CLOCK] = pose.clock; N[SIM] = pose.day * DAY;
    stepSystem(S, N[SIM]);
    applyPose(P.pose, S);                       // again, now that the bodies are where they will be drawn
  } else {
    if (!isNaN(P.clock)) N[CLOCK] = P.clock;
    if (!isNaN(P.day)) N[SIM] = P.day * DAY;
    stepSystem(S, N[SIM]);
    if (P.pos) {
      cam.sys = 0;
      cam.pos[0] = P.pos.x * AU; cam.pos[1] = P.pos.y * AU; cam.pos[2] = P.pos.z * AU;
      quatLook(cam.q, [1, 0, 0], [0, 1, 0]);
      updateBasis();
      rotateLocal(-P.pos.yaw * DEG, 0, 0);
      rotateLocal(0, P.pos.pitch * DEG, 0);
    } else {
      const v = P.view || { body: 'pelagia', dist: 3.4, az: 50, el: 12, yaw: 0, pitch: 0, roll: 0 };
      if (!S.index.has(v.body)) throw new Error(`?view names an unknown body "${v.body}"`);
      placeView(S, S.index.get(v.body), v.dist, v.az, v.el, v.yaw, v.pitch, v.roll, P.eq);
    }
  }
  updateBasis();
  const sel = pose ? pose.sel : P.sel;
  if (sel) {
    if (!S.index.has(sel)) throw new Error(`unknown body "${sel}"`);
    select(S.index.get(sel));
    inspect.panel = pose ? !!pose.panel : P.panel;
  }
  if (P.cursor || (pose && pose.panel)) control.mode = CURSOR;
  if (CAPTURE && !TOURING) { inspect.forced = inspect.panel ? 1 : 0; inspect.follow = false; }
  if (P.mouse) { input.mouseX = P.mouse[0] * canvas.clientWidth; input.mouseY = P.mouse[1] * canvas.clientHeight; }
  return pose;
}

async function boot() {
  gpu = await initGPU(canvas, reportError);
  window.__info = { adapter: gpu.info, timestamps: gpu.hasTimestamps };
  const layouts = createLayouts(gpu.device);
  const shaders = createShaderModules(gpu.device, { body, sky, post, field: fieldCode, bake });
  const pipes = await createPipelines(gpu.device, shaders, layouts, gpu.format);
  targets = new Targets(gpu.device, P.msaa === 1 ? 1 : SCENE_SAMPLES);
  timer = new FrameTimer(gpu.device, gpu.hasTimestamps);
  const noise = createNoise(gpu.device, pipes);
  renderer = new Renderer(gpu, pipes, layouts, targets, timer, noise);
  const cube = createSkyCube(gpu.device, P.neb);
  baker = new NebulaBaker(gpu.device, layouts.globals, pipes.nebula, cube, noise);
  renderer.setSky(cube.cubeView, makeStarCatalogue(), STAR_FLOATS);

  S = buildSystem(DATA);
  scene = new Scene(gpu.device, layouts, pipes, S, LOOKS, DATA);
  renderer.scene = scene;
  field = new Field(gpu.device, layouts, pipes, S, DATA.belt);
  renderer.field = field;
  for (const name of P.no) scene.skip[name] = true;
  if (P.only) scene.only = S.index.get(P.only) ?? -1;
  initControl(S, DATA, LOOKS);
  initTour(S, DATA);
  hud = new Hud(document.getElementById('hud'), S, DATA, LOOKS, scene, layer => { inspect.hoverHud = layer; });
  hudState.visible = P.hud;
  if (CAPTURE || P.tt >= 0) document.getElementById('hud').classList.add('still');
  if (DEV) window.__dbg = { cam, control, inspect, flight, auto, hudState, tour, S, scene };
  placeStart();

  initInput(canvas);
  canvas.addEventListener('click', () => { if (wantsPointerLock(control.mode)) syncPointerLock(); });
  new ResizeObserver(() => { sizeDirty = true; }).observe(canvas);
  // capture: jump to another moment of the tour without reloading; __ready goes true again once it has been drawn
  window.__seek = t => { N[SEEK] = Math.max(0, +t); framesSinceReady = 0; window.__ready = false; };
  requestAnimationFrame(frame);
}

boot().catch(fail);
