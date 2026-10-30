/**
 * Ground physics — a faithful port of rwengine's soil.py + geotech.py,
 * running live on the 192×192 game grid (4 m cells) while you walk on it.
 *
 * Rain (from the real engine's weather timeline, spatialised into drifting
 * storm cells / bands) → Green-Ampt infiltration with rain-KE crusting →
 * layered Clapp-Hornberger percolation → D8 runoff routing & ponding →
 * evaporation, plus the full geotechnical response: matric suction,
 * Fredlund apparent cohesion, Terzaghi bearing capacity, Atterberg
 * consistency (solid / plastic / liquid MUD), CBR.
 */
import { CFG, DEG, SOIL_TEXTURES, SoilTexture, bearingFactors, medianDropMm } from "./params";
import { GRID, WORLD_SIZE, TerrainData, cellIndex } from "./terrain";

const N = GRID * GRID;
const CELL = WORLD_SIZE / GRID;
const HALF = WORLD_SIZE / 2;

export interface GroundForcing {
  /** timeline rain intensity at the storm core [mm/h] */
  coreRainMmH: number;
  windMs: number;
  tempC: number;
  /** relative humidity 0..1 */
  rh: number;
  /** shortwave factor (0..1, cloud attenuation) */
  sw: number;
  /** pattern kind: "cells" | "band" | "broad" | "none" */
  pattern: "cells" | "band" | "broad" | "none";
  /** pattern drift vector in world coords [m/s, real time] */
  driftU: number;
  driftV: number;
  /** game seconds advanced since last tick */
  dtGame: number;
  /** real seconds since last tick (for pattern motion) */
  dtReal: number;
  /** player anchor for the storm core [world m] */
  playerX: number;
  playerZ: number;
}

/** per-cell derived view for the renderer / inspector */
export interface CellReport {
  texture: SoilTexture;
  wPct: number;
  theta: number[];
  sr: number;
  suctionKpa: number;
  cEffKpa: number;
  phiEffDeg: number;
  qUltKpa: number;
  cbr: number;
  tauFKpa: number;
  consistency: 0 | 1 | 2;
  consistencyLabel: string;
  pondMm: number;
  rutM: number;
  infilCapMmH: number;
  mudFactor: number;
  branchLabel: string;
  traffic: number;
  disturbed: boolean;
}

export class Ground {
  // prognostic fields (all GRID*GRID)
  theta: Float32Array[]; // 4 soil layers, volumetric
  hPond = new Float32Array(N); // m
  infiltF = new Float32Array(N); // cumulative infiltration [m]
  keCum = new Float32Array(N); // rain kinetic energy [J/m2]
  rut = new Float32Array(N); // m
  // derived geotech fields
  wPct = new Float32Array(N);
  sr = new Float32Array(N);
  suction = new Float32Array(N); // kPa
  qUlt = new Float32Array(N); // kPa
  cbr = new Float32Array(N);
  consistency = new Uint8Array(N); // 0 solid 1 plastic 2 liquid
  mudFactor = new Float32Array(N); // smooth 0..1 for rendering
  wetness = new Float32Array(N); // top-layer wetness 0..1 for darkening
  rainField = new Float32Array(N); // mm/h per cell (current)
  // hysteretic state (spec §2)
  branch = new Uint8Array(N); // retention branch: 0 drying (main), 1 wetting (scanning)
  traffic = new Uint8Array(N); // cumulative traffic compaction memory
  disturbed = new Uint8Array(N); // dig/till disturbance: crust broken, layers mixed
  /** compaction accumulator (fine-grained footfall memory; traffic = floor) */
  private compAcc = new Float32Array(N);
  /** per-step infiltration flux [m] — branch flips on the NET water tendency */
  private wetFlux = new Float32Array(N);
  /** sub-grid basin outflow ledger [m3] (depression-cap spillover, spec §4) */
  basinOutflowM3 = 0;
  // spatial pattern state
  private blobPhase = 0;
  private bandX = -0.35; // band centre, fraction of world
  patternTime = 0;
  /** packed render texture data RGBA: R wetness, G pond, B mud, A road */
  public texData = new Uint8Array(N * 4);

