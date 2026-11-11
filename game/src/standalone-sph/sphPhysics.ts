import * as THREE from "three";
import { SphTerrain } from "./terrain";

export interface SphParams {
  particleCount: number;
  particleRadius: number;
  smoothingRadius: number; // H
  restDensity: number;     // rho0
  stiffness: number;       // k in P = k * (rho - rho0)
  viscosity: number;       // mu
  gravity: number;         // g = 9.81
  restitution: number;     // collision energy keep (0.3)
  xsphFactor: number;      // Monaghan 1992 XSPH artificial viscosity (0.28)
}

export type SimPreset = "wave" | "rain" | "crater" | "jet" | "ditch" | "bottle" | "tanker";
export type InteractionMode = "orbit" | "vortex" | "attract" | "repel" | "emit";

export class SphPhysics {
  readonly maxParticles: number;
  activeParticles = 0;

  // Particle Attributes (SOA format for cache efficiency)
  pos: Float32Array;      // [x, y, z] * N
  vel: Float32Array;      // [vx, vy, vz] * N
  acc: Float32Array;      // [ax, ay, az] * N
  density: Float32Array;  // [rho] * N
  pressure: Float32Array; // [P] * N

  // Particle mass
  readonly mass = 1.0;

  // Parameters
  params: SphParams;

  // Spatial Hash Grid for O(N) neighbor lookup
  private cellSize: number;
  private gridW = 36;
  private gridH = 36;
  private gridD = 36;
  private gridCount: number;
  private gridHead: Int32Array;
  private gridNext: Int32Array;
  private gridOrigin = new THREE.Vector3(-18, -10, -18);

  // Kernel Coefficients
  private poly6Factor = 0;
  private spikyGradFactor = 0;
  private viscLapFactor = 0;
  private h2 = 0;

  terrain: SphTerrain;

  // Interactive Cursor Forces (deni10000/Godot-3D-SPH-Fluid-Simulation)
  interactionMode: InteractionMode = "vortex";
  interactionPos = new THREE.Vector3(0, -1.0, 0);
  interactionRadius = 5.5;
  interactionStrength = 65.0;
  isInteracting = false;

  // Bottle Sloshing Simulation State
  isShakingBottle = false;
  private shakeTimer = 0;
  private shakeIntensity = 0;

  // Live Telemetry
  avgDensity = 12.0;
  maxSpeed = 0.0;
  kineticEnergy = 0.0;

  private rainTimer = 0;
  private jetTimer = 0;
  private emitTimer = 0;
  private ditchRainTimer = 0;
  private tankerTimer = 0;
  currentPreset: SimPreset = "wave";

  constructor(terrain: SphTerrain, maxParticles = 16000, options: Partial<SphParams> = {}) {
    this.terrain = terrain;
    this.maxParticles = maxParticles;

    this.params = {
      particleCount: Math.min(6000, maxParticles),
      particleRadius: 0.18,
      smoothingRadius: 0.72,
      restDensity: 12.0,
      stiffness: 85.0,
      viscosity: 0.18,
      gravity: 9.81,
      restitution: 0.32,
      xsphFactor: 0.28, // XSPH surface tension parameter
      ...options,
    };

    this.pos = new Float32Array(maxParticles * 3);
    this.vel = new Float32Array(maxParticles * 3);
    this.acc = new Float32Array(maxParticles * 3);
    this.density = new Float32Array(maxParticles);
    this.pressure = new Float32Array(maxParticles);

    this.cellSize = this.params.smoothingRadius;
    this.gridCount = this.gridW * this.gridH * this.gridD;
    this.gridHead = new Int32Array(this.gridCount);
    this.gridNext = new Int32Array(maxParticles);

    this.updateKernelCoefficients();
    this.applyPreset(this.currentPreset);
  }

  updateKernelCoefficients() {
    const h = this.params.smoothingRadius;
    this.h2 = h * h;
    this.cellSize = h;

    // Poly6 kernel: 315 / (64 * pi * h^9)
    this.poly6Factor = 315.0 / (64.0 * Math.PI * Math.pow(h, 9));
    // Spiky gradient: -45 / (pi * h^6)
    this.spikyGradFactor = -45.0 / (Math.PI * Math.pow(h, 6));
    // Viscosity Laplacian: 45 / (pi * h^6)
    this.viscLapFactor = 45.0 / (Math.PI * Math.pow(h, 6));
  }

