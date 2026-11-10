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

  constructor() {
    this.texData = new Float32Array(this.numStations * 4);
    this.texture = new THREE.DataTexture(
      this.texData,
      this.numStations,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
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

  getBedElevation(z: number): number {
    return (1.0 - (z + 40.0) / 80.0) * 6.5;
  }

  recompute() {
    this.stations = [];
    const dz = this.length / (this.numStations - 1);
    let minV = 999;
    let maxV = 0;
    let minFr = 999;
    let maxFr = 0;
    let totalD = 0;

    for (let i = 0; i < this.numStations; i++) {
      const z = this.zMin + i * dz;
      const bedBase = this.getBedElevation(z);
      const bedLowest = bedBase - 1.45; // lowest point of parabolic channel

      // Channel cross-section geometry: parabolic with top half-width ~4.2m
      const w0 = 4.2;
      const dMax = 1.45;

      // Bed slope S0 = -d(bedBase)/dz
      const slope = 6.5 / 80.0; // ~0.08125

      // Submerged boulder obstruction calculation at this z slice
      let blockedArea = 0;
      for (const b of this.boulders) {
        const distZ = Math.abs(z - b.z);
        if (distZ < b.radius) {
          const sliceR = Math.sqrt(b.radius * b.radius - distZ * distZ);
          // Blockage area contribution (submerged cylinder/sphere slice)
          blockedArea += sliceR * sliceR * 1.25;
        }
      }

      // Solve for steady-state normal depth h using Manning's Equation:
      // Q = (1/n) * A * R_h^(2/3) * S0^(1/2)
      // Iterative Newton/bisection solve for depth h:
      let h = 0.85; // initial guess
      for (let iter = 0; iter < 12; iter++) {
        const topWidth = 2.0 * w0 * Math.sqrt(Math.min(1.0, Math.max(0.05, h / dMax)));
        const cleanArea = (2.0 / 3.0) * topWidth * h;
        const effArea = Math.max(0.6, cleanArea - Math.min(cleanArea * 0.55, blockedArea));
        const wettedPerim = topWidth + (8.0 / 3.0) * ((h * h) / Math.max(topWidth, 1.0));
        const rh = effArea / Math.max(wettedPerim, 1.0);

        const qCalc = (1.0 / this.manningN) * effArea * Math.pow(rh, 2.0 / 3.0) * Math.sqrt(slope);
        const diff = qCalc - this.dischargeQ;
        if (Math.abs(diff) < 0.05) break;

        // Derivative approximation
        const dh = 0.02;
        const h2 = h + dh;
        const tw2 = 2.0 * w0 * Math.sqrt(Math.min(1.0, Math.max(0.05, h2 / dMax)));
        const ca2 = (2.0 / 3.0) * tw2 * h2;
        const ea2 = Math.max(0.6, ca2 - Math.min(ca2 * 0.55, blockedArea));
        const wp2 = tw2 + (8.0 / 3.0) * ((h2 * h2) / Math.max(tw2, 1.0));
        const rh2 = ea2 / Math.max(wp2, 1.0);
        const q2 = (1.0 / this.manningN) * ea2 * Math.pow(rh2, 2.0 / 3.0) * Math.sqrt(slope);
        const dqdh = Math.max((q2 - qCalc) / dh, 0.5);

        h = Math.max(0.2, h - diff / dqdh);
      }

      // Backwater swell upstream of tight obstructions and draw-down at contractions
      const topWidth = 2.0 * w0 * Math.sqrt(Math.min(1.0, Math.max(0.05, h / dMax)));
      const cleanArea = (2.0 / 3.0) * topWidth * h;
      const area = Math.max(0.8, cleanArea - Math.min(cleanArea * 0.55, blockedArea));

      // Physical velocity via continuity: v = Q / A
      const velocity = this.dischargeQ / area;

      // Froude number: Fr = v / sqrt(g * (A / topWidth))
      const hydMeanDepth = Math.max(area / Math.max(topWidth, 1.0), 0.15);
      const froude = velocity / Math.sqrt(this.gravity * hydMeanDepth);

      // Velocity head: Hv = v^2 / (2g)
      const head = (velocity * velocity) / (2.0 * this.gravity);

      // Water surface elevation
      const waterY = bedLowest + h;

      // Foam intensity: created when Froude is high (supercritical rapids) or dynamic head is large
      const foamIntensity = Math.min(1.0, Math.max(0.0, (froude - 0.75) * 1.4 + head * 0.25));

      minV = Math.min(minV, velocity);
      maxV = Math.max(maxV, velocity);
      minFr = Math.min(minFr, froude);
      maxFr = Math.max(maxFr, froude);
      totalD += h;

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
      });

      // Write to texture (RGBA 32F):
      // R: velocity (m/s)
      // G: waterY (absolute world height)
      // B: froude number
      // A: dynamic wave amplitude (head in meters)
      const idx = i * 4;
      this.texData[idx] = velocity;
      this.texData[idx + 1] = waterY;
      this.texData[idx + 2] = froude;
      this.texData[idx + 3] = head;
    }

    this.minVelocity = minV;
    this.maxVelocity = maxV;
    this.minFroude = minFr;
    this.maxFroude = maxFr;
    this.avgDepth = totalD / this.numStations;

    this.texture.needsUpdate = true;
  }

  // CPU query helper along river
  getStationAtZ(z: number): HydraulicStation {
    const clampedZ = Math.max(this.zMin, Math.min(this.zMax, z));
    const t = (clampedZ - this.zMin) / this.length;
    const index = Math.min(this.numStations - 1, Math.max(0, Math.round(t * (this.numStations - 1))));
    return this.stations[index];
  }

  // Cross-sectional velocity taking boundary layer friction (law of the wall) into account
  getVelocityAt(x: number, z: number): number {
    const st = this.getStationAtZ(z);
    const xc = this.getRiverCenter(z);
    const dist = Math.abs(x - xc);
    const w0 = 4.2;
    if (dist >= w0) return 0.2;

    // Parabolic/power profile across channel width: zero at banks, max in center
    const u = dist / w0;
    const wallShear = Math.pow(Math.max(0.0, 1.0 - u * u * u * u), 0.33);
    return Math.max(0.2, st.velocity * wallShear * 1.22);
  }

  getWaterHeightAt(z: number): number {
    return this.getStationAtZ(z).waterY;
  }
}
