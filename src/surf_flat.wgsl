// Placeholder surface: a lit, noisy sphere. Used for any body whose real surface is not written yet.
// Surface contract (every surf_X): pw = hit point relative to the body centre (world axes, km),
// rd = unit view ray, fp = pixel footprint on the unit sphere. Returns the radiance leaving the surface
// towards the camera. Extinction along the view ray is NOT applied here; the atmosphere pass owns it.
fn surf_flat(pw: vec3f, rd: vec3f, fp: f32) -> vec3f {
  let n = normalize(pw);
  let muS = dot(n, B.sun.xyz);
  let pl = toLocal(n);
  let oct = clamp(log2(1.0/(8.0*fp)) + 1.0, 1.0, 8.0);
  let alb = B.colA.rgb*(0.7 + 0.6*fbm(pl*4.0 + vec3f(B.rot0.w), oct));
  return alb*(groundLight(pw, muS, fp) + skyLight(muS) + vec3f(B.sunCol.w));
}