  setInteraction(
    active: boolean,
    mode: InteractionMode,
    pos: THREE.Vector3,
    radius = 5.5,
    strength = 65.0
  ) {
    this.isInteracting = active;
    this.interactionMode = mode;
    this.interactionPos.copy(pos);
    this.interactionRadius = radius;
    this.interactionStrength = strength;

    // In bottle mode, dragging also shakes the bottle!
    if (this.currentPreset === "bottle" && active) {
      this.shakeIntensity = Math.min(1.5, this.shakeIntensity + 0.15);
    }
  }

  shakeBottle(durationSec = 2.0) {
    this.isShakingBottle = true;
    this.shakeTimer = durationSec;
    this.shakeIntensity = 1.0;
  }

  applyPreset(preset: SimPreset) {
    this.currentPreset = preset;
    this.terrain.setPreset(preset);
    this.activeParticles = 0;
    this.isShakingBottle = false;
    this.shakeIntensity = 0;

    switch (preset) {
      case "wave": {
        this.terrain.holeEnabled = false;
        // Rectangular dam-break block of water on upper slope (X: -11 to -6)
        const count = Math.min(this.params.particleCount, 5500);
        let idx = 0;
        const spacing = this.params.particleRadius * 1.85;

        for (let x = -11.0; x <= -6.0 && idx < count; x += spacing) {
          for (let y = 3.5; y <= 9.0 && idx < count; y += spacing) {
            for (let z = -3.5; z <= 3.5 && idx < count; z += spacing) {
              const i3 = idx * 3;
              this.pos[i3] = x + (Math.random() - 0.5) * 0.05;
              this.pos[i3 + 1] = y;
              this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.05;
              this.vel[i3] = 4.5;
              this.vel[i3 + 1] = -1.0;
              this.vel[i3 + 2] = (Math.random() - 0.5) * 0.5;
              idx++;
            }
          }
        }
        this.activeParticles = idx;
        break;
      }

      case "ditch": {
        // Ditch Pooling & Lower Elevation Overflow Mode:
        // Initial small puddle in upper ditch; continuous rain fills and overflows across weir notch into lower terrace!
        this.terrain.holeEnabled = false;
        const count = Math.min(this.params.particleCount, 800);
        let idx = 0;
        const spacing = this.params.particleRadius * 1.8;

        for (let x = -5.8; x <= -3.2 && idx < count; x += spacing) {
          for (let y = -1.7; y <= -0.5 && idx < count; y += spacing) {
            for (let z = -2.2; z <= 2.2 && idx < count; z += spacing) {
              const i3 = idx * 3;
              this.pos[i3] = x + (Math.random() - 0.5) * 0.04;
              this.pos[i3 + 1] = y;
              this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.04;
              this.vel[i3] = 0;
              this.vel[i3 + 1] = 0;
              this.vel[i3 + 2] = 0;
              idx++;
            }
          }
        }
        this.activeParticles = idx;
        break;
      }

      case "bottle": {
        // Water in an enclosed bottle with rigid walls (sloshing & shaking)
        this.terrain.holeEnabled = false;
        const count = Math.min(this.params.particleCount, 3800);
        let idx = 0;
        const spacing = this.params.particleRadius * 1.8;

        for (let x = -2.0; x <= 2.0 && idx < count; x += spacing) {
          for (let y = -2.5; y <= 0.6 && idx < count; y += spacing) {
            for (let z = -2.0; z <= 2.0 && idx < count; z += spacing) {
              const i3 = idx * 3;
              this.pos[i3] = x + (Math.random() - 0.5) * 0.03;
              this.pos[i3 + 1] = y;
              this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.03;
              this.vel[i3] = 0;
              this.vel[i3 + 1] = 0;
              this.vel[i3 + 2] = 0;
              idx++;
            }
          }
        }
        this.activeParticles = idx;
        break;
      }

      case "tanker": {
        // High-volume dump from an overhead tanker outlet above the slope
        this.terrain.holeEnabled = false;
        this.activeParticles = 0;
        break;
      }

      case "rain": {
        this.terrain.holeEnabled = false;
        this.activeParticles = 0;
        break;
      }

      case "crater": {
        const count = Math.min(this.params.particleCount, 6000);
        let idx = 0;
        const spacing = this.params.particleRadius * 1.8;
        const radius = this.terrain.craterRadius * 0.75;

        for (let y = -4.2; y <= 0.0 && idx < count; y += spacing) {
          for (let x = -radius; x <= radius && idx < count; x += spacing) {
            for (let z = -radius; z <= radius && idx < count; z += spacing) {
              if (Math.hypot(x, z) < radius) {
                const tY = this.terrain.getHeight(x, z);
                if (y > tY + 0.1) {
                  const i3 = idx * 3;
                  this.pos[i3] = x + (Math.random() - 0.5) * 0.04;
                  this.pos[i3 + 1] = y;
                  this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.04;
                  this.vel[i3] = 0;
                  this.vel[i3 + 1] = 0;
                  this.vel[i3 + 2] = 0;
                  idx++;
                }
              }
            }
          }
        }
        this.activeParticles = idx;
        break;
      }

      case "jet": {
        this.terrain.holeEnabled = false;
        this.activeParticles = 0;
        break;
      }
    }
  }

