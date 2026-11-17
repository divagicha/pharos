// Rocky and icy bodies: fractal terrain and craters with analytic normals, plus optional lava, ice fractures,
// sulfur plains, frost and planetshine. One shader, parameter sets per body (src/js/looks.js).
//   p0 = terrain frequency, terrain amplitude, crater probability, crater depth
//   p1 = lava amount, crack frequency, lava sea level, ice-fracture amount
//   p2 = dark-plains amount, bump strength, polar frost, sulfur patches
//   p3 = planetshine, Lommel-Seeliger weight (0 = Lambert), detail albedo contrast, unused
//   colA highlands, colB plains, colC lava or fracture colour (w = lava emission gain), colD planetshine colour

// One lattice of craters: height and its gradient with respect to x. Centres sit at random points of a unit
// lattice and reach at most half a cell, so searching the 2x2x2 nearest cells is complete.
fn craterField(x: vec3f, seed: i32, prob: f32) -> vec4f {
  let ib = vec3i(floor(x - 0.5));
  var h = 0.0; var g = vec3f(0.0);
  for (var k = 0; k < 2; k++) { for (var j = 0; j < 2; j++) { for (var i = 0; i < 2; i++) {
    let cell = ib + vec3i(i, j, k);
    let hh = h3u(cell + vec3i(seed, seed*7, seed*13));
    let e = u2f(h1u(hh));
    if (e > prob) { continue; }
    let q = e/prob;
    let rad = 0.085 + 0.225*q*q;                                // cell units; 1.6*rad <= 0.5
    let c = vec3f(cell) + vec3f(f32(hh & 1023u), f32((hh >> 10u) & 1023u), f32((hh >> 20u) & 1023u))/1023.0;
    let dv = x - c; let d = length(dv); let u = d/rad;
    if (u >= 1.6) { continue; }
    let age = 0.3 + 0.7*u2f(h1u(hh ^ 0x9e3779b9u));             // old craters are shallow
    var hp = 0.0; var dh = 0.0;
    if (u < 1.0) { hp = 0.5*(u*u - 1.0); dh = u; }              // bowl
    let rim = 0.42*exp(-22.0*(u - 1.0)*(u - 1.0));              // raised rim
    let depth = rad*2.2*age;
    h += depth*(hp + rim);
    g += depth*(dh - 44.0*(u - 1.0)*rim)*dv/(d*rad + 1e-6);
  }}}
  return vec4f(h, g);
}

// Glow of molten rock for heat 0..1+: deep red through orange to yellow-white.
fn lavaGlow(heat: f32) -> vec3f {
  let t = sat(heat);
  return vec3f(1.0, 0.10 + 0.62*t*t, 0.01 + 0.36*t*t*t*t)*(heat*(0.35 + 0.65*t));
}

// Europa-style lineae: arcs of random small circles on the unit sphere, never thinner than a pixel.
fn lineae(pl: vec3f, sd: f32, fp: f32) -> f32 {
  let wob = (vnoise(pl*2.6 + vec3f(sd)) - 0.5)*0.10 + (vnoise(pl*8.0 + vec3f(sd + 5.0)) - 0.5)*0.025;
  var s = 0.0;
  for (var i = 0; i < 16; i++) {
    let hh = h3u(vec3i(i, i32(sd*37.0), 11));
    let n = normalize(vec3f(f32(hh & 1023u), f32((hh >> 10u) & 1023u), f32((hh >> 20u) & 1023u))/511.5 - 1.0 + vec3f(0.013, 0.007, 0.003));
    let k = h1u(hh);
    let off = (u2f(k) - 0.5)*1.1;                               // which small circle about the axis n
    let wd = 0.0035 + 0.011*u2f(h1u(k));
    let m = normalize(cross(n, vec3f(0.37, 0.88, 0.29)));       // each arc lives on one side of a second plane
    let ext = smoothstep(-0.15, 0.25, dot(pl, m)*(f32(i & 1)*2.0 - 1.0) + 0.3);
    let d = abs(dot(pl, n) - off + wob*(0.6 + 0.4*f32(i % 3)));
    let w = max(wd, fp*1.3);
    s = max(s, fall(0.0, w, d)*(wd/w)*ext*(0.5 + 0.5*u2f(h1u(k + 3u))));
  }
  return s;
}

