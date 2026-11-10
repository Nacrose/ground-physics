import * as THREE from "three";
import { RiverRocks } from "./riverRocks";
import { RiverHydraulics } from "./riverHydraulics";

function generateSpraySpriteTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = (x + 0.5 - center) / center;
      const dy = (y + 0.5 - center) / center;
      const r = Math.hypot(dx, dy);
      if (r >= 1.0) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = 0;
        continue;
      }
      // Dense droplet nucleus (r < 0.28) + soft billowing Gaussian mist halo
      const core = Math.max(0, 1.0 - (r / 0.28) * (r / 0.28));
      const halo = Math.exp(-r * r * 4.5);
      const alpha = Math.min(1.0, core * 0.90 + halo * 0.60);

      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class RiverSpray {
  readonly maxParticles = 1400;
  readonly mesh: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  private posArray: Float32Array;
  private sizeArray: Float32Array;
  private colorArray: Float32Array;

  private velArray: Float32Array;
  private lifeArray: Float32Array;
  private maxLifeArray: Float32Array;
  private typeArray: Uint8Array; // 0 = Ballistic Droplet, 1 = Billowing Mist

  private rocks: RiverRocks;
  private hydraulics: RiverHydraulics;

  constructor(rocks: RiverRocks, hydraulics: RiverHydraulics, sunDir?: THREE.Vector3) {
    this.rocks = rocks;
    this.hydraulics = hydraulics;

    this.posArray = new Float32Array(this.maxParticles * 3);
    this.sizeArray = new Float32Array(this.maxParticles);
    this.colorArray = new Float32Array(this.maxParticles * 4);

    this.velArray = new Float32Array(this.maxParticles * 3);
    this.lifeArray = new Float32Array(this.maxParticles);
    this.maxLifeArray = new Float32Array(this.maxParticles);
    this.typeArray = new Uint8Array(this.maxParticles);

    for (let i = 0; i < this.maxParticles; i++) {
      this.lifeArray[i] = -1.0;
      this.posArray[i * 3 + 1] = -999.0;
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.posArray, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.sizeArray, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.colorArray, 4).setUsage(THREE.DynamicDrawUsage));

    const spriteTex = generateSpraySpriteTexture(64);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uSprite: { value: spriteTex },
        uSunDir: { value: sunDir || new THREE.Vector3(0.55, 0.75, 0.35).normalize() },
      },
      vertexShader: `
        attribute float aSize;
        attribute vec4 aColor;
        varying vec4 vColor;

        void main() {
          vColor = aColor;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * (420.0 / -mvPos.z), 1.0, 180.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uSprite;
        varying vec4 vColor;

        void main() {
          vec4 tex = texture2D(uSprite, gl_PointCoord);
          vec4 col = vColor * tex;
          if (col.a < 0.012) discard;
          gl_FragColor = col;
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Points(this.geo, this.mat);
    this.mesh.renderOrder = 15;
  }

  update(dt: number) {
    const boulders = this.rocks.boulders;
    const pos = this.posArray;
    const size = this.sizeArray;
    const col = this.colorArray;
    const vel = this.velArray;
    const life = this.lifeArray;
    const maxLife = this.maxLifeArray;
    const type = this.typeArray;

    const clampedDt = Math.min(dt, 0.033);

    for (let i = 0; i < this.maxParticles; i++) {
      const i3 = i * 3;
      const i4 = i * 4;

      if (life[i] <= 0) {
        if (boulders.length > 0) {
          const b = boulders[Math.floor(Math.random() * boulders.length)];
          const st = this.hydraulics.getStationAtZ(b.center.z);

          // Kinetic energy threshold: scales aggressively with velocity head Hv = v^2 / 2g and Froude
          const spawnThreshold = Math.min(0.88, 0.14 + st.head * 0.35 + (st.froude > 1.0 ? 0.30 : 0.0));

          if (Math.random() < spawnThreshold) {
            const localV = st.velocity;
            const isMist = Math.random() < 0.35;
            type[i] = isMist ? 1 : 0;

            // Spawn at upstream impact prow of boulder where water smashes into the rock
            pos[i3] = b.center.x + (Math.random() - 0.5) * (b.radius * 0.85);
            pos[i3 + 1] = st.waterY + 0.06 + Math.random() * 0.12;
            pos[i3 + 2] = b.center.z - b.radius * 0.80;

            if (isMist) {
              // Atomized Mist Puff: lighter, buoyant, billows in air
              vel[i3] = (Math.random() - 0.5) * (localV * 0.85);
              vel[i3 + 1] = localV * (0.45 + Math.random() * 0.65) + 0.35;
              vel[i3 + 2] = localV * (0.80 + Math.random() * 0.95);
              const totalLife = 1.2 + Math.random() * 1.0;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.25;
              col[i4] = 0.96;
              col[i4 + 1] = 0.98;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.0;
            } else {
              // Ballistic Splash Droplet: fast, parabolic arc, splashes into pool
              vel[i3] = (Math.random() - 0.5) * (localV * 1.15);
              vel[i3 + 1] = localV * (0.85 + Math.random() * 1.10);
              vel[i3 + 2] = localV * (1.15 + Math.random() * 1.35); // Races downstream with current!
              const totalLife = 0.45 + Math.random() * 0.45;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.14 + Math.random() * 0.08;
              col[i4] = 1.0;
              col[i4 + 1] = 1.0;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.88;
            }
          }
        }
      } else {
        life[i] -= clampedDt;
        const progress = Math.max(0, 1.0 - life[i] / maxLife[i]); // 0 -> 1

        if (type[i] === 1) {
          // Atomized Mist Physics:
          vel[i3 + 1] -= 1.6 * clampedDt;
          vel[i3] *= (1.0 - 1.8 * clampedDt);
          vel[i3 + 2] *= (1.0 - 1.4 * clampedDt);

          pos[i3] += vel[i3] * clampedDt;
          pos[i3 + 1] += vel[i3 + 1] * clampedDt;
          pos[i3 + 2] += vel[i3 + 2] * clampedDt;

          // Expand puff as it disperses: 0.25m -> 1.15m
          size[i] = 0.25 + progress * 0.90;
          // Smooth bell-curve alpha: fade in, linger, fade out
          const bellAlpha = Math.sin(progress * Math.PI) * 0.42;
          col[i4 + 3] = bellAlpha;
        } else {
          // Ballistic Splash Droplet Physics:
          vel[i3 + 1] -= 9.81 * clampedDt;

          pos[i3] += vel[i3] * clampedDt;
          pos[i3 + 1] += vel[i3 + 1] * clampedDt;
          pos[i3 + 2] += vel[i3 + 2] * clampedDt;

          size[i] = 0.15;
          col[i4 + 3] = Math.max(0, (life[i] / maxLife[i]) * 0.88);

          // Kill droplet immediately upon plunging back into river surface
          const waterY = this.hydraulics.getWaterHeightAt(pos[i3 + 2]);
          if (pos[i3 + 1] < waterY - 0.04 && vel[i3 + 1] < 0) {
            life[i] = -1.0;
            pos[i3 + 1] = -999.0;
          }
        }

        if (life[i] <= 0) {
          pos[i3 + 1] = -999.0;
        }
      }
    }

    const posAttr = this.geo.attributes.position as THREE.BufferAttribute;
    const sizeAttr = this.geo.attributes.aSize as THREE.BufferAttribute;
    const colAttr = this.geo.attributes.aColor as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}
