// DRAFT. Sky: baked nebula cubemap plus instanced star points. Both sit at infinite distance (depth 0).
@group(1) @binding(0) var skyTex: texture_cube<f32>;
@group(1) @binding(1) var skySmp: sampler;

struct VF { @builtin(position) pos: vec4f }
@vertex fn vs_full(@builtin(vertex_index) vi: u32) -> VF {
  var o: VF;
  o.pos = vec4f(f32(vi & 1u)*4.0 - 1.0, f32((vi >> 1u) & 1u)*4.0 - 1.0, 0.0, 1.0);
  return o;
}
@fragment fn fs_sky(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let c = textureSampleLevel(skyTex, skySmp, rayDir(fc.xy), 0.0).rgb;
  return vec4f(c*G.post.w, 1.0);
}

// Star points. Instance: dir.xyz unit direction, dir.w quad half-size (px at 1440p); colr.rgb colour x intensity.
// A Gaussian core of sigma >= 0.65 px sums to a constant on the pixel grid, so stars do not twinkle or crawl.
struct PV { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f, @location(2) h: f32 }
@vertex fn vs_pts(@builtin(vertex_index) vi: u32, @location(0) dir: vec4f, @location(1) colr: vec4f) -> PV {
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u))*2.0 - 1.0;
  let v = toView(dir.xyz);
  var o: PV;
  if (v.z < 0.05) { o.pos = vec4f(2.0, 2.0, 0.0, 1.0); return o; }
  let ndc = vec2f(v.x/(v.z*G.right.w), v.y/(v.z*G.up.w));
  let h = dir.w*G.time.w;
  o.pos = vec4f(ndc + c*h*2.0*G.res.zw, 0.0, 1.0);
  o.uv = c*h;
  o.col = colr.rgb;
  o.h = h;
  return o;
}
@fragment fn fs_pts(v: PV) -> @location(0) vec4f {
  let r = length(v.uv);
  let sg = 0.65*G.time.w;
  let core = exp(-r*r/(2.0*sg*sg));
  let halo = 0.06*exp(-r/(0.22*v.h))*sat(v.h/(3.0*G.time.w) - 1.0);
  // faint four-point spikes on the brightest points only
  let a = abs(v.uv);
  let spike = 0.022*(exp(-a.y/(0.045*v.h) - a.x/(0.42*v.h)) + exp(-a.x/(0.045*v.h) - a.y/(0.42*v.h)))*sat(v.h/(4.0*G.time.w) - 1.0);
  return vec4f(v.col*((core + halo + spike)*fall(0.6*v.h, v.h, r)), 0.0);
}
