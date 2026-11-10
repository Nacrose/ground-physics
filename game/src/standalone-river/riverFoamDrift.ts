import * as THREE from "three";
import { RiverHydraulics } from "./riverHydraulics";
import { RiverRocks } from "./riverRocks";

export class RiverFoamDrift {
  readonly maxParticles = 1200;
  readonly mesh: THREE.InstancedMesh;

  private xOffset: Float32Array; // offset from river centerline
  private zPos: Float32Array;    // z along river [-40, +40]
  private baseScale: Float32Array;
  private rot: Float32Array;
  private spinSpeed: Float32Array;

  private dummy = new THREE.Object3D();
  private hydraulics: RiverHydraulics;
  private rocks: RiverRocks;

  constructor(hydraulics: RiverHydraulics, rocks: RiverRocks) {
    this.hydraulics = hydraulics;
    this.rocks = rocks;

    // Disc / squashed sphere for floating foam clumps
    const geo = new THREE.CylinderGeometry(0.18, 0.18, 0.03, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xf0fdf4,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, this.maxParticles);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 12;

    this.xOffset = new Float32Array(this.maxParticles);
    this.zPos = new Float32Array(this.maxParticles);
    this.baseScale = new Float32Array(this.maxParticles);
    this.rot = new Float32Array(this.maxParticles);
    this.spinSpeed = new Float32Array(this.maxParticles);

    // Seed foam clumps distributed along entire 80m river corridor
    for (let i = 0; i < this.maxParticles; i++) {
      this.zPos[i] = -39.0 + (i / this.maxParticles) * 78.0 + (Math.random() - 0.5) * 1.5;
      // Normal distribution toward center channel
      const u = (Math.random() - 0.5) + (Math.random() - 0.5);
      this.xOffset[i] = u * 2.8;
      this.baseScale[i] = 0.5 + Math.random() * 0.9;
      this.rot[i] = Math.random() * Math.PI * 2.0;
      this.spinSpeed[i] = (Math.random() - 0.5) * 2.5;
    }
  }

  update(dt: number) {
    const boulders = this.rocks.boulders;

    for (let i = 0; i < this.maxParticles; i++) {
      let z = this.zPos[i];
      let xOff = this.xOffset[i];
      const xc = this.hydraulics.getRiverCenter(z);
      const worldX = xc + xOff;

      // 1. Physical Velocity from Saint-Venant Solver
      let v = this.hydraulics.getVelocityAt(worldX, z);

      // Check for boulder interactions
      for (const b of boulders) {
        const dx = worldX - b.center.x;
        const dz = z - b.center.z;
        const dist = Math.hypot(dx, dz);

        // Boulder deflection around flanks
        if (dist < b.radius + 0.3) {
          xOff += Math.sign(dx || 0.1) * 3.5 * dt;
          v *= 0.5;
        }

        // Leeward eddy wake: behind boulder
        if (dz > 0.1 && dz < b.radius * 3.2 && Math.abs(dx) < b.radius * 1.1) {
          // Foam gets trapped and slowly spins in the eddy
          v *= 0.25;
          this.rot[i] += 4.5 * dt;
        }
      }

      // Advect downstream with physical current
      z += v * dt;
      this.rot[i] += this.spinSpeed[i] * dt;

      // Wrap around when reaching downstream exit
      if (z > 39.5) {
        z = -39.5 + Math.random() * 2.0;
        const u = (Math.random() - 0.5) + (Math.random() - 0.5);
        xOff = u * 2.8;
      }

      this.zPos[i] = z;
      this.xOffset[i] = xOff;

      // Place exactly on dynamic water surface
      const finalXc = this.hydraulics.getRiverCenter(z);
      const waterY = this.hydraulics.getWaterHeightAt(z);

      // Standing wave dynamic heave
      const st = this.hydraulics.getStationAtZ(z);
      const waveHeave = Math.sin(z * 1.4) * (st.head * 0.12);

      this.dummy.position.set(finalXc + xOff, waterY + 0.02 + waveHeave, z);
      this.dummy.rotation.set(0, this.rot[i], 0);

      // Scale stretched in flow direction proportionally to speed (motion blur elongation)
      const speedStretch = Math.min(2.5, 1.0 + v * 0.18);
      const s = this.baseScale[i];
      this.dummy.scale.set(s * 0.85, s * 0.5, s * speedStretch);
      this.dummy.updateMatrix();

      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
