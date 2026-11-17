// Atmosphere pass: single scattering (Rayleigh + Mie) integrated along the view ray, plus aurora.
// Dual-source blending: dst = inscatter + dst*transmittance, so everything seen through the air (ground,
// clouds, moons, the star's disc at sunset, background stars) is dimmed and reddened per channel.
// Draw after the body's solid and cloud passes; depth test on, depth write off.
const NS = 16;
const NAUR = 6;
const SUN_E = 3.14159265;   // irradiance that makes a white Lambert surface facing the star read 1.0

struct AOut {
  @location(0) @blend_src(0) c: vec4f,
  @location(0) @blend_src(1) t: vec4f,
  @builtin(frag_depth) d: f32,
}

// Aurora brightness at point pw on a shell; hj = 0 (bottom of the curtain) .. 1 (top).
// fpx = pixel footprint on the unit sphere at that point, stretched by obliquity.
fn auroraAt(pw: vec3f, hj: f32, fpx: f32) -> f32 {
  let n = normalize(pw);
  let pl = toLocal(n);
  let m = B.aur.xyz;
  let cm = dot(pl, m);
  let colat = acos(clamp(abs(cm), 0.0, 1.0));
  let e1 = normalize(cross(m, vec3f(0.31, 0.2, 0.93)));
  let e2 = cross(m, e1);
  let lv = vec2f(dot(pl, e1), dot(pl, e2));
  let ln = lv/max(length(lv), 1e-4);
  let tm = G.time.x;
  let hemi = sign(cm)*5.0;
  let wob = (vnoise(vec3f(ln*2.2, tm*0.03 + hemi)) - 0.5)*0.12 + (vnoise(vec3f(ln*7.0, tm*0.07 + hemi)) - 0.5)*0.04;
  let dth = (colat - B.aurA.w - wob)/0.035;
  let oval = exp(-dth*dth);
  if (oval < 0.002) { return 0.0; }
  let night = fall(-0.25, 0.05, dot(n, B.sun.xyz));             // invisible in daylight
  if (night <= 0.0) { return 0.0; }
  // curtains: broad folds, then fine rays whose pattern drifts with height so they do not line up into a comb
  let folds = vnoise(vec3f(ln*11.0, tm*0.10 + hemi));
  let rays = vnoise(vec3f(ln*46.0 + vec2f(hj*0.35, -hj*0.2), tm*0.30 + hemi + hj*1.7));
  let fine = mix(0.33, rays*rays, sat(1.0/(fpx*420.0) - 0.5));   // 0.33 = mean of rays^2
  return oval*(0.25 + 1.5*folds*folds + 1.3*fine*folds)*night;
}

