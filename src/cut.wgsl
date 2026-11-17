// Cutaway: the octant {x>a, y>a, z>a} (cut frame, unit sphere) is removed; the inner core stays whole.
// pc = point where the ray enters the unit sphere, rc = ray direction, both in the cut frame.
// Returns (kind, t, axis): kind 0 = passes through the hole, 1 = outer surface, 2 = cut face, 3 = core ball.
// src/js/cutaway.js repeats this for the cursor ray; keep the two in step.
fn traceCut(pc: vec3f, rc: vec3f, a: f32) -> vec3f {
  if (pc.x <= a || pc.y <= a || pc.z <= a) { return vec3f(1.0, 0.0, 0.0); }
  var te = 1e9; var ax = -1.0;
  if (rc.x < 0.0) { let tx = (a - pc.x)/rc.x; if (tx < te) { te = tx; ax = 0.0; } }
  if (rc.y < 0.0) { let ty = (a - pc.y)/rc.y; if (ty < te) { te = ty; ax = 1.0; } }
  if (rc.z < 0.0) { let tz = (a - pc.z)/rc.z; if (tz < te) { te = tz; ax = 2.0; } }
  let r0 = B.layR.x;
  let bb = dot(pc, rc);
  let dd = bb*bb - (dot(pc, pc) - r0*r0);
  if (dd > 0.0) { let tk = -bb - sqrt(dd); if (tk > 0.0 && tk < te) { return vec3f(3.0, tk, 0.0); } }
  if (ax < 0.0) { return vec3f(0.0); }
  let pe = pc + rc*te;
  if (dot(pe, pe) >= 1.0) { return vec3f(0.0); }
  return vec3f(2.0, te, ax);
}
fn layerOf(r: f32) -> i32 {
  if (r < B.layR.x) { return 0; }
  if (r < B.layR.y) { return 1; }
  if (r < B.layR.z) { return 2; }
  if (r < B.layR.w) { return 3; }
  return 4;
}
// Colour of a point on a cut face or on the core ball. fpx = pixel footprint in body radii.
fn shadeCut(pe: vec3f, hit: vec3f, fpx: f32) -> vec3f {
  let r = length(pe);
  let dirn = pe/max(r, 1e-5);
  var nrm = dirn;
  if (hit.x < 2.5) {
    if (hit.z < 0.5) { nrm = vec3f(1.0, 0.0, 0.0); } else if (hit.z < 1.5) { nrm = vec3f(0.0, 1.0, 0.0); } else { nrm = vec3f(0.0, 0.0, 1.0); }
  }
  var l = layerOf(r);
  if (hit.x > 2.5) { l = 0; }               // the core ball lies exactly on its own boundary: rounding must not pick the layer
  let P = B.layP[l];                       // x frequency, y grain (-1 concentric shells .. 0 none .. 1 radial), z flow, w contrast
  let C = B.layC[l];
  let tm = G.time.x;
  var q = pe*(P.x*(1.0 - abs(P.y))) - vec3f(tm*P.z);
  if (P.y > 0.0) { q += dirn*(P.x*0.55*P.y); } else { q += vec3f(r*P.x*1.6*(-P.y)); }
  let n = fbm(q, 4.0);
  let n2 = vnoise(q*2.7 + vec3f(5.0, 1.0, tm*P.z*1.7));
  var c = C.rgb*(0.55 + 0.9*(0.5 + (n - 0.5)*P.w*2.0));
  // Light on the faces: the body's own star or, for a star, a key light over the viewer's shoulder. The glow
  // of a hot layer follows it part of the way, so the three faces of the opening never come out equally
  // bright and the cut reads as a solid corner.
  var key = B.sun.xyz;
  if (dot(key, key) < 0.25) { key = normalize(G.up.xyz*0.50 + G.right.xyz*0.62 - normalize(B.center.xyz)*0.60); }
  let face = max(dot(cutWorld(nrm), key), 0.0);
  c *= 0.62 + 0.38*face;
  let veins = sat(n*0.6 + n2*0.6 - 0.1);
  c += C.rgb*C.w*(0.4 + 1.6*veins*veins*veins)*(0.66 + 0.34*face);
  // a line on every layer boundary also hides the hard colour switch, so the boundary cannot alias
  // (not on the core ball: its whole surface lies on its own boundary and would be washed out)
  if (hit.x < 2.5) {
    let db = min(min(abs(r - B.layR.x), abs(r - B.layR.y)), min(min(abs(r - B.layR.z), abs(r - B.layR.w)), abs(r - 1.0)));
    c = mix(c, vec3f(1.2, 1.14, 1.02), 0.6*fall(fpx*0.5, fpx*1.5 + 0.0015, db));
  }
  let hv = i32(B.cut1.w);
  if (hv == l) { c = c*1.35 + vec3f(0.04); } else if (hv >= 0) { c *= 0.55; }
  return c;
}

const SUB = array<vec2f, 4>(vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(-0.375, 0.125), vec2f(0.125, 0.375));
