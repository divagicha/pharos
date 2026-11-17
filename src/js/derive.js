// Quantities derived from the base parameters in src/data/system.json. Pure functions, no DOM or GPU:
// the simulation, the HUD and tools/derive.mjs all call these, so displayed numbers cannot contradict the motion.
// `K` is the "constants" object of system.json. Units: km, kg, s unless a name says otherwise.

export const DAY = 86400;
export const YEAR = 365.25 * DAY;

/** Mass in kg, or null when the data gives none (the comet). */
export function massKg(b, K) {
  if (b.massSun != null) return b.massSun * K.Msun_kg;
  if (b.massJup != null) return b.massJup * K.Mjup_kg;
  if (b.massEarth != null) return b.massEarth * K.Mearth_kg;
  return b.massKg ?? null;
}
export function radiusKm(b, K) {
  if (b.radiusSun != null) return b.radiusSun * K.Rsun_km;
  if (b.radiusJup != null) return b.radiusJup * K.Rjup_km;
  if (b.radiusEarth != null) return b.radiusEarth * K.Rearth_km;
  return b.radiusKm;
}
/** Bolometric luminosity in solar units from radius and effective temperature (Stefan-Boltzmann). */
export function lumSun(b, K) { return (radiusKm(b, K) / K.Rsun_km) ** 2 * (b.teffK / K.Tsun_K) ** 4; }
/** Kepler's third law: period (s) of a relative orbit of semi-major axis aKm about total mass mTotKg. */
export function periodS(aKm, mTotKg, K) { return 2 * Math.PI * Math.sqrt(aKm ** 3 / (K.G_km3_kg_s2 * mTotKg)); }
/** Semi-major axis in km from whichever form the orbit record uses. */
export function semiMajorKm(o, K) { return o.aKm ?? (o.aAU != null ? o.aAU * K.AU_km : o.qAU / (1 - o.e) * K.AU_km); }
export function gravityMs2(M, R, K) { return K.G_km3_kg_s2 * M / (R * R) * 1000; }
export function densityGcm3(M, R) { return M / (4 / 3 * Math.PI * R ** 3) * 1e-12; }
export function escapeKms(M, R, K) { return Math.sqrt(2 * K.G_km3_kg_s2 * M / R); }
export function absMagBol(L) { return 4.74 - 2.5 * Math.log10(L); }
/**
 * Equilibrium temperature (K) of a fast rotator of Bond albedo `albedo` at distance dKm from a star
 * of radius RstarKm and effective temperature teffK.
 */
export function equilibriumK(teffK, RstarKm, dKm, albedo) { return teffK * Math.sqrt(RstarKm / (2 * dKm)) * (1 - albedo) ** 0.25; }
/** Distance from the star at true anomaly nu (rad) on an orbit of semi-major axis a and eccentricity e. */
export function orbitRadius(a, e, nu) { return a * (1 - e * e) / (1 + e * Math.cos(nu)); }

/**
 * Solve Kepler's equation E - e sin E = M for the eccentric anomaly E (radians), 0 <= e < 1.
 * Fixed work per call (no data-dependent loop in the frame path): a starter followed by six Halley steps.
 * For eccentric orbits the starter is the exact root of the equation with sin E replaced by its cubic,
 * e E^3/6 + (1-e) E = M, which is what keeps a near-parabolic comet stable right at periapsis.
 * The unit tests check the residual over a grid up to e = 0.97.
 */
export function solveKepler(M, e) {
  M -= 2 * Math.PI * Math.floor((M + Math.PI) / (2 * Math.PI));          // wrap to [-pi, pi)
  const sign = M < 0 ? -1 : 1, m = M * sign;
  let E;
  if (e < 0.3) {
    E = m + e * Math.sin(m);
  } else {
    const a = 2 * (1 - e) / e, b = 3 * m / e;                             // E^3 + 3aE - 2b = 0
    const c = Math.cbrt(b + Math.sqrt(b * b + a * a * a));
    E = Math.min(c - a / c, Math.PI);
  }
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(E), co = Math.cos(E);
    const f = E - e * s - m, f1 = 1 - e * co;
    E -= f / (f1 - 0.5 * f * e * s / f1);
  }
  return E * sign;
}
