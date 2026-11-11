import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";
import { RiverRocks } from "./riverRocks";
import { RiverHydraulics } from "./riverHydraulics";
import { SphPhysicsLike, SphRenderer } from "../standalone-sph/sphRenderer";

/**
 * 🌊 3D SPH Fluid Solver for the 80-Meter River Valley
 *
 * Simulates thousands of true 3D Navier-Stokes fluid particles
 * surging down the winding canyon reach, splashing around 10 boulders,
 * interacting with gravel banks, and rendering via the SSFR pipeline.
 */
export class RiverSph implements SphPhysicsLike {
  readonly maxParticles = 4500;
  activeParticles = 0;

  pos: Float32Array;
  vel: Float32Array;
  acc: Float32Array;
  density: Float32Array;
  pressure: Float32Array;

  readonly mass = 1.0;

  params = {
    particleRadius: 0.24,
    smoothingRadius: 0.72,
    restDensity: 12.0,
    stiffness: 85.0,
    viscosity: 0.20,
    gravity: 9.81,
    restitution: 0.30,
    xsphFactor: 0.28,
  };

  terrain: RiverTerrain;
  rocks: RiverRocks;
  hydraulics: RiverHydraulics;
  renderer: SphRenderer;

  // Spatial Hash Partitioning along 80m river reach
  private cellSize: number;
  private gridW = 36;  // X: [-15, +15]
  private gridH = 22;  // Y: [-4, +12]
  private gridD = 100; // Z: [-45, +45]
  private gridOrigin = new THREE.Vector3(-15, -4, -45);
  private gridCount: number;
  private gridHead: Int32Array;
  private gridNext: Int32Array;

  // SPH Kernel Constants
  private poly6Factor = 0;
  private spikyGradFactor = 0;
  private viscLapFactor = 0;
  private h2 = 0;

  private inflowTimer = 0;
  targetSpeed = 4.2;

  constructor(
    scene: THREE.Scene,
    webglRenderer: THREE.WebGLRenderer,
    terrain: RiverTerrain,
    rocks: RiverRocks,
    hydraulics: RiverHydraulics
  ) {
    this.terrain = terrain;
    this.rocks = rocks;
    this.hydraulics = hydraulics;

    const max = this.maxParticles;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.acc = new Float32Array(max * 3);
    this.density = new Float32Array(max);
    this.pressure = new Float32Array(max);

    this.cellSize = this.params.smoothingRadius;
    this.gridCount = this.gridW * this.gridH * this.gridD;
    this.gridHead = new Int32Array(this.gridCount);
    this.gridNext = new Int32Array(max);

    this.updateKernelCoefficients();

    // High-Fidelity SSFR Renderer
    this.renderer = new SphRenderer(scene, webglRenderer, this);

    // Initial prefill of the river channel
    this.initRiverParticles();
  }

  private updateKernelCoefficients() {
    const h = this.params.smoothingRadius;
    this.h2 = h * h;
    this.cellSize = h;

    this.poly6Factor = 315.0 / (64.0 * Math.PI * Math.pow(h, 9));
    this.spikyGradFactor = -45.0 / (Math.PI * Math.pow(h, 6));
    this.viscLapFactor = 45.0 / (Math.PI * Math.pow(h, 6));
  }

  private initRiverParticles() {
    const count = this.maxParticles;
    let idx = 0;
    const spacing = this.params.particleRadius * 1.7;

    // Fill the 80m river channel from upstream z = -38 down to z = +34
    for (let z = -38.0; z <= 34.0 && idx < count; z += spacing * 1.15) {
      const xc = this.terrain.getRiverCenter(z);
      const slope = this.terrain.getBedElevation(z);

      for (let x = xc - 3.2; x <= xc + 3.2 && idx < count; x += spacing) {
        const bedY = this.terrain.getBedHeight(x, z);

        for (let y = bedY + 0.15; y <= bedY + 0.95 && idx < count; y += spacing) {
          const i3 = idx * 3;
          this.pos[i3] = x + (Math.random() - 0.5) * 0.05;
          this.pos[i3 + 1] = y;
          this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.05;

          // Downstream flow velocity along river centerline
          const eps = 0.5;
          const x0 = this.terrain.getRiverCenter(z - eps);
          const x1 = this.terrain.getRiverCenter(z + eps);
          const dirX = (x1 - x0) / (2.0 * eps);

          this.vel[i3] = dirX * 3.8 + (Math.random() - 0.5) * 0.4;
          this.vel[i3 + 1] = -0.35; // gentle descent
          this.vel[i3 + 2] = 4.2 + (Math.random() - 0.5) * 0.6;
          idx++;
        }
      }
    }
    this.activeParticles = idx;
  }

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

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;
      const px = this.pos[i3];
      const py = this.pos[i3 + 1];
      const pz = this.pos[i3 + 2];

      let rho = 0;
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
              const j3 = j * 3;
              const rX = px - this.pos[j3];
              const rY = py - this.pos[j3 + 1];
              const rZ = pz - this.pos[j3 + 2];
              const r2 = rX * rX + rY * rY + rZ * rZ;

