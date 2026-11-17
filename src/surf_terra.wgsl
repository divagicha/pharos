// Earth-like world: oceans, continents with relief, climate-driven biomes, polar ice, cloud shadows, city lights.
//   p0 = continent frequency, sea level, cloud coverage, unused
//   p1 = relief (bump) strength, ice-cap edge (sine of latitude), city-light amount, ocean roughness
//   p2 = cloud drift rate, cloud optical depth, cloud detail frequency, snow line (temperature)
//   colA deep ocean, colB shallow ocean, colC vegetation, colD desert

// GGX specular lobe for a flat surface of roughness alpha: waves live in the roughness, not in a perturbed
// normal, so the sun glint is broad and cannot shimmer.
fn glint(N: vec3f, L: vec3f, V: vec3f, alpha: f32) -> f32 {
  let H = normalize(L + V + vec3f(1e-6, 0.0, 0.0));           // L = -V would otherwise give 0/0
  let ndh = max(dot(N, H), 0.0); let ndl = max(dot(N, L), 0.0); let ndv = max(dot(N, V), 1e-3);
  let a2 = alpha*alpha;
  let dd = ndh*ndh*(a2 - 1.0) + 1.0;
  let D = a2/(3.14159265*dd*dd);
  let F = 0.02 + 0.98*pow(sat(1.0 - dot(V, H)), 5.0);
  let k = alpha*0.5;
  let Gv = 1.0/((ndv*(1.0 - k) + k)*(ndl*(1.0 - k) + k) + 1e-4);
  return D*F*Gv*0.25*ndl;
}

