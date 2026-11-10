import * as THREE from "three";
import { RiverRocks } from "./riverRocks";
import { RiverHydraulics } from "./riverHydraulics";

export class RiverSpray {
  readonly maxParticles = 900;
  private geo: THREE.SphereGeometry;
  private mat: THREE.MeshBasicMaterial;
  readonly mesh: THREE.InstancedMesh;

  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private dummy = new THREE.Object3D();

  private rocks: RiverRocks;
  private hydraulics: RiverHydraulics;

  constructor(rocks: RiverRocks, hydraulics: RiverHydraulics) {
    this.rocks = rocks;
    this.hydraulics = hydraulics;

    // Glistening white-water droplet particles (visible kinetic spray)
    this.geo = new THREE.SphereGeometry(0.08, 6, 6);
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.maxParticles);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 12;

    this.pos = new Float32Array(this.maxParticles * 3);
    this.vel = new Float32Array(this.maxParticles * 3);
    this.life = new Float32Array(this.maxParticles);

    // Initialize dead
    for (let i = 0; i < this.maxParticles; i++) {
      this.life[i] = -1.0;
    }
  }

  update(dt: number) {
    const boulders = this.rocks.boulders;
    let active = 0;

    // Spawn new spray from boulders based on fluid kinetic energy
    for (let i = 0; i < this.maxParticles; i++) {
      if (this.life[i] <= 0) {
        if (boulders.length > 0) {
          const b = boulders[Math.floor(Math.random() * boulders.length)];
          const st = this.hydraulics.getStationAtZ(b.center.z);

          // Kinetic energy threshold: scales aggressively with velocity head Hv = v^2 / 2g
          const spawnThreshold = Math.min(0.85, 0.15 + st.head * 0.35 + (st.froude > 1.0 ? 0.30 : 0.0));

          if (Math.random() < spawnThreshold) {
            const i3 = i * 3;
            const localV = st.velocity;

            // Spawn at upstream impact prow of boulder
            this.pos[i3] = b.center.x + (Math.random() - 0.5) * (b.radius * 0.9);
            this.pos[i3 + 1] = st.waterY + 0.08 + Math.random() * 0.15;
            this.pos[i3 + 2] = b.center.z - b.radius * 0.85;

            // Blast upwards and downstream proportional to kinetic energy
            this.vel[i3] = (Math.random() - 0.5) * (localV * 1.1);
            this.vel[i3 + 1] = localV * (0.85 + Math.random() * 0.95);
            this.vel[i3 + 2] = localV * (1.15 + Math.random() * 1.25);

            this.life[i] = 0.55 + Math.random() * 0.60;
          }
        }
      } else {
        const i3 = i * 3;
        this.life[i] -= dt;

        // Gravity
        this.vel[i3 + 1] -= 9.81 * dt;

        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

        // Kill droplet if it plunges back into river surface
        const st = this.hydraulics.getStationAtZ(this.pos[i3 + 2]);
        if (this.pos[i3 + 1] < st.waterY - 0.05 && this.vel[i3 + 1] < 0) {
          this.life[i] = -1.0;
        }

        this.dummy.position.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
        const s = Math.max(this.life[i] * 1.6, 0.25);
        this.dummy.scale.set(s, s, s);
        this.dummy.updateMatrix();

        this.mesh.setMatrixAt(i, this.dummy.matrix);
        active++;
      }
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = this.maxParticles;
  }
}
