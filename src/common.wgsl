struct Globals {
  right: vec4f, // xyz camera right, w tan(fovx/2)
  up: vec4f,    // xyz camera up, w tan(fovy/2)
  fwd: vec4f,   // xyz camera forward, w near plane (km)
  res: vec4f,   // w, h, 1/w, 1/h
  time: vec4f,  // x anim seconds, y radians per pixel, z warp 0..1, w resolution scale (h/1440)
  post: vec4f,  // x exposure, y bloom mix, z master fade, w sky intensity
  vel: vec4f,
  aux: vec4f,
}
@group(0) @binding(0) var<uniform> G: Globals;
// Baked noise volumes (src/bake.wgsl, src/js/noise.js) and their repeating, filtering sampler.
@group(0) @binding(1) var noiseV: texture_3d<f32>;
@group(0) @binding(2) var noiseG: texture_3d<f32>;
@group(0) @binding(3) var noiseS: sampler;

const PI = 3.14159265;
const TAU = 6.28318531;
const M3 = mat3x3f(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64);
const M3T = mat3x3f(0.0, -0.8, -0.6, 0.8, 0.36, -0.48, 0.6, -0.48, 0.64);

fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

fn rayDir(fc: vec2f) -> vec3f {
  let n = vec2f(fc.x*G.res.z*2.0 - 1.0, 1.0 - fc.y*G.res.w*2.0);
  return normalize(G.fwd.xyz + G.right.xyz*(n.x*G.right.w) + G.up.xyz*(n.y*G.up.w));
}
fn toView(p: vec3f) -> vec3f { return vec3f(dot(p, G.right.xyz), dot(p, G.up.xyz), dot(p, G.fwd.xyz)); }
// reversed-Z, infinite far plane
fn depthOf(t: f32, rd: vec3f) -> f32 { return min(G.fwd.w/max(t*dot(rd, G.fwd.xyz), 1e-9), 1.0); }

fn rotAx(p: vec3f, ax: vec3f, ang: f32) -> vec3f {
  let c = cos(ang); let s = sin(ang);
  return p*c + cross(ax, p)*s + ax*(dot(ax, p)*(1.0 - c));
}
fn rotY(p: vec3f, ang: f32) -> vec3f {
  let c = cos(ang); let s = sin(ang);
  return vec3f(p.x*c - p.z*s, p.y, p.x*s + p.z*c);
}

// ---- hashes (integer, stable across GPUs) ----
fn h1u(n: u32) -> u32 {
  var x = n*747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x)*277803737u;
  return (x >> 22u) ^ x;
}
fn h3u(p: vec3i) -> u32 {
  let q = vec3u(p);
  var n = (q.x*1597334677u) ^ (q.y*3812015801u) ^ (q.z*2798796415u);
  n = (n ^ (n >> 16u))*2246822519u;
  n = (n ^ (n >> 13u))*3266489917u;
  return n ^ (n >> 16u);
}
fn u2f(n: u32) -> f32 { return f32(n >> 8u)*(1.0/16777216.0); }
fn h31(p: vec3i) -> f32 { return u2f(h3u(p)); }
fn h33(p: vec3i) -> vec3f {
  let n = h3u(p);
  return vec3f(f32(n & 1023u), f32((n >> 10u) & 1023u), f32((n >> 20u) & 1023u))*(1.0/1023.0);
}
fn hg3(p: vec3i) -> vec3f {
  let n = h3u(p);
  return vec3f(f32(n & 2047u), f32((n >> 11u) & 2047u), f32(n >> 22u))*vec3f(1.0/1023.5, 1.0/1023.5, 1.0/511.5) - 1.0;
}

// ---- 1D value noise ----
fn n1(x: f32) -> f32 {
  let i = floor(x); let f = x - i; let u = f*f*(3.0 - 2.0*f);
  let k = u32(i32(i));
  return mix(u2f(h1u(k)), u2f(h1u(k + 1u)), u);
}

// ---- 3D value noise, 0..1 ----
// One fetch from the baked lattice (period 64 cells, two texels per cell). Easing the lookup coordinate
// within the cell reproduces smoothstep interpolation of the lattice values; the hardware only has to
// interpolate linearly, and with two texels per cell its fixed-point weights give 512 steps across a cell.
fn vnoise(x: vec3f) -> f32 {
  let i = floor(x); let f = x - i;
  let u = f*f*(3.0 - 2.0*f);
  return textureSampleLevel(noiseV, noiseS, (i + u + 0.25)*(1.0/64.0), 0.0).r;
}

