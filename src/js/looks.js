// Art direction: how each body is drawn. Science lives in src/data/system.json; nothing here is shown as data.
// Everything is a starting value tuned by eye. Colours are linear RGB.
//
// Per body:
//   surf     surface shader: 'flat' | 'rock' | 'terra' | 'giant' | 'star'   (pipeline "solid_<surf>")
//   p0..p3   surface parameters and colA..colD palette; their meaning is documented at the top of src/surf_<surf>.wgsl
//   emissive ambient term for the placeholder surface
//   gain     stars: surface brightness when the disc fills the view (the scene raises it as the disc shrinks)
//   corona   type 'star' | 'pulsar' | 'comet', radius of the glow in body radii (0 = set by the generator),
//            glow [intensity, falloff exponent, streamer strength, streamer frequency], color, optional
//            core [flat core radius, close-up fade distance] in radii, loops colour, spinSeconds (animation clock)
//   tint     colour of the point sprite that stands in for the body when it is under a pixel; spriteFloor its minimum
//   atm      atmosphere: top / hR / hM in km, or topF / hRF / hMF as fractions of the radius;
//            g Mie asymmetry, bR Rayleigh beta (1/km), bM Mie beta (1/km), abs absorption (1/km), sky ground sky-light
//   ring     tau optical-depth scale, albedo rgb, dust forward-scattering fraction (radii come from system.json)
//   clouds   shell height above the surface (km)
//   storms   up to six [longitudeDeg, latitudeDeg, radiusDeg, strength, ...extras]: cyclones, vortices, active regions
//   aurora   tilt of the magnetic axis (deg), intensity, oval colatitude (deg), low / high colours, height (fraction of R)
//   layers   one MATERIALS name per interior layer of system.json, from the centre out: the colour of that layer
//            on the cutaway faces and of its swatch in the HUD
//   accent   CSS colour of the body's HUD panels
//   standKm  where the autopilot parks, in km from the centre, when the default of a few radii will not do
// Active regions of a star: [longitudeDeg, latitudeDeg, radiusDeg, flare level (animated), spot size, spot separation, seed]
const REGIONS = [
  [20, 14, 5.5, 0, 0.55, 0.9, 1.3], [95, -19, 4.5, 0, 0.5, 1.0, 4.1], [160, 23, 6.5, 0, 0.6, 0.85, 7.7],
  [215, -9, 4.0, 0, 0.5, 1.0, 2.9], [275, 17, 5.0, 0, 0.55, 0.95, 9.2], [330, -24, 6.0, 0, 0.6, 0.9, 5.5],
];

// Planetshine tints: roughly each planet's disc colour times its albedo.
const SHINE_PELAGIA = [0.20, 0.30, 0.46, 0], SHINE_BOREAS = [0.42, 0.33, 0.24, 0], SHINE_NIVALIS = [0.16, 0.26, 0.30, 0];