  // Fast cell indexing for spatial hashing
  private getCellCoord(x: number, y: number, z: number): [number, number, number] {
    const gx = Math.floor((x - this.gridOrigin.x) / this.cellSize);
    const gy = Math.floor((y - this.gridOrigin.y) / this.cellSize);
    const gz = Math.floor((z - this.gridOrigin.z) / this.cellSize);
    return [
      Math.max(0, Math.min(this.gridW - 1, gx)),
      Math.max(0, Math.min(this.gridH - 1, gy)),
      Math.max(0, Math.min(this.gridD - 1, gz)),
    ];
  }

  private getCellIndex(gx: number, gy: number, gz: number): number {
    return gx + gz * this.gridW + gy * (this.gridW * this.gridD);
  }

  private buildSpatialGrid() {
    this.gridHead.fill(-1);

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;
      const [gx, gy, gz] = this.getCellCoord(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      const cellIdx = this.getCellIndex(gx, gy, gz);

      this.gridNext[i] = this.gridHead[cellIdx];
      this.gridHead[cellIdx] = i;
    }
  }

  private computeDensityAndPressure() {
    const h2 = this.h2;
    const poly6 = this.poly6Factor;
    const rho0 = this.params.restDensity;
    const k = this.params.stiffness;
    const mass = this.mass;

    let rhoSum = 0;

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;
      const px = this.pos[i3];
      const py = this.pos[i3 + 1];
      const pz = this.pos[i3 + 2];

      const [cgx, cgy, cgz] = this.getCellCoord(px, py, pz);
      let rho = 0;

      for (let dx = -1; dx <= 1; dx++) {
        const gx = cgx + dx;
        if (gx < 0 || gx >= this.gridW) continue;

        for (let dy = -1; dy <= 1; dy++) {
          const gy = cgy + dy;
          if (gy < 0 || gy >= this.gridH) continue;

          for (let dz = -1; dz <= 1; dz++) {
            const gz = cgz + dz;
            if (gz < 0 || gz >= this.gridD) continue;

            const cellIdx = this.getCellIndex(gx, gy, gz);
            let j = this.gridHead[cellIdx];

            while (j !== -1) {
              const j3 = j * 3;
              const rx = px - this.pos[j3];
              const ry = py - this.pos[j3 + 1];
              const rz = pz - this.pos[j3 + 2];
              const dist2 = rx * rx + ry * ry + rz * rz;

              if (dist2 < h2) {
                const diff = h2 - dist2;
                rho += mass * poly6 * diff * diff * diff;
              }
              j = this.gridNext[j];
            }
          }
        }
      }

      this.density[i] = Math.max(rho, rho0 * 0.5);
      rhoSum += this.density[i];
      this.pressure[i] = Math.max(k * (this.density[i] - rho0), 0.0);
    }

