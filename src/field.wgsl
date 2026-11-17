// Things that live in a lattice wrapped around the camera, so the GPU never sees a large coordinate:
// the asteroid field (instanced displaced icospheres, with point sprites for the ones too small to mesh)
// and the cosmic dust that conveys motion.
//
// An instance's place is base in [0,1)^3; its camera-relative position is (fract(base - camFrac + 0.5) - 0.5)*L,
// where camFrac is the camera's position in the lattice, computed in doubles on the CPU. Everything fades to
// nothing before half a cell, so the wrap is never seen.
struct Zone {
  rock: vec4f,     // xyz camFrac of the asteroid lattice, w cell size L (km)
  sun: vec4f,      // xyz unit direction to the star, w belt mask 0..1 (0 = outside the belt: nothing drawn)
  sunCol: vec4f,   // rgb sunlight, w animation time for tumbling (s)
  dustA: vec4f,    // xyz camFrac of dust layer A, w its cell size (km)
  dustB: vec4f,    // same for layer B
  dustV: vec4f,    // xyz streak vector in view space (km, already times the shutter), w layer A weight
  dustP: vec4f,    // x layer B weight, y particle half-width (px), z brightness, w unused
}
@group(1) @binding(0) var<uniform> Z: Zone;

fn wrapRel(base: vec3f, camFrac: vec3f, L: f32) -> vec3f { return (fract(base - camFrac + 0.5) - 0.5)*L; }
// 1 in the middle of the cell, 0 well before the wrap at half a cell
fn cellFade(rel: vec3f, L: f32) -> f32 { return fall(0.30*L, 0.46*L, length(rel)); }

// ---------------------------------------------------------------- asteroids: mesh ----
// Instance: a0 = base xyz, radius (km);  a1 = tumble axis xyz (unit), seed (its fraction also sets the spin rate)
struct RV {
  @builtin(position) pos: vec4f,
  @location(0) lp: vec3f,                      // point on the unit sphere, body frame
  @location(1) wn: vec3f,                      // world normal
  @location(2) @interpolate(flat) seed: f32,
  @location(3) fadeAndPx: vec2f,               // x fade 0..1, y pixels per unit of the body radius
  @location(4) ax: vec3f,
  @location(5) @interpolate(flat) ang: f32,
}

// Shape: a lumpy ellipsoid. Returns the radius multiplier in x and its gradient with respect to the unit direction in yzw.
fn rockShape(n: vec3f, seed: f32) -> vec4f {
  let a = fbmd(n*1.15 + vec3f(seed), 3.0);
  let b = fbmd(n*3.1 + vec3f(seed*1.7 + 5.0), 2.0);
  return vec4f(1.0 + 0.62*a.x + 0.18*b.x, 0.62*1.15*a.yzw + 0.18*3.1*b.yzw);
}

@vertex fn vs_rock(@location(0) vp: vec3f, @location(1) a0: vec4f, @location(2) a1: vec4f) -> RV {
  var o: RV;
  let L = Z.rock.w;
  let rel = wrapRel(a0.xyz, Z.rock.xyz, L);
  let d = length(rel);
  let fade = cellFade(rel, L)*Z.sun.w;
  let px = a0.w/(max(d, 1e-3)*G.time.y);                      // projected radius in pixels
  let big = smoothstep(2.0, 3.5, px);                         // below this the sprite pass takes over
  let v0 = toView(rel);
  // cull: faded out, too small to mesh, or wholly outside the view cone
  let lim = a0.w*1.9;
  if (fade*big <= 0.0 || v0.z < -lim || abs(v0.x) > v0.z*G.right.w + lim*1.6 || abs(v0.y) > v0.z*G.up.w + lim*1.6) {
    o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
    return o;
  }
  let seed = a1.w;
  let ang = Z.sunCol.w*(0.02 + 0.10*fract(seed*7.31)) + seed*3.0;
  let s = rockShape(vp, seed);
  let squash = vec3f(1.0, 0.62 + 0.36*fract(seed*3.17), 0.72 + 0.28*fract(seed*5.71));
  let pl = vp*s.x*squash;                                     // body frame, unit scale
  let gt = s.yzw - vp*dot(s.yzw, vp);
  let nl = normalize((vp*s.x - gt)/squash);
  let P = rel + rotAx(pl, a1.xyz, ang)*(a0.w*fade*big);
  let v = toView(P);
  o.pos = vec4f(v.x/G.right.w, v.y/G.up.w, G.fwd.w, v.z);
  o.lp = vp;
  o.wn = rotAx(nl, a1.xyz, ang);
  o.seed = seed;
  o.fadeAndPx = vec2f(fade, px);
  o.ax = a1.xyz;
  o.ang = ang;
  return o;
}

@fragment fn fs_rock(v: RV) -> @location(0) vec4f {
  let seed = v.seed;
  // fine relief: derivative noise in the body frame, limited to what the pixel footprint can hold
  let fp = 1.0/max(v.fadeAndPx.y, 1.0);
  let oct = clamp(log2(0.5/(fp*5.0)), 0.0, 6.0);
  let bump = fbmd(v.lp*5.0 + vec3f(seed*2.3), oct);
  let gl = bump.yzw - v.lp*dot(bump.yzw, v.lp);
  let n = normalize(normalize(v.wn) - rotAx(gl, v.ax, v.ang)*0.55);
  let L = Z.sun.xyz;
  let ndl = max(dot(n, L), 0.0);
  let hard = smoothstep(-0.05, 0.10, dot(normalize(v.wn), L));       // no lit specks deep in the night side
  // two families: dark carbon-rich rocks and lighter, browner stony ones
  let stony = step(0.62, fract(seed*13.7));
  var alb = mix(vec3f(0.105, 0.098, 0.092), vec3f(0.27, 0.23, 0.185), stony);
  alb *= 0.75 + 0.5*fract(seed*29.3);
  alb *= 0.82 + 0.36*(0.5 + 0.5*bump.x);
  let col = alb*(Z.sunCol.rgb*(ndl*hard) + vec3f(0.020, 0.022, 0.030));     // a little starlight on the night side
  return vec4f(col, 1.0);
}