@fragment fn fs_atmo(@builtin(position) fc: vec4f) -> AOut {
  let rd = rayDir(fc.xy);
  let R0 = B.center.w; let Rt = B.atm0.x; let Rb = B.bnd.z;
  let HR = B.atm0.y; let HM = B.atm0.z;
  let o = -B.center.xyz;
  let b = dot(o, rd);
  let qc = o - b*rd;
  let q2 = dot(qc, qc);
  let hb = Rb*Rb - q2;
  if (hb <= 0.0) { discard; }
  let sb = sqrt(hb);
  if (sb - b <= 0.0) { discard; }
  let tb0 = max(-b - sb, 0.0);

  // Ground: sg = half-chord inside the solid sphere. cov is the same limb coverage the solid pass uses,
  // so the part of the ray beyond the ground fades in across the limb pixel instead of switching on.
  let dq = sqrt(q2);
  let sg = sqrt(max((R0 - dq)*(R0 + dq), 0.0));
  var cov = 0.0;
  if (b < 0.0) { cov = sat((R0 - dq)/(max(-b, G.fwd.w)*G.time.y) + 0.5); }
  let hitsGround = b < 0.0 && dq < R0;
  var tg = 1e30;                                   // distance to the ground along the ray, if it is in front
  if (hitsGround) { tg = max(-b - sg, 0.0); }

  var col = vec3f(0.0); var T = vec3f(1.0);
  let ht = Rt*Rt - q2;
  if (ht > 0.0) {
    let st = sqrt(ht);
    let s0 = max(-st, b);                          // s = distance past the ray's closest point to the centre
    var s1 = st;
    if (cov >= 1.0) { s1 = -sg; }
    if (s1 > s0) {
      // sample uniformly in u = asinh(s/k): dense where the air is, sparse above it
      let k = B.atm3.w;
      let u0 = asinh(s0/k);
      let du = (asinh(s1/k) - u0)/f32(NS);
      let L = B.sun.xyz;
      let qL = dot(qc, L); let rL = dot(rd, L);
      let bR = B.atm1.xyz + B.atm2.xyz;
      let bM = B.atm1.w*1.1;
      let far = 1.0 - cov;                         // weight of the ray beyond the ground's edge
      let sEdge = select(0.0, -sg, hitsGround);
      // moon and ring shadows vary slowly across the air column: take them once, where the ray is lowest
      var pShadow = qc;
      if (hitsGround) { pShadow = qc - rd*sg; }
      let shadow = occluders(pShadow)*ringShadow(pShadow, 0.002);
      var tR = 0.0; var tM = 0.0; var sR = vec3f(0.0); var sM = vec3f(0.0); var sA = vec3f(0.0);
      for (var i = 0; i < NS; i++) {
        let eu = exp(u0 + (f32(i) + 0.5)*du);
        let s = k*0.5*(eu - 1.0/eu);
        var ds = k*0.5*(eu + 1.0/eu)*du;
        if (s > sEdge) { ds *= far; }
        let r = max(sqrt(q2 + s*s), R0);
        let rhoR = exp((R0 - r)/HR); let rhoM = exp((R0 - r)/HM);
        let dR = rhoR*ds; let dM = rhoM*ds;
        let muS = (qL + s*rL)/r;
        let Tv = exp(-bR*(tR + 0.5*dR) - vec3f(bM*(tM + 0.5*dM)));
        let Ts = exp(-bR*columnRho(r, muS, HR, R0, rhoR) - vec3f(bM*columnRho(r, muS, HM, R0, rhoM)));
        sR += Tv*Ts*dR;
        sM += Tv*Ts*dM;
        sA += Tv*(dR*smoothstep(-0.35, 0.25, muS));      // crude multiple-scattering fill past the terminator
        tR += dR; tM += dM;
      }
      let g = B.atm0.w; let g2 = g*g;
      let phR = 0.0596831*(1.0 + rL*rL);
      let phM = 0.1193662*(1.0 - g2)*(1.0 + rL*rL)/((2.0 + g2)*pow(1.0 + g2 - 2.0*g*rL, 1.5));
      col = B.sunCol.rgb*SUN_E*(B.atm1.xyz*(sR*(phR*shadow) + sA*0.012) + vec3f(B.atm1.w)*sM*(phM*shadow));
      T = exp(-bR*tR - vec3f(bM*tM));
    }
  }
  if (B.aur.w > 0.0) {
    var au = vec3f(0.0);
    for (var j = 0; j < NAUR; j++) {
      let hj = f32(j)/f32(NAUR - 1);
      let rj = R0*(1.0 + B.aurB.w*(0.25 + 0.75*hj));
      let hh = rj*rj - q2;
      if (hh <= 0.0) { continue; }
      let sh = sqrt(hh);
      let w = exp(-hj*2.2)*(0.3 + 0.7*smoothstep(0.0, 0.12, hj))*min(rj/max(sh, 1e-3), 6.0);
      let cj = mix(B.aurA.rgb, B.aurB.rgb, smoothstep(0.2, 1.0, hj));
      let ta = -b - sh;
      let fa = G.time.y*rj/max(sh, rj*0.05)/R0;                 // footprint per unit distance, with obliquity
      if (ta > 0.0 && ta < tg) { au += cj*(w*auroraAt(qc - rd*sh, hj, ta*fa)); }
      let tz = -b + sh;
      if (tz > 0.0 && tz < tg) { au += cj*(w*auroraAt(qc + rd*sh, hj, tz*fa)); }
    }
    col += au*B.aur.w;
  }
  let f = B.atm2.w;
  var res: AOut;
  res.c = vec4f(col*f, 1.0);
  // p3.w = how grey the limb's transmittance is. Full colour reddens a star setting behind the limb, which is
  // right; on a giant with its deep haze the same law draws a red outline round the unlit limb.
  let Tg = mix(T, vec3f((T.r + T.g + T.b)/3.0), B.p3.w);
  res.t = vec4f(mix(vec3f(1.0), Tg, f), 1.0);
  res.d = depthOf(max(tb0, G.fwd.w), rd);
  return res;
}
