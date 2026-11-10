import * as THREE from "three";
import { RiverRocks } from "./riverRocks";

export class RiverSpray {
  readonly maxParticles = 600;
  private geo: THREE.SphereGeometry;
  private mat: THREE.MeshPhysicalMaterial;
  readonly mesh: THREE.InstancedMesh;

  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private dummy = new THREE.Object3D();

  private rocks: RiverRocks;

  constructor(rocks: RiverRocks) {
    this.rocks = rocks;

    this.geo = new THREE.SphereGeometry(0.06, 6, 6);
    this.mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.1,
      metalness: 0.0,
      transmission: 0.85,
      transparent: true,
      opacity: 0.9,
    });

    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.maxParticles);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

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

    // Spawn new spray from boulders
    for (let i = 0; i < this.maxParticles; i++) {
      if (this.life[i] <= 0) {
        if (Math.random() < 0.25 && boulders.length > 0) {
          const b = boulders[Math.floor(Math.random() * boulders.length)];
          const i3 = i * 3;

          // Spawn upstream face of boulder
          this.pos[i3] = b.center.x + (Math.random() - 0.5) * b.radius;
          this.pos[i3 + 1] = b.center.y + b.radius * 0.4;
          this.pos[i3 + 2] = b.center.z - b.radius * 0.8;

          // Blast upwards and outwards
          this.vel[i3] = (Math.random() - 0.5) * 3.5;
          this.vel[i3 + 1] = 2.5 + Math.random() * 3.0;
          this.vel[i3 + 2] = 2.0 + Math.random() * 3.0; // downstream

          this.life[i] = 0.6 + Math.random() * 0.5;
        }
      } else {
        const i3 = i * 3;
        this.life[i] -= dt;

        // Gravity
        this.vel[i3 + 1] -= 9.81 * dt;

        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

        this.dummy.position.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
        const s = Math.max(this.life[i] * 1.5, 0.2);
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