  constructor(terrain: TerrainData, initSat: number) {
    this.terrain = terrain;
    this.theta = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
    this.reset(initSat);
  }

  /** re-initialise all state (weather scenario switch) */
  reset(initSat: number) {
    for (let k = 0; k < N; k++) {
      const tex = SOIL_TEXTURES[this.terrain.soil[k]];
      const jit = 0.94 + 0.12 * ((k * 2654435761) % 1000) / 1000;
      const th = tex.thetaS * initSat * jit;
      for (let L = 0; L < 4; L++) this.theta[L][k] = th;
      this.hPond[k] = 0; this.infiltF[k] = 0; this.keCum[k] = 0; this.rut[k] = 0;
      this.branch[k] = 0; this.traffic[k] = 0; this.disturbed[k] = 0; this.compAcc[k] = 0;
      this.wetFlux[k] = 0;
    }
    this.basinOutflowM3 = 0;
  }

  /** saturation vapor pressure [kPa] (Magnus, ported spirit of Bolton) */
  private es(totalC: number): number {
    return 0.6108 * Math.exp((17.27 * totalC) / (totalC + 237.3));
  }

  // ---------------------------------------------------------------- rain field
  private computeRainField(f: GroundForcing) {
    const rf = this.rainField;
    const core = f.coreRainMmH;
    if (f.pattern === "none" || core < 0.02) {
      rf.fill(0);
      return;
    }
    this.patternTime += f.dtReal;
    const t = this.patternTime;
    this.blobPhase += f.dtReal;

    if (f.pattern === "cells") {
      // three convective cells: the lead cell tracks the player (the storm
      // follows the action, RDR2-style), two more drift independently
      // NOTE: all positions in world coords (−HALF..HALF)
      rf.fill(core * 0.16); // anvil / stratiform sheet under the storm
      const specs: Array<[number, number, number, number]> = [
        [0.0, 130, 1.0, 0.13],
        [2.1, 150, 0.72, 0.09],
        [4.4, 105, 1.25, 0.17],
      ];
      for (let s = 0; s < specs.length; s++) {
        const [ph, rad, spd, wf] = specs[s];
        let bx: number, by: number;
        if (s === 0) {
          // lead cell: anchored near the player with slow wobble
          bx = f.playerX + WORLD_SIZE * 0.16 * Math.sin(t * wf + ph * 3.0);
          by = f.playerZ + WORLD_SIZE * 0.22 * Math.sin(t * wf * 0.7 + 1.1);
        } else {
          bx = -HALF + WORLD_SIZE * (0.15 + 0.7 * frac(0.211 + ph + t * 0.006 * spd));
          by = -HALF + WORLD_SIZE *
            (0.5 + 0.22 * Math.sin(t * wf + ph * 3.0) + 0.18 * frac(0.77 + ph));
        }
        for (let j = 0; j < GRID; j++) {
          const y = (j + 0.5) * CELL - HALF;
          const ddy = y - by;
          const radY = rad * 2.2;
          const rowB = Math.exp(-(ddy * ddy) / (2 * radY * radY));
          if (rowB < 0.02) continue;
          for (let i = 0; i < GRID; i++) {
            const x = (i + 0.5) * CELL - HALF;
            const ddx = x - bx;
            const rr = rad * (1 + 0.3 * Math.sin(t * 0.3 + i * 0.2));
            const g = Math.exp(-(ddx * ddx) / (2 * rr * rr)) * rowB;
            rf[j * GRID + i] += core * g;
          }
        }
      }
    } else if (f.pattern === "band") {
      // frontal band sweeping along the drift direction (world coords)
      const ang = Math.atan2(f.driftV, f.driftU);
      const sweep = WORLD_SIZE * (0.9 * frac(0.3 + t * 0.004) - 0.55);
      const cxb = sweep * Math.cos(ang), cyb = sweep * Math.sin(ang);
      const width = 150, length = WORLD_SIZE * 1.6;
      for (let j = 0; j < GRID; j++) {
        const y = (j + 0.5) * CELL - HALF;
        for (let i = 0; i < GRID; i++) {
          const x = (i + 0.5) * CELL - HALF;
          // project onto band cross-section
          const rx = x - cxb, ry = y - cyb;
          const cross = -rx * Math.sin(ang) + ry * Math.cos(ang);
          const along = rx * Math.cos(ang) + ry * Math.sin(ang);
          const gc = Math.exp(-(cross * cross) / (2 * width * width));
          const gl = Math.exp(-(along * along) / (2 * length * length));
          rf[j * GRID + i] = core * (0.05 + 0.95 * gc * gl);
        }
      }
    } else {
      // broad stratiform coverage with drifting modulation
      for (let j = 0; j < GRID; j++) {
        const y = (j + 0.5) / GRID;
        for (let i = 0; i < GRID; i++) {
          const x = (i + 0.5) / GRID;
          const nz = 0.6 + 0.4 * Math.sin(x * 9 + t * 0.11 + Math.sin(y * 7 + t * 0.07) * 1.3);
          rf[j * GRID + i] = core * Math.max(0.15, nz);
        }
      }
    }
  }

