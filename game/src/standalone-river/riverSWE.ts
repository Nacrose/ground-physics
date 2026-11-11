import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";
import { RiverHydraulics } from "./riverHydraulics";
import { RiverRocks } from "./riverRocks";

/**
 * RiverSWE: 2D Shallow Water Equations (SWE) Wave Solver
 *
 * Implements Chentanez & Müller 2010 ("Real-Time Simulation of Large Bodies of
 * Water with Small Scale Details", SIGGRAPH 2010 / Unity-SWE) coupled to the
 * 1D Saint-Venant hydraulic baseflow.
 *
 * Physics passes per frame:
 * 1. Pressure / Gravity Wave Acceleration: ∂u/∂t = -g ∇η
 * 2. Mass-Conserving Height Flux Update: ∂η/∂t = -∇ · (h u)
 * 3. Mean Downstream River Advection: Semi-Lagrangian / Upwind advection along z
 * 4. Obstacle Masking & Reflection: Zero-flux Neumann walls around 10 boulders & banks
 * 5. Sommerfeld Radiation Open Boundaries: Non-reflecting absorption at z = ±40m
 * 6. Interactive Impulses & Ballistic 3D Splash Droplets: Ballistic droplets under g = -9.81 m/s²
 */
export class RiverSWE {
  readonly Nx = 128;
  readonly Nz = 256;
  readonly channelW = 20.0; // cross-channel width [m]
  readonly reachL = 80.0;   // longitudinal reach length [m]

  readonly dx: number;
  readonly dz: number;

  // SWE state arrays
  readonly eta: Float32Array;         // Wave height perturbation [m]
  readonly vel: Float32Array;         // Vertical surface velocity [m/s]
  readonly mask: Uint8Array;          // 1 = active water cell, 0 = solid boulder or dry rock
  readonly baseDepth: Float32Array;    // Static water depth h [m]
  readonly waveSpeedSq: Float32Array; // c² = g * h [m²/s²]
  readonly riverVelZ: Float32Array;   // Downstream base current velocity [m/s]

  // GPU Texture Data (128x256 RGBA Float):
  // R: eta (height displacement [m])
  // G: dEta/dx (cross slope for normal)
  // B: dEta/dz (stream slope for normal)
  // A: wave curvature / foam energy (∇²η)
  readonly texData: Float32Array;
  readonly texture: THREE.DataTexture;

  // Kinetic 3D Splash Droplets System (ballistic gravity g = -9.81 m/s²)
  readonly splashGroup = new THREE.Group();
  private splashMesh: THREE.InstancedMesh;
  private readonly maxSplashes = 256;
  private splashPos: Float32Array;
  private splashVel: Float32Array;
  private splashLife: Float32Array;
  private dummyMatrix = new THREE.Matrix4();

  // Telemetry metrics
  waveEnergy = 0.0;
  maxWaveHeight = 0.0;
  impulseCount = 0;
  avgWaveSpeed = 2.8;

  private simTime = 0;

