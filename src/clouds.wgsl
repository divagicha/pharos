// Cloud layer of an Earth-like world: a thin shell at radius B.bnd.y, drawn after the solid surface and
// before the atmosphere (so the air in front of it hazes it). Premultiplied alpha, depth test on, no depth write.
// The same density function gives the cloud shadows in surf_terra.
//   p0.z cloud coverage threshold   p2 = drift rate, optical depth, detail frequency, (surface: snow line)
//   st[i] = cyclone centre (unit, local) and angular radius; sx[i].x = swirl strength (sign = sense of rotation)

// The slowly varying part of the deck at unit direction pl (body frame), shared by the taps of one pixel:
// the lookup position q after the cyclones have wound the domain up and the deck has drifted, a small offset
// dl from pl carried through the same turns (d), the domain warp and the weather systems.
struct CloudBase { q: vec3f, d: vec3f, w: vec3f, big: f32 }
fn cloudBase(pl: vec3f, dl: vec3f, fp: f32) -> CloudBase {
  let t = G.time.x*B.p2.x;
  var q = pl; var d = dl;
  for (var i = 0; i < 6; i++) {                                 // cyclones wind the noise domain up into spirals
    let c = B.st[i];
    if (c.w <= 0.0) { continue; }
    let r = acos(clamp(dot(q, c.xyz), -1.0, 1.0))/c.w;
    if (r < 2.5) {
      let ang = B.sx[i].x*exp(-r*r*1.1)/(0.3 + r);
      q = rotAx(q, c.xyz, ang); d = rotAx(d, c.xyz, ang);
    }
  }
  var cb: CloudBase;
  cb.q = rotY(q, t*0.5);                                        // the whole deck drifts relative to the ground
  cb.d = rotY(d, t*0.5);
  cb.w = warp3(cb.q*2.2 + vec3f(t*1.3, 0.0, -t));
  // weather systems. They steer the detail below, so they must not move in steps when magnified (fbmA).
  cb.big = fbmA(cb.q*1.7 + cb.w*0.6 + vec3f(B.rot0.w), 4.0, fp*1.7);
  return cb;
}
// Cloud thickness at lookup position q (cb.q, or cb.q + cb.d for an offset tap) and unsheared direction pl:
// negative in clear sky, about 1 in the core of a weather system. fp = pixel footprint on the unit sphere.
fn cloudFrom(cb: CloudBase, q: vec3f, pl: vec3f, fp: f32) -> f32 {
  let t = G.time.x*B.p2.x;
  let df = B.p2.z;
  let det = fbm(q*df + cb.w*1.1 + vec3f(0.0, t, 0.0) + vec3f(cb.big*2.0), clamp(log2(0.5/(fp*df)), 1.0, 6.0));
  // climate bands: wet equator and mid-latitudes, clear subtropics, overcast towards the poles
  let lat = abs(pl.y);
  let cov = B.p0.z + 0.055*cos(lat*9.4) - 0.05*smoothstep(0.75, 0.95, lat);
  let mass = 0.38*cb.big + 0.62*det;
  let shape = smoothstep(cov, cov + 0.30, mass);
  let thin = smoothstep(cov - 0.10, cov + 0.14, mass);          // thin cloud reaches further out than thick
  if (thin <= 0.0) { return -1.0; }
  // Billows at two scales break up each system and texture its top: tens of km, and for close range a few km.
  // They use the unsheared direction (the cyclones would smear them into streaks) and fade to their mean as
  // they shrink below a pixel, so nothing pops.
  let hf = df*7.0;
  let hq = rotY(pl, t*0.5)*hf + cb.w*2.0;
  let hi = fbm(hq + vec3f(t*3.0, 0.0, 0.0), clamp(log2(0.5/(fp*hf)), 0.0, 6.0));
  let pOct = clamp(log2(0.5/(fp*hf*9.0)), 0.0, 5.0);
  let puff = fbm(hq*9.0 + vec3f(0.0, t*5.0, 7.0), pOct);
  // the billows die away with the system: its edge is then where the thickness crosses zero, not a jump
  let core = shape*1.25 + ((hi - 0.5)*1.5 + (puff - 0.5)*0.8)*sat(shape*4.0) - 0.28;
  // a thin veil over the whole system, which the ground shows through: without it a system is opaque white
  // lumps with hard edges, like torn paper
  // (it stands for small cloud too fine to see; as the camera closes in and the puffs resolve, it gives way to them)
  return max(core, 0.19*thin*(0.5 + hi)*(1.0 - 0.7*sat(pOct*0.33)));
}
fn cloudThick(pl: vec3f, fp: f32) -> f32 {
  let cb = cloudBase(pl, vec3f(0.0), fp);
  return cloudFrom(cb, cb.q, pl, fp);
}
// Cloud density 0..1 (used for opacity here and for the cloud shadows on the ground).
fn cloudDens(pl: vec3f, fp: f32) -> f32 { return smoothstep(0.0, 0.45, cloudThick(pl, fp)); }