  // ------------------------------------------------------------------- update
  update(f: GroundForcing) {
    this.computeRainField(f);
    const dt = f.dtGame; // game seconds
    if (dt <= 0) return;
    const dth = dt / 3600; // hours
    const dz = CFG.soilDz;

    // 1) rain → ponding + kinetic-energy crusting
    const rf = this.rainField;
    const ke = this.keCum;
    const dMed = medianDropMm(Math.max(f.coreRainMmH, 0.1)); // mm
    const vFall = Math.min(3.778 * Math.pow(dMed, 0.67), 9.2); // m/s
    const kePerMm = 0.5 * 0.5 * Math.pow(vFall, 2) * 0.5; // J/m2/mm (bulk approx)
    for (let k = 0; k < N; k++) {
      const r = rf[k];
      if (r > 0.001) {
        this.hPond[k] += (r * dth) / 1000; // m
        ke[k] += r * dth * kePerMm; // J/m2
      }
    }

    // 2) Green-Ampt infiltration with crusting (ported from soil.py)
    const soil = this.terrain.soil;
    const theta0 = this.theta[0], theta1 = this.theta[1];
    const hP = this.hPond, F = this.infiltF;
    for (let k = 0; k < N; k++) {
      const avail = hP[k];
      if (avail <= 1e-7) { F[k] = Math.max(F[k], 2e-3); this.wetFlux[k] = 0; continue; }
      const tex = SOIL_TEXTURES[soil[k]];
      const seal = 1 - CFG.keSealFrac * Math.min(ke[k] / CFG.keSealJ, 1);
      // disturbed soil infiltrates faster (crust broken, structure open);
      // compacted paths shed water — the desire-path feedback (spec §2)
      const kTraffic = 1 - 0.12 * Math.min(this.traffic[k], 5);
      const kDig = this.disturbed[k] > 0 ? 1.7 : 1;
      const ks = (tex.kSatMmH / 3600) / 1000 * seal * kTraffic * kDig; // m/s
      const dTheta = Math.max(tex.thetaS - theta0[k], 1e-3);
      const Fk = Math.max(F[k], 2e-3);
      const psiF = Math.min(
        Math.max((tex.psiSmm / 1000) * Math.pow((0.55 * tex.thetaS) / Math.max(theta0[k], tex.thetaWp), -tex.b), 0.02),
        0.6,
      );
      const head = psiF * dTheta + avail;
      const fCap = ks * (1 + head / Fk); // m/s
      let infil = Math.min(fCap * dt, avail);
      const cap1 = Math.max(tex.thetaS - theta0[k], 0) * dz[0];
      infil = Math.min(infil, cap1);
      hP[k] -= infil;
      theta0[k] = Math.min(theta0[k] + infil / dz[0], tex.thetaS);
      F[k] += infil;
      this.wetFlux[k] = infil;
    }

    // 3) percolation between layers (Clapp-Hornberger K(theta))
    for (let L = 0; L < 3; L++) {
      const th = this.theta[L], thn = this.theta[L + 1];
      for (let k = 0; k < N; k++) {
        const tex = SOIL_TEXTURES[soil[k]];
        const excess = th[k] - tex.thetaFc;
        if (excess <= 1e-5) continue;
        const kUnsat = ((tex.kSatMmH / 3600) / 1000) *
          Math.pow(Math.max(th[k] / tex.thetaS, 1e-3), 2 * tex.b + 3);
        const drainable = kUnsat * (excess / Math.max(tex.thetaS - tex.thetaFc, 1e-3));
        let flux = Math.min(drainable * dt, excess * dz[L]);
        const cap = Math.max(tex.thetaS - thn[k], 0) * dz[L + 1];
        flux = Math.min(flux, cap);
        th[k] -= flux / dz[L];
        thn[k] += flux / dz[L + 1];
      }
    }
    // bottom boundary: deep percolation
    {
      const th = this.theta[3];
      for (let k = 0; k < N; k++) {
        const tex = SOIL_TEXTURES[soil[k]];
        const excess = th[k] - tex.thetaFc;
        if (excess <= 1e-5) continue;
        const kUnsat = ((tex.kSatMmH / 3600) / 1000) *
          Math.pow(Math.max(th[k] / tex.thetaS, 1e-3), 2 * tex.b + 3);
        const flux = Math.min(kUnsat * dt, excess * dz[3]);
        th[k] -= flux / dz[3];
      }
    }

    // 4) evaporation (bulk-aerodynamic, ported from soil.py)
    {
      const T = f.tempC, Ts = T - 1;
      const esS = this.es(Ts), ea = f.rh * this.es(T);
      const qsS = 0.622 * esS / (101.3 - esS);
      const qa = 0.622 * ea / (101.3 - ea);
      const dq = Math.max(qsS - qa, 0);
      const ePot = (4e-3 * f.sw * (1 + 0.35 * f.windMs) * dq * 1.2) / 1000; // m/s
      const ePotDt = ePot * dt;
      for (let k = 0; k < N; k++) {
        const tex = SOIL_TEXTURES[soil[k]];
        // puddle evaporation at full potential
        const ePond = Math.min(ePotDt, this.hPond[k]);
        this.hPond[k] -= ePond;
        // soil evaporation, supply-limited between wp and fc
        const beta = Math.max(0, Math.min(
          (theta0[k] - tex.thetaWp) / Math.max(tex.thetaFc - tex.thetaWp, 1e-3), 1));
        const eSoil = Math.min(ePotDt * beta, Math.max(theta0[k] - tex.thetaWp, 0) * dz[0]);
        theta0[k] -= eSoil / dz[0];
        // retention branch follows the NET tendency (spec §3): rain of mm must
        // beat drizzle-scale evaporation of µm, not lose to it by run order.
        const netWet = this.wetFlux[k] - eSoil;
        if (netWet > 1e-7) this.branch[k] = 1; // wetting scan
        else if (netWet < -1e-7) this.branch[k] = 0; // main drying curve
      }
    }

    // 5) D8 runoff routing (Manning overland, one capped hop per tick)
    this.route(dt);

    // 6) geotechnical response (ported from geotech.py update)
    this.updateGeotech();
  }

