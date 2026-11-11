import * as THREE from "three";

export interface HydraulicStation {
  z: number;
  bedY: number;
  waterY: number;
  depth: number;
  area: number;
  velocity: number;
  froude: number;
  head: number; // velocity head v^2 / (2g)
  foamIntensity: number;
  shearStress: number;  // REEF3D: Bed shear stress τ_b = ρ · g · R_h · S [Pa]
  shieldsParam: number; // REEF3D: Dimensionless Shields parameter θ = τ_b / [(ρ_s - ρ) g d_50]
  isScouring: boolean;  // θ > 0.047 (Meyer-Peter & Müller active bedload motion threshold)
}

export interface BoulderObstruction {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export class RiverHydraulics {
  readonly length = 80.0;
  readonly zMin = -40.0;
  readonly zMax = 40.0;
  readonly numStations = 256;

  dischargeQ = 22.0; // m³/s (volumetric discharge)
  readonly manningN = 0.040; // mountain stream with cobbles & boulders
  readonly gravity = 9.81;

  stations: HydraulicStation[] = [];
  boulders: BoulderObstruction[] = [];

  readonly texture: THREE.DataTexture;
  private texData: Float32Array;

  // Global hydraulic metrics for HUD
  minVelocity = 0;
  maxVelocity = 0;
  minFroude = 0;
  maxFroude = 0;
  avgDepth = 0;
  totalVolume = 0;      // m³ (instantaneous reach water volume)
  totalMassTonnes = 0;  // metric tonnes (ρ = 1000 kg/m³)
  massFlowRate = 0;     // kg/s (longitudinal conserved flux ρ * Q)

  // REEF3D Morphodynamics & Sediment Scour Metrics
  minShearStress = 0;   // Pa (τ_b = ρ · g · R_h · S)
  maxShearStress = 0;   // Pa
  minShields = 0;       // Dimensionless Shields parameter θ
  maxShields = 0;       // Dimensionless Shields parameter θ
  scourCount = 0;       // Stations where θ > 0.047 (Meyer-Peter & Müller active transport)
  bedloadFluxKgS = 0;   // Meyer-Peter & Müller total reach bedload sediment flux [kg/s]