fn surf_rock(pw: vec3f, rd: vec3f, fp: f32) -> vec3f {
  let n0 = normalize(pw);
  let pl = toLocal(n0);
  let L = toLocal(B.sun.xyz);
  let V = toLocal(-rd);
  let sd = B.rot0.w;
  let muS = dot(pl, L);

  // ---- large provinces: dark plains fill the lowlands and are smoother ----
  let prov = fbm(pl*1.4 + vec3f(sd*3.1, sd, -sd), 5.0);
  let mare = smoothstep(0.50, 0.63, prov)*B.p2.x;

  // ---- height and gradient: fractal terrain plus crater lattices at shrinking scales ----
  let tf = B.p0.x;
  let oct = clamp(log2(0.5/(fp*tf)), 1.0, 11.0);
  let T = fbmd(pl*tf + vec3f(sd), oct);
  let rough = 1.0 - 0.7*mare;
  var h = T.x*B.p0.y*rough;
  var g = T.yzw*(tf*B.p0.y*rough);
  var cf = 2.3;
  for (var k = 0; k < 9; k++) {
    let fade = smoothstep(2.5, 6.0, 0.2/(cf*fp));               // typical crater radius in pixels
    if (fade <= 0.0) { break; }
    let c = craterField(pl*cf + vec3f(sd*1.7), k*31 + 7, B.p0.z*(1.0 - 0.8*mare));
    h += c.x*(B.p0.w/cf)*fade;
    g += c.yzw*(B.p0.w*fade);
    cf *= 1.9;
  }
  let gt = g - pl*dot(g, pl);
  let nl = normalize(pl - B.p2.y*gt);

  // ---- albedo ----
  var alb = mix(B.colA.rgb, B.colB.rgb, mare);
  let dOct = clamp(log2(0.5/(fp*9.0)), 1.0, 7.0);
  alb *= 1.0 + B.p3.z*(fbm(pl*9.0 + vec3f(sd*2.3), dOct) - 0.5)*2.0;
  alb *= 1.0 + clamp(h*30.0, -0.22, 0.28);                      // crater floors darker, rims and peaks brighter
  var emit = vec3f(0.0);

  // sulfur plains: mottled yellow, orange and white frost, with dark calderas ringed by red fallout
  if (B.p2.w > 0.0) {
    let s1 = fbm(pl*2.3 + vec3f(sd*5.0), 6.0);
    let s2 = fbm(pl*4.3 - vec3f(sd*2.0), clamp(log2(0.5/(fp*4.3)), 1.0, 7.0));
    alb = mix(alb, B.colB.rgb, smoothstep(0.40, 0.66, s1)*B.p2.w);
    alb = mix(alb, vec3f(0.90, 0.89, 0.80), smoothstep(0.54, 0.74, s2)*0.7*B.p2.w);
    let vq = pl*6.0 + warp3(pl*3.0 + vec3f(sd))*0.8;
    let vc = voro(vq, 0.0);
    let sz = 0.05 + 0.09*fract(vc.z*7.31);                      // each caldera its own size
    // cell id switches at cell borders, so everything keyed on it must fade out before the border
    let on = step(0.35, vc.z)*smoothstep(0.0, 0.16, vc.y - vc.x);
    let ragged = vc.x + 0.05*(vnoise(pl*40.0 + vec3f(sd)) - 0.5);
    let cald = fall(sz*0.55, sz, ragged)*on;
    alb = mix(alb, B.colC.rgb*vec3f(0.5, 0.42, 0.35), fall(sz, sz*3.2, ragged)*on*0.55);
    alb = mix(alb, vec3f(0.03, 0.027, 0.026), cald);
    emit += lavaGlow(fall(0.0, sz*0.4, ragged)*step(0.7, vc.z)*on*1.1)*B.colC.w;
  }

  // ice fractures: long arcs, stained darker, plus faint mottled "chaos" regions
  if (B.p1.w > 0.0) {
    let chaos = smoothstep(0.55, 0.75, fbm(pl*3.1 + vec3f(sd*4.0), 5.0));
    alb = mix(alb, mix(alb, B.colC.rgb, 0.35), chaos);
    alb = mix(alb, B.colC.rgb, sat(lineae(pl, sd, fp)*B.p1.w));
  }

  // polar frost with a ragged edge
  if (B.p2.z > 0.0) {
    let edge = abs(pl.y) + 0.10*(fbm(pl*6.0 + vec3f(sd), 4.0) - 0.5);
    alb = mix(alb, vec3f(0.92, 0.94, 0.97), smoothstep(1.0 - B.p2.z, 1.04 - B.p2.z, edge));
  }

  // ---- lava: fissures in volcanically active regions (act), plated lakes in the lowlands ----
  if (B.p1.x > 0.0) {
    let lf = B.p1.y;
    let q = pl*lf + warp3(pl*2.3 + vec3f(sd))*1.5 + warp3(pl*7.1 + vec3f(sd + 3.0))*0.45;
    let v1 = voro(q, 0.0); let e1 = v1.y - v1.x;
    let v2 = voro(q*3.3 + vec3f(7.0), 0.0); let e2 = v2.y - v2.x;
    let aN = fbm(pl*1.9 - vec3f(sd*1.3), 5.0);
    let act = smoothstep(0.42, 0.72, aN);
    // not every plate boundary is open: slowly varying masks break the network into separate fissures
    let open1 = smoothstep(0.36, 0.60, vnoise(q*0.9 + vec3f(sd*0.7)));
    let open2 = smoothstep(0.42, 0.72, vnoise(q*2.3 + vec3f(sd*1.9)));
    let lake = fall(B.p1.z - 0.04, B.p1.z + 0.04, T.x)*smoothstep(0.36, 0.60, aN);
    let pulse = 0.8 + 0.4*vnoise(pl*26.0 + vec3f(0.0, G.time.x*0.12, sd));
    let c1 = 0.006 + 0.016*open1;                               // fissures widen where they are most active
    let w1 = max(c1, fp*lf*1.3); let w2 = max(0.020, fp*lf*4.3);
    let core1 = fall(0.0, w1, e1)*(c1/w1)*open1;
    let core2 = fall(0.0, w2, e2)*(0.020/w2);
    // a narrow white-hot core, a soft halo of heated rock beside it, and finer cracks branching off
    var heat = act*(core1*1.15 + 0.20*open1*exp(-e1*34.0)) + act*0.55*core2*open2*exp(-e1*7.0);
    heat = max(heat, lake*(0.20 + 0.85*core2 + 0.45*core1 + 0.25*vnoise(q*5.0 + vec3f(G.time.x*0.05))));
    heat *= B.p1.x*pulse;
    alb = mix(alb, vec3f(0.02, 0.017, 0.016), sat(lake*0.85 + act*0.4));   // fresh dark crust
    emit += lavaGlow(heat)*B.colC.w;
  }

  // ---- lighting ----
  let ndl = max(dot(nl, L), 0.0);
  let ndv = max(dot(nl, V), 0.0);
  let refl = mix(ndl, 2.0*ndl/(ndl + ndv + 1e-3), B.p3.y);       // Lambert blended with Lommel-Seeliger
  var lit = sunAt(pw, muS, fp)*refl + skyLight(muS);
  if (B.p3.x > 0.0 && B.occ[0].w > 0.0) {                        // planetshine from the parent, occ[0]
    let toP = B.occ[0].xyz - pw;
    let dP = length(toP);
    let phase = 0.5 + 0.5*dot(B.sun.xyz, -toP/dP);
    let rr = B.occ[0].w/dP;
    lit += B.colD.rgb*(B.p3.x*rr*rr*phase*max(dot(nl, toLocal(toP/dP)), 0.0));
  }
  return alb*(lit + vec3f(B.sunCol.w)) + emit;
}