              if (r2 < h2) {
                const diff = h2 - r2;
                rho += mass * poly6 * diff * diff * diff;
              }
              j = this.gridNext[j];
            }
          }
        }
      }

      this.density[i] = Math.max(rho, rho0 * 0.5);
      this.pressure[i] = Math.max(0.0, k * (this.density[i] - rho0));
    }
  }

  private computeForces() {
    const h = this.params.smoothingRadius;
    const spiky = this.spikyGradFactor;
    const viscLap = this.viscLapFactor;
    const mu = this.params.viscosity;
    const mass = this.mass;

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;
      const px = this.pos[i3];
      const py = this.pos[i3 + 1];
      const pz = this.pos[i3 + 2];
      const vx = this.vel[i3];
      const vy = this.vel[i3 + 1];
      const vz = this.vel[i3 + 2];
      const pi = this.pressure[i];
      const rhoi = this.density[i];

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
                const rX = px - this.pos[j3];
                const rY = py - this.pos[j3 + 1];
                const rZ = pz - this.pos[j3 + 2];
                const dist = Math.hypot(rX, rY, rZ);

                if (dist > 1e-4 && dist < h) {
                  const pj = this.pressure[j];
                  const rhoj = this.density[j];

                  // Symmetric Pressure Gradient force
                  const pTerm = -mass * (pi / (rhoi * rhoi) + pj / (rhoj * rhoj));
                  const gradW = spiky * Math.pow(h - dist, 2) / dist;
                  fpx += pTerm * gradW * rX;
                  fpy += pTerm * gradW * rY;
                  fpz += pTerm * gradW * rZ;

                  // Viscosity force
                  const vTerm = mu * mass * (viscLap * (h - dist)) / rhoj;
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

      // Gravity: downward acceleration
      this.acc[i3] = (fpx + fvx) / rhoi;
      this.acc[i3 + 1] = (fpy + fvy) / rhoi - this.params.gravity;
      this.acc[i3 + 2] = (fpz + fvz) / rhoi;
    }
  }

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
                const rX = px - this.pos[j3];
                const rY = py - this.pos[j3 + 1];
                const rZ = pz - this.pos[j3 + 2];
                const r2 = rX * rX + rY * rY + rZ * rZ;

                if (r2 < h2) {
                  const diff = h2 - r2;
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

      this.vel[i3] += eps * dvx;
      this.vel[i3 + 1] += eps * dvy;
      this.vel[i3 + 2] += eps * dvz;
    }
  }

  private integrateAndCollide(dt: number) {
    const r = this.params.particleRadius;
    const cr = this.params.restitution;

    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;

      // Verlet / Euler update
      this.vel[i3] += this.acc[i3] * dt;
      this.vel[i3 + 1] += this.acc[i3 + 1] * dt;
      this.vel[i3 + 2] += this.acc[i3 + 2] * dt;

      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      let px = this.pos[i3];
      let py = this.pos[i3 + 1];
      let pz = this.pos[i3 + 2];

      // 1. Terrain Bed & Bank Collision
      const bedY = this.terrain.getBedHeight(px, pz);
      if (py - r <= bedY) {
        this.pos[i3 + 1] = bedY + r;

        // Approximate terrain normal from finite differences
        const eps = 0.15;
        const hL = this.terrain.getBedHeight(px - eps, pz);
        const hR = this.terrain.getBedHeight(px + eps, pz);
        const hD = this.terrain.getBedHeight(px, pz - eps);
        const hU = this.terrain.getBedHeight(px, pz + eps);

        const nx = -(hR - hL) / (2 * eps);
        const ny = 1.0;
        const nz = -(hU - hD) / (2 * eps);
        const invLen = 1.0 / Math.hypot(nx, ny, nz);
        const nNormX = nx * invLen;
        const nNormY = ny * invLen;
        const nNormZ = nz * invLen;

        const vDotN = this.vel[i3] * nNormX + this.vel[i3 + 1] * nNormY + this.vel[i3 + 2] * nNormZ;
        if (vDotN < 0) {
          this.vel[i3] -= (1.0 + cr) * vDotN * nNormX;
          this.vel[i3 + 1] -= (1.0 + cr) * vDotN * nNormY;
          this.vel[i3 + 2] -= (1.0 + cr) * vDotN * nNormZ;
          // Bed sliding friction
          this.vel[i3] *= 0.96;
          this.vel[i3 + 2] *= 0.98;
        }
      }

      // 2. 3D Collision against the 10 River Boulders
      for (const b of this.rocks.boulders) {
        const dx = px - b.center.x;
        const dy = py - b.center.y;
        const dz = pz - b.center.z;
        const dist = Math.hypot(dx, dy, dz);
        const minDist = b.radius + r;

        if (dist < minDist) {
          const invD = dist > 1e-4 ? 1.0 / dist : 1.0;
          const bnx = dx * invD;
          const bny = dy * invD;
          const bnz = dz * invD;

          // Push out of boulder
          const pen = minDist - dist;
          this.pos[i3] += bnx * pen;
          this.pos[i3 + 1] += bny * pen;
          this.pos[i3 + 2] += bnz * pen;

          const vDotB = this.vel[i3] * bnx + this.vel[i3 + 1] * bny + this.vel[i3 + 2] * bnz;
          if (vDotB < 0) {
            this.vel[i3] -= (1.0 + cr) * vDotB * bnx;
            this.vel[i3 + 1] -= (1.0 + cr) * vDotB * bny;
            this.vel[i3 + 2] -= (1.0 + cr) * vDotB * bnz;
            // Upward deflection rooster splash
            this.vel[i3 + 1] += 0.8;
          }
        }
      }

      // 3. Perpetual Downstream Catchment Recycling (z > 37.0 -> recycle to z = -38.5)
      if (this.pos[i3 + 2] > 37.2) {
        const zSpring = -38.2;
        const xcSpring = this.terrain.getRiverCenter(zSpring);
        const bedYSpring = this.terrain.getBedHeight(xcSpring, zSpring);

        this.pos[i3] = xcSpring + (Math.random() - 0.5) * 4.8;
        this.pos[i3 + 1] = bedYSpring + 0.35 + Math.random() * 0.8;
        this.pos[i3 + 2] = zSpring + (Math.random() - 0.5) * 1.5;

        this.vel[i3] = (Math.random() - 0.5) * 0.5;
        this.vel[i3 + 1] = -0.4;
        this.vel[i3 + 2] = this.targetSpeed + Math.random() * 1.0;
      }
    }
  }

  setDischarge(q: number) {
    this.targetSpeed = 2.4 + (q / 22.0) * 2.2;
  }

  addImpulse(x: number, z: number, radius: number, strength: number) {
    const r2 = radius * radius;
    for (let i = 0; i < this.activeParticles; i++) {
      const i3 = i * 3;
      const dx = this.pos[i3] - x;
      const dz = this.pos[i3 + 2] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < r2) {
        const factor = (1.0 - Math.sqrt(d2) / radius) * strength;
        this.vel[i3 + 1] += factor * 3.2; // upward splash
        this.vel[i3] += (dx / (Math.sqrt(d2) + 0.05)) * factor * 1.8;
        this.vel[i3 + 2] += (dz / (Math.sqrt(d2) + 0.05)) * factor * 1.8;
      }
    }
  }

  dropParticlesAt(x: number, z: number, count = 24) {
    const bedY = this.terrain.getBedHeight(x, z);
    for (let k = 0; k < count && this.activeParticles < this.maxParticles; k++) {
      const idx = this.activeParticles++;
      const i3 = idx * 3;
      this.pos[i3] = x + (Math.random() - 0.5) * 0.8;
      this.pos[i3 + 1] = bedY + 1.2 + Math.random() * 0.6;
      this.pos[i3 + 2] = z + (Math.random() - 0.5) * 0.8;

      this.vel[i3] = (Math.random() - 0.5) * 0.6;
      this.vel[i3 + 1] = -1.2;
      this.vel[i3 + 2] = this.targetSpeed * 0.8 + Math.random() * 0.8;
    }
  }

  setRenderMode(mode: "fluid" | "particles") {
    this.renderer.setMode(mode);
  }

  setVisible(visible: boolean) {
    this.renderer.setVisible(visible);
  }

  step(dt: number) {
    const clampedDt = Math.min(dt, 0.022);

    // Continuous Upstream Spring Inflow
    this.inflowTimer += clampedDt;
    if (this.inflowTimer >= 0.025 && this.activeParticles < this.maxParticles) {
      this.inflowTimer = 0;
      const springDrops = 14;
      const zSpring = -38.2;
      const xcSpring = this.terrain.getRiverCenter(zSpring);
      const bedYSpring = this.terrain.getBedHeight(xcSpring, zSpring);

      for (let k = 0; k < springDrops && this.activeParticles < this.maxParticles; k++) {
        const idx = this.activeParticles++;
        const i3 = idx * 3;
        this.pos[i3] = xcSpring + (Math.random() - 0.5) * 4.8;
        this.pos[i3 + 1] = bedYSpring + 0.35 + Math.random() * 0.8;
        this.pos[i3 + 2] = zSpring + (Math.random() - 0.5) * 1.5;

        this.vel[i3] = (Math.random() - 0.5) * 0.5;
        this.vel[i3 + 1] = -0.4;
        this.vel[i3 + 2] = this.targetSpeed + Math.random() * 1.0;
      }
    }

    this.buildSpatialGrid();
    this.computeDensityAndPressure();
    this.computeForces();
    this.computeXSPH();
    this.integrateAndCollide(clampedDt);
  }

  update() {
    this.renderer.update();
  }

  render(cam: THREE.PerspectiveCamera, sunDir?: THREE.Vector3) {
    this.renderer.render(cam, sunDir);
  }

  resize(w: number, h: number) {
    this.renderer.resize(w, h);
  }

  dispose() {
    this.renderer.dispose();
  }
}
