// Solid-body fragment template. tools/wgsl.mjs stamps one copy per surface type, replacing the token
// SURF, so fs_SURF calls surf_SURF. Output is premultiplied alpha (analytic limb coverage) plus true depth;
// bodies are drawn far to near so each limb blends over what is behind it.
@fragment fn fs_SURF(@builtin(position) fc: vec4f) -> FOut {
  let rd = rayDir(fc.xy);
  let R = B.center.w;
  let o = -B.center.xyz;
  let b = dot(o, rd);
  let tc = -b;
  let qc = o - b*rd;                       // closest point of the ray to the centre: stable at any distance
  let q2 = dot(qc, qc);
  if (tc <= 0.0 && dot(o, o) > R*R) { discard; }
  let px = max(tc, G.fwd.w)*G.time.y;      // km per pixel at the closest approach
  let dq = sqrt(q2);
  // limb coverage; a disc under about a pixel across fades out and its flare sprite carries the light instead
  let cov = sat((R - dq)/px + 0.5)*sat((R/px - 0.3)*1.1);
  if (cov <= 0.0) { discard; }
  let sh = sqrt(max((R - dq)*(R + dq), 0.0));
  var pw = qc - rd*sh;
  if (dq > R) { pw = qc*(R/dq); }
  let t = max(tc - sh, G.fwd.w);
  let cosv = max(dot(pw, -rd)/R, 0.0);
  let fp = t*G.time.y/R/max(cosv, 0.2);    // pixel footprint on the unit sphere, stretched at grazing angles
  var res: FOut;
  res.d = depthOf(t, rd);
  let a = B.cut0.w;
  if (a >= 0.999) {
    res.c = vec4f(surf_SURF(pw, rd, fp)*cov, cov);
    return res;
  }
  // cutaway open: 4 sub-pixel rays anti-alias the cut edges
  var acc = vec4f(0.0); var surfC = vec3f(0.0); var haveSurf = false; var nCut = 0;
  let fpx = t*G.time.y/R;
  for (var i = 0; i < 4; i++) {
    let rdi = rayDir(fc.xy + SUB[i]);
    let bi = dot(o, rdi);
    let qi = o - bi*rdi;
    let hi = R*R - dot(qi, qi);
    if (hi <= 0.0) { continue; }
    let pwi = qi - rdi*sqrt(hi);
    let pc = cutLocal(pwi)/R;
    let rc = cutLocal(rdi);
    let hit = traceCut(pc, rc, a);
    if (hit.x < 0.5) { nCut++; continue; }
    if (hit.x < 1.5) {
      if (!haveSurf) { surfC = surf_SURF(pw, rd, fp); haveSurf = true; }
      acc += vec4f(surfC, 1.0);
    } else {
      nCut++;
      acc += vec4f(shadeCut(pc + rc*hit.y, hit, fpx), 1.0);
    }
  }
  if (nCut == 0) {
    if (!haveSurf) { surfC = surf_SURF(pw, rd, fp); }
    res.c = vec4f(surfC*cov, cov);
    return res;
  }
  acc *= 0.25;
  if (acc.a <= 0.0) { discard; }
  res.c = acc;
  return res;
}
