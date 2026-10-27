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

/** Texture order matches rwengine: 0 upland sand, 1 slopes loam, 2 valley clay. */
export const SOIL_TEXTURES: SoilTexture[] = [
  makeTexture("sandy_loam", "Sandy loam", 65, 25, 10, 0.435, 218.0, 4.9, 25.9, 32.0, 3.0, 21.0, 13.0, 0.6),
  makeTexture("loam", "Loam", 40, 42, 18, 0.451, 478.0, 5.25, 13.0, 28.0, 8.0, 27.0, 18.0, 0.5),
  makeTexture("silty_clay_loam", "Silty clay loam", 15, 55, 30, 0.5, 356.0, 7.75, 3.4, 24.0, 15.0, 32.0, 20.0, 0.4),
];

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
  rhoW: 1000.0,
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
