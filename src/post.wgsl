// Post chain: bloom (13-tap downsample, tent upsample), then composite, tone map, dither.
@group(1) @binding(0) var tA: texture_2d<f32>;
@group(1) @binding(1) var sL: sampler;
@group(1) @binding(2) var tB: texture_2d<f32>;

struct VP { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs_post(@builtin(vertex_index) vi: u32) -> VP {
  let p = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u))*2.0;
  var o: VP;
  o.pos = vec4f(p*2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(tA, sL, uv, 0.0).rgb; }
// Every read of the HDR scene goes through this clamp to a finite range. Without it a single NaN or Inf
// pixel is spread by the bloom filters into a black square hundreds of pixels wide (this happened: a
// pow() with a base that rounded below zero). min/max return the finite operand on the D3D and Vulkan paths.
fn tapScene(uv: vec2f) -> vec3f { return min(max(textureSampleLevel(tA, sL, uv, 0.0).rgb, vec3f(0.0)), vec3f(6.0e4)); }

// 13-tap downsample (Jimenez, SIGGRAPH 2014): five overlapping 4-tap boxes.
struct Boxes { g0: vec3f, g1: vec3f, g2: vec3f, g3: vec3f, g4: vec3f }
fn boxes(a: vec3f, b: vec3f, c: vec3f, d: vec3f, e: vec3f, f: vec3f, g: vec3f, h: vec3f, i: vec3f,
         j: vec3f, k: vec3f, l: vec3f, m: vec3f) -> Boxes {
  return Boxes((j + k + l + m)*0.25, (a + b + d + e)*0.25, (b + c + e + f)*0.25, (d + e + g + h)*0.25, (e + f + h + i)*0.25);
}
// First level, from the scene: each box is weighted by 1/(1+luma) (Karis average) so a single very bright
// pixel (a star, a glint) cannot flicker through the bloom chain.
@fragment fn fs_down0(v: VP) -> @location(0) vec4f {
  let ts = 1.0/vec2f(textureDimensions(tA)); let uv = v.uv;
  let q = boxes(tapScene(uv + ts*vec2f(-2.0, -2.0)), tapScene(uv + ts*vec2f(0.0, -2.0)), tapScene(uv + ts*vec2f(2.0, -2.0)),
                tapScene(uv + ts*vec2f(-2.0, 0.0)), tapScene(uv), tapScene(uv + ts*vec2f(2.0, 0.0)),
                tapScene(uv + ts*vec2f(-2.0, 2.0)), tapScene(uv + ts*vec2f(0.0, 2.0)), tapScene(uv + ts*vec2f(2.0, 2.0)),
                tapScene(uv + ts*vec2f(-1.0, -1.0)), tapScene(uv + ts*vec2f(1.0, -1.0)),
                tapScene(uv + ts*vec2f(-1.0, 1.0)), tapScene(uv + ts*vec2f(1.0, 1.0)));
  let w0 = 0.5/(1.0 + luma(q.g0));
  let w1 = 0.125/(1.0 + luma(q.g1)); let w2 = 0.125/(1.0 + luma(q.g2));
  let w3 = 0.125/(1.0 + luma(q.g3)); let w4 = 0.125/(1.0 + luma(q.g4));
  return vec4f((q.g0*w0 + q.g1*w1 + q.g2*w2 + q.g3*w3 + q.g4*w4)/(w0 + w1 + w2 + w3 + w4), 1.0);
}
@fragment fn fs_down(v: VP) -> @location(0) vec4f {
  let ts = 1.0/vec2f(textureDimensions(tA)); let uv = v.uv;
  let q = boxes(tap(uv + ts*vec2f(-2.0, -2.0)), tap(uv + ts*vec2f(0.0, -2.0)), tap(uv + ts*vec2f(2.0, -2.0)),
                tap(uv + ts*vec2f(-2.0, 0.0)), tap(uv), tap(uv + ts*vec2f(2.0, 0.0)),
                tap(uv + ts*vec2f(-2.0, 2.0)), tap(uv + ts*vec2f(0.0, 2.0)), tap(uv + ts*vec2f(2.0, 2.0)),
                tap(uv + ts*vec2f(-1.0, -1.0)), tap(uv + ts*vec2f(1.0, -1.0)),
                tap(uv + ts*vec2f(-1.0, 1.0)), tap(uv + ts*vec2f(1.0, 1.0)));
  return vec4f(q.g0*0.5 + (q.g1 + q.g2 + q.g3 + q.g4)*0.125, 1.0);
}

// 9-tap tent upsample; render with additive blending (one, one) into the next larger bloom level.
@fragment fn fs_up(v: VP) -> @location(0) vec4f {
  let ts = 1.0/vec2f(textureDimensions(tA));
  var c = tap(v.uv)*4.0;
  c += (tap(v.uv + ts*vec2f(-1.0, 0.0)) + tap(v.uv + ts*vec2f(1.0, 0.0)) + tap(v.uv + ts*vec2f(0.0, -1.0)) + tap(v.uv + ts*vec2f(0.0, 1.0)))*2.0;
  c += tap(v.uv + ts*vec2f(-1.0, -1.0)) + tap(v.uv + ts*vec2f(1.0, -1.0)) + tap(v.uv + ts*vec2f(-1.0, 1.0)) + tap(v.uv + ts*vec2f(1.0, 1.0));
  return vec4f(c/16.0, 1.0);
}

// ACES fit by Stephen Hill (BakingLab). Matrices are written column-major for WGSL.
const ACES_IN = mat3x3f(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const ACES_OUT = mat3x3f(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
fn aces(c: vec3f) -> vec3f {
  let v = ACES_IN*c;
  let a = v*(v + 0.0245786) - 0.000090537;
  let b = v*(0.983729*v + 0.4329510) + 0.238081;
  return clamp(ACES_OUT*(a/b), vec3f(0.0), vec3f(1.0));
}
// interleaved gradient noise (Jimenez): cheap, stable dither that removes banding in dark gradients
fn ign(p: vec2f) -> f32 { return fract(52.9829189*fract(dot(p, vec2f(0.06711056, 0.00583715)))); }
const BLOOM_NORM = 0.2;   // 1 / number of bloom levels accumulated into level 0; keep in sync with the JS

// tA = resolved HDR scene, tB = bloom level 0. Target is the canvas (sRGB-encoded by hand).
@fragment fn fs_comp(v: VP) -> @location(0) vec4f {
  let cc = v.uv - 0.5;
  let warp = G.time.z;
  var c: vec3f;
  if (warp > 0.003) {
    let k = dot(cc, cc)*warp*0.02;
    c = vec3f(tapScene(v.uv - cc*k).r, tapScene(v.uv).g, tapScene(v.uv + cc*k).b);
  } else {
    c = tapScene(v.uv);
  }
  let bl = textureSampleLevel(tB, sL, v.uv, 0.0).rgb*BLOOM_NORM;
  c = mix(c, bl, G.post.y)*G.post.x;
  c *= 1.0 - dot(cc, cc)*0.35;
  c = aces(c);
  c = mix(c*12.92, 1.055*pow(c, vec3f(1.0/2.4)) - 0.055, step(vec3f(0.0031308), c));
  c *= G.post.z;
  c += vec3f((ign(v.pos.xy) - 0.5)/255.0);
  return vec4f(c, 1.0);
}
