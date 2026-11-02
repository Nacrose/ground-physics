/**
 * rwengine → game port: soil texture tables & engine constants.
 * Values are lifted verbatim from rwengine/config.py (Clapp & Hornberger 1978 /
 * Cosby et al. 1984 pedotransfer + textbook geotechnics) so the 3D world
 * wets, ponds and turns to mud with the same numbers as the reference model.
 */

export interface SoilTexture {
  key: string;
  label: string;
  sand: number;
  silt: number;
  clay: number;
  thetaS: number; // porosity [-]
  psiSmm: number; // air-entry suction head [mm H2O]
  b: number; // Clapp-Hornberger exponent
  kSatMmH: number; // saturated conductivity [mm/h]
  phiDeg: number; // Mohr-Coulomb friction angle [deg]
  cEffKpa: number; // effective cohesion [kPa]
  LL: number; // Atterberg liquid limit [gravimetric %]
  PL: number; // plastic limit [%]
  relDens: number; // relative density Dr
  // derived (Clapp-Hornberger retention @ 33 kPa / 1500 kPa)
  thetaFc: number;
  thetaWp: number;
  phiEff: number;
  rhoDry: number; // kg/m3
  gammaDry: number; // kN/m3
}

function makeTexture(
  key: string,
  label: string,
  sand: number,
  silt: number,
  clay: number,
  thetaS: number,
  psiSmm: number,
  b: number,
  kSatMmH: number,
  phiDeg: number,
  cEffKpa: number,
  LL: number,
  PL: number,
  relDens: number,
): SoilTexture {
  const thetaFc = thetaS * Math.pow(psiSmm / 3367.0, 1.0 / b);
  const thetaWp = thetaS * Math.pow(psiSmm / 153000.0, 1.0 / b);
  const phiEff = phiDeg + 8.0 * (relDens - 0.5);
  const rhoDry = 2650.0 * (1.0 - thetaS);
  return {
    key, label, sand, silt, clay, thetaS, psiSmm, b, kSatMmH,
    phiDeg, cEffKpa, LL, PL, relDens,
    thetaFc, thetaWp, phiEff, rhoDry, gammaDry: rhoDry * 9.81e-3,
  };
}

/** Texture order: 0 upland sand, 1 slopes loam, 2 valley clay, 3 desert dune
 *  sand, 4 swamp muck, 5 river gravel. The first three match rwengine
 *  exactly; the new ones extend the same pedotransfer so the biomes wet and
 *  fail consistently. */
export const SOIL_TEXTURES: SoilTexture[] = [
  makeTexture("sandy_loam", "Sandy loam", 65, 25, 10, 0.435, 218.0, 4.9, 25.9, 32.0, 3.0, 21.0, 13.0, 0.6),
  makeTexture("loam", "Loam", 40, 42, 18, 0.451, 478.0, 5.25, 13.0, 28.0, 8.0, 27.0, 18.0, 0.5),
  makeTexture("silty_clay_loam", "Silty clay loam", 15, 55, 30, 0.5, 356.0, 7.75, 3.4, 24.0, 15.0, 32.0, 20.0, 0.4),
  // desert dune sand: drains fast, barely cohesive, never really muds — the
  // one soil you can always cross (loose, but always crossable)
  makeTexture("dune_sand", "Dune sand", 92, 5, 3, 0.395, 70.0, 3.5, 105.0, 31.0, 0.4, 15.0, 5.0, 0.45),
  // swamp muck: organic, porous, weak — saturated soup with a huge liquid
  // limit; the deepest mud in the world lives here
  makeTexture("muck", "Muck", 18, 47, 35, 0.62, 420.0, 9.0, 1.2, 21.0, 4.0, 60.0, 30.0, 0.3),
  // river gravel: channel bars and gorge beds — friction-only, drains at
  // 310 mm/h so RAIN alone can never mud it (only submersion can), and the
  // one material that gets STRONGER under your boots, not weaker
  makeTexture("gravel", "Gravel", 82, 12, 6, 0.40, 60.0, 2.7, 310.0, 35.0, 0.5, 18.0, 9.0, 0.7),
];

