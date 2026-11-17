// Nebula bake: one cubemap face (or a scissored tile of one) per draw, at start-up only.
// The face is selected through the ordinary Globals block: right/up/fwd hold the face basis with unit
// tangents, res the face size, so rayDir() gives the direction of each texel. vel.xyz = galactic pole,
// aux.xyz = direction of the galactic centre.
//
// Per texel: march through a warped noise volume, accumulating emission front to back (red hydrogen and teal
// oxygen, tinted by a second noise), blue-white light scattered from a few embedded stars, and absorption by
// dust. A faint galactic band with dark rifts goes behind it.
const NEB_STEPS = 60;

// centres (xyz) and radii (w) of the cloud complexes, in march units; the camera sits at the origin
const NEB_C1 = vec4f(-2.6, 0.9, -2.4, 1.55);
const NEB_C2 = vec4f(2.9, -1.3, 1.6, 1.10);
const NEB_C3 = vec4f(0.6, 2.9, 2.6, 0.85);

fn nebEnvelope(p: vec3f) -> f32 {
  let a = p - NEB_C1.xyz; let b = p - NEB_C2.xyz; let c = p - NEB_C3.xyz;
  return exp(-dot(a, a)/(NEB_C1.w*NEB_C1.w)) + 0.7*exp(-dot(b, b)/(NEB_C2.w*NEB_C2.w)) + 0.5*exp(-dot(c, c)/(NEB_C3.w*NEB_C3.w));
}

// x = glowing gas, y = dust, z = tint selector 0..1
fn nebDensity(p: vec3f) -> vec3f {
  let env = nebEnvelope(p);
  if (env < 0.004) { return vec3f(0.0); }
  let q = p + warp3(p*0.6)*1.9 + warp3(p*1.7 + vec3f(4.0))*0.6;
  let n = fbm(q*0.85, 5.0);
  let ridge = 1.0 - abs(2.0*fbm(q*1.6 + vec3f(9.0), 5.0) - 1.0);     // filaments and shock fronts
  let gas = max(0.62*n + 0.55*ridge*ridge - 0.40, 0.0)*env;
  let dust = max(fbm(q*1.25 + vec3f(21.0), 5.0) - 0.47, 0.0)*(env*1.6 + 0.004);
  return vec3f(gas, dust, fbm(q*0.5 + vec3f(33.0), 3.0));
}

// Diffuse light of the unresolved disc stars: a band along the galactic equator, brighter and thicker towards
// the centre, broken by dark rifts.
fn galacticBand(d: vec3f) -> vec3f {
  let gn = G.vel.xyz; let gc = G.aux.xyz;
  let lat = asin(clamp(dot(d, gn), -1.0, 1.0));
  let toC = dot(normalize(d - gn*dot(d, gn) + vec3f(1e-5)), gc);          // 1 towards the centre, -1 away
  let bulge = smoothstep(0.2, 1.0, toC);
  let width = 0.10 + 0.13*bulge*bulge;
  let rift = fbm(d*4.2 + warp3(d*2.0)*1.4, 6.0);
  let lane = smoothstep(0.38, 0.74, rift)*exp(-lat*lat/(0.05*0.05 + 0.02*bulge))*0.72;
  let glow = exp(-lat*lat/(width*width))*(0.35 + 0.65*smoothstep(-0.6, 1.0, toC))
           + 0.9*bulge*bulge*exp(-lat*lat/0.05);
  let grain = 0.86 + 0.28*fbm(d*23.0, 4.0);
  // warm towards the galactic centre, cooler along the outer disc; dust lanes redden what shows through them
  let tint = mix(vec3f(0.74, 0.82, 1.0), vec3f(1.0, 0.84, 0.64), smoothstep(-0.2, 0.9, toC))*mix(vec3f(1.0), vec3f(1.0, 0.72, 0.52), lane);
  return tint*(glow*(1.0 - lane)*grain*0.115) + vec3f(0.0035, 0.0045, 0.008);
}

@fragment fn fs_nebula(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let d = rayDir(fc.xy);
  // embedded stars that light the dust: xyz position, w brightness
  let L1 = vec4f(-2.3, 1.1, -2.0, 0.55); let L2 = vec4f(-3.2, 0.3, -2.9, 0.4); let L3 = vec4f(2.7, -1.2, 1.5, 0.5);
  var col = vec3f(0.0); var T = 1.0;
  let dt = 6.4/f32(NEB_STEPS);
  // No per-texel jitter: the cubemap is magnified several times on screen, which would turn any noise in the
  // ray start into a visible weave. The step count is high enough that the shells do not show instead.
  let jitter = 0.5;
  for (var i = 0; i < NEB_STEPS; i++) {
    let p = d*(0.5 + (f32(i) + jitter)*dt);
    let m = nebDensity(p);
    if (m.x + m.y <= 0.0) { continue; }
    let hot = smoothstep(0.38, 0.62, m.z);
    let emis = mix(vec3f(1.0, 0.16, 0.10), vec3f(0.10, 0.72, 0.68), hot)*(m.x*0.85);
    let a = p - L1.xyz; let b = p - L2.xyz; let c = p - L3.xyz;
    let lit = L1.w/(dot(a, a) + 0.05) + L2.w/(dot(b, b) + 0.05) + L3.w/(dot(c, c) + 0.05);
    let scat = vec3f(0.42, 0.56, 1.0)*(m.y*lit*0.5);
    col += (emis + scat)*(T*dt);
    T *= exp(-m.y*5.5*dt);
    if (T < 0.01) { break; }
  }
  col += galacticBand(d)*T;
  return vec4f(col, 1.0);
}
