// Gas and ice giants: latitude bands sheared by zonal jets, turbulent festoons between them, vortex storms.
// One shader, two parameter sets (src/js/looks.js).
//   p0 = band count pole to pole, band contrast, turbulence, flow speed
//   p1 = detail frequency, bright-streak amount, polar tint amount, limb-darkening exponent
//   colA zones (light), colB belts (dark), colC accent belt colour, colD polar colour
//   st[i] = storm centre (unit, local) and angular radius
//   sx[i] = swirl strength (sign = sense), tint amount, tint brightness, hue (0 = accent colour .. 1 = white)
const FLOW_T = 36.0;        // seconds of the animation clock per flow cycle

// Colour of the cloud deck at unit direction p (body frame), with the flow frozen at offset tau seconds.
// The flow is real shear: zonal jets slide each latitude along, vortices turn about their centres.
fn giantDeck(p0: vec3f, tau: f32, fp: f32) -> vec3f {
  let sd = B.rot0.w;
  let F = B.p0.x;
  var p = p0;
  // ---- vortices: wind the surroundings into a spiral, and remember the strongest one for tinting ----
  var tint = 0.0; var tintCol = vec3f(0.0); var collar = 0.0;
  for (var i = 0; i < 6; i++) {
    let c = B.st[i];
    if (c.w <= 0.0) { continue; }
    let x = B.sx[i];
    // elliptical footprint, longer along the latitude circle
    let east = normalize(cross(vec3f(0.0, 1.0, 0.0), c.xyz));
    let north = cross(c.xyz, east);
    let dv = p - c.xyz;
    let d = length(vec2f(dot(dv, east)/1.55, dot(dv, north)))/c.w;
    if (d > 2.2) { continue; }
    let core = fall(0.78, 1.02, d);
    p = rotAx(p, c.xyz, x.x*(fall(0.15, 1.6, d)*(1.2 + tau*0.07)));
    let w = core*x.y;
    if (w > tint) { tint = w; tintCol = mix(B.colC.rgb, vec3f(1.0), x.w)*x.z; }
    collar = max(collar, exp(-(d - 1.08)*(d - 1.08)/0.02)*abs(x.y));
  }
  // ---- zonal jets: alternate east and west with the bands ----
  let lat0 = asin(clamp(p.y, -1.0, 1.0));
  let bj = lat0*F/3.14159265;
  p = rotY(p, sin(bj*6.2831853)*0.0075*tau);
  // ---- turbulence displaces the band coordinate; strongest where neighbouring jets shear past each other ----
  let q = vec3f(p.x, p.y*2.6, p.z);
  let wv = warp3(q*3.4 + vec3f(sd));
  let turb = fbm(q*5.5 + wv*1.3 + vec3f(sd*2.0), clamp(log2(0.5/(fp*5.5)), 1.0, 7.0)) - 0.5;
  let shear = 0.45 + 0.55*abs(cos(bj*6.2831853));
  let b = bj + turb*B.p0.z*shear + (wv.y)*0.25*B.p0.z;
  // ---- band colour: irregular widths from two scales of 1D noise ----
  let v = 0.60*n1(b + sd) + 0.40*n1(b*2.37 + sd*1.7);
  let zone = smoothstep(0.5 - 0.20/B.p0.y, 0.5 + 0.20/B.p0.y, v);
  var col = mix(B.colB.rgb, B.colA.rgb, zone);
  let acc = smoothstep(0.55, 0.78, n1(b*0.61 + sd*3.3 + 11.0));
  col = mix(col, B.colC.rgb, acc*(1.0 - zone)*0.8);                                  // accent tints some belts
  col *= 0.84 + 0.32*n1(b*1.31 + sd*5.1 + 40.0);                                     // every band its own brightness
  // ---- fine streaks stretched along the flow ----
  let df = B.p1.x;
  let qs = vec3f(p.x*0.45, p.y*13.0, p.z*0.45)*df + wv*2.0;
  let str = fbm(qs + vec3f(sd*5.0), clamp(log2(0.5/(fp*df*4.0)), 1.0, 8.0));
  col *= 0.86 + 0.28*str;
  col = mix(col, vec3f(1.0), smoothstep(0.66, 0.80, str)*B.p1.y*(0.4 + 0.6*shear));  // bright high cloud
  // ---- poles ----
  col = mix(col, B.colD.rgb, smoothstep(0.62, 0.93, abs(p0.y))*B.p1.z);
  // ---- storms ----
  col = mix(col, tintCol*(0.72 + 0.56*str), tint);
  col *= 1.0 - 0.34*collar*(1.0 - tint);
  return col;
}

fn surf_giant(pw: vec3f, rd: vec3f, fp: f32) -> vec3f {
  let n0 = normalize(pw);
  let pl = toLocal(n0);
  let muS = dot(n0, B.sun.xyz);
  let muV = max(dot(n0, -rd), 0.0);
  // two-phase flow blending: each phase runs the shear for FLOW_T seconds and is faded out before it winds
  // up too far; the phases are half a cycle apart, so their weights always sum to one
  let ph = fract(G.time.x*B.p0.w/FLOW_T);
  let ph2 = fract(ph + 0.5);
  let w1 = 1.0 - abs(2.0*ph - 1.0);
  var col = giantDeck(pl, (ph - 0.5)*FLOW_T, fp)*w1 + giantDeck(pl, (ph2 - 0.5)*FLOW_T, fp)*(1.0 - w1);
  // light: soft terminator (deep scattering atmosphere) and limb darkening
  let wrap = sat((muS + 0.10)/1.10);
  let light = sunAt(pw, max(muS, 0.0) + 0.02, fp)*(wrap*pow(max(muV, 0.02), B.p1.w)) + skyLight(muS)*0.4;
  return col*light;
}
