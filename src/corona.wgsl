// Glow volumes: a radial corona with streamers plus up to 24 glowing polylines per body. The polylines are
// filled in on the CPU each frame (src/js/corona.js) and serve as coronal loops, flare ejecta, pulsar beams,
// dipole field lines and comet tails. Additive (premultiplied with alpha 0); depth test on, no depth write.
//   p2 = glow intensity at the limb, radial falloff exponent, streamer strength, streamer frequency
//   p3 = core radius (radii; 0 for a star: the glow is flat inside it, as in a comet's coma),
//        close-up fade distance (radii; 0 = off: the glow thins out as the camera enters it),
//        far gain (set every frame for stars: 0 with the disc filling the view, rising as it shrinks to a point,
//        so a distant star keeps a glare around it), unused
//   colD glow colour
struct Loops {
  n: vec4f,                // x = polyline count
  par: array<vec4f, 24>,   // intensity, width at start (km), width at end (km), flow pattern frequency
  col: array<vec4f, 24>,   // rgb, w flow speed
  bs: array<vec4f, 24>,    // xyz centre of the points relative to the body centre (km), w radius of the capsule about the chord from the first point to the last that holds the whole line
  pts: array<vec4f, 216>,  // 24 polylines x 9 points: xyz relative to the body centre (km), w intensity scale
}
@group(2) @binding(0) var<uniform> LP: Loops;

