// Shared code for every spherical body drawn as a ray-traced impostor.
// Per-body uniform block: 55 vec4f = 880 bytes; one 1024-byte slot per body. src/js/layout.js mirrors the
// field order and test/layout.test.mjs checks the two against each other.
struct Body {
  center: vec4f,           //  0 xyz camera-relative centre (km), w solid radius (km)
  rot0: vec4f,             //  1 world->local rotation row 0, w seed
  rot1: vec4f,             //  2 row 1 (spin axis)
  rot2: vec4f,             //  3 row 2
  sun: vec4f,              //  4 xyz unit direction to the star, w star angular radius (rad)
  sunCol: vec4f,           //  5 rgb sunlight (white surface facing the star = 1), w ambient
  p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f,          //  6-9  surface-type parameters
  colA: vec4f, colB: vec4f, colC: vec4f, colD: vec4f,  // 10-13 palette
  atm0: vec4f,             // 14 top radius (km), Rayleigh scale height (km), Mie scale height (km), Mie g
  atm1: vec4f,             // 15 rgb Rayleigh beta (1/km), w Mie beta (1/km)
  atm2: vec4f,             // 16 rgb absorption on the Rayleigh column (1/km), w atmosphere strength 0..1
  atm3: vec4f,             // 17 rgb sky light on the ground (fraction of sunlight), w sample scale k (km)
  ring0: vec4f,            // 18 xyz ring normal (world), w inner radius (km)
  ring1: vec4f,            // 19 outer radius (km), optical-depth scale, seed, enabled (0/1)
  ring2: vec4f,            // 20 rgb ring albedo, w forward-scattering dust fraction
  occ: array<vec4f, 4>,    // 21-24 occluders: xyz relative to this body's centre (km), w radius (0 = unused)
  cut0: vec4f,             // 25 world->cut row 0, w cut offset a (1 = closed .. 0 = open to the centre)
  cut1: vec4f,             // 26 row 1, w hovered layer (-1 = none)
  cut2: vec4f,             // 27 row 2, w unused
  layR: vec4f,             // 28 outer radius fraction of layers 0..3 (layer 4 ends at 1)
  layC: array<vec4f, 5>,   // 29-33 rgb, w emissive
  layP: array<vec4f, 5>,   // 34-38 radial freq, tangential freq, speed, contrast
  aur: vec4f,              // 39 xyz magnetic axis (local), w intensity
  aurA: vec4f,             // 40 rgb low colour, w oval colatitude (rad)
  aurB: vec4f,             // 41 rgb high colour, w top height (fraction of R)
  st: array<vec4f, 6>,     // 42-47 storms / active regions: xyz unit (local), w angular radius
  sx: array<vec4f, 6>,     // 48-53 per-storm extras
  bnd: vec4f,              // 54 impostor bounding radii (km): solid, cloud shell, atmosphere, corona
}
@group(1) @binding(0) var<uniform> B: Body;

struct VB { @builtin(position) pos: vec4f }
struct FOut { @location(0) c: vec4f, @builtin(frag_depth) d: f32 }

// Quad that tightly bounds the sphere of radius B.bnd[instance_index]; full screen when the camera is close.
// Draw 4 vertices as a triangle strip, cullMode none; firstInstance selects which bounding radius.
@vertex fn vs_body(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VB {
  let c = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u))*2.0 - 1.0;
  let C = B.center.xyz;
  let Rb = B.bnd[ii];
  let d2 = dot(C, C);
  var o: VB;
  if (d2 < Rb*Rb*2.6) { o.pos = vec4f(c, 0.5, 1.0); return o; }
  let d = sqrt(d2);
  let s2 = Rb*Rb/d2;
  let cd = C/d;
  var ax = vec3f(0.0, 1.0, 0.0);
  if (abs(cd.y) > 0.9) { ax = vec3f(1.0, 0.0, 0.0); }
  let a = normalize(cross(cd, ax));
  let b = cross(a, cd);
  let h = Rb*sqrt(1.0 - s2)*1.03 + d*G.time.y*2.0;
  let P = C*(1.0 - s2) + (a*c.x + b*c.y)*h;
  let v = toView(P);
  o.pos = vec4f(v.x/G.right.w, v.y/G.up.w, 0.5*v.z, v.z);
  return o;
}