// Interior materials: c linear colour, e self-glow, p pattern [frequency, grain, flow speed, contrast], where grain
// runs from -1 (concentric shells) through 0 (none) to 1 (rays along the radius); see shadeCut in src/cut.wgsl.
// Hot and fluid layers glow and flow; cold solid ones are matte and still.
export const MATERIALS = {
  // rock and metal
  iron:        { c: [1.00, 0.88, 0.60], e: 1.10, p: [6.0, 0.70, 0.00, 0.30] },   // solid iron-nickel, the hottest thing in the planet: crystalline, still
  ironCold:    { c: [0.46, 0.43, 0.40], e: 0.03, p: [7.0, 0.30, 0.00, 0.35] },   // the cooled core of a small moon
  ironMolten:  { c: [0.95, 0.40, 0.08], e: 0.42, p: [6.0, 0.00, 0.16, 0.70] },   // liquid iron alloy, turbulent
  magma:       { c: [0.80, 0.20, 0.05], e: 0.55, p: [5.0, 0.45, 0.07, 0.75] },   // partly molten silicate
  silicate:    { c: [0.52, 0.17, 0.08], e: 0.22, p: [4.5, 0.50, 0.035, 0.65] },  // hot solid mantle, rising in slow plumes
  rock:        { c: [0.30, 0.24, 0.20], e: 0.02, p: [8.0, 0.15, 0.00, 0.55] },   // cold rocky interior
  basalt:      { c: [0.17, 0.15, 0.14], e: 0.00, p: [26, 0.0, 0.00, 0.50] },
  granite:     { c: [0.40, 0.34, 0.28], e: 0.00, p: [26, 0.0, 0.00, 0.50] },
  regolith:    { c: [0.46, 0.45, 0.43], e: 0.00, p: [26, 0.0, 0.00, 0.40] },
  sulfur:      { c: [0.78, 0.62, 0.16], e: 0.04, p: [20, 0.0, 0.00, 0.50] },
  // ices and water
  ocean:       { c: [0.04, 0.22, 0.52], e: 0.16, p: [9.0, -0.30, 0.12, 0.60] },
  ice:         { c: [0.72, 0.84, 0.94], e: 0.02, p: [10, 0.40, 0.00, 0.30] },
  dirtyIce:    { c: [0.36, 0.38, 0.40], e: 0.00, p: [18, 0.0, 0.00, 0.50] },
  iceRock:     { c: [0.40, 0.46, 0.55], e: 0.02, p: [7.0, 0.10, 0.00, 0.50] },
  rockIce:     { c: [0.38, 0.30, 0.26], e: 0.05, p: [6.0, 0.10, 0.00, 0.50] },
  nitrogenIce: { c: [0.84, 0.76, 0.70], e: 0.02, p: [18, 0.0, 0.00, 0.35] },
  cometCore:   { c: [0.30, 0.33, 0.38], e: 0.03, p: [14, 0.0, 0.00, 0.80] },
  cometDust:   { c: [0.09, 0.08, 0.07], e: 0.00, p: [26, 0.0, 0.00, 0.50] },
  // giant planets
  rockCore:    { c: [0.86, 0.48, 0.22], e: 0.70, p: [5.0, 0.30, 0.04, 0.50] },   // rock and ice at tens of thousands of K
  metallicH:   { c: [0.56, 0.62, 0.86], e: 0.40, p: [6.0, -0.55, 0.10, 0.55] },
  molecularH:  { c: [0.78, 0.62, 0.42], e: 0.08, p: [9.0, -0.80, 0.06, 0.50] },
  superionic:  { c: [0.16, 0.44, 0.80], e: 0.35, p: [5.0, -0.20, 0.07, 0.60] },  // hot dense water-ammonia fluid
  gasEnvelope: { c: [0.46, 0.76, 0.82], e: 0.06, p: [9.0, -0.80, 0.06, 0.45] },
  // stars
  fusion:      { c: [1.00, 0.95, 0.84], e: 1.60, p: [5.0, 0.00, 0.25, 0.45] },
  radiative:   { c: [1.00, 0.72, 0.28], e: 0.95, p: [4.0, 0.75, 0.05, 0.30] },
  convective:  { c: [1.00, 0.42, 0.11], e: 0.70, p: [8.0, 0.25, 0.40, 0.80] },
  dwarfFusion: { c: [1.00, 0.66, 0.34], e: 1.25, p: [5.0, 0.00, 0.22, 0.45] },
  dwarfConvective: { c: [0.92, 0.24, 0.06], e: 0.65, p: [7.0, 0.25, 0.32, 0.85] },
  blueCore:    { c: [1.00, 0.97, 0.92], e: 1.70, p: [5.0, 0.00, 0.25, 0.45] },
  blueEnvelope: { c: [0.26, 0.42, 1.00], e: 0.62, p: [4.0, 0.75, 0.06, 0.35] },
  blueWind:    { c: [0.40, 0.60, 0.95], e: 0.22, p: [12, 0.60, 0.45, 0.70] },
  // neutron star
  quark:       { c: [0.86, 0.46, 1.00], e: 1.40, p: [6.0, 0.00, 0.30, 0.60] },
  superfluid:  { c: [0.38, 0.50, 1.00], e: 0.95, p: [7.0, -0.40, 0.20, 0.50] },
  nuclearCrust: { c: [0.50, 0.80, 1.00], e: 0.55, p: [20, 0.0, 0.00, 0.50] },
  ironCrust:   { c: [0.86, 0.92, 1.00], e: 0.35, p: [28, 0.0, 0.00, 0.40] },
};