@fragment fn fs_corona(@builtin(position) fc: vec4f) -> FOut {
  let rd = rayDir(fc.xy);
  let R = B.center.w; let Rb = B.bnd.w;
  let o = -B.center.xyz;
  let b = dot(o, rd);
  let qc = o - b*rd;
  let q2 = dot(qc, qc);
  let hb = Rb*Rb - q2;
  if (hb <= 0.0) { discard; }
  if (-b + sqrt(hb) <= 0.0) { discard; }
  let tb0 = max(-b - sqrt(hb), 0.0);
  var tS = 1e30;                                       // where the ray meets the photosphere, if it does
  let hs = R*R - q2;
  if (hs > 0.0 && b < 0.0) { tS = max(-b - sqrt(hs), 0.0); }
  var col = vec3f(0.0);
  let dq = sqrt(q2)/R;                                 // impact parameter in radii
  if (b < 0.0 || dot(o, o) < Rb*Rb) {
    // m = cosine of the angle between the ray and the direction of the centre. For m > 0 the ray's closest
    // approach to the centre lies ahead and sets the brightness. For m <= 0 it lies behind the camera: the
    // nearest point of the ray is the camera itself and only the thinning far side of the glow is in view
    // (without this the corona would reappear, mirrored, in the sky opposite the star).
    let od = length(o);
    let m = -b/max(od, 1e-6);
    var x = max(dq, 1.0);
    var part = 0.5 + 0.5*smoothstep(0.0, 0.6, m);
    // the glow starts at the limb itself, one pixel wide: begun inside the disc it draws a pale outline round the star
    var disc = sat((dq - 1.0)*R/(max(-b, G.fwd.w)*G.time.y) + 0.5);
    if (m <= 0.0) { x = max(od/R, 1.0); part = 0.5*(1.0 + m)*(1.0 + m); disc = 1.0; }
    // Which radial ray: the position angle of the pixel about the line from the camera to the centre.
    // Every pixel on one screen radius shares it, so streamers are straight rays; it turns smoothly as the
    // camera orbits, as if different streamers came into view.
    let axis = normalize(B.center.xyz);
    let qp = qc - axis*dot(qc, axis);
    let nd = toLocal(qp/max(length(qp), 1e-6));
    // streamers: two scales of noise indexed by the direction of closest approach, so they are radial and
    // stay put as the camera moves; squared twice for thin bright rays between dark gaps
    // the lookup also drifts with height, so a ray wanders, forks and dies out instead of running ruler-straight to the edge
    let s1 = fbm(nd*B.p2.w + vec3f(0.0, G.time.x*0.01, (x - 1.0)*0.24), 4.0);
    let s2 = fbm(nd*B.p2.w*3.1 + vec3f(7.0, -G.time.x*0.015, 3.0 + (x - 1.0)*0.55), 3.0);
    let r0 = sat((0.65*s1 + 0.35*s2)*2.2 - 0.60 - 0.06*(x - 1.0));   // streamers taper with distance
    let rays = r0*r0;
    let x0 = B.p3.x;
    let radial = pow((1.0 + x0)/(x + x0), B.p2.y);
    let star = step(0.5, 1.0 - x0);
    // between its streamers a star's corona is nearly dark: an even glow there reads as a veil over the sky
    var glow = B.p2.x*radial*(mix(0.45, 0.26, star) + rays*B.p2.z);
    // stars only: a bright inner corona, steepest at the limb, so the disc melts into it instead of wearing a thin pale rim
    glow += B.p2.x*(1.5*exp(-(x - 1.0)*60.0) + 0.9*exp(-(x - 1.0)*11.0))*star;
    glow *= 1.0 + 0.4*B.p3.z;
    if (B.p3.y > 0.0) { glow *= smoothstep(0.0, 1.0, length(o)/(B.p3.y*R)); }
    col += B.colD.rgb*(glow*part*fall(0.7, 1.0, x*R/Rb)*disc);
  }
  // polylines: closest approach between the view ray and each segment, Gaussian falloff, max over segments
  // against the photosphere the faint light of loops and ejecta is lost (drawn there it is a pale smear over
  // the granulation): they show beyond the limb and fade out just inside it
  var over = 1.0;
  if (tS < 1e29) { over = mix(0.08, 1.0, smoothstep(0.84, 1.0, dq)); }
  let nl = i32(LP.n.x);
  for (var i = 0; i < nl; i++) {
    // cull: one closest approach between the view ray and the chord of the line, against the capsule that holds it
    let a0 = LP.pts[i*9].xyz;
    let cu = LP.pts[i*9 + 8].xyz - a0;
    let cw = o - a0;
    let cb = dot(rd, cu); let cq2 = dot(cu, cu); let cdr = dot(rd, cw); let ce = dot(cu, cw);
    let cden = cq2 - cb*cb;
    var cs = 0.0;
    if (cden > 1e-9*cq2) { cs = clamp((ce - cb*cdr)/cden, 0.0, 1.0); }
    let cdv = cw + rd*max(cb*cs - cdr, 0.0) - cu*cs;
    if (dot(cdv, cdv) > LP.bs[i].w*LP.bs[i].w) { continue; }
    let par = LP.par[i];
    var best = 0.0;
    // Each of the eight spans is drawn as two straight pieces through its Catmull-Rom midpoint, so nine
    // control points read as a smooth curve instead of an octagon.
    for (var k = 0; k < 8; k++) {
      let p1 = LP.pts[i*9 + k];
      let p2 = LP.pts[i*9 + k + 1];
      let pm = LP.pts[i*9 + max(k - 1, 0)].xyz;
      let pn = LP.pts[i*9 + min(k + 2, 8)].xyz;
      let mid = (9.0*(p1.xyz + p2.xyz) - pm - pn)/16.0;
      for (var h = 0; h < 2; h++) {
        var a = p1.xyz; var bq3 = mid; var wa = p1.w; var wb = 0.5*(p1.w + p2.w);
        if (h == 1) { a = mid; bq3 = p2.xyz; wa = wb; wb = p2.w; }
        let u = bq3 - a;
        let w0 = o - a;
        let bq = dot(rd, u); let cq = dot(u, u); let dr = dot(rd, w0); let e = dot(u, w0);
        let den = cq - bq*bq;
        var s = 0.0;
        if (den > 1e-9*cq) { s = clamp((e - bq*dr)/den, 0.0, 1.0); }
        let t = max(bq*s - dr, 0.0);
        let dv = w0 + rd*t - u*s;
        let along = (f32(k) + 0.5*(f32(h) + s))/8.0;
        let wd = mix(par.y, par.z, along);
        let we = max(wd, t*G.time.y*0.8);              // never thinner than a pixel; intensity compensates
        let g2 = dot(dv, dv)/(we*we);
        var I = (exp(-g2) + 0.30*exp(-g2*0.16))*(wd/we)*mix(wa, wb, s);   // a bright thread in a soft sheath 2.5 times as wide: a thread alone reads as wire
        I *= sat((tS - t)/we + 1.0);                   // hidden behind the star
        I *= 0.65 + 0.7*n1(along*par.w - G.time.x*LP.col[i].w);
        best = max(best, I);
      }
    }
    col += LP.col[i].rgb*(best*par.x*over);
  }
  var res: FOut;
  // glare: the faint sky behind a bright glow is lost in it (stars shining through the inner corona look pasted on)
  res.c = vec4f(col, sat(0.6*max(col.r, max(col.g, col.b))));
  res.d = depthOf(max(tb0, G.fwd.w), rd);
  return res;
}