  private routeOut = new Float32Array(N);
  private routeIn = new Float32Array(N);

  /** Manning-D8 routing with a hop cap for stability. */
  private route(dt: number) {
    const h = this.hPond;
    const outflow = this.routeOut;
    const inflow = this.routeIn;
    outflow.fill(0); inflow.fill(0);
    const depStore = 0.002; // 2 mm micro-depression storage
    const nMan = 0.05;
    const height = this.terrain.height;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const hExcess = h[k] - depStore - this.rut[k] * 0.4;
        if (hExcess <= 2e-4) continue;
        // steepest descent among 8 neighbours (use node heights)
        let bestK = -1, bestSlope = 0.02; // minimum slope to move
        const zc = height[(j + 1) * (GRID + 1) + i + 1] + h[k];
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = i + di, nj = j + dj;
            if (ni < 0 || ni >= GRID || nj < 0 || nj >= GRID) continue;
            const nk = nj * GRID + ni;
            const dist = (di !== 0 && dj !== 0) ? CELL * 1.414 : CELL;
            const slope = (zc - (height[(nj + 1) * (GRID + 1) + ni + 1] + h[nk])) / dist;
            if (slope > bestSlope) { bestSlope = slope; bestK = nk; }
          }
        }
        if (bestK < 0) continue;
        // Manning velocity for the excess depth
        const v = (1 / nMan) * Math.pow(hExcess, 5 / 3) * Math.sqrt(bestSlope);
        let q = Math.min(v * dt, CELL * CELL * hExcess); // volumetric m3
        q = Math.min(q, hExcess * CELL * CELL * 0.5);
        const dq = q / (CELL * CELL); // depth equivalent [m]
        outflow[k] += dq;
        inflow[bestK] += dq;
      }
    }
    for (let k = 0; k < N; k++) h[k] += inflow[k] - outflow[k];

    // depression-cap spillover. This catchment has no mapped outlet channel
    // yet (rivers are Phase 3), so a closed bowl would silently pile up a
    // phantom lake — 13+ m of invisible water keeping the valley on the
    // wetting branch for months. Water beyond a legible sheet depth leaves
    // as sub-grid basin outflow, booked in the ledger so mass is accounted,
    // never silently destroyed (spec §4: conserve, and never forget).
    const cap = CFG.depressionMaxM;
    for (let k = 0; k < N; k++) {
      if (h[k] > cap) {
        this.basinOutflowM3 += (h[k] - cap) * CELL * CELL;
        h[k] = cap;
      }
    }
  }

  /** recompute geotech state from moisture (ported from geotech.py). */
  private updateGeotech() {
    const soil = this.terrain.soil;
    const th0 = this.theta[0], th1 = this.theta[1];
    for (let k = 0; k < N; k++) {
      const tex = SOIL_TEXTURES[soil[k]];
      const th = (CFG.soilDz[0] / 0.3) * th0[k] + (CFG.soilDz[1] / 0.3) * th1[k];
      const Sr = Math.max(0, Math.min(th / tex.thetaS, 1));
      const wPct = (100 * th * 1000) / tex.rhoDry;
      // suction from retention curve — DUAL BRANCH (spec §3): the Clapp-
      // Hornberger power law is the main DRYING curve; a freshly wetted cell
      // sits on the scanning wetting branch at ~0.42× suction, so wetting
      // weakens fast while drying recovers strength slowly — the drying crust.
      let psiMm = tex.psiSmm * Math.pow(Math.max(th / tex.thetaS, 1e-3), -tex.b);
      if (this.branch[k] === 1) psiMm *= 0.42;
      let suction = Math.min(psiMm * 9.81e-3, CFG.suctionCapKpa);
      if (Sr >= 0.999) suction = 0;
      // apparent cohesion (Fredlund)
      let cApp = tex.cEffKpa + Sr * suction * Math.tan(CFG.phiBDeg * DEG);
      cApp = Math.min(cApp, CFG.cAppCapKpa);
      // liquid-consistency collapse
      const overLiq = Math.max(wPct - tex.LL, 0);
      const soft = Math.min(overLiq / 15, 1);
      const cEff = cApp * Math.max(1 - soft, 0.1);
      const phiEff = Math.max(tex.phiEff - 12 * soft, 8);
      // unit weights (submerged when ponded)
      const submerged = this.hPond[k] > 5e-3;
      const gammaBulk = tex.gammaDry + tex.thetaS * Sr * CFG.gammaW;
      const gammaEff = submerged ? tex.gammaDry + tex.thetaS * CFG.gammaW - CFG.gammaW : gammaBulk;
      const [Nq, Nc, Ng] = bearingFactors(phiEff);
      let qUlt = 1.2 * cEff * Nc + 0.4 * gammaEff * CFG.footingB * Ng;
      qUlt = Math.max(qUlt, 2);
      // shear strength at 0.3 m
      const sigmaV = gammaBulk * 0.3;
      const uPos = submerged && Sr >= 0.999 ? CFG.gammaW * this.hPond[k] * 1000 : 0;
      const sigmaEff = sigmaV - uPos + Sr * suction;
      const tauF = cEff + sigmaEff * Math.tan(phiEff * DEG);

      this.wPct[k] = wPct;
      this.sr[k] = Sr;
      this.suction[k] = suction;
      this.qUlt[k] = qUlt;
      this.cbr[k] = Math.max(0.05, Math.min(100 * qUlt / 6900, 150));
      this.consistency[k] = wPct < tex.PL ? 0 : wPct < tex.LL ? 1 : 2;
      // smooth mud factor: ramps through plastic → past LL
      const mud = Math.max(0, Math.min((wPct - (tex.PL + 0.55 * (tex.LL - tex.PL))) /
        (0.6 * (tex.LL - tex.PL)), 1));
      this.mudFactor[k] = mud * mud * (3 - 2 * mud); // smoothstep
      // wetness for darkening: saturation of the top layer
      this.wetness[k] = Math.max(0, Math.min((th0[k] - tex.thetaWp) / (tex.thetaS - tex.thetaWp), 1));
    }
  }

  // ------------------------------------------------------------- interactions
  /** player/vehicle rutting: punching shear into soft ground [m sinkage] */
  applyWheelLoad(x: number, y: number, contactKpa: number, isPlayer: boolean): { sinkage: number; verdict: string } {
    const k = cellIndex(x, y);
    // every pass leaves compaction memory (hysteretic — spec rule 8)
    if (this.traffic[k] < 255) this.traffic[k]++;
    const qUlt = this.qUlt[k] * (1 + 0.05 * Math.min(this.traffic[k], 5));
    const E = 120 * Math.max(this.suction[k] * this.sr[k] + 3, 10);
    const sEl = (contactKpa * CFG.footingB * (1 - 0.3 * 0.3)) / E;
    const excess = Math.max(contactKpa - qUlt, 0);
    const tex = SOIL_TEXTURES[this.terrain.soil[k]];
    const [Nq] = bearingFactors(tex.phiEff);
    let sPl = excess > 0 ? Math.min(excess / Math.max(tex.gammaDry * Nq, 1), CFG.maxRutM) : 0;
    if (this.consistency[k] === 2) sPl = Math.max(sPl, isPlayer ? 0.22 : 0.35);
    const sTotal = Math.max(0, Math.min(sEl + sPl, isPlayer ? 0.32 : CFG.maxRutM));
    this.rut[k] = Math.min(this.rut[k] + sTotal * (isPlayer ? 0.35 : 1), CFG.maxRutM + 0.2);
    const verdict = sTotal < 0.05 ? "PASSABLE" : sTotal < 0.25 ? "MARGINAL (rutting)" : "BOGGED";
    return { sinkage: sTotal, verdict };
  }

  /**
   * A walking footfall — compaction memory without rut carving (spec §2, §9).
   * Compaction peaks at the PLASTIC optimum: dry soil barely packs further,
   * liquid mud flows instead of compacting (the churn record lives in the
   * micro tier), plastic soil takes the full memory. This is the seed of the
   * desire path: a walked line sheds water, firms up and sinks less.
   */
  footPass(x: number, y: number, sprint = false) {
    const k = cellIndex(x, y);
    const cons = this.consistency[k];
    const w = cons === 1 ? (sprint ? 1.6 : 1.3) : cons === 0 ? (sprint ? 1.2 : 0.9) : 0;
    if (w <= 0) return;
    this.compAcc[k] += w;
    this.traffic[k] = Math.min(255, Math.floor(this.compAcc[k]));
  }

  /** digging disturbed this cell: crust broken, layers mixed, structure open */
  markDug(x: number, y: number) {
    const k = cellIndex(x, y);
    this.disturbed[k] = 1;
    this.keCum[k] *= 0.25; // crust shattered
    // lift moist subsoil into the top layer (mixed, loosened)
    const th0 = this.theta[0][k], th1 = this.theta[1][k];
    const mixed = 0.5 * th0 + 0.5 * th1;
    this.theta[0][k] = mixed;
    this.theta[1][k] = mixed;
  }

  /** movement penalty & visual sinkage at a world position */
  sampleMud(x: number, y: number): { mud: number; pondM: number; slow: number; sink: number; rut: number } {
    const k = cellIndex(x, y);
    const mud = this.mudFactor[k];
    const pond = this.hPond[k];
    const pondSlow = Math.min(pond / 0.25, 1) * 0.45;
    const slow = Math.max(0.18, 1 - 0.68 * mud - pondSlow);
    // a compacted path is a hard path: prints sink less (spec §2)
    const kComp = 1 - 0.08 * Math.min(this.traffic[k], 5);
    const sink = (mud * 0.24 + Math.min(this.rut[k], 0.2)) * kComp;
    return { mud, pondM: pond, slow, sink, rut: this.rut[k] };
  }

  rainAt(x: number, y: number): number {
    return this.rainField[cellIndex(x, y)];
  }

  cellReport(x: number, y: number): CellReport {
    const k = cellIndex(x, y);
    const tex = SOIL_TEXTURES[this.terrain.soil[k]];
    const Fk = Math.max(this.infiltF[k], 2e-3);
    const dTheta = Math.max(tex.thetaS - this.theta[0][k], 1e-3);
    const psiF = Math.min(Math.max((tex.psiSmm / 1000) *
      Math.pow((0.55 * tex.thetaS) / Math.max(this.theta[0][k], tex.thetaWp), -tex.b), 0.02), 0.6);
    const seal = 1 - CFG.keSealFrac * Math.min(this.keCum[k] / CFG.keSealJ, 1);
    const kEff = (1 - 0.12 * Math.min(this.traffic[k], 5)) * (this.disturbed[k] > 0 ? 1.7 : 1);
    const fCap = ((tex.kSatMmH / 3600) / 1000) * seal * kEff * (1 + (psiF * dTheta + this.hPond[k]) / Fk);
    // strength chain at this cell
    const Sr = this.sr[k];
    const overLiq = Math.max(this.wPct[k] - tex.LL, 0);
    const soft = Math.min(overLiq / 15, 1);
    const cApp = Math.min(tex.cEffKpa + Sr * this.suction[k] * Math.tan(CFG.phiBDeg * DEG), CFG.cAppCapKpa);
    const cEff = cApp * Math.max(1 - soft, 0.1);
    const phiEff = Math.max(tex.phiEff - 12 * soft, 8);
    const gammaBulk = tex.gammaDry + tex.thetaS * Sr * CFG.gammaW;
    const sigmaV = gammaBulk * 0.3;
    const uPos = this.hPond[k] > 5e-3 && Sr >= 0.999 ? CFG.gammaW * this.hPond[k] * 1000 : 0;
    const sigmaEff = sigmaV - uPos + Sr * this.suction[k];
    const tauF = cEff + sigmaEff * Math.tan(phiEff * DEG);
    return {
      texture: tex,
      wPct: this.wPct[k],
      theta: [this.theta[0][k], this.theta[1][k], this.theta[2][k], this.theta[3][k]],
      sr: Sr,
      suctionKpa: this.suction[k],
      cEffKpa: cEff,
      phiEffDeg: phiEff,
      qUltKpa: this.qUlt[k],
      cbr: this.cbr[k],
      tauFKpa: tauF,
      consistency: this.consistency[k] as 0 | 1 | 2,
      consistencyLabel: ["SOLID", "PLASTIC", "LIQUID — MUD"][this.consistency[k]],
      pondMm: this.hPond[k] * 1000,
      rutM: this.rut[k],
      infilCapMmH: fCap * 3600 * 1000,
      mudFactor: this.mudFactor[k],
      branchLabel: this.branch[k] === 1 ? "WETTING (scan)" : "DRYING (main)",
      traffic: this.traffic[k],
      disturbed: this.disturbed[k] > 0,
    };
  }

  /** pack render texture: R wetness, G pond, B mud, A road */
  packTexture(road: Float32Array) {
    const d = this.texData;
    for (let k = 0; k < N; k++) {
      d[k * 4 + 0] = Math.min(255, this.wetness[k] * 255) | 0;
      d[k * 4 + 1] = Math.min(255, Math.min(this.hPond[k] / 0.12, 1) * 255) | 0;
      d[k * 4 + 2] = Math.min(255, this.mudFactor[k] * 255) | 0;
      d[k * 4 + 3] = Math.min(255, road[k] * 255) | 0;
    }
  }
}

function frac(x: number): number {
  return x - Math.floor(x);
}