  constructor() {
    this.texData = new Float32Array(this.numStations * 4);
    this.texture = new THREE.DataTexture(
      this.texData,
      this.numStations,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;

    // Default boulders matching riverRocks
    this.boulders = [
      { z: -32.0, x: 0.5,  y: 5.8, radius: 1.4 },
      { z: -25.0, x: -1.8, y: 5.2, radius: 1.8 },
      { z: -18.0, x: 1.2,  y: 4.7, radius: 2.1 }, // Major rapid boulder
      { z: -10.0, x: -0.6, y: 4.0, radius: 1.5 },
      { z: -2.0,  x: 1.6,  y: 3.4, radius: 1.9 },
      { z: 6.0,   x: -1.2, y: 2.7, radius: 1.6 },
      { z: 15.0,  x: 0.4,  y: 2.0, radius: 2.3 }, // Big island rock
      { z: 22.0,  x: -2.0, y: 1.5, radius: 1.4 },
      { z: 30.0,  x: 1.1,  y: 0.8, radius: 1.7 },
      { z: 36.0,  x: -0.5, y: 0.3, radius: 1.3 },
    ];

    this.recompute();
  }

  setDischarge(q: number) {
    this.dischargeQ = Math.max(5.0, Math.min(60.0, q));
    this.recompute();
  }

  getRiverCenter(z: number): number {
    return 4.0 * Math.sin(z * 0.07) + 1.8 * Math.cos(z * 0.15);
  }

  // Step-pool longitudinal elevation profile
  getBedElevation(z: number): number {
    const t = (z + 40.0) / 80.0;
    const base = (1.0 - t) * 6.5;

    // 3 Natural Step-Pool plunge basins where water pools and levels out:
    // Basin 1: z ≈ -16 (upstream of big rapid boulder)
    // Basin 2: z ≈ +14 (around island rock)
    // Basin 3: z ≈ +32 (lower quiet pool)
    const pool1 = Math.exp(-Math.pow((z + 16.0) / 6.5, 2.0)) * 0.45;
    const pool2 = Math.exp(-Math.pow((z - 14.0) / 7.5, 2.0)) * 0.50;
    const pool3 = Math.exp(-Math.pow((z - 32.0) / 6.0, 2.0)) * 0.35;

    return base - (pool1 + pool2 + pool3);
  }

  recompute() {
    this.stations = [];
    const dz = this.length / (this.numStations - 1);

    const w0 = 4.0;
    const dMax = 0.85;

    // Natural lateral expansion: as water rises, width expands onto gently sloping gravel bars
    const getBankDist = (dh: number) => {
      let dist = dh / 0.25;
      for (let k = 0; k < 3; k++) {
        const f = 0.22 * dist + 0.12 * Math.log(1.0 + 1.2 * dist) - dh;
        const df = 0.22 + 0.144 / (1.0 + 1.2 * dist);
        dist -= f / df;
      }
      return Math.max(0, dist);
    };

    const getTopWidth = (depth: number) => {
      if (depth <= dMax) {
        return 2.0 * w0 * Math.sqrt(Math.max(0.05, depth / dMax));
      } else {
        const dh = depth - dMax;
        return 2.0 * (w0 + getBankDist(dh));
      }
    };

    const getChannelArea = (depth: number) => {
      if (depth <= dMax) {
        const tw = getTopWidth(depth);
        return (2.0 / 3.0) * tw * depth;
      } else {
        const aMain = (2.0 / 3.0) * (2.0 * w0) * dMax;
        const dh = depth - dMax;
        const tw = getTopWidth(depth);
        const aBanks = 0.5 * (2.0 * w0 + tw) * dh * 0.82;
        return aMain + aBanks;
      }
    };

    for (let i = 0; i < this.numStations; i++) {
      const z = this.zMin + i * dz;
      const bedBase = this.getBedElevation(z);
      const bedLowest = bedBase - dMax; // lowest point of parabolic channel

      // Local bed slope S0 = -d(bedBase)/dz
      const zPrev = Math.max(this.zMin, z - dz * 2.0);
      const zNext = Math.min(this.zMax, z + dz * 2.0);
      const slope = Math.max(0.015, (this.getBedElevation(zPrev) - this.getBedElevation(zNext)) / (zNext - zPrev));

      // Submerged boulder obstruction calculation at this z slice
      let blockedArea = 0;
      for (const b of this.boulders) {
        const distZ = Math.abs(z - b.z);
        if (distZ < b.radius) {
          const sliceR = Math.sqrt(b.radius * b.radius - distZ * distZ);
          blockedArea += sliceR * sliceR * 1.25;
        }
      }

      // Solve for steady-state normal depth h using Manning's Equation:
      let h = 0.85;
      for (let iter = 0; iter < 15; iter++) {
        const topWidth = getTopWidth(h);
        const cleanArea = getChannelArea(h);
        const effArea = Math.max(0.6, cleanArea - Math.min(cleanArea * 0.55, blockedArea));
        const wettedPerim = topWidth + (8.0 / 3.0) * ((h * h) / Math.max(topWidth, 1.0));
        const rh = effArea / Math.max(wettedPerim, 1.0);

        const qCalc = (1.0 / this.manningN) * effArea * Math.pow(rh, 2.0 / 3.0) * Math.sqrt(slope);
        const diff = qCalc - this.dischargeQ;
        if (Math.abs(diff) < 0.05) break;

        const dh = 0.02;
        const h2 = h + dh;
        const tw2 = getTopWidth(h2);
        const ca2 = getChannelArea(h2);
        const ea2 = Math.max(0.6, ca2 - Math.min(ca2 * 0.55, blockedArea));
        const wp2 = tw2 + (8.0 / 3.0) * ((h2 * h2) / Math.max(tw2, 1.0));
        const rh2 = ea2 / Math.max(wp2, 1.0);
        const q2 = (1.0 / this.manningN) * ea2 * Math.pow(rh2, 2.0 / 3.0) * Math.sqrt(slope);
        const dqdh = Math.max((q2 - qCalc) / dh, 0.5);

        h = Math.max(0.2, h - diff / dqdh);
      }

      const topWidth = getTopWidth(h);
      const cleanArea = getChannelArea(h);
      const area = Math.max(0.8, cleanArea - Math.min(cleanArea * 0.55, blockedArea));

      const velocity = this.dischargeQ / area;
      const hydMeanDepth = Math.max(area / Math.max(topWidth, 1.0), 0.15);
      const froude = velocity / Math.sqrt(this.gravity * hydMeanDepth);
      const head = (velocity * velocity) / (2.0 * this.gravity);
      const waterY = bedLowest + h;
      const foamIntensity = Math.min(1.0, Math.max(0.0, (froude - 0.75) * 1.4 + head * 0.25));

      // REEF3D Bed Shear Stress & Shields Parameter (d50 = 65mm gravel/cobble):
      const wettedPerim = topWidth + (8.0 / 3.0) * ((h * h) / Math.max(topWidth, 1.0));
      const rh = area / Math.max(wettedPerim, 1.0);
      const tau = 1000.0 * this.gravity * rh * Math.max(0.002, slope);
      const theta = tau / 1052.0;
      const isScouring = theta > 0.047;

      this.stations.push({
        z,
        bedY: bedLowest,
        waterY,
        depth: h,
        area,
        velocity,
        froude,
        head,
        foamIntensity,
        shearStress: tau,
        shieldsParam: theta,
        isScouring,
      });
    }

    // Hydrostatic backwater leveling pass:
    // Water "finds its own level" in basins behind boulder sills (upstream water surface cannot drop below a downstream pond crest)
    for (let i = this.numStations - 2; i >= 0; i--) {
      const nextY = this.stations[i + 1].waterY;
      if (this.stations[i].waterY < nextY - 0.005) {
        // Pool leveled out to downstream sill crest
        this.stations[i].waterY = nextY;
        this.stations[i].depth = Math.max(0.2, this.stations[i].waterY - this.stations[i].bedY);
        this.stations[i].area = Math.max(0.8, getChannelArea(this.stations[i].depth));
        this.stations[i].velocity = this.dischargeQ / this.stations[i].area;
        this.stations[i].froude = this.stations[i].velocity / Math.sqrt(this.gravity * Math.max(this.stations[i].depth, 0.15));
        this.stations[i].head = (this.stations[i].velocity * this.stations[i].velocity) / (2.0 * this.gravity);

        const twL = getTopWidth(this.stations[i].depth);
        const wpL = twL + (8.0 / 3.0) * (Math.pow(this.stations[i].depth, 2) / Math.max(twL, 1.0));
        const rhL = this.stations[i].area / Math.max(wpL, 1.0);
        const sf = Math.max(0.001, Math.pow(this.manningN * this.stations[i].velocity, 2) / Math.pow(rhL, 4.0 / 3.0));
        this.stations[i].shearStress = 1000.0 * this.gravity * rhL * sf;
        this.stations[i].shieldsParam = this.stations[i].shearStress / 1052.0;
        this.stations[i].isScouring = this.stations[i].shieldsParam > 0.047;
      }
    }

    let minV = 999;
    let maxV = 0;
    let minFr = 999;
    let maxFr = 0;
    let totalD = 0;
    let reachVolume = 0;
    let minTau = 999;
    let maxTau = 0;
    let minTheta = 999;
    let maxTheta = 0;
    let activeScour = 0;
    let totalSedimentKgS = 0;

    for (let i = 0; i < this.numStations; i++) {
      const st = this.stations[i];
      minV = Math.min(minV, st.velocity);
      maxV = Math.max(maxV, st.velocity);
      minFr = Math.min(minFr, st.froude);
      maxFr = Math.max(maxFr, st.froude);
      totalD += st.depth;
      reachVolume += st.area * dz;

      minTau = Math.min(minTau, st.shearStress);
      maxTau = Math.max(maxTau, st.shearStress);
      minTheta = Math.min(minTheta, st.shieldsParam);
      maxTheta = Math.max(maxTheta, st.shieldsParam);

      if (st.isScouring) {
        activeScour++;
        const excess = Math.max(0, st.shieldsParam - 0.047);
        const qbUnit = 1413.4 * Math.pow(excess, 1.5);
        totalSedimentKgS += qbUnit * getTopWidth(st.depth) * (dz / this.length);
      }

      const idx = i * 4;
      this.texData[idx] = st.velocity;
      this.texData[idx + 1] = st.waterY;
      this.texData[idx + 2] = st.froude;
      this.texData[idx + 3] = st.head;
    }

    this.minVelocity = minV;
    this.maxVelocity = maxV;
    this.minFroude = minFr;
    this.maxFroude = maxFr;
    this.avgDepth = totalD / this.numStations;
    this.totalVolume = reachVolume;
    this.totalMassTonnes = reachVolume; // 1 m³ water = 1 tonne = 1000 kg
    this.massFlowRate = this.dischargeQ * 1000.0; // kg/s (continuous conservation along reach)
    this.minShearStress = minTau;
    this.maxShearStress = maxTau;
    this.minShields = minTheta;
    this.maxShields = maxTheta;
    this.scourCount = activeScour;
    this.bedloadFluxKgS = totalSedimentKgS;

    this.texture.needsUpdate = true;
  }

  getStationAtZ(z: number): HydraulicStation {
    const clampedZ = Math.max(this.zMin, Math.min(this.zMax, z));
    const t = (clampedZ - this.zMin) / this.length;
    const index = Math.min(this.numStations - 1, Math.max(0, Math.round(t * (this.numStations - 1))));
    return this.stations[index];
  }

  getVelocityAt(x: number, z: number): number {
    const st = this.getStationAtZ(z);
    const xc = this.getRiverCenter(z);
    const dist = Math.abs(x - xc);
    const w0 = 4.2;
    if (dist >= w0) return 0.2;

    const u = dist / w0;
    const wallShear = Math.pow(Math.max(0.0, 1.0 - u * u * u * u), 0.33);
    return Math.max(0.2, st.velocity * wallShear * 1.22);
  }

  getWaterHeightAt(z: number): number {
    return this.getStationAtZ(z).waterY;
  }
}