// The picture's tone curve, repeated here so a swatch is the colour its layer has on screen: the ACES fit and
// the sRGB encoding of fs_comp in src/post.wgsl. Start-up only.
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul3 = (m, v) => m.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export function toneMap(c) {
  const v = mul3(ACES_IN, c).map(x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  return mul3(ACES_OUT, v).map(x => { const l = Math.min(Math.max(x, 0), 1); return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; });
}

/**
 * CSS colour of a material's swatch in the HUD: what shadeCut (src/cut.wgsl) gives for the middle of the
 * pattern on a face half turned to the light, through the picture's tone curve.
 */
export function swatch(name) {
  const m = MATERIALS[name], k = 0.81 + 0.50 * m.e;
  const [r, g, b] = toneMap([m.c[0] * k, m.c[1] * k, m.c[2] * k]).map(v => Math.round(v * 255));
  return `rgb(${r},${g},${b})`;
}

export const LOOKS = {
  pharos: {
    layers: ['fusion', 'radiative', 'convective'], accent: '#ffd58a',
    surf: 'star', gain: 2.6, tint: [1.0, 0.95, 0.85],
    p0: [22, 0.46, 0.92, 0.5], p1: [2.6, 0.40, 4.0, 0.22],
    colA: [1.0, 0.80, 0.44, 0], colB: [1.0, 0.46, 0.10, 0], colC: [1.0, 0.56, 0.18, 0],
    storms: REGIONS,
    corona: { type: 'star', radius: 4.5, glow: [0.60, 6.0, 2.0, 5.0], color: [1.0, 0.88, 0.70], loops: [1.0, 0.66, 0.34] },
  },

  ignis: {
    layers: ['ironMolten', 'magma', 'basalt'], accent: '#ff7a3d',
    surf: 'rock',
    p0: [3.5, 0.030, 0.70, 0.30], p1: [1.0, 4.2, -0.10, 0], p2: [0.5, 1.0, 0, 0], p3: [0, 0.4, 0.30, 0],
    colA: [0.20, 0.16, 0.135, 0], colB: [0.075, 0.066, 0.062, 0], colC: [1.0, 0.33, 0.06, 3.4],
    atm: { top: 60, hR: 15, hM: 3, g: 0.7, bR: [2.0e-3, 1.5e-3, 1.0e-3], bM: 1.0e-3, abs: [0, 0, 0], sky: [0.03, 0.022, 0.016] },
  },

  pelagia: {
    layers: ['iron', 'ironMolten', 'silicate', 'granite'], accent: '#4fd6c4',
    surf: 'terra',
    p0: [1.7, 0.06, 0.47, 0], p1: [0.42, 0.90, 1.6, 0.20], p2: [0.02, 3.4, 5.2, 0.16],
    colA: [0.008, 0.035, 0.10, 0], colB: [0.03, 0.16, 0.22, 0], colC: [0.045, 0.10, 0.03, 0], colD: [0.42, 0.31, 0.18, 0],
    clouds: 9,
    storms: [[40, 38, 13, 1.5], [160, -42, 15, -1.6], [250, 50, 11, 1.3], [310, -30, 10, -1.2], [110, 18, 5, 2.2]],
    aurora: { tilt: 11, intensity: 0.55, colat: 19, low: [0.15, 1.0, 0.40], high: [0.70, 0.15, 0.55], height: 0.045 },
    atm: { top: 110, hR: 8.5, hM: 1.3, g: 0.78, bR: [5.8e-3, 13.5e-3, 33.1e-3], bM: 4.0e-3, abs: [1.2e-3, 3.5e-3, 0.16e-3], sky: [0.045, 0.075, 0.13] },
  },
  luma: {
    layers: ['ironCold', 'rock', 'regolith'], accent: '#c9d2dc',
    surf: 'rock',
    p0: [4.0, 0.012, 1.0, 0.32], p2: [0.9, 1.0, 0, 0], p3: [1.0, 0.6, 0.25, 0],
    colA: [0.36, 0.35, 0.33, 0], colB: [0.13, 0.13, 0.135, 0], colD: SHINE_PELAGIA,
  },

  boreas: {
    layers: ['rockCore', 'metallicH', 'molecularH'], accent: '#f0b25a',
    surf: 'giant',
    p0: [21, 1.5, 0.50, 1.0], p1: [9, 0.05, 0.8, 0.30], p3: [0, 0, 0, 0.9],
    colA: [0.86, 0.80, 0.68, 0], colB: [0.55, 0.36, 0.22, 0], colC: [0.70, 0.30, 0.16, 0], colD: [0.40, 0.42, 0.50, 0],
    storms: [[200, -22, 8, 2.6, 0.9, 1.05, 0], [130, -33, 3.2, -2.2, 0.85, 1.25, 0.85], [80, -34, 2.6, -2.2, 0.8, 1.2, 0.85],
             [300, 14, 3.0, 2.0, 0.75, 0.6, 0], [20, 40, 2.4, 1.8, 0.75, 1.2, 0.8], [250, -52, 2.2, -1.8, 0.7, 1.15, 0.7]],
    aurora: { tilt: 9, intensity: 0.5, colat: 14, low: [0.25, 0.45, 1.0], high: [0.70, 0.30, 0.90], height: 0.03 },
    atm: { topF: 0.03, hRF: 0.004, hMF: 0.001, g: 0.7, bR: [1.5e-4, 2.6e-4, 4.8e-4], bM: 4.0e-5, abs: [0, 0, 0], sky: [0.02, 0.03, 0.045] },
  },
  pyre: {
    layers: ['iron', 'magma', 'sulfur'], accent: '#f2cf4f',
    surf: 'rock',
    p0: [3.0, 0.008, 0.08, 0.20], p2: [0, 0.6, 0, 1.0], p3: [1.0, 0.3, 0.20, 0],
    colA: [0.80, 0.68, 0.25, 0], colB: [0.75, 0.38, 0.12, 0], colC: [1.0, 0.35, 0.08, 4.0], colD: SHINE_BOREAS,
  },
  rime: {
    layers: ['iron', 'rock', 'ocean', 'ice'], accent: '#bfe0ff',
    surf: 'rock',
    p0: [5.0, 0.004, 0.15, 0.12], p1: [0, 0, 0, 0.85], p2: [0.3, 0.5, 0, 0], p3: [1.0, 0.15, 0.10, 6.0],
    colA: [0.86, 0.90, 0.94, 0], colB: [0.70, 0.76, 0.84, 0], colC: [0.42, 0.24, 0.17, 0], colD: SHINE_BOREAS,
  },
  slate: {
    layers: ['rockIce', 'iceRock', 'dirtyIce'], accent: '#b9b4ae',
    surf: 'rock',
    p0: [4.0, 0.012, 1.0, 0.34], p2: [0.4, 1.0, 0, 0], p3: [1.0, 0.6, 0.25, 0],
    colA: [0.24, 0.23, 0.22, 0], colB: [0.14, 0.135, 0.13, 0], colD: SHINE_BOREAS,
  },

  nivalis: {
    layers: ['rockCore', 'superionic', 'gasEnvelope'], accent: '#9be8f2',
    surf: 'giant',
    p0: [11, 0.55, 0.35, 0.6], p1: [7, 0.16, 0.6, 0.45], p3: [0, 0, 0, 0.9],
    colA: [0.50, 0.76, 0.84, 0], colB: [0.36, 0.62, 0.78, 0], colC: [0.07, 0.16, 0.36, 0], colD: [0.42, 0.66, 0.74, 0],
    storms: [[150, -24, 7, -1.6, 0.8, 1.0, 0], [260, 38, 3, 1.5, 0.7, 1.0, 0], [165, -33, 2.0, -1.2, 0.8, 1.3, 1.0]],
    atm: { topF: 0.03, hRF: 0.004, hMF: 0.001, g: 0.7, bR: [3.5e-4, 9.5e-4, 1.4e-3], bM: 1.0e-4, abs: [0, 0, 0], sky: [0.015, 0.035, 0.045] },
    ring: { tau: 1.3, albedo: [0.86, 0.82, 0.76], dust: 0.3 },
  },
  firn: {
    layers: ['rock', 'ice'], accent: '#e2efff',
    surf: 'rock',
    p0: [4.0, 0.006, 0.60, 0.20], p1: [0, 0, 0, 0.5], p2: [0.3, 0.7, 0, 0], p3: [1.0, 0.15, 0.10, 5.0],
    colA: [0.90, 0.93, 0.96, 0], colB: [0.78, 0.83, 0.90, 0], colC: [0.55, 0.62, 0.72, 0], colD: SHINE_NIVALIS,
  },
  neve: {
    layers: ['rock', 'ice'], accent: '#c6d6ea',
    surf: 'rock',
    p0: [4.5, 0.010, 0.90, 0.26], p2: [0.5, 0.8, 0, 0], p3: [1.0, 0.2, 0.15, 0],
    colA: [0.74, 0.78, 0.84, 0], colB: [0.50, 0.54, 0.60, 0], colD: SHINE_NIVALIS,
  },
  serac: {
    layers: ['rock', 'ice', 'nitrogenIce'], accent: '#dccbc0',
    surf: 'rock',
    p0: [3.5, 0.016, 0.90, 0.30], p2: [0.6, 1.0, 0.15, 0], p3: [1.0, 0.5, 0.25, 0],
    colA: [0.52, 0.50, 0.50, 0], colB: [0.33, 0.30, 0.29, 0], colD: SHINE_NIVALIS,
  },

  wayfarer: {
    layers: ['cometCore', 'cometDust'], accent: '#a8dcff', standKm: 2.4e6,
    surf: 'rock',
    p0: [2.2, 0.080, 0.50, 0.30], p2: [0.3, 1.0, 0, 0], p3: [0, 0.7, 0.30, 0],
    colA: [0.060, 0.055, 0.050, 0], colB: [0.035, 0.032, 0.030, 0],
    tint: [0.80, 0.90, 1.0], spriteFloor: 0.9,
    // coma: flat inside about 40,000 km, thinning as the camera enters it; the generator sets the bound to cover the tails
    corona: { type: 'comet', radius: 0, glow: [0.50, 1.6, 0.0, 2.0], core: [9000, 4000], color: [0.62, 0.95, 0.86] },
  },

  cinnabar: {
    layers: ['dwarfFusion', 'dwarfConvective'], accent: '#ff7350',
    surf: 'star', gain: 2.0, tint: [1.0, 0.50, 0.22],
    p0: [9, 0.5, 0.92, 0.35], p1: [2.0, 0.50, 5.0, 0.35],
    colA: [1.0, 0.45, 0.16, 0], colB: [0.8, 0.20, 0.05, 0], colC: [0.7, 0.12, 0.03, 0],
    storms: [[30, 20, 12, 0, 0.6, 0.8, 2.2], [130, -30, 10, 0, 0.6, 0.9, 6.1], [220, 8, 13, 0, 0.65, 0.8, 8.8], [310, -15, 9, 0, 0.55, 0.9, 3.4]],
    corona: { type: 'star', radius: 4, glow: [0.50, 6.2, 1.8, 6.0], color: [1.0, 0.60, 0.38], loops: [1.0, 0.42, 0.18] },
  },
  caerulea: {
    layers: ['blueCore', 'blueEnvelope', 'blueWind'], accent: '#8fb8ff',
    surf: 'star', gain: 2.0, tint: [0.70, 0.82, 1.0],
    p0: [11, 0.36, 0, 0.2], p1: [2.0, 0.55, 0, 0.45],
    colA: [0.60, 0.74, 1.0, 0], colB: [0.38, 0.54, 1.0, 0], colC: [0.34, 0.46, 1.0, 0],
    corona: { type: 'star', radius: 5, glow: [0.46, 4.6, 1.2, 5.0], color: [0.52, 0.68, 1.0] },
  },
  'dioscuri-a': {
    layers: ['fusion', 'radiative', 'convective'], accent: '#ffeec9',
    surf: 'star', gain: 2.5, tint: [1.0, 0.97, 0.92],
    p0: [20, 0.42, 0.90, 0.6], p1: [2.5, 0.38, 4.0, 0.22],
    colA: [1.0, 0.90, 0.62, 0], colB: [1.0, 0.50, 0.16, 0], colC: [1.0, 0.55, 0.20, 0],
    storms: REGIONS.slice(0, 4),
    corona: { type: 'star', radius: 4, glow: [0.58, 6.0, 1.9, 7.0], color: [1.0, 0.92, 0.78], loops: [1.0, 0.80, 0.55] },
  },
  'dioscuri-b': {
    layers: ['dwarfFusion', 'radiative', 'convective'], accent: '#ffb070',
    surf: 'star', gain: 2.2, tint: [1.0, 0.72, 0.42],
    p0: [15, 0.46, 0.92, 0.45], p1: [2.2, 0.45, 4.5, 0.30],
    colA: [1.0, 0.62, 0.24, 0], colB: [0.90, 0.26, 0.05, 0], colC: [0.9, 0.24, 0.05, 0],
    storms: [[60, 25, 8, 0, 0.6, 0.9, 1.9], [150, -18, 9, 0, 0.6, 0.85, 5.0], [240, 12, 7, 0, 0.55, 0.9, 7.3], [320, -28, 8, 0, 0.6, 0.9, 3.8]],
    corona: { type: 'star', radius: 4, glow: [0.52, 6.0, 1.8, 6.0], color: [1.0, 0.72, 0.48], loops: [1.0, 0.58, 0.28] },
  },
  metronome: {
    layers: ['quark', 'superfluid', 'nuclearCrust', 'ironCrust'], accent: '#b9c8ff',
    surf: 'star', gain: 1.6, tint: [0.75, 0.85, 1.0],
    p0: [30, 0.08, 0, 2.0], p1: [1.6, 0.3, 3.0, 0.15],
    colA: [0.78, 0.86, 1.0, 0], colB: [0.60, 0.70, 1.0, 0], colC: [0.50, 0.60, 1.0, 0],
    // the two magnetic poles: permanently "flaring" hot caps; the first one is the beam axis
    storms: [[0, 55, 14, 1, 0.001, 0, 1], [180, -55, 14, 1, 0.001, 0, 2]],
    corona: { type: 'pulsar', radius: 80, glow: [0.6, 2.2, 0.5, 2.0], color: [0.60, 0.72, 1.0], spinSeconds: 1.337 },
  },
};
