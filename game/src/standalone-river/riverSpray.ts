import * as THREE from "three";
import { RiverRocks } from "./riverRocks";
import { RiverHydraulics } from "./riverHydraulics";
import { RiverTerrain } from "./riverTerrain";

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
      // Glowing liquid droplet nucleus (r < 0.45) with soft natural falloff
      const core = Math.max(0, 1.0 - (r / 0.45) * (r / 0.45));
      const halo = Math.exp(-r * r * 4.2);
      const alpha = Math.min(1.0, core * 0.90 + halo * 0.55);

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
  readonly maxParticles = 4200;
  readonly mesh: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  private posArray: Float32Array;
  private sizeArray: Float32Array;
  private colorArray: Float32Array;

  private velArray: Float32Array;
  private lifeArray: Float32Array;
  private maxLifeArray: Float32Array;
  private typeArray: Uint8Array; // 0 = Ballistic Droplet, 1 = Fine Mist

  private rocks: RiverRocks;
  private hydraulics: RiverHydraulics;
  private terrain?: RiverTerrain;

  constructor(rocks: RiverRocks, hydraulics: RiverHydraulics, sunDir?: THREE.Vector3, terrain?: RiverTerrain) {
    this.rocks = rocks;
    this.hydraulics = hydraulics;
    this.terrain = terrain;

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
          // Tangible, clearly visible spray scale (4 to 75 pixels across typical viewing distances)
          gl_PointSize = clamp(aSize * (1250.0 / -mvPos.z), 3.0, 75.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uSprite;
        uniform vec3 uSunDir;
        varying vec4 vColor;

        void main() {
          vec4 tex = texture2D(uSprite, gl_PointCoord);
          vec4 col = vColor * tex;
          if (col.a < 0.012) discard;

          // Sparkling liquid sun glint on droplet surface:
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float glint = pow(max(0.0, 1.0 - length(p - vec2(0.25, 0.25)) * 2.2), 3.0) * 1.8;
          col.rgb += vec3(glint) * col.a;

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
        const isMist = Math.random() < 0.20; // 80% sparkling ballistic droplets, 20% soft mist
        type[i] = isMist ? 1 : 0;

        const spawnRoll = Math.random();
        if (spawnRoll < 0.80 && boulders.length > 0) {
          const b = boulders[Math.floor(Math.random() * boulders.length)];
          const st = this.hydraulics.getStationAtZ(b.center.z);
          const localV = st.velocity;

          if (spawnRoll < 0.60) {
            // Zone A: Upstream Bow Impact (water violently crashing into boulder's upstream face)
            const angle = (Math.random() - 0.5) * Math.PI * 0.85;
            const rDist = b.radius * (0.75 + Math.random() * 0.25);
            pos[i3] = b.center.x + Math.sin(angle) * rDist;
            pos[i3 + 1] = st.waterY + 0.05 + Math.random() * 0.08;
            pos[i3 + 2] = b.center.z - Math.cos(angle) * rDist; // Upstream face (-z)

            const outDirX = Math.sin(angle);

            if (isMist) {
              // Soft billowy mist puff rising over rock
              vel[i3] = outDirX * (localV * 0.35);
              vel[i3 + 1] = 0.90 + Math.random() * 1.10;
              vel[i3 + 2] = localV * (0.75 + Math.random() * 0.40);
              const totalLife = 0.60 + Math.random() * 0.45;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.35;
              col[i4] = 0.95;
              col[i4 + 1] = 0.98;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.0;
            } else {
              // Energetic ballistic droplet curling over boulder
              vel[i3] = outDirX * localV * (0.45 + Math.random() * 0.50);
              vel[i3 + 1] = 1.80 + Math.random() * 2.50; // Flight time ~ 0.4 - 0.7s
              vel[i3 + 2] = localV * (0.95 + Math.random() * 0.50);
              const totalLife = 0.38 + Math.random() * 0.32;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.12 + Math.random() * 0.09;
              col[i4] = 1.0;
              col[i4 + 1] = 1.0;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.95;
            }
          } else {
            // Zone B: Downstream Wake Rooster Tail & Turbulent Boil (streams recombining behind boulder)
            const wakeOffsetZ = b.radius * (0.35 + Math.random() * 1.40);
            const wakeOffsetX = (Math.random() - 0.5) * (b.radius * 1.20);
            pos[i3] = b.center.x + wakeOffsetX;
            pos[i3 + 1] = st.waterY + 0.04 + Math.random() * 0.06;
            pos[i3 + 2] = b.center.z + wakeOffsetZ;

            if (isMist) {
              vel[i3] = wakeOffsetX * 1.2;
              vel[i3 + 1] = 0.85 + Math.random() * 0.90;
              vel[i3 + 2] = localV * (0.65 + Math.random() * 0.35);
              const totalLife = 0.55 + Math.random() * 0.40;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.32;
              col[i4] = 0.95;
              col[i4 + 1] = 0.98;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.0;
            } else {
              vel[i3] = (Math.random() - 0.5) * 1.6;
              vel[i3 + 1] = 1.40 + Math.random() * 1.90;
              vel[i3 + 2] = localV * (0.80 + Math.random() * 0.45);
              const totalLife = 0.32 + Math.random() * 0.28;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.11 + Math.random() * 0.07;
              col[i4] = 1.0;
              col[i4 + 1] = 1.0;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.92;
            }
          }
        } else {
          // Zone C: Rapid Chute Crests & Supercritical Waves
          const zRand = -32.0 + Math.random() * 64.0;
          const st = this.hydraulics.getStationAtZ(zRand);
          const localV = st.velocity;
          const xc = this.hydraulics.getRiverCenter(zRand);

          pos[i3] = xc + (Math.random() - 0.5) * 3.8;
          pos[i3 + 1] = st.waterY + 0.04 + Math.random() * 0.06;
          pos[i3 + 2] = zRand;

          vel[i3] = (Math.random() - 0.5) * (localV * 0.45);
          vel[i3 + 1] = 1.50 + Math.random() * 2.00;
          vel[i3 + 2] = localV * (1.05 + Math.random() * 0.45);

          const totalLife = 0.32 + Math.random() * 0.28;
          life[i] = totalLife;
          maxLife[i] = totalLife;
          size[i] = 0.11 + Math.random() * 0.07;
          col[i4] = 1.0;
          col[i4 + 1] = 1.0;
          col[i4 + 2] = 1.0;
          col[i4 + 3] = 0.90;
        }
      } else {
        life[i] -= clampedDt;
        const progress = Math.max(0, 1.0 - life[i] / maxLife[i]); // 0 -> 1

        if (type[i] === 1) {
          // Mist Physics:
          vel[i3 + 1] -= 1.2 * clampedDt;
          vel[i3] *= (1.0 - 1.8 * clampedDt);
          vel[i3 + 2] *= (1.0 - 1.2 * clampedDt);

          pos[i3] += vel[i3] * clampedDt;
          pos[i3 + 1] += vel[i3 + 1] * clampedDt;
          pos[i3 + 2] += vel[i3 + 2] * clampedDt;

          // Expand puff: 0.35m -> 0.75m
          size[i] = 0.35 + progress * 0.40;
          const bellAlpha = Math.sin(progress * Math.PI) * 0.28;
          col[i4 + 3] = bellAlpha;
        } else {
          // Ballistic Splash Droplet Physics:
          vel[i3 + 1] -= 9.81 * clampedDt;

          pos[i3] += vel[i3] * clampedDt;
          pos[i3 + 1] += vel[i3 + 1] * clampedDt;
          pos[i3 + 2] += vel[i3 + 2] * clampedDt;

          col[i4 + 3] = Math.max(0, (life[i] / maxLife[i]) * 0.95);

          // Kill droplet upon plunging back into river surface or striking terrain
          const waterY = this.hydraulics.getWaterHeightAt(pos[i3 + 2]);
          const groundY = this.terrain ? this.terrain.getBedHeight(pos[i3], pos[i3 + 2]) : -999.0;
          const hitY = Math.max(waterY - 0.03, groundY);
          if (pos[i3 + 1] < hitY && vel[i3 + 1] < 0) {
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