fn toLocal(v: vec3f) -> vec3f { return vec3f(dot(B.rot0.xyz, v), dot(B.rot1.xyz, v), dot(B.rot2.xyz, v)); }
fn toWorld(v: vec3f) -> vec3f { return B.rot0.xyz*v.x + B.rot1.xyz*v.y + B.rot2.xyz*v.z; }
fn cutLocal(v: vec3f) -> vec3f { return vec3f(dot(B.cut0.xyz, v), dot(B.cut1.xyz, v), dot(B.cut2.xyz, v)); }
fn cutWorld(v: vec3f) -> vec3f { return B.cut0.xyz*v.x + B.cut1.xyz*v.y + B.cut2.xyz*v.z; }

// Soft shadow of sphere oc on point p for a star of angular radius sa in direction L.
// p and oc.xyz are both relative to the body centre. Handles umbra, penumbra and annular eclipses.
fn eclipse(p: vec3f, L: vec3f, oc: vec4f, sa: f32) -> f32 {
  if (oc.w <= 0.0) { return 1.0; }
  let v = oc.xyz - p;
  let tca = dot(v, L);
  if (tca <= 0.0) { return 1.0; }
  let d = sqrt(max(dot(v, v) - tca*tca, 0.0));
  let ro = oc.w/tca;
  let rs = d/tca;
  let md = min(1.0, (ro*ro)/(sa*sa));
  let e = smoothstep(abs(ro - sa), ro + sa, rs);
  return 1.0 - md*(1.0 - e);
}
// Sunlight left at point p (relative to the body centre) after the body's occluders.
fn occluders(p: vec3f) -> f32 {
  var s = 1.0;
  for (var i = 0; i < 4; i++) { s *= eclipse(p, B.sun.xyz, B.occ[i], B.sun.w); }
  return s;
}

// Ring profile at radius r (planet radii), filtered to width fw (planet radii): x = optical depth,
// y = brightness modulation of the particles (mean 1). From the inside out: a faint translucent ring, a dense
// grooved main ring, a nearly empty division, a thinner outer ring with one narrow gap, and a thread at the edge.
// Ringlets whose wavelength approaches the filter width fade to their mean, so rings never alias.
fn ringProfile(r: f32, fw: f32) -> vec2f {
  let ri = B.ring0.w/B.center.w;
  let ro = B.ring1.x/B.center.w;
  let x = (r - ri)/(ro - ri);
  if (B.ring1.w < 0.5 || x <= 0.0 || x >= 1.0) { return vec2f(0.0, 1.0); }
  let w = fw/(ro - ri);
  let e = 0.004 + w;                                   // softness of every edge: at least a pixel
  let sd = B.ring1.z;
  let inner = smoothstep(0.0, 0.03 + w, x)*fall(0.175 - e, 0.175 + e, x);
  let main = smoothstep(0.175 - e, 0.175 + e, x)*fall(0.585 - e, 0.585 + e, x);
  let gap = smoothstep(0.585 - e, 0.585 + e, x)*fall(0.635 - e, 0.635 + e, x);
  let outer = smoothstep(0.635 - e, 0.635 + e, x)*fall(0.945 - e, 0.945 + e, x)
            *(1.0 - 0.93*fall(0.004, 0.004 + e, abs(x - 0.865)));
  let thread = fall(0.003, 0.003 + e, abs(x - 0.982))*(0.006/(0.006 + w));
  var tau = inner*0.11 + main*(1.0 + 1.5*smoothstep(0.2, 0.55, x)) + gap*0.05 + outer*0.50 + thread*0.35;
  var alb = 1.0;
  // Ringlets at ten scales, an octave apart, with a nearly flat spectrum: seen close, a ring is ringlets within
  // ringlets, as distinct at the finest scale as at the coarsest. Each scale fades to its mean as its
  // wavelength nears two pixels, and has crisp edges only where those can be resolved too (three times that).
  var f = 9.0; var a = 0.36;
  for (var k = 0; k < 10; k++) {
    let fade = sat(1.25 - w*f*3.4);
    if (fade <= 0.0) { break; }
    let crisp = 1.0 + 2.0*sat(1.25 - w*f*10.0);
    let n = clamp((n1(x*f + sd + f32(k)*17.3)*2.0 - 1.0)*crisp, -1.0, 1.0);
    tau *= 1.0 + a*fade*n;
    // the dense ring is opaque, so its ringlets show as brightness, not as gaps: the particles of each differ
    let m = clamp((n1(x*f*1.7 + sd*2.0 + f32(k)*7.1)*2.0 - 1.0)*crisp, -1.0, 1.0);
    alb += 0.45*a*sat(1.25 - w*f*5.8)*m;
    f *= 2.0; a *= 0.93;
  }
  return vec2f(max(tau, 0.0)*B.ring1.y, max(alb, 0.3));
}
fn ringTau(r: f32, fw: f32) -> f32 { return ringProfile(r, fw).x; }
// Sunlight left after crossing the ring plane on the way to point pw (relative to the planet centre).
fn ringShadow(pw: vec3f, fw: f32) -> f32 {
  if (B.ring1.w < 0.5) { return 1.0; }
  let n = B.ring0.xyz;
  let dn = dot(B.sun.xyz, n);
  if (abs(dn) < 1e-4) { return 1.0; }
  let t = -dot(pw, n)/dn;
  if (t <= 0.0) { return 1.0; }
  let q = pw + B.sun.xyz*t;
  return exp(-ringTau(length(q)/B.center.w, fw)/abs(dn));
}

