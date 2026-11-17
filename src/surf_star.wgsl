// Star photosphere: boiling granulation at three scales, sunspot pairs with plage in the active regions,
// limb darkening with a colour shift, and white-hot ribbons between the spots while a region flares. Emissive only.
//   p0 = granule frequency, granule contrast, spot darkness, boil rate
//   p1 = gain (set every frame from the star's size on screen), limb darkening, flare brightness, mottle amount
//   p2 / colD are the corona's (see corona.wgsl)
//   colA hot granule colour, colB cool lane colour, colC limb tint
//   st[i] = active region centre (unit, local) and angular radius
//   sx[i] = flare level 0..1 (animated on the CPU), spot size, spot separation, phase seed

// Granulation: bright polygonal cells with dark lanes, from the border distance of animated cellular noise.
// Each scale fades to its mean as its cells shrink below about three pixels.
fn granules(pl: vec3f, fp: f32) -> f32 {
  let tm = G.time.x*B.p0.w;
  // The finest cells the screen can resolve carry most of the contrast; the coarser networks under them are
  // only a faint mottle with soft lanes, or the disc reads as cracked mud.
  let amps = array<f32, 3>(0.16, 0.34, 0.50);
  var f = B.p0.x; var g = 0.0;
  for (var k = 0; k < 3; k++) {
    let fade = sat(1.0/(fp*f*3.0) - 0.4);
    if (fade > 0.0) {
      let v = voro(pl*f + vec3f(B.rot0.w + f32(k)*7.0), tm*(1.0 + f32(k)*0.7));
      // a dome over each cell (brightest at its centre, sinking smoothly into the lane) and a brightness of its own
      let dome = smoothstep(0.0, 0.62 + 0.14*f32(2 - k), v.y - v.x);
      let cell = dome*(0.93 + 0.14*fract(v.z*9.37));
      g += amps[k]*mix(0.62, cell, fade);
    } else {
      g += amps[k]*0.62;                                        // 0.62 = mean of the cell profile
    }
    f *= 3.1;
  }
  return g;
}

fn surf_star(pw: vec3f, rd: vec3f, fp: f32) -> vec3f {
  let n0 = normalize(pw);
  let pl = toLocal(n0);
  let mu = max(dot(n0, -rd), 0.0);
  let sd = B.rot0.w;

  // slow large-scale mottling (supergranulation, faculae) under the granules
  let mott = fbm(pl*3.1 + vec3f(sd, G.time.x*B.p0.w*0.02, -sd), 4.0);
  var bright = 1.0 + B.p0.y*(granules(pl, fp) - 0.62)*1.6 + B.p1.w*(mott - 0.5);

  // active regions: a pair of spots (dark umbra, fibrous penumbra) set in bright plage
  var heat = 0.0; var flash = 0.0;
  for (var i = 0; i < 6; i++) {
    let c = B.st[i];
    if (c.w <= 0.0) { continue; }
    let x = B.sx[i];
    let east = normalize(cross(vec3f(0.0, 1.0, 0.0), c.xyz));
    let north = cross(c.xyz, east);
    let dv = pl - c.xyz;
    let d0 = length(dv)/c.w;
    if (d0 > 3.0) { continue; }
    let ragged = 0.22*(vnoise(pl*60.0 + vec3f(x.w)) - 0.5);
    for (var s = -1; s <= 1; s += 2) {
      let ds = length(dv - east*(f32(s)*x.z*c.w))/(c.w*x.y*(1.0 + 0.25*f32(s))) + ragged;
      let umbra = fall(0.30, 0.48, ds);
      let pen = fall(0.80, 1.0, ds)*(1.0 - umbra);
      let fibril = 0.78 + 0.44*vnoise(vec3f(atan2(dot(dv, east), dv.y)*14.0, ds*3.0, x.w));
      bright *= 1.0 - B.p0.z*umbra - B.p0.z*0.45*pen*fibril;
    }
    // plage: a bright network of filaments around the spots (the ridges of a fine noise, fading with distance)
    let web = 1.0 - abs(2.0*fbm(pl*90.0 + vec3f(x.w*3.0), clamp(log2(1.0/(fp*90.0)), 0.0, 3.0)) - 1.0);
    heat += fall(0.9, 2.6, d0)*smoothstep(0.74, 0.96, web)*0.32;
    if (x.z > 0.01) {
      // a flare: two thin bright ribbons either side of the line between the spots, wandering a little
      let fe = dot(dv, east)/c.w; let fq = dot(dv, north)/c.w;
      let rb = (abs(fe + 0.10*(vnoise(vec3f(fq*2.6, x.w*7.0, 1.5)) - 0.5)) - 0.15)/0.045;
      flash += x.x*exp(-rb*rb - fq*fq*3.2);
    } else {
      flash += x.x*exp(-d0*d0*2.2);                              // no pair (the polar cap of a pulsar): a round patch
    }
  }
  bright = max(bright*(1.0 + heat), 0.03);                       // a factor, so plage cannot fill in an umbra

  // limb darkening: dimmer and redder towards the edge
  let ld = 1.0 - B.p1.y*(1.0 - mu);
  // hue follows temperature; brightness follows it only weakly outside the spots, so the lanes between
  // granules stay a glowing orange instead of going brown
  let lum = mix(bright, 0.55 + 0.45*bright, smoothstep(0.45, 0.80, bright));
  var col = mix(B.colB.rgb, B.colA.rgb, sat(bright*1.1 - 0.25))*lum;
  col = mix(B.colC.rgb*col, col, 0.25 + 0.75*mu)*ld;
  col += vec3f(1.0, 0.96, 0.90)*(flash*B.p1.z);
  return col*B.p1.x;
}