    if (this.activeParticles > 0) {
      this.avgDensity = rhoSum / this.activeParticles;
    }
  }

  private computeForces() {
    const h = this.params.smoothingRadius;
    const spiky = this.spikyGradFactor;
    const viscLap = this.viscLapFactor;
    const mu = this.params.viscosity;
    const mass = this.mass;
    const g = this.params.gravity;

    // Interactive Force params
    const hasForce = this.isInteracting && this.interactionMode !== "orbit" && this.interactionMode !== "emit";
    const iPos = this.interactionPos;
    const iRad = this.interactionRadius;
    const iStr = this.interactionStrength;
    const iMode = this.interactionMode;

    // Bottle shaking dynamic body force acceleration
    let aShakeX = 0, aShakeY = 0, aShakeZ = 0;
    if (this.currentPreset === "bottle" && this.shakeIntensity > 0.01) {
      const t = performance.now() * 0.012;
      aShakeX = Math.sin(t * 1.7) * 38.0 * this.shakeIntensity;
      aShakeY = Math.cos(t * 2.3) * 22.0 * this.shakeIntensity;
      aShakeZ = Math.cos(t * 1.3) * 32.0 * this.shakeIntensity;
    }

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;
      const px = this.pos[i3];
      const py = this.pos[i3 + 1];
      const pz = this.pos[i3 + 2];
      const vx = this.vel[i3];
      const vy = this.vel[i3 + 1];
      const vz = this.vel[i3 + 2];

      const rho_i = this.density[i];
      const P_i = this.pressure[i];

      let fpx = 0, fpy = 0, fpz = 0;
      let fvx = 0, fvy = 0, fvz = 0;

      const [cgx, cgy, cgz] = this.getCellCoord(px, py, pz);

      for (let dx = -1; dx <= 1; dx++) {
        const gx = cgx + dx;
        if (gx < 0 || gx >= this.gridW) continue;

        for (let dy = -1; dy <= 1; dy++) {
          const gy = cgy + dy;
          if (gy < 0 || gy >= this.gridH) continue;

          for (let dz = -1; dz <= 1; dz++) {
            const gz = cgz + dz;
            if (gz < 0 || gz >= this.gridD) continue;

            const cellIdx = this.getCellIndex(gx, gy, gz);
            let j = this.gridHead[cellIdx];

            while (j !== -1) {
              if (i !== j) {
                const j3 = j * 3;
                const rx = px - this.pos[j3];
                const ry = py - this.pos[j3 + 1];
                const rz = pz - this.pos[j3 + 2];
                const dist = Math.hypot(rx, ry, rz);

                if (dist > 1e-4 && dist < h) {
                  const invDist = 1.0 / dist;
                  const dirX = rx * invDist;
                  const dirY = ry * invDist;
                  const dirZ = rz * invDist;

                  const rho_j = this.density[j];
                  const P_j = this.pressure[j];

                  // Symmetric Pressure Force (Müller / SPH)
                  const pKernel = spiky * Math.pow(h - dist, 2);
                  const pTerm = mass * (P_i / (rho_i * rho_i) + P_j / (rho_j * rho_j)) * pKernel;
                  fpx -= pTerm * dirX;
                  fpy -= pTerm * dirY;
                  fpz -= pTerm * dirZ;

                  // Viscosity Force (Laplacian)
                  const vKernel = viscLap * (h - dist);
                  const vTerm = (mu * mass / rho_j) * vKernel;
                  fvx += vTerm * (this.vel[j3] - vx);
                  fvy += vTerm * (this.vel[j3 + 1] - vy);
                  fvz += vTerm * (this.vel[j3 + 2] - vz);
                }
              }
              j = this.gridNext[j];
            }
          }
        }
      }

      // External Interactive Forces (deni10000 GPGPU SPH interaction)
      let uFx = 0, uFy = 0, uFz = 0;
      if (hasForce) {
        const dx = px - iPos.x;
        const dy = py - iPos.y;
        const dz = pz - iPos.z;
        const dist = Math.hypot(dx, dy, dz);

        if (dist < iRad) {
          const invD = dist > 1e-3 ? 1.0 / dist : 1.0;
          const falloff = 1.0 - dist / iRad;

          if (iMode === "attract") {
            uFx = -dx * invD * iStr * falloff;
            uFy = -dy * invD * (iStr * 0.7) * falloff;
            uFz = -dz * invD * iStr * falloff;
          } else if (iMode === "repel") {
            uFx = dx * invD * iStr * 1.35 * falloff;
            uFy = Math.max(0.0, dy * invD) * iStr * 0.9 * falloff;
            uFz = dz * invD * iStr * 1.35 * falloff;
          } else if (iMode === "vortex") {
            const swirlX = -dz * invD;
            const swirlZ = dx * invD;
            uFx = swirlX * iStr * falloff - dx * invD * (iStr * 0.35) * falloff;
            uFz = swirlZ * iStr * falloff - dz * invD * (iStr * 0.35) * falloff;
            uFy = (Math.random() - 0.5) * iStr * 0.2 * falloff;
          }
        }
      }

      this.acc[i3] = fpx + fvx + uFx + aShakeX;
      this.acc[i3 + 1] = fpy + fvy + uFy - g + aShakeY;
      this.acc[i3 + 2] = fpz + fvz + uFz + aShakeZ;
    }
  }

  private integrateAndCollide(dt: number) {
    const bound = 13.5;
    const r = this.params.particleRadius;
    const cr = this.params.restitution;

    // Bottle mode dimensions
    const isBottle = this.currentPreset === "bottle";
    const bW = 2.65;
    const bYMin = -2.85;
    const bYMax = 3.65;
    const bD = 2.65;

    let maxV = 0;
    let sumKE = 0;

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;

      // Symplectic Euler integration
      this.vel[i3] += this.acc[i3] * dt;
      this.vel[i3 + 1] += this.acc[i3 + 1] * dt;
      this.vel[i3 + 2] += this.acc[i3 + 2] * dt;

      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      let px = this.pos[i3];
      let py = this.pos[i3 + 1];
      let pz = this.pos[i3 + 2];

      if (isBottle) {
        // Enclosed Rigid Bottle Walls Collision (6-sided box with glass rebound)
        if (px < -bW) { this.pos[i3] = -bW; this.vel[i3] = -this.vel[i3] * cr; this.vel[i3 + 1] *= 0.94; this.vel[i3 + 2] *= 0.94; }
        if (px > bW)  { this.pos[i3] = bW;  this.vel[i3] = -this.vel[i3] * cr; this.vel[i3 + 1] *= 0.94; this.vel[i3 + 2] *= 0.94; }
        if (pz < -bD) { this.pos[i3 + 2] = -bD; this.vel[i3 + 2] = -this.vel[i3 + 2] * cr; this.vel[i3] *= 0.94; this.vel[i3 + 1] *= 0.94; }
        if (pz > bD)  { this.pos[i3 + 2] = bD;  this.vel[i3 + 2] = -this.vel[i3 + 2] * cr; this.vel[i3] *= 0.94; this.vel[i3 + 1] *= 0.94; }
        if (py < bYMin) { this.pos[i3 + 1] = bYMin; this.vel[i3 + 1] = -this.vel[i3 + 1] * cr; this.vel[i3] *= 0.94; this.vel[i3 + 2] *= 0.94; }
        if (py > bYMax) { this.pos[i3 + 1] = bYMax; this.vel[i3 + 1] = -this.vel[i3 + 1] * cr; this.vel[i3] *= 0.94; this.vel[i3 + 2] *= 0.94; }
      } else {
        // 3D SDF Terrain & Boulder Collision Check
        const col = this.terrain.checkCollision(px, py, pz, r);

        if (col.isInHole) {
          if (py < -9.5) {
            this.pos[i3] = (Math.random() - 0.5) * 8.0;
            this.pos[i3 + 1] = 7.0 + Math.random() * 2.0;
            this.pos[i3 + 2] = (Math.random() - 0.5) * 8.0;
            this.vel[i3] = 0;
            this.vel[i3 + 1] = -2.0;
            this.vel[i3 + 2] = 0;
          }
        } else if (col.isColliding) {
          if (col.isBoulder && col.penetration) {
            this.pos[i3] += col.normal.x * col.penetration;
            this.pos[i3 + 1] += col.normal.y * col.penetration;
            this.pos[i3 + 2] += col.normal.z * col.penetration;
          } else {
            this.pos[i3 + 1] = col.terrainY + r;
          }

          const nx = col.normal.x;
          const ny = col.normal.y;
          const nz = col.normal.z;
          const vDotN = this.vel[i3] * nx + this.vel[i3 + 1] * ny + this.vel[i3 + 2] * nz;

          if (vDotN < 0) {
            this.vel[i3] -= (1.0 + cr) * vDotN * nx;
            this.vel[i3 + 1] -= (1.0 + cr) * vDotN * ny;
            this.vel[i3 + 2] -= (1.0 + cr) * vDotN * nz;
            this.vel[i3] *= 0.94;
            this.vel[i3 + 2] *= 0.94;
          }
        }

        // Domain outer walls
        if (this.pos[i3] < -bound) { this.pos[i3] = -bound; this.vel[i3] *= -cr; }
        if (this.pos[i3] > bound)  { this.pos[i3] = bound;  this.vel[i3] *= -cr; }
        if (this.pos[i3 + 2] < -bound) { this.pos[i3 + 2] = -bound; this.vel[i3 + 2] *= -cr; }
        if (this.pos[i3 + 2] > bound)  { this.pos[i3 + 2] = bound;  this.vel[i3 + 2] *= -cr; }
      }

      const spd = Math.hypot(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
      if (spd > maxV) maxV = spd;
      sumKE += 0.5 * this.mass * spd * spd;
    }

    this.maxSpeed = maxV;
    this.kineticEnergy = sumKE;
  }

  /**
   * XSPH Artificial Viscosity (Monaghan 1992)
   */
  private computeXSPH() {
    const eps = this.params.xsphFactor;
    if (eps <= 0.001) return;

    const h2 = this.h2;
    const poly6 = this.poly6Factor;
    const mass = this.mass;

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;
      const px = this.pos[i3];
      const py = this.pos[i3 + 1];
      const pz = this.pos[i3 + 2];
      const vx = this.vel[i3];
      const vy = this.vel[i3 + 1];
      const vz = this.vel[i3 + 2];

      let dvx = 0, dvy = 0, dvz = 0;
      const [cgx, cgy, cgz] = this.getCellCoord(px, py, pz);

      for (let dx = -1; dx <= 1; dx++) {
        const gx = cgx + dx;
        if (gx < 0 || gx >= this.gridW) continue;

        for (let dy = -1; dy <= 1; dy++) {
          const gy = cgy + dy;
          if (gy < 0 || gy >= this.gridH) continue;

          for (let dz = -1; dz <= 1; dz++) {
            const gz = cgz + dz;
            if (gz < 0 || gz >= this.gridD) continue;

            const cellIdx = this.getCellIndex(gx, gy, gz);
            let j = this.gridHead[cellIdx];

            while (j !== -1) {
              if (i !== j) {
                const j3 = j * 3;
                const rx = px - this.pos[j3];
                const ry = py - this.pos[j3 + 1];
                const rz = pz - this.pos[j3 + 2];
                const dist2 = rx * rx + ry * ry + rz * rz;

                if (dist2 < h2) {
                  const diff = h2 - dist2;
                  const w = poly6 * diff * diff * diff;
                  const rhoAvg = 0.5 * (this.density[i] + this.density[j]);
                  const factor = (mass / rhoAvg) * w;
                  dvx += (this.vel[j3] - vx) * factor;
                  dvy += (this.vel[j3 + 1] - vy) * factor;
                  dvz += (this.vel[j3 + 2] - vz) * factor;
                }
              }
              j = this.gridNext[j];
            }
          }
        }
      }

      this.vel[i3] += dvx * eps;
      this.vel[i3 + 1] += dvy * eps;
      this.vel[i3 + 2] += dvz * eps;
    }
  }

  // Dynamic emitters for Rain, Jet, Ditch Inflow, Tanker Dump, and User Cursor
  private updateEmitters(dt: number) {
    // 1. Ditch Inflow Rain Mode: Pours into upper ditch; spills over weir notch when full!
    if (this.currentPreset === "ditch") {
      this.ditchRainTimer += dt;
      if (this.ditchRainTimer >= 0.04 && this.activeParticles < this.params.particleCount) {
        this.ditchRainTimer = 0;
        const drops = 10;
        for (let k = 0; k < drops && this.activeParticles < this.params.particleCount; k++) {
          const idx = this.activeParticles++;
          const i3 = idx * 3;
          // Spawn rain over upper ditch catchment area
          this.pos[i3] = -4.5 + (Math.random() - 0.5) * 2.8;
          this.pos[i3 + 1] = 4.5 + Math.random() * 1.5;
          this.pos[i3 + 2] = (Math.random() - 0.5) * 2.8;
          this.vel[i3] = (Math.random() - 0.5) * 0.3;
          this.vel[i3 + 1] = -10.0 - Math.random() * 3.0;
          this.vel[i3 + 2] = (Math.random() - 0.5) * 0.3;
        }
      }
    }

    // 2. Tanker Dump Mode: Massive overhead deluge pouring from tanker spout onto slope!
    else if (this.currentPreset === "tanker") {
      this.tankerTimer += dt;
      if (this.tankerTimer >= 0.02 && this.activeParticles < this.params.particleCount) {
        this.tankerTimer = 0;
        const perTick = 18; // Massive volumetric dump
        for (let k = 0; k < perTick && this.activeParticles < this.params.particleCount; k++) {
          const idx = this.activeParticles++;
          const i3 = idx * 3;
          // Tanker spout at (-6.5, 7.5, 0.0)
          this.pos[i3] = -6.5 + (Math.random() - 0.5) * 0.8;
          this.pos[i3 + 1] = 7.5 + (Math.random() - 0.5) * 0.4;
          this.pos[i3 + 2] = (Math.random() - 0.5) * 0.8;
          this.vel[i3] = 3.5 + (Math.random() - 0.5) * 1.5; // forward dump trajectory
          this.vel[i3 + 1] = -12.0 - Math.random() * 2.0;  // high downward velocity
          this.vel[i3 + 2] = (Math.random() - 0.5) * 1.5;
        }
      }
    }

    // 3. Regular Crater Rain
    else if (this.currentPreset === "rain") {
      this.rainTimer += dt;
      if (this.rainTimer >= 0.05 && this.activeParticles < this.params.particleCount) {
        this.rainTimer = 0;
        const drops = 12;
        for (let k = 0; k < drops && this.activeParticles < this.params.particleCount; k++) {
          const idx = this.activeParticles++;
          const i3 = idx * 3;
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.random() * this.terrain.craterRadius * 1.1;
          this.pos[i3] = Math.cos(ang) * rad;
          this.pos[i3 + 1] = 8.5 + Math.random() * 2.0;
          this.pos[i3 + 2] = Math.sin(ang) * rad;
          this.vel[i3] = (Math.random() - 0.5) * 0.4;
          this.vel[i3 + 1] = -12.0 - Math.random() * 4.0;
          this.vel[i3 + 2] = (Math.random() - 0.5) * 0.4;
        }
      }
    }

    // 4. Jet Mode
    else if (this.currentPreset === "jet") {
      this.jetTimer += dt;
      if (this.jetTimer >= 0.025 && this.activeParticles < this.params.particleCount) {
        this.jetTimer = 0;
        const perTick = 8;
        for (let k = 0; k < perTick && this.activeParticles < this.params.particleCount; k++) {
          const idx = this.activeParticles++;
          const i3 = idx * 3;
          this.pos[i3] = -11.5 + (Math.random() - 0.5) * 0.4;
          this.pos[i3 + 1] = 7.0 + (Math.random() - 0.5) * 0.4;
          this.pos[i3 + 2] = (Math.random() - 0.5) * 0.4;
          this.vel[i3] = 16.0 + Math.random() * 3.0;
          this.vel[i3 + 1] = 1.0 + Math.random() * 1.5;
          this.vel[i3 + 2] = (Math.random() - 0.5) * 3.0;
        }
      }
    }

    // 5. User Cursor Fluid Emitter Mode
    if (this.isInteracting && this.interactionMode === "emit") {
      this.emitTimer += dt;
      if (this.emitTimer >= 0.035 && this.activeParticles < this.params.particleCount) {
        this.emitTimer = 0;
        const count = 10;
        for (let k = 0; k < count && this.activeParticles < this.params.particleCount; k++) {
          const idx = this.activeParticles++;
          const i3 = idx * 3;
          this.pos[i3] = this.interactionPos.x + (Math.random() - 0.5) * 0.6;
          this.pos[i3 + 1] = this.interactionPos.y + 0.6 + Math.random() * 0.4;
          this.pos[i3 + 2] = this.interactionPos.z + (Math.random() - 0.5) * 0.6;
          this.vel[i3] = (Math.random() - 0.5) * 2.0;
          this.vel[i3 + 1] = -4.0 - Math.random() * 3.0;
          this.vel[i3 + 2] = (Math.random() - 0.5) * 2.0;
        }
      }
    }
  }

  step(dt: number) {
    const clampedDt = Math.min(dt, 0.033);
    const subSteps = 3;
    const subDt = clampedDt / subSteps;

    // Decay bottle shaking timer
    if (this.isShakingBottle) {
      this.shakeTimer -= clampedDt;
      if (this.shakeTimer <= 0) {
        this.isShakingBottle = false;
        this.shakeIntensity = 0;
      }
    } else {
      this.shakeIntensity = Math.max(0.0, this.shakeIntensity - clampedDt * 1.5);
    }

    for (let s = 0; s < subSteps; s++) {
      this.updateEmitters(subDt);
      if (this.activeParticles === 0) continue;

      this.buildSpatialGrid();
      this.computeDensityAndPressure();
      this.computeForces();
      this.integrateAndCollide(subDt);
      this.computeXSPH(); // Monaghan XSPH surface tension smoothing
    }
  }
}
