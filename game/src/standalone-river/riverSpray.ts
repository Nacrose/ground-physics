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
      // Razor-sharp liquid droplet nucleus (r < 0.22) + soft exponential droplet sheen
      const core = Math.max(0, 1.0 - (r / 0.22) * (r / 0.22));
      const halo = Math.exp(-r * r * 7.5);
      const alpha = Math.min(1.0, core * 0.95 + halo * 0.45);

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
  readonly maxParticles = 1200;
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
          // Crisp realistic droplet scale: clamped tightly to 1.5 - 28.0 pixels max (no giant balloons!)
          gl_PointSize = clamp(aSize * (460.0 / -mvPos.z), 1.5, 28.0);
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
          if (col.a < 0.015) discard;

          // Sparkling liquid sun glint on droplet surface:
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float glint = pow(max(0.0, 1.0 - length(p - vec2(0.25, 0.25)) * 2.4), 3.5) * 1.8;
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
        if (boulders.length > 0) {
          const b = boulders[Math.floor(Math.random() * boulders.length)];
          const st = this.hydraulics.getStationAtZ(b.center.z);

          // Kinetic energy threshold: scales with velocity head Hv = v^2 / 2g and Froude
          const spawnThreshold = Math.min(0.92, 0.18 + st.head * 0.40 + (st.froude > 1.0 ? 0.35 : 0.0));

          if (Math.random() < spawnThreshold) {
            const localV = st.velocity;
            const isMist = Math.random() < 0.15; // 85% crisp ballistic droplets, 15% faint mist
            type[i] = isMist ? 1 : 0;

            // Semicircular bow-shock spawn wrapping around the upstream prow and flanks of the boulder
            const angle = (Math.random() - 0.5) * Math.PI * 0.85;
            const rDist = b.radius * (0.80 + Math.random() * 0.22);
            pos[i3] = b.center.x + Math.sin(angle) * rDist;
            pos[i3 + 1] = st.waterY + 0.02 + Math.random() * 0.06;
            pos[i3 + 2] = b.center.z - Math.cos(angle) * rDist;

            const outDirX = Math.sin(angle);

            if (isMist) {
              // Fine Hovering Mist Haze: subtle, faint, stays low to river surface
              vel[i3] = outDirX * (localV * 0.28);
              vel[i3 + 1] = 0.40 + Math.random() * 0.60;
              vel[i3 + 2] = localV * (0.75 + Math.random() * 0.35);
              const totalLife = 0.50 + Math.random() * 0.40;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.08;
              col[i4] = 0.95;
              col[i4 + 1] = 0.98;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.0;
            } else {
              // Ballistic Spray Droplet: realistic low-trajectory splash crest (10 to 30 cm rise max!)
              vel[i3] = outDirX * localV * (0.35 + Math.random() * 0.45);
              vel[i3 + 1] = 0.90 + Math.random() * 1.50; // Max height = vy^2/2g ~ 15-28 cm
              vel[i3 + 2] = localV * (0.85 + Math.random() * 0.45); // Swept downstream by raging torrent
              const totalLife = 0.22 + Math.random() * 0.24;
              life[i] = totalLife;
              maxLife[i] = totalLife;
              size[i] = 0.035 + Math.random() * 0.035; // Tiny 3.5 - 7 cm droplets (2 - 5 px on screen)
              col[i4] = 1.0;
              col[i4 + 1] = 1.0;
              col[i4 + 2] = 1.0;
              col[i4 + 3] = 0.85;
            }
          }
        }
      } else {
        life[i] -= clampedDt;
        const progress = Math.max(0, 1.0 - life[i] / maxLife[i]); // 0 -> 1

        if (type[i] === 1) {
          // Subtle Mist Physics:
          vel[i3 + 1] -= 1.8 * clampedDt;
          vel[i3] *= (1.0 - 2.2 * clampedDt);
          vel[i3 + 2] *= (1.0 - 1.6 * clampedDt);

          pos[i3] += vel[i3] * clampedDt;
          pos[i3 + 1] += vel[i3 + 1] * clampedDt;
          pos[i3 + 2] += vel[i3 + 2] * clampedDt;

          // Expand puff gently: 0.08m -> 0.26m (subtle vapor puff, NOT 1-meter smoke ball)
          size[i] = 0.08 + progress * 0.18;
          // Faint, delicate bell-curve alpha: max 16% opacity
          const bellAlpha = Math.sin(progress * Math.PI) * 0.16;
          col[i4 + 3] = bellAlpha;
        } else {
          // Ballistic Splash Droplet Physics:
          vel[i3 + 1] -= 9.81 * clampedDt;

          pos[i3] += vel[i3] * clampedDt;
          pos[i3 + 1] += vel[i3 + 1] * clampedDt;
          pos[i3 + 2] += vel[i3 + 2] * clampedDt;

          col[i4 + 3] = Math.max(0, (life[i] / maxLife[i]) * 0.85);

          // Kill droplet immediately upon plunging back into river surface or striking terrain
          const waterY = this.hydraulics.getWaterHeightAt(pos[i3 + 2]);
          const groundY = this.terrain ? this.terrain.getBedHeight(pos[i3], pos[i3 + 2]) : -999.0;
          const hitY = Math.max(waterY - 0.02, groundY);
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