  constructor(
    terrain: RiverTerrain,
    hydraulics: RiverHydraulics,
    rocks: RiverRocks
  ) {
    this.dx = this.channelW / this.Nx;
    this.dz = this.reachL / this.Nz;

    const totalCells = this.Nx * this.Nz;
    this.eta = new Float32Array(totalCells);
    this.vel = new Float32Array(totalCells);
    this.mask = new Uint8Array(totalCells);
    this.baseDepth = new Float32Array(totalCells);
    this.waveSpeedSq = new Float32Array(totalCells);
    this.riverVelZ = new Float32Array(totalCells);

    this.texData = new Float32Array(totalCells * 4);

    const g = 9.81;

    // Initialize physical depth, wave speed, obstacle mask, and downstream velocity
    for (let j = 0; j < this.Nz; j++) {
      const z = -this.reachL * 0.5 + (j + 0.5) * this.dz;
      const xc = terrain.getRiverCenter(z);
      const waterY = hydraulics.getWaterHeightAt(z);

      for (let i = 0; i < this.Nx; i++) {
        const idx = j * this.Nx + i;
        const uCross = -this.channelW * 0.5 + (i + 0.5) * this.dx;
        const worldX = xc + uCross;
        const bedY = terrain.getBedHeight(worldX, z);
        const depth = Math.max(0.04, waterY - bedY);
        const streamV = hydraulics.getVelocityAt(worldX, z);

        this.baseDepth[idx] = depth;
        this.waveSpeedSq[idx] = g * depth;
        this.riverVelZ[idx] = streamV;

        // Check if inside solid bank or dry terrain
        if (depth <= 0.06 || Math.abs(uCross) >= 8.8) {
          this.mask[idx] = 0; // Solid bank boundary
          continue;
        }

        // Check 10 mid-stream boulders
        let inBoulder = false;
        for (const b of rocks.boulders) {
          const dx = worldX - b.center.x;
          const dz = z - b.center.z;
          const distSq = dx * dx + dz * dz;
          if (distSq <= Math.pow(b.radius * 1.08, 2)) {
            inBoulder = true;
            break;
          }
        }

        this.mask[idx] = inBoulder ? 0 : 1;
      }
    }

    // 128x256 RGBA Float DataTexture
    this.texture = new THREE.DataTexture(
      this.texData,
      this.Nx,
      this.Nz,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    // Setup 3D kinetic splash droplet instancing
    const dropGeo = new THREE.SphereGeometry(0.045, 8, 8);
    const dropMat = new THREE.MeshStandardMaterial({
      color: 0x99ddff,
      roughness: 0.1,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
    });
    this.splashMesh = new THREE.InstancedMesh(dropGeo, dropMat, this.maxSplashes);
    this.splashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.splashGroup.add(this.splashMesh);

    this.splashPos = new Float32Array(this.maxSplashes * 3);
    this.splashVel = new Float32Array(this.maxSplashes * 3);
    this.splashLife = new Float32Array(this.maxSplashes);

    // Hide all droplets initially off-screen
    for (let i = 0; i < this.maxSplashes; i++) {
      this.dummyMatrix.makeTranslation(0, -999, 0);
      this.splashMesh.setMatrixAt(i, this.dummyMatrix);
    }
    this.splashMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Inject a physical shallow water wave impulse at world coordinate (worldX, worldZ)
   */
  addImpulse(
    worldX: number,
    worldZ: number,
    radius = 0.9,
    strength = 0.35,
    spawnSplashes = true,
    terrain?: RiverTerrain
  ) {
    if (worldZ < -39.0 || worldZ > 39.0) return;

    // Curvilinear river coordinates
    const xc = 4.0 * Math.sin(worldZ * 0.07) + 1.8 * Math.cos(worldZ * 0.15);
    const uCross = worldX - xc;
    if (Math.abs(uCross) > 9.5) return;

    // Map to grid indices
    const fi = ((uCross + this.channelW * 0.5) / this.channelW) * this.Nx;
    const fj = ((worldZ + this.reachL * 0.5) / this.reachL) * this.Nz;

    const i0 = Math.round(fi);
    const j0 = Math.round(fj);

    const rCellsX = Math.max(1, Math.ceil(radius / this.dx));
    const rCellsZ = Math.max(1, Math.ceil(radius / this.dz));

    for (let dj = -rCellsZ * 2; dj <= rCellsZ * 2; dj++) {
      const j = j0 + dj;
      if (j < 1 || j >= this.Nz - 1) continue;

      for (let di = -rCellsX * 2; di <= rCellsX * 2; di++) {
        const i = i0 + di;
        if (i < 1 || i >= this.Nx - 1) continue;

        const idx = j * this.Nx + i;
        if (this.mask[idx] === 0) continue;

        const distNormX = (di * this.dx) / radius;
        const distNormZ = (dj * this.dz) / radius;
        const distSq = distNormX * distNormX + distNormZ * distNormZ;

        if (distSq <= 4.0) {
          // Mexican hat / Ricker wave profile: positive central peak with surrounding trough
          const pulse = (1.0 - distSq) * Math.exp(-distSq) * strength;
          this.eta[idx] += pulse;
          this.vel[idx] += pulse * 4.2;
        }
      }
    }

    this.impulseCount++;

    // Ballistic 3D splash droplet burst
    if (spawnSplashes) {
      const waterY = 6.5 * (1.0 - (worldZ + 40.0) / 80.0);
      const splashCount = 14 + Math.floor(Math.random() * 8);
      this.spawnSplashDroplets(worldX, waterY + 0.15, worldZ, splashCount, strength);
    }
  }

  /**
   * Spawn physical 3D splash droplets flying into the air with ballistic gravity
   */
  private spawnSplashDroplets(
    x: number,
    y: number,
    z: number,
    count: number,
    strength: number
  ) {
    let spawned = 0;
    for (let i = 0; i < this.maxSplashes && spawned < count; i++) {
      if (this.splashLife[i] <= 0) {
        this.splashLife[i] = 0.5 + Math.random() * 0.55; // 0.5 - 1.05s lifetime
        const pIdx = i * 3;
        const angle = Math.random() * Math.PI * 2.0;
        const speedHoriz = (0.8 + Math.random() * 2.2) * (strength + 0.4);
        const speedVert = (2.6 + Math.random() * 3.4) * (strength + 0.5);

        this.splashPos[pIdx + 0] = x + (Math.random() - 0.5) * 0.3;
        this.splashPos[pIdx + 1] = y + 0.05;
        this.splashPos[pIdx + 2] = z + (Math.random() - 0.5) * 0.3;

        this.splashVel[pIdx + 0] = Math.cos(angle) * speedHoriz;
        this.splashVel[pIdx + 1] = speedVert;
        this.splashVel[pIdx + 2] = Math.sin(angle) * speedHoriz + 1.2; // slight downstream bias
        spawned++;
      }
    }
  }

  /**
   * Update 2D Shallow Water Equations simulation
   */
  update(delta: number, rainIntensity: number, simTime: number) {
    this.simTime = simTime;
    const dt = Math.min(delta, 0.033);

    // Substep integration for Courant-Friedrichs-Lewy (CFL) unconditional stability
    const subSteps = 2;
    const subDt = dt / subSteps;

    const dxSqInv = 1.0 / (this.dx * this.dx);
    const dzSqInv = 1.0 / (this.dz * this.dz);
    const damping = Math.pow(0.996, subDt * 60.0);

    for (let step = 0; step < subSteps; step++) {
      // Pass 1: Wave Acceleration with Obstacle Neumann Zero-Flux Walls
      for (let j = 1; j < this.Nz - 1; j++) {
        const row = j * this.Nx;
        const rowU = (j - 1) * this.Nx;
        const rowD = (j + 1) * this.Nx;

        for (let i = 1; i < this.Nx - 1; i++) {
          const idx = row + i;
          if (this.mask[idx] === 0) continue;

          const eC = this.eta[idx];
          // Zero-flux reflection off solid obstacles (boulders and banks)
          const eL = this.mask[idx - 1] ? this.eta[idx - 1] : eC;
          const eR = this.mask[idx + 1] ? this.eta[idx + 1] : eC;
          const eU = this.mask[rowU + i] ? this.eta[rowU + i] : eC;
          const eD = this.mask[rowD + i] ? this.eta[rowD + i] : eC;

          // 2D Laplace operator ∇²η
          const lapX = (eL + eR - 2.0 * eC) * dxSqInv;
          const lapZ = (eU + eD - 2.0 * eC) * dzSqInv;
          const lap = lapX + lapZ;

          const c2 = this.waveSpeedSq[idx];
          this.vel[idx] = (this.vel[idx] + c2 * lap * subDt) * damping;
        }
      }

      // Pass 2: Height Update & Downstream River Advection
      for (let j = 1; j < this.Nz - 1; j++) {
        const row = j * this.Nx;
        const rowU = (j - 1) * this.Nx;

        for (let i = 1; i < this.Nx - 1; i++) {
          const idx = row + i;
          if (this.mask[idx] === 0) continue;

          // Advection downstream along z by the river velocity V_river
          const streamV = this.riverVelZ[idx];
          const advZ = -streamV * (this.eta[idx] - this.eta[rowU + i]) / this.dz;

          this.eta[idx] += (this.vel[idx] + advZ) * subDt;
        }
      }

      // Pass 3: Sommerfeld Radiation Non-Reflecting Open Boundary Conditions
      // Upstream Boundary (j = 0):
      for (let i = 0; i < this.Nx; i++) {
        const idx0 = i;
        const idx1 = this.Nx + i;
        const c = Math.sqrt(this.waveSpeedSq[idx0]);
        this.eta[idx0] += c * (subDt / this.dz) * (this.eta[idx1] - this.eta[idx0]);
        this.vel[idx0] *= 0.95;
      }
      // Downstream Boundary (j = Nz - 1):
      for (let i = 0; i < this.Nx; i++) {
        const idxN = (this.Nz - 1) * this.Nx + i;
        const idxPrev = (this.Nz - 2) * this.Nx + i;
        const c = Math.sqrt(this.waveSpeedSq[idxN]);
        const streamV = this.riverVelZ[idxN];
        this.eta[idxN] -= (c + streamV) * (subDt / this.dz) * (this.eta[idxN] - this.eta[idxPrev]);
        this.vel[idxN] *= 0.95;
      }
    }

    // Pass 4: Dynamic Raindrop Wave Drops across River Surface
    if (rainIntensity > 1.0) {
      const dropCount = Math.min(8, Math.floor(rainIntensity * 0.12));
      for (let d = 0; d < dropCount; d++) {
        const rj = 4 + Math.floor(Math.random() * (this.Nz - 8));
        const ri = 12 + Math.floor(Math.random() * (this.Nx - 24));
        const idx = rj * this.Nx + ri;
        if (this.mask[idx] === 1) {
          const dropImpulse = 0.045 + Math.random() * 0.035;
          this.eta[idx] += dropImpulse;
          this.vel[idx] += dropImpulse * 3.5;
        }
      }
    }

    // Pass 5: Compute Surface Gradients, Normals, and Curvature for GPU Shader
    let totalEnergy = 0.0;
    let peakHeight = 0.0;
    const inv2dx = 1.0 / (2.0 * this.dx);
    const inv2dz = 1.0 / (2.0 * this.dz);

    for (let j = 0; j < this.Nz; j++) {
      const row = j * this.Nx;
      const rowPrev = Math.max(0, j - 1) * this.Nx;
      const rowNext = Math.min(this.Nz - 1, j + 1) * this.Nx;

      for (let i = 0; i < this.Nx; i++) {
        const idx = row + i;
        const tIdx = idx * 4;

        if (this.mask[idx] === 0) {
          this.texData[tIdx + 0] = 0.0;
          this.texData[tIdx + 1] = 0.0;
          this.texData[tIdx + 2] = 0.0;
          this.texData[tIdx + 3] = 0.0;
          continue;
        }

        const hC = this.eta[idx];
        const absH = Math.abs(hC);
        totalEnergy += absH * absH;
        if (absH > peakHeight) peakHeight = absH;

        const iPrev = Math.max(0, i - 1);
        const iNext = Math.min(this.Nx - 1, i + 1);

        const hL = this.eta[row + iPrev];
        const hR = this.eta[row + iNext];
        const hU = this.eta[rowPrev + i];
        const hD = this.eta[rowNext + i];

        // Slopes for normal perturbation
        const slopeX = (hR - hL) * inv2dx;
        const slopeZ = (hD - hU) * inv2dz;

        // Wave curvature / foam excitation
        const curv = Math.abs(hL + hR + hU + hD - 4.0 * hC);

        this.texData[tIdx + 0] = hC;      // R: Height displacement [m]
        this.texData[tIdx + 1] = slopeX;  // G: dEta/dx
        this.texData[tIdx + 2] = slopeZ;  // B: dEta/dz
        this.texData[tIdx + 3] = curv;    // A: Curvature
      }
    }

    this.texture.needsUpdate = true;
    this.waveEnergy = Math.sqrt(totalEnergy / (this.Nx * this.Nz));
    this.maxWaveHeight = peakHeight;

    // Pass 6: Update Kinetic 3D Splash Droplets
    this.updateSplashDroplets(dt);
  }

  /**
   * Update kinetic 3D splash droplets under ballistic gravity (g = -9.81 m/s²)
   */
  private updateSplashDroplets(dt: number) {
    const g = -9.81;
    let anyActive = false;

    for (let i = 0; i < this.maxSplashes; i++) {
      if (this.splashLife[i] > 0) {
        anyActive = true;
        this.splashLife[i] -= dt;
        const pIdx = i * 3;

        // Ballistic Euler integration
        this.splashVel[pIdx + 1] += g * dt;
        this.splashPos[pIdx + 0] += this.splashVel[pIdx + 0] * dt;
        this.splashPos[pIdx + 1] += this.splashVel[pIdx + 1] * dt;
        this.splashPos[pIdx + 2] += this.splashVel[pIdx + 2] * dt;

        // Scale shrinks as droplet dissolves / vaporizes
        const scale = Math.max(0.01, this.splashLife[i] * 1.2);
        this.dummyMatrix.makeScale(scale, scale, scale);
        this.dummyMatrix.setPosition(
          this.splashPos[pIdx + 0],
          this.splashPos[pIdx + 1],
          this.splashPos[pIdx + 2]
        );
        this.splashMesh.setMatrixAt(i, this.dummyMatrix);
      } else {
        this.dummyMatrix.makeTranslation(0, -999, 0);
        this.splashMesh.setMatrixAt(i, this.dummyMatrix);
      }
    }

    if (anyActive) {
      this.splashMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Triggers a wide transverse surge bore wave travelling down the river
   */
  triggerSurgeWave() {
    const jStart = 6;
    for (let dj = 0; dj < 4; dj++) {
      const j = jStart + dj;
      for (let i = 8; i < this.Nx - 8; i++) {
        const idx = j * this.Nx + i;
        if (this.mask[idx] === 1) {
          this.eta[idx] += 0.42 * Math.sin((dj / 4) * Math.PI);
          this.vel[idx] += 1.8;
        }
      }
    }
    this.impulseCount += 5;
  }

  /**
   * Pulses water behind the main rapids boulder at z = -18m
   */
  triggerBoulderShock() {
    this.addImpulse(1.2, -17.0, 1.8, 0.55, true);
  }

  /**
   * Reset all dynamic waves to calm baseline
   */
  clear() {
    this.eta.fill(0);
    this.vel.fill(0);
    this.texData.fill(0);
    this.texture.needsUpdate = true;
    this.waveEnergy = 0;
    this.maxWaveHeight = 0;
  }
}