// ---------------------------------------------------------------- asteroids: far sprites ----
struct SV { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f }

@vertex fn vs_rockfar(@builtin(vertex_index) vi: u32, @location(1) a0: vec4f, @location(2) a1: vec4f) -> SV {
  var o: SV;
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u))*2.0 - 1.0;
  let L = Z.rock.w;
  let rel = wrapRel(a0.xyz, Z.rock.xyz, L);
  let d = length(rel);
  let fade = cellFade(rel, L)*Z.sun.w;
  let px = a0.w/(max(d, 1e-3)*G.time.y);
  let small = 1.0 - smoothstep(2.0, 3.5, px);
  let v = toView(rel);
  if (fade*small <= 0.0 || v.z < 1.0) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); return o; }
  // a Gaussian of sigma >= 0.65 px carrying the light the disc would: area in pixels times albedo times phase
  let seed = a1.w;
  let stony = step(0.62, fract(seed*13.7));
  let alb = mix(0.098, 0.23, stony)*(0.75 + 0.5*fract(seed*29.3));
  let phase = 0.5 + 0.5*dot(Z.sun.xyz, -rel/d);
  let flux = alb*phase*3.14159*px*px/2.65;
  let h = 2.5*G.time.w;
  let ndc = vec2f(v.x/(v.z*G.right.w), v.y/(v.z*G.up.w));
  o.pos = vec4f((ndc + c*h*2.0*G.res.zw)*v.z, G.fwd.w, v.z);
  o.uv = c*h;
  o.col = Z.sunCol.rgb*(flux*fade*small);
  return o;
}
@fragment fn fs_rockfar(v: SV) -> @location(0) vec4f {
  let sg = 0.65*G.time.w;
  let r2 = dot(v.uv, v.uv);
  return vec4f(v.col*exp(-r2/(2.0*sg*sg)), 0.0);
}

// ---------------------------------------------------------------- dust ----
// Instance: base xyz in [0,1), w brightness variation. Drawn twice per frame (instance ranges A and B) for
// the two lattice sizes that bracket the current speed. Each grain is a capsule along its apparent motion.
struct DV { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) len: f32, @location(2) a: f32 }

fn dustVert(vi: u32, base: vec4f, camFrac: vec4f, weight: f32) -> DV {
  var o: DV;
  let L = camFrac.w;
  let rel = wrapRel(base.xyz, camFrac.xyz, L);
  let d = length(rel);
  let v1 = toView(rel);                          // where the grain is
  let v0 = v1 + Z.dustV.xyz;                     // where it was one shutter ago (the camera moved, so it trails)
  let fade = cellFade(rel, L)*smoothstep(0.02*L, 0.10*L, d)*weight;
  if (fade <= 0.0 || v1.z < 0.004*L || v0.z < 0.004*L) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); return o; }
  let p1 = vec2f(v1.x/(v1.z*G.right.w), v1.y/(v1.z*G.up.w))*G.res.xy*0.5;    // pixels from the centre
  let p0 = vec2f(v0.x/(v0.z*G.right.w), v0.y/(v0.z*G.up.w))*G.res.xy*0.5;
  let seg = p1 - p0;
  let len = length(seg);
  var dir = vec2f(1.0, 0.0);
  if (len > 1e-3) { dir = seg/len; }
  let nrm = vec2f(-dir.y, dir.x);
  let hw = Z.dustP.y;
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u));           // x along (0..1), y across (0..1)
  let along = mix(-hw, len + hw, c.x);
  let across = (c.y*2.0 - 1.0)*hw;
  let p = p0 + dir*along + nrm*across;
  let z = mix(v0.z, v1.z, c.x);
  o.pos = vec4f(p/(G.res.xy*0.5)*z, G.fwd.w, z);
  o.uv = vec2f(along, across);
  o.len = len;
  // a streak spreads the same light over more pixels
  o.a = fade*Z.dustP.z*(0.4 + 0.6*base.w)*(2.0*hw/(2.0*hw + len));
  return o;
}
@vertex fn vs_dustA(@builtin(vertex_index) vi: u32, @location(0) base: vec4f) -> DV { return dustVert(vi, base, Z.dustA, Z.dustV.w); }
@vertex fn vs_dustB(@builtin(vertex_index) vi: u32, @location(0) base: vec4f) -> DV { return dustVert(vi, base, Z.dustB, Z.dustP.x); }

@fragment fn fs_dust(v: DV) -> @location(0) vec4f {
  // distance to the segment [0, len] on the x axis
  let dx = v.uv.x - clamp(v.uv.x, 0.0, v.len);
  let r2 = dx*dx + v.uv.y*v.uv.y;
  let hw = Z.dustP.y;
  let g = exp(-r2/(0.32*hw*hw));
  return vec4f(vec3f(0.80, 0.86, 1.0)*(g*v.a), 0.0);
}
