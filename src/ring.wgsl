// DRAFT. Planetary rings: one quad in the ring plane, real rasterised depth, analytic radial profile.
// Draw twice (4 vertices each): firstInstance 0 = half behind the planet centre (before the atmosphere),
// firstInstance 1 = half in front (after it). Blend premultiplied, depth test on, depth write off.
struct VR { @builtin(position) pos: vec4f, @location(0) rel: vec3f, @location(1) @interpolate(flat) side: u32 }

@vertex fn vs_ring(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VR {
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u))*2.0 - 1.0;
  let n = B.ring0.xyz;
  var ax = vec3f(0.0, 1.0, 0.0);
  if (abs(n.y) > 0.9) { ax = vec3f(1.0, 0.0, 0.0); }
  let a = normalize(cross(n, ax));
  let b = cross(n, a);
  let rel = (a*c.x + b*c.y)*(B.ring1.x*1.01);
  let v = toView(B.center.xyz + rel);
  var o: VR;
  o.pos = vec4f(v.x/G.right.w, v.y/G.up.w, G.fwd.w, v.z);
  o.rel = rel;
  o.side = ii;
  return o;
}

fn hgPhase(c: f32, g: f32) -> f32 { return (1.0 - g*g)/pow(1.0 + g*g - 2.0*g*c, 1.5); }

@fragment fn fs_ring(v: VR) -> @location(0) vec4f {
  let R = B.center.w;
  let r = length(v.rel)/R;
  // must stay ahead of any branch (derivative uniformity). The length of the gradient, not fwidth: fwidth is
  // up to 1.4 times too wide where the ring runs diagonally, and that much fine structure would be filtered away
  let fw = length(vec2f(dpdx(r), dpdy(r)));
  let isFar = dot(v.rel, normalize(B.center.xyz)) > 0.0;
  if (isFar != (v.side == 0u)) { discard; }
  let prof = ringProfile(r, fw*0.75);
  let tau = prof.x;
  if (tau < 0.0005) { discard; }
  let n = B.ring0.xyz;
  let P = B.center.xyz + v.rel;
  let V = -normalize(P);
  let L = B.sun.xyz;
  let vn = dot(V, n); let ln = dot(L, n);
  let mu = max(abs(vn), 0.02);
  var mu0 = max(abs(ln), 0.02);
  let ct = dot(-L, V);                                 // cosine of the scattering angle
  let ph = mix(hgPhase(ct, -0.35), hgPhase(ct, 0.75), B.ring2.w);
  // single scattering in a thin slab (Chandrasekhar): reflection on the lit face, transmission on the other
  var I: f32;
  if (vn*ln > 0.0) {
    I = mu0/(mu + mu0)*(1.0 - exp(-tau*(1.0/mu + 1.0/mu0)));
  } else {
    if (abs(mu - mu0) < 0.01) { mu0 += 0.02; }
    I = mu0/(mu0 - mu)*(exp(-tau/mu0) - exp(-tau/mu));
  }
  // the planet, then its moons; inside a shadow the particles still catch light off the planet and each other,
  // so the ring stays faintly visible there instead of turning into a black hole in the picture
  let shadow = mix(0.05, 1.0, eclipse(v.rel, L, vec4f(0.0, 0.0, 0.0, R), B.sun.w + 0.0015)*occluders(v.rel));
  // particles are dirtier and redder towards the planet, cleaner and brighter outside
  let x = (r*R - B.ring0.w)/(B.ring1.x - B.ring0.w);
  let hue = mix(vec3f(0.78, 0.64, 0.50), vec3f(1.0, 0.99, 0.97), smoothstep(0.05, 0.62, x));
  let col = B.sunCol.rgb*B.ring2.rgb*hue*(prof.y*I*ph*0.785*shadow);
  let alpha = 1.0 - exp(-tau/mu);
  // fade out when the whole ring projects thinner than about a pixel (edge-on)
  let thin = sat((B.ring1.x - B.ring0.w)/R/max(fw*2.0, 1e-6));
  return vec4f(col, alpha)*thin;
}
