// Start-up bake of the two noise volumes every other shader reads (see vnoise and noised in common.wgsl).
// One draw per slice of a 3D texture; the slice index arrives as the instance index.
// Both fields are periodic, so the volumes tile under a repeating sampler.
//
//   noiseV  r16float, 128^3: value-noise lattice, period 64 cells, two texels per cell, plain trilinear
//           (the smoothstep easing is applied to the lookup coordinate instead, which keeps it exact)
//   noiseG  rgba16float, 128^3: gradient noise with its analytic gradient, period 32 cells, four texels per cell
struct BV { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) slice: u32 }
@vertex fn vs_bake(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BV {
  var o: BV;
  o.pos = vec4f(f32(vi & 1u)*4.0 - 1.0, f32((vi >> 1u) & 1u)*4.0 - 1.0, 0.0, 1.0);
  o.slice = ii;
  return o;
}

@fragment fn fs_bakeV(v: BV) -> @location(0) vec4f {
  let x = vec3f(v.pos.xy - 0.5, f32(v.slice))*0.5;       // texel centre -> lattice coordinate
  let i = floor(x); let f = x - i;
  let p = vec3i(i); let m = vec3i(63);
  let a = h31(p & m); let b = h31((p + vec3i(1, 0, 0)) & m);
  let c = h31((p + vec3i(0, 1, 0)) & m); let d = h31((p + vec3i(1, 1, 0)) & m);
  let e = h31((p + vec3i(0, 0, 1)) & m); let g = h31((p + vec3i(1, 0, 1)) & m);
  let h = h31((p + vec3i(0, 1, 1)) & m); let k = h31((p + vec3i(1, 1, 1)) & m);
  let n = mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
  return vec4f(n, 0.0, 0.0, 1.0);
}

// Gradient noise with analytic derivatives (after Inigo Quilez): x = value (-1..1), yzw = gradient.
@fragment fn fs_bakeG(v: BV) -> @location(0) vec4f {
  let x = vec3f(v.pos.xy - 0.5, f32(v.slice))*0.25;
  let i = floor(x); let f = x - i;
  let u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  let du = 30.0*f*f*(f*(f - 2.0) + 1.0);
  let p = vec3i(i); let m = vec3i(31);
  let ga = hg3(p & m); let gb = hg3((p + vec3i(1, 0, 0)) & m);
  let gc = hg3((p + vec3i(0, 1, 0)) & m); let gd = hg3((p + vec3i(1, 1, 0)) & m);
  let ge = hg3((p + vec3i(0, 0, 1)) & m); let gf = hg3((p + vec3i(1, 0, 1)) & m);
  let gg = hg3((p + vec3i(0, 1, 1)) & m); let gh = hg3((p + vec3i(1, 1, 1)) & m);
  let va = dot(ga, f); let vb = dot(gb, f - vec3f(1.0, 0.0, 0.0));
  let vc = dot(gc, f - vec3f(0.0, 1.0, 0.0)); let vd = dot(gd, f - vec3f(1.0, 1.0, 0.0));
  let ve = dot(ge, f - vec3f(0.0, 0.0, 1.0)); let vf = dot(gf, f - vec3f(1.0, 0.0, 1.0));
  let vg = dot(gg, f - vec3f(0.0, 1.0, 1.0)); let vh = dot(gh, f - vec3f(1.0, 1.0, 1.0));
  let k0 = va - vb - vc + vd; let k1 = va - vc - ve + vg; let k2 = va - vb - ve + vf;
  let k3 = -va + vb + vc - vd + ve - vf - vg + vh;
  let val = va + u.x*(vb - va) + u.y*(vc - va) + u.z*(ve - va) + u.x*u.y*k0 + u.y*u.z*k1 + u.z*u.x*k2 + u.x*u.y*u.z*k3;
  let d = ga + u.x*(gb - ga) + u.y*(gc - ga) + u.z*(ge - ga) + u.x*u.y*(ga - gb - gc + gd) + u.y*u.z*(ga - gc - ge + gg)
        + u.z*u.x*(ga - gb - ge + gf) + u.x*u.y*u.z*(-ga + gb + gc - gd + ge - gf - gg + gh)
        + du*(vec3f(vb - va, vc - va, ve - va) + u.yzx*vec3f(k0, k1, k2) + u.zxy*vec3f(k2, k0, k1) + u.yzx*u.zxy*k3);
  return vec4f(val, d);
}