// One crossing of the shell at point pc (relative to the centre): premultiplied colour and alpha.
fn cloudLayer(pc: vec3f, rd: vec3f, t: f32) -> vec4f {
  let Rc = B.bnd.y;
  // the cutaway takes the cloud over the opening with it: coverage from the distance to the octant's nearest face
  var keep = 1.0;
  if (B.cut0.w < 0.999) {
    let c = cutLocal(pc)/B.center.w - vec3f(B.cut0.w);
    keep = sat(0.5 - min(c.x, min(c.y, c.z))*B.center.w/(t*G.time.y));
    if (keep <= 0.0) { return vec4f(0.0); }
  }
  let n = pc/Rc;
  let pl = toLocal(n);
  let cosv = abs(dot(n, rd));
  // footprint: geometric mean of the along-view (stretched) and across-view pixel sizes, so oblique views keep detail
  let fp = t*G.time.y/Rc/max(sqrt(cosv), 0.35);
  let Ll = toLocal(B.sun.xyz);
  // the second tap stands a little way towards the star: about forty pixels, at most 26 km
  let off = clamp(fp*40.0, 0.0007, 0.004);
  let pl2 = normalize(pl + Ll*off);
  let cb = cloudBase(pl, pl2 - pl, fp);
  let h = cloudFrom(cb, cb.q, pl, fp);
  let dens = smoothstep(0.0, 0.45, h);
  if (dens <= 0.002) { return vec4f(0.0); }
  // thin edges stay translucent (dens squared), cores are opaque
  let alpha = 1.0 - exp(-dens*dens*B.p2.y/max(cosv, 0.5));
  let muS = dot(pl, Ll);
  // Relief: compare with the thickness at the second tap. Standing above the sunward neighbour means a lit
  // flank; sitting below it means being in its shadow. (A nearer tap sees a smaller difference: part made up.)
  let h2 = max(cloudFrom(cb, cb.q + cb.d, pl2, fp*1.5), -0.25);
  let sl = (h - h2)*2.2*sqrt(0.004/off);
  let shade = 0.56 + 0.44*sl/sqrt(1.0 + sl*sl);                 // smooth saturation: no contour lines
  // thick cloud scatters light forward and sideways: softer than Lambert, with a little bleed past the terminator
  let wrap = sat((muS + 0.12)/1.12);
  let sun = B.sunCol.rgb*sunTrans(Rc, muS)*occluders(pc)*smoothstep(-0.06, 0.06, muS);
  let lit = sun*(wrap*(0.30 + 0.88*shade)) + skyLight(muS)*1.6;
  let col = vec3f(0.95, 0.96, 0.97)*lit*(0.84 + 0.16*dens);
  return vec4f(col*alpha, alpha)*keep;
}

@fragment fn fs_clouds(@builtin(position) fc: vec4f) -> FOut {
  let rd = rayDir(fc.xy);
  let R0 = B.center.w; let Rc = B.bnd.y;
  let o = -B.center.xyz;
  let b = dot(o, rd);
  let qc = o - b*rd;
  let q2 = dot(qc, qc);
  if (b >= 0.0) { discard; }                                    // the camera is always above the deck, looking away
  let dq = sqrt(q2);
  let px = max(-b, G.fwd.w)*G.time.y;
  let covS = sat((Rc - dq)/px + 0.5);                           // the shell's own limb, anti-aliased
  if (covS <= 0.0) { discard; }
  let sc = sqrt(max((Rc - dq)*(Rc + dq), 0.0));
  let tn = -b - sc;
  if (tn <= 0.0) { discard; }
  let covG = sat((R0 - dq)/px + 0.5);                           // how much of this pixel's ray is stopped by the ground
  // Cloud standing above the horizon is only drawn once the deck is a few pixels tall on screen; from far
  // away it would be a hairline along the limb.
  let above = (1.0 - covG)*sat(((Rc - R0)/px - 1.0)*0.5);
  var acc = vec4f(0.0);
  if (above > 0.0) {                                            // limb ray: the far crossing shows too
    acc = cloudLayer(qc + rd*sc, rd, -b + sc)*above;
  }
  let near = cloudLayer(qc - rd*sc, rd, tn)*(covG + above);
  acc = near + acc*(1.0 - near.a);
  if (acc.a*covS <= 0.0) { discard; }
  var res: FOut;
  res.c = acc*covS;
  res.d = depthOf(tn, rd);
  return res;
}