/** Blend the tabulated textures by fraction — the pedotransfer move for
 *  in-between soils (Cosby/Clapp-Hornberger class properties are smooth in
 *  texture space). kSat and psiS span decades, so those two interpolate
 *  LOGARITHMICALLY (an arithmetic mean would pin a 50/50 sand-clar mix at
 *  half of sand's K; the geometric mean lands it near the real ~2%).
 *  Fractions need not be normalised — they are here. */
export function mixTextures(fracs: number[]): SoilTexture {
  let sand = 0, silt = 0, clay = 0, thetaS = 0, b = 0, kSat = 0, psiS = 0,
    phi = 0, c = 0, LL = 0, PL = 0, dr = 0, w = 0;
  for (let i = 0; i < Math.min(fracs.length, SOIL_TEXTURES.length); i++) {
    const f = Math.max(fracs[i], 0);
    if (f <= 0) continue;
    const t = SOIL_TEXTURES[i];
    sand += f * t.sand; silt += f * t.silt; clay += f * t.clay;
    thetaS += f * t.thetaS; b += f * t.b;
    kSat += f * Math.log10(t.kSatMmH); psiS += f * Math.log10(t.psiSmm);
    phi += f * t.phiDeg; c += f * t.cEffKpa; LL += f * t.LL; PL += f * t.PL;
    dr += f * t.relDens; w += f;
  }
  if (w <= 0) return SOIL_TEXTURES[1];
  const n = 1 / w;
  sand *= n; silt *= n; clay *= n; thetaS *= n; b *= n; phi *= n; c *= n;
  LL *= n; PL *= n; dr *= n;
  kSat = Math.pow(10, kSat * n); psiS = Math.pow(10, psiS * n);
  // label: the two heaviest fractions read as "Loam + 22% sand"
  const order = fracs.map((f, i) => [f, i] as [number, number]).sort((a, b2) => b2[0] - a[0]);
  const label = order[1] && order[1][0] * n > 0.18
    ? `${SOIL_TEXTURES[order[0][1]].label.split(" ")[0]} + ${(order[1][0] * n * 100).toFixed(0)}% ${SOIL_TEXTURES[order[1][1]].key.replace(/_/g, " ")}`
    : SOIL_TEXTURES[order[0][1]].label;
  return makeTexture("mixed", label, sand, silt, clay, thetaS, psiS, b, kSat, phi, c, LL, PL, dr);
}

/** Engine constants (rwengine EngineConfig). */
export const CFG = {
  soilDz: [0.1, 0.2, 0.3, 0.4], // 4-layer column, top first [m]
  gammaW: 9.81, // kN/m3
  footingB: 0.3, // reference wheel width [m]
  phiBDeg: 15.0, // Fredlund suction friction angle
  suctionCapKpa: 2000.0,
  cAppCapKpa: 150.0,
  maxRutM: 0.5,
  keSealJ: 800.0, // rain KE for full surface sealing
  keSealFrac: 0.35, // max Ks reduction from crusting
  /** depression-storage cap [m]: beyond this, routed water spills out of the
   *  catchment as sub-grid basin outflow (no river outlet until Phase 3 —
   *  without the cap a closed bowl silently lakes up 13+ m of phantom water).
   *  River-channel and tarn cells get their own deeper per-cell cap
   *  (terrain.pondCap) so the river can hold a real channel of water. */
  depressionMaxM: 0.25,
  /** river source (tarn) spring discharge [m³/s] — feeds the channel every
   *  physics tick; the water genuinely travels the D8 route to the map edge */
  riverSpringQ: 0.06,
  // ---- shallow bedrock (the crags) ------------------------------------
  /** bearing boost at full bare-rock fraction (rock is a raft: q_ult climbs
   *  toward what the rock mass itself carries, not the soil mantle) */
  rockBearingBoost: 3.5,
  /** infiltration cut at full bare-rock fraction — bare rock sheds rain into
   *  runoff instead of drinking it (rill water on the crags runs to the scree) */
  rockInfilCut: 0.85,
  /** spade refusal threshold: more bare rock than this and the blade
   *  clinks off instead of biting (dig elsewhere, or tunnel from a face) */
  rockDigRefuse: 0.5,
  rhoW: 1000.0,
  // ---- mud material (thixotropy / creep / stickiness / desiccation) --------
  // Mud is a Herschel-Bulkley solid-liquid: it has a yield stress (no sink
  // below it), shear-thins, and its clay particles re-flocculate at REST —
  // gel strength rebuilds while water content stays constant (10 s vs 10 min
  // gel readings in drilling fluids; geotech calls the same thing sensitivity).
  gelTauH: 180, // gel recovery τ [h] = gelTauH / clay%  (30% clay ≈ 6 h)
  sensitivityPerClay: 0.07, // S_t = 1 + clay% · this  (30% → 3.1, 18% → 2.3)
  remoldPerPass: 0.55, // structure knock-down per plastic/liquid wheel pass
  remoldPerStroke: 0.72, // knock-down per spade stroke / hard landing
  mudCreepRate: 0.0016, // viscoplastic sinkage [m/s] at q/qult = 2
  mudCreepRampS: 8, // dwell seconds until creep is fully developed
  stickPeak: 1.0, // peak adhesion scale (sticky-limit window, FAO classes)
  crustGrowPerDryH: 0.22, // desiccation crust growth per drying-hour
  crustSlakePerWetH: 6, // rain re-slaking decay per wetting-hour
  crustSealFrac: 0.35, // infiltration sealing by a fully developed crust
};