fn surf_terra(pw: vec3f, rd: vec3f, fp: f32) -> vec3f {
  let n0 = normalize(pw);
  let pl = toLocal(n0);
  let L = toLocal(B.sun.xyz);
  let V = toLocal(-rd);
  let sd = B.rot0.w;
  let muS = dot(pl, L);
  let alat = abs(pl.y);

  // ---- height: warped fractal continents; e = height above sea level ----
  let cfq = B.p0.x;
  let wq = pl*cfq + warp3(pl*1.3 + vec3f(sd))*0.75 + vec3f(sd);
  let oct = clamp(log2(0.5/(fp*cfq)), 1.0, 12.0);
  var soft: vec3f;
  let T = fbmds(wq, oct, &soft);
  let e = T.x - B.p0.y;
  let gt = (T.yzw - pl*dot(T.yzw, pl))*cfq;
  let gs = (soft - pl*dot(soft, pl))*cfq;                       // the slope that relief is shaded with
  let aa = max(fp*length(gt), 1e-5);                            // height change across one pixel
  let land = smoothstep(-aa, aa, e);                            // anti-aliased coastline
  let high = max(e, 0.0);

  // ---- climate ----
  let moist = fbm(pl*2.7 + vec3f(sd*1.9), 5.0);
  let dOct = clamp(log2(0.5/(fp*31.0)), 1.0, 7.0);
  let detail = fbm(pl*31.0 + vec3f(sd*0.7), dOct);
  let temp = 1.0 - 1.18*alat*alat - 1.5*high + 0.14*(moist - 0.5) + 0.05*(detail - 0.5);   // 1 hot .. 0 freezing
  let arid = (1.0 - moist) + 0.42*exp(-(alat - 0.40)*(alat - 0.40)/0.022) - 0.30*exp(-alat*alat/0.02);
  let desert = smoothstep(0.52, 0.80, arid);
  let forest = mix(B.colC.rgb, B.colC.rgb*vec3f(1.9, 1.5, 1.2), smoothstep(0.45, 0.75, arid));   // lush to dry grass
  var ground = mix(forest, B.colD.rgb, desert);
  ground = mix(ground, vec3f(0.20, 0.17, 0.13), fall(0.20, 0.36, temp)*0.8);                    // tundra
  ground = mix(ground, vec3f(0.27, 0.24, 0.21), smoothstep(0.10, 0.24, high));                  // bare rock
  ground *= 0.86 + 0.28*fbm(pl*7.0 - vec3f(sd*1.3), 5.0);                                       // regional mottling
  ground *= 0.80 + 0.40*detail;
  // ground cover for close range: patches from tens of km down to a few hundred metres; gone by about four radii
  let fOct = clamp(log2(0.5/(fp*260.0)), 0.0, 7.0);
  let fine = fbm(pl*260.0 + vec3f(sd*4.3), fOct);
  ground *= 0.78 + 0.44*fine;
  let snow = fall(B.p2.w - 0.05, B.p2.w + 0.05, temp);
  ground = mix(ground, vec3f(0.86, 0.89, 0.93), snow);

  // ---- ocean ----
  let depth = max(-e, 0.0);
  var sea = mix(B.colB.rgb, B.colA.rgb, smoothstep(0.0, 0.10, depth));
  sea *= (0.92 + 0.16*fbm(pl*9.0 + vec3f(sd*3.0), 4.0))*(0.93 + 0.14*fine);                     // currents and plankton
  let iceEdge = alat + 0.07*(moist - 0.5) + 0.03*(detail - 0.5);
  let seaIce = smoothstep(B.p1.y, B.p1.y + 0.035, iceEdge);
  sea = mix(sea, vec3f(0.80, 0.86, 0.91), seaIce);

  // ---- light ----
  let Rc = B.bnd.y; let R0 = B.center.w;
  // cloud shadow: where the ray from this point towards the star crosses the cloud deck
  let pcl = normalize(pl + L*((Rc - R0)/R0/max(muS, 0.12)));
  let cshadow = exp(-cloudDens(pcl, fp*2.0)*B.p2.y*0.9);
  let sun = sunAt(pw, muS, fp)*cshadow;
  // relief is confined to mountain belts (ridges of a second noise); plains and coasts stay flat
  let ridge = 1.0 - abs(2.0*fbm(pl*3.3 + vec3f(sd*2.9), 4.0) - 1.0);
  let mtn = smoothstep(0.80, 0.97, ridge)*smoothstep(0.01, 0.06, high);
  // plains show their hills only from close by, where the slope has its fine octaves
  let hills = 0.10 + 0.22*sat(fOct*0.2);
  let nl = normalize(pl - gs*(B.p1.x*(hills + (1.0 - hills)*mtn)*smoothstep(0.0, 0.02, high)));
  let ndl = max(0.72*dot(nl, L) + 0.28*muS, 0.0);
  let sky = skyLight(muS);
  var col = ground*(sun*ndl + sky);
  let ndv = max(dot(pl, V), 0.0);
  let fres = 0.02 + 0.98*pow(sat(1.0 - ndv), 5.0);                // sat: at the nadir ndv can round above 1, and pow of a negative base is NaN
  let water = sea*(sun*max(muS, 0.0) + sky)*(1.0 - fres)
            + sun*glint(pl, L, V, B.p1.w)*(1.0 - seaIce)
            + sky*(fres*2.2);                                                                    // the sea mirrors the sky
  col = mix(water, col, land);

  // ---- city lights on the night side: a cascade of noise scales, each fading to its mean below two pixels ----
  if (B.p1.z > 0.0 && muS < 0.15) {
    let pop = smoothstep(0.50, 0.72, fbm(pl*3.7 + vec3f(sd*7.0), 4.0))*land*fall(0.02, 0.10, high)
            *smoothstep(0.25, 0.45, temp)*(1.0 - desert*0.8);
    // towns: a thresholded mid-scale noise picks out clusters, a fine one breaks them into points
    // No lights on the beach or on islets a pixel wide: the coastline is noisy at pixel scale and every stray
    // land pixel would light up as a spark.
    let inland = smoothstep(0.003, 0.024, e);
    // five scales, each fading to its mean before it would alias: regions, towns within them, districts, blocks
    // and single lights. Each multiplies the next, so the brightness is heavy-tailed: a few bright points in a
    // dim web, which is what a city looks like from orbit; fewer scales leave soft blobs.
    let f1 = sat(1.0/(fp*180.0) - 1.0); let fm = sat(1.0/(fp*520.0) - 1.0);
    let f2 = sat(1.0/(fp*1400.0) - 1.0); let f3 = sat(1.0/(fp*5200.0) - 1.0); let f4 = sat(1.0/(fp*18000.0) - 1.0);
    let c1 = mix(0.16, smoothstep(0.56, 0.86, vnoise(pl*90.0 + vec3f(sd))), f1);
    let cm = mix(0.30, smoothstep(0.52, 0.88, vnoise(pl*260.0 + vec3f(sd*5.0))), fm);
    let v2 = vnoise(pl*700.0 + vec3f(sd*3.0));
    let c2 = mix(0.16, v2*v2*v2*v2*2.6, f2);
    let v3 = vnoise(pl*2600.0 + vec3f(sd*11.0));
    let v6 = v3*v3*v3;
    let c3 = mix(0.14, v6*v6*7.0, f3);
    let v4 = vnoise(pl*9000.0 + vec3f(sd*17.0));
    let c4 = mix(0.27, v4*v4*v4*v4*2.5, f4);
    let lights = pop*inland*c1*(0.25 + 2.5*cm)*(0.04 + 1.3*c2 + 5.5*c2*c3)*(0.35 + 2.4*c4)*B.p1.z;
    col += vec3f(1.0, 0.70, 0.36)*(lights*fall(-0.06, 0.15, muS));
  }
  return col;
}
