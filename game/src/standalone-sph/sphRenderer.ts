import * as THREE from "three";
import { SphPhysics } from "./sphPhysics";

export type RenderMode = "fluid" | "particles";

export class SphRenderer {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly physics: SphPhysics;

  mode: RenderMode = "fluid";

  // Particle Point Cloud
  private pointsGeo: THREE.BufferGeometry;
  private pointsMat: THREE.ShaderMaterial;
  private pointsMesh: THREE.Points;

  // Fluid Mesh / Screen Space representation
  private fluidMat: THREE.MeshPhysicalMaterial;
  private instancedFluidGeo: THREE.SphereGeometry;
  private instancedFluidMesh: THREE.InstancedMesh;

  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, physics: SphPhysics) {
    this.scene = scene;
    this.renderer = renderer;
    this.physics = physics;

    const max = physics.maxParticles;

    // 1. Points geometry for particle mode
    this.pointsGeo = new THREE.BufferGeometry();
    this.pointsGeo.setAttribute("position", new THREE.BufferAttribute(physics.pos, 3));
    this.pointsGeo.setAttribute("velocity", new THREE.BufferAttribute(physics.vel, 3));

    this.pointsMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x38bdf8) },
        uRadius: { value: physics.params.particleRadius * 160.0 },
      },
      vertexShader: `
        attribute vec3 velocity;
        varying vec3 vVel;
        varying float vSpeed;
        uniform float uRadius;

        void main() {
          vVel = velocity;
          vSpeed = length(velocity);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uRadius / -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vVel;
        varying float vSpeed;
        uniform vec3 uColor;

        void main() {
          // Circular point sprite with specular highlight
          vec2 coord = gl_PointCoord - vec2(0.5);
          float dist2 = dot(coord, coord);
          if (dist2 > 0.25) discard;

          float normalZ = sqrt(max(0.25 - dist2, 0.0)) * 2.0;
          vec3 N = normalize(vec3(coord * 2.0, normalZ));
          vec3 L = normalize(vec3(0.5, 0.8, 0.4));
          float NdotL = max(dot(N, L), 0.0);
          float spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 32.0);

          vec3 baseColor = mix(vec3(0.05, 0.35, 0.85), vec3(0.35, 0.85, 1.0), clamp(vSpeed * 0.1, 0.0, 1.0));
          vec3 finalColor = baseColor * (0.3 + 0.7 * NdotL) + vec3(1.0) * spec;

          gl_FragColor = vec4(finalColor, 0.95);
        }
      `,
      transparent: true,
      depthWrite: true,
    });

    this.pointsMesh = new THREE.Points(this.pointsGeo, this.pointsMat);
    this.pointsMesh.visible = false;
    scene.add(this.pointsMesh);

    // 2. High-performance Physical Fluid Mesh (Instanced smooth water droplets with transmission)
    this.instancedFluidGeo = new THREE.SphereGeometry(physics.params.particleRadius * 1.35, 12, 10);
    this.fluidMat = new THREE.MeshPhysicalMaterial({
      color: 0x0077ff,
      roughness: 0.06,
      metalness: 0.0,
      transmission: 0.88,
      ior: 1.333,
      thickness: 1.4,
      transparent: true,
      opacity: 0.92,
    });

    this.instancedFluidMesh = new THREE.InstancedMesh(this.instancedFluidGeo, this.fluidMat, max);
    this.instancedFluidMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedFluidMesh.castShadow = true;
    this.instancedFluidMesh.receiveShadow = true;
    scene.add(this.instancedFluidMesh);

    this.setMode(this.mode);
  }

  setMode(mode: RenderMode) {
    this.mode = mode;
    if (mode === "fluid") {
      this.instancedFluidMesh.visible = true;
      this.pointsMesh.visible = false;
    } else {
      this.instancedFluidMesh.visible = false;
      this.pointsMesh.visible = true;
    }
  }

  update() {
    const count = this.physics.activeParticles;

    if (this.mode === "fluid") {
      this.instancedFluidMesh.count = count;
      const pos = this.physics.pos;
      const vel = this.physics.vel;

      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        this.dummy.position.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);

        // Slight velocity stretching for hydrodynamic look
        const vx = vel[i3];
        const vy = vel[i3 + 1];
        const vz = vel[i3 + 2];
        const speed = Math.hypot(vx, vy, vz);

        if (speed > 1.5) {
          const stretch = Math.min(1.0 + speed * 0.04, 1.8);
          this.dummy.scale.set(1.0 / Math.sqrt(stretch), stretch, 1.0 / Math.sqrt(stretch));
          this.dummy.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(vx / speed, vy / speed, vz / speed)
          );
        } else {
          this.dummy.scale.set(1, 1, 1);
          this.dummy.quaternion.identity();
        }

        this.dummy.updateMatrix();
        this.instancedFluidMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.instancedFluidMesh.instanceMatrix.needsUpdate = true;
    } else {
      // Points mode
      const posAttr = this.pointsGeo.getAttribute("position") as THREE.BufferAttribute;
      const velAttr = this.pointsGeo.getAttribute("velocity") as THREE.BufferAttribute;

      posAttr.needsUpdate = true;
      velAttr.needsUpdate = true;
      this.pointsGeo.setDrawRange(0, count);
    }
  }
}