export const DEG = Math.PI / 180.0;

/** Terzaghi bearing capacity factors (ported from geotech.py). */
export function bearingFactors(phiDeg: number): [number, number, number] {
  const phi = Math.max(phiDeg, 0.0) * DEG;
  const tanPhi = Math.tan(phi);
  const Nq = Math.exp(Math.PI * tanPhi) * Math.pow(Math.tan(0.25 * Math.PI + 0.5 * phi), 2);
  const Nc = tanPhi > 1e-3 ? (Nq - 1.0) / Math.max(tanPhi, 1e-12) : 5.14;
  const Ng = 2.0 * (Nq + 1.0) * tanPhi;
  return [Nq, Nc, Ng];
}

/** Marshall-Palmer style rain terminal velocity (Gunn & Kinzer fit, m/s). */
export function dropFallSpeed(diameterMm: number): number {
  return Math.min(3.778 * Math.pow(diameterMm, 0.67), 9.2);
}

/** Median raindrop diameter from intensity (Marshall-Palmer Λ = 4.1 R^-0.21). */
export function medianDropMm(rainMmH: number): number {
  const r = Math.max(rainMmH, 0.01);
  const lambda = 4.1 * Math.pow(r, -0.21); // 1/mm
  return 3.67 / lambda; // ~ median volume diameter
}

export interface WeatherEntry {
  t: number; // game minutes
  rain: number; // mm/h
  wind: number; // m/s
  temp: number; // deg C
  cloud: number; // 0..1
  pond: number; // mm (domain diagnostics, reference only)
}

export interface PresetDef {
  key: string;
  label: string;
  labelShort: string;
  timescale: number; // default game-minutes per real-minute
  initSat: number; // initial soil saturation fraction (of thetaS)
  wetStart: boolean; // start pre-soaked (clear-sky drying story)
}

export const PRESETS: PresetDef[] = [
  { key: "clear_sky", label: "Clear Sky — drying cycle", labelShort: "CLEAR SKY", timescale: 24, initSat: 0.78, wetStart: true },
  { key: "drizzle", label: "Drizzle — stratiform band", labelShort: "DRIZZLE", timescale: 8, initSat: 0.5, wetStart: false },
  { key: "thunderstorm", label: "Thunderstorm — convective cells", labelShort: "THUNDERSTORM", timescale: 16, initSat: 0.42, wetStart: false },
  { key: "monsoon", label: "Monsoon — sustained heavy rain", labelShort: "MONSOON", timescale: 32, initSat: 0.6, wetStart: false },
  { key: "cold_front", label: "Cold Front — travelling band", labelShort: "COLD FRONT", timescale: 8, initSat: 0.45, wetStart: false },
];