// The same value noise at full precision: the eight lattice values are loaded and interpolated in the shader.
// The filtered fetch above quantises its weights to 8 bits, which is invisible in an fbm sum but shows as a
// faint weave when one cell is magnified over thousands of pixels AND the result steers something thin and
// bright (a domain warp under lava cracks, for instance). Use this there; it costs eight loads instead of one fetch.
fn vnoiseP(x: vec3f) -> f32 {
  let i = floor(x); let f = x - i; let u = f*f*(3.0 - 2.0*f);
  let p = vec3i(i) & vec3i(63);
  let q = (p + vec3i(1)) & vec3i(63);
  let a = textureLoad(noiseV, vec3i(p.x, p.y, p.z)*2, 0).r; let b = textureLoad(noiseV, vec3i(q.x, p.y, p.z)*2, 0).r;
  let c = textureLoad(noiseV, vec3i(p.x, q.y, p.z)*2, 0).r; let d = textureLoad(noiseV, vec3i(q.x, q.y, p.z)*2, 0).r;
  let e = textureLoad(noiseV, vec3i(p.x, p.y, q.z)*2, 0).r; let g = textureLoad(noiseV, vec3i(q.x, p.y, q.z)*2, 0).r;
  let h = textureLoad(noiseV, vec3i(p.x, q.y, q.z)*2, 0).r; let k = textureLoad(noiseV, vec3i(q.x, q.y, q.z)*2, 0).r;
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

// Three decorrelated value-noise taps, centred on zero: a vector field for warping a domain (precise, see above).
fn warp3(p: vec3f) -> vec3f {
  return vec3f(vnoiseP(p), vnoiseP(p + vec3f(13.7, 5.1, 9.3)), vnoiseP(p + vec3f(29.3, 17.9, 3.7))) - 0.5;
}

// fbm on value noise, centred on 0.5; fractional octave count fades the last octave (no LOD pop)
fn fbm(p: vec3f, oct: f32) -> f32 {
  var s = 0.5; var a = 1.0; var q = p;
  let n = i32(ceil(oct));
  for (var i = 0; i < n; i++) {
    s += a*sat(oct - f32(i))*(vnoise(q) - 0.5);
    q = M3*q*2.02 + vec3f(3.1, 1.7, 5.3);
    a *= 0.5;
  }
  return s;
}

// fbm that stays smooth however far it is magnified: an octave whose cells cover more than about 600 pixels is
// interpolated in the shader (vnoiseP), the others take the filtered fetch. px = pixel footprint in units of p.
// For a field that steers another lookup or feeds a steep threshold (weather systems under a cloud edge).
fn fbmA(p: vec3f, oct: f32, px: f32) -> f32 {
  var s = 0.5; var a = 1.0; var q = p; var w = px;
  let n = i32(ceil(oct));
  for (var i = 0; i < n; i++) {
    var v: f32;
    if (w < 0.0016) { v = vnoiseP(q); } else { v = vnoise(q); }
    s += a*sat(oct - f32(i))*(v - 0.5);
    q = M3*q*2.02 + vec3f(3.1, 1.7, 5.3);
    a *= 0.5; w *= 2.02;
  }
  return s;
}

// ---- gradient noise with analytic derivatives: x = value (-1..1), yzw = gradient ----
// One fetch from the baked volume (period 32 cells, four texels per cell). Plain linear filtering has two
// faults when a cell is magnified. It leaves a crease at every texel, so a contour of the sum (a coastline)
// comes out as a polygon. And its weights have 8 bits, so the value moves in steps, and a coast on flat ground
// comes out as a comb. So the lookup is eased towards the texel centres and snapped to the steps of the filter,
// which makes the sample point known exactly, and the value is carried from there to the true position along
// the stored gradient: smooth (C1) across texels, free of steps, and exact for a linear field.
fn noised(x: vec3f) -> vec4f {
  let t = x*4.0; let i = floor(t); let f = t - i;
  let u = floor(f*f*(3.0 - 2.0*f)*256.0 + 0.5)*(1.0/256.0);
  let s = textureSampleLevel(noiseG, noiseS, (i + u + 0.5)*(1.0/128.0), 0.0);
  return vec4f(s.x + 0.25*dot(s.yzw, f - u), s.yzw);
}

// fbm with derivatives (value roughly -1..1, gradient w.r.t. p). `soft` receives the gradient of all but the
// two finest octaves in use: the finest ones change from pixel to pixel, so a normal built from the full
// gradient glitters; relief is shaded with the soft one.
fn fbmds(p: vec3f, oct: f32, soft: ptr<function, vec3f>) -> vec4f {
  var v = 0.0; var d = vec3f(0.0); var ds = vec3f(0.0); var a = 0.5; var q = p;
  var m = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  let n = i32(ceil(oct));
  for (var i = 0; i < n; i++) {
    let nn = noised(q);
    let g = m*nn.yzw;
    v += a*sat(oct - f32(i))*nn.x;
    d += a*sat(oct - f32(i))*g;
    ds += a*sat(oct - 2.0 - f32(i))*g;
    q = M3*q*2.0;
    m = m*M3T*2.0;
    a *= 0.5;
  }
  *soft = ds;
  return vec4f(v, d);
}
fn fbmd(p: vec3f, oct: f32) -> vec4f { var soft: vec3f; return fbmds(p, oct, &soft); }

// ---- cellular noise: (F1, F2, cell id). tm animates the feature points ----
fn voro(x: vec3f, tm: f32) -> vec3f {
  let ip = vec3i(floor(x)); let f = fract(x);
  var d1 = 8.0; var d2 = 8.0; var id = 0.0;
  for (var k = -1; k <= 1; k++) {
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let g = vec3i(i, j, k);
        let hh = h33(ip + g);
        let o = 0.5 + 0.42*sin(vec3f(tm) + TAU*hh);
        let r = vec3f(g) + o - f;
        let d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = hh.x; } else if (d < d2) { d2 = d; }
      }
    }
  }
  return vec3f(sqrt(d1), sqrt(d2), id);
}

// Falling ramp: 1 at x <= lo, 0 at x >= hi. Use this instead of smoothstep with reversed edges,
// which is undefined in SPIR-V/HLSL and may be rejected by the compiler for constant arguments.
fn fall(lo: f32, hi: f32, x: f32) -> f32 { return 1.0 - smoothstep(lo, hi, x); }