// Chapman grazing-incidence function, interpolation exact at 0 and 90 degrees (after Schueler, GPU Pro 3).
fn chapH(x: f32, mu: f32) -> f32 { let c = sqrt(1.5707963*x); return c/((c - 1.0)*mu + 1.0); }
// Column density (km) of an exponential atmosphere of scale height H above radius R0, from radius r along a
// direction with zenith cosine mu. rho must be exp((R0 - r)/H): callers usually have it already.
fn columnRho(r: f32, mu: f32, H: f32, R0: f32, rho: f32) -> f32 {
  let x = r/H;
  if (mu >= 0.0) { return H*rho*chapH(x, mu); }
  let rt = r*sqrt(max(1.0 - mu*mu, 0.0));
  let rhot = exp(min((R0 - rt)/H, 40.0));
  return H*max(2.0*rhot*sqrt(1.5707963*rt/H) - rho*chapH(x, -mu), 0.0);
}
fn column(r: f32, mu: f32, H: f32, R0: f32) -> f32 { return columnRho(r, mu, H, R0, exp(min((R0 - r)/H, 40.0))); }
// Colour of sunlight reaching radius r where the star's zenith cosine is muS (reddens at the terminator).
// Returns white for a body with no atmosphere (strength 0).
fn sunTrans(r: f32, muS: f32) -> vec3f {
  if (B.atm2.w <= 0.0) { return vec3f(1.0); }
  let R0 = B.center.w;
  let cR = column(r, muS, B.atm0.y, R0);
  let cM = column(r, muS, B.atm0.z, R0);
  let T = exp(-(B.atm1.xyz + B.atm2.xyz)*cR - vec3f(B.atm1.w*1.1*cM));
  return mix(vec3f(1.0), T, B.atm2.w);
}
// Sunlight arriving at ground level: direct light through the air, the body's shadow casters, ring shadow.
// pw = surface point relative to the centre, muS = cosine of the star's zenith angle there.
// It does NOT include the surface's own cosine term, so each surface applies its own reflectance model.
// The star is a disc, so the terminator is a ramp one angular diameter wide rather than a hard edge.
fn sunAt(pw: vec3f, muS: f32, fp: f32) -> vec3f {
  let sa = max(B.sun.w, 0.004);
  if (muS <= -sa) { return vec3f(0.0); }
  return B.sunCol.rgb*sunTrans(B.center.w, muS)*(smoothstep(-sa, sa, muS)*occluders(pw)*ringShadow(pw, fp*2.0));
}
fn groundLight(pw: vec3f, muS: f32, fp: f32) -> vec3f { return sunAt(pw, muS, fp)*max(muS, 0.0); }
// Diffuse light from the sky dome on the ground; lingers a little past the terminator (twilight).
fn skyLight(muS: f32) -> vec3f {
  return B.sunCol.rgb*B.atm3.rgb*(B.atm2.w*smoothstep(-0.18, 0.35, muS));
}
