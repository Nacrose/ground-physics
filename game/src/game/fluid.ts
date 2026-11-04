/**
 * 🌊 Screen-Space Fluid Rendering (SSFR) & 3D SPH Particle Water System
 * Inspired by talvinckb/OpenGL-Water-Simulation and Timberborn's 3D volumetric water.
 *
 * Pipeline Architecture:
 *  1. 3D SPH Fluid Particle Physics (Lagrangian particle simulation with pressure,
 *     viscosity, gravity, and terrain/obstacle boundary collision).
 *  2. Scene Color & Depth Pre-Pass (records background world).
 *  3. Fluid Depth & Thickness Pass (point/sphere billboard rasterization).
 *  4. Bilateral Depth-Aware Smoothing Filter (smooths discrete particle lumps into
 *     a cohesive, glass-like liquid isosurface without blurring silhouettes).
 *  5. Fullscreen Composite Shader (normal reconstruction from depth finite-differences,
 *     screen-space optical refraction, Beer-Lambert absorption, Timberborn palette,
 *     Fresnel sky reflection, sun specular glints, and stylized edge foam).
 */
import * as THREE from "three";
import { TerrainData, sampleHeight, terrainNormal, WORLD_SIZE } from "./terrain";
import { Ground } from "./ground";

const MAX_PARTICLES = 1200;
const PARTICLE_RADIUS = 0.09; // [m] reduced so droplets form tight cohesive streams
const SPH_H = 0.32; // [m] smoothing kernel radius
const SPH_H2 = SPH_H * SPH_H;
const SPH_MASS = 0.045; // [kg] per particle
const SPH_REST_DENSITY = 32.0;
const SPH_GAS_K = 18.0; // pressure stiffness
const SPH_VISC = 0.45; // artificial viscosity
const GRAVITY = -11.5;

// SPH Kernel constants
const POLY6 = 315.0 / (64.0 * Math.PI * Math.pow(SPH_H, 9));
const SPIKY_GRAD = -45.0 / (Math.PI * Math.pow(SPH_H, 6));
const VISC_LAP = 45.0 / (Math.PI * Math.pow(SPH_H, 6));

// Spatial Hash constants
const HASH_CELL = 0.40;
const HASH_SIZE = 2048;
const HASH_MASK = HASH_SIZE - 1;

export class FluidSystem {
  // --- Particle Data ---
  private pX = new Float32Array(MAX_PARTICLES);
  private pY = new Float32Array(MAX_PARTICLES);
  private pZ = new Float32Array(MAX_PARTICLES);
  private vX = new Float32Array(MAX_PARTICLES);
  private vY = new Float32Array(MAX_PARTICLES);
  private vZ = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private density = new Float32Array(MAX_PARTICLES);
  private pressure = new Float32Array(MAX_PARTICLES);
  private activeCount = 0;

  // --- Spatial Hash Table (Linked List) ---
  private hashHead = new Int32Array(HASH_SIZE);
  private hashNext = new Int32Array(MAX_PARTICLES);

  // --- Emitters & Interaction ---
  streamActive = false;
  private streamTimer = 0;
  private waterfallTimer = 0;
  private tempNrm: [number, number, number] = [0, 0, 1];

  // --- Three.js SSFR Pipeline Components ---
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private terrain: TerrainData;
  private ground: Ground;

  // Render Targets
  private sceneTarget: THREE.WebGLRenderTarget;
  private fluidDepthTarget: THREE.WebGLRenderTarget;
  private fluidThicknessTarget: THREE.WebGLRenderTarget;
  private smoothedDepthTarget: THREE.WebGLRenderTarget;

  // Particle Mesh (Instanced Quads)
  private particleGeo: THREE.InstancedBufferGeometry;
  private posAttr: THREE.InstancedBufferAttribute;
  private lifeAttr: THREE.InstancedBufferAttribute;
  private densityAttr: THREE.InstancedBufferAttribute;
  private particleDepthMat: THREE.ShaderMaterial;
  private particleThicknessMat: THREE.ShaderMaterial;
  private particleMesh: THREE.Mesh;
  private fluidScene: THREE.Scene;

  // Fullscreen Post-Processing
  private postCam: THREE.OrthographicCamera;
  private blurScene: THREE.Scene;
  private blurQuad: THREE.Mesh;
  private blurMat: THREE.ShaderMaterial;

  private compositeScene: THREE.Scene;
  private compositeQuad: THREE.Mesh;
  private compositeMat: THREE.ShaderMaterial;

  private targetW = 0;
  private targetH = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    terrain: TerrainData,
    ground: Ground
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.terrain = terrain;
    this.ground = ground;

    const size = new THREE.Vector2();
    renderer.getSize(size);
    const dpr = Math.min(renderer.getPixelRatio(), 1.5);
    const w = Math.max(1, Math.round(size.x * dpr));
    const h = Math.max(1, Math.round(size.y * dpr));
    this.targetW = w;
    this.targetH = h;

    // 1. Scene Render Target with attached Depth Texture
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(w, h);
    this.sceneTarget.depthTexture.type = THREE.UnsignedIntType;

    // 2. Fluid Depth Target (linear view depth)
    this.fluidDepthTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // 3. Fluid Thickness Target (accumulated optical thickness)
    this.fluidThicknessTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // 4. Smoothed Depth Target (bilateral filter output)
    this.smoothedDepthTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // --- Particle Geometry & Instanced Attributes ---
    const baseGeo = new THREE.PlaneGeometry(1, 1);
    this.particleGeo = new THREE.InstancedBufferGeometry();
    this.particleGeo.index = baseGeo.index;
    this.particleGeo.attributes.position = baseGeo.attributes.position;
    this.particleGeo.attributes.uv = baseGeo.attributes.uv;

    this.posAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.lifeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    this.densityAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    this.particleGeo.setAttribute("aInstancePos", this.posAttr);
    this.particleGeo.setAttribute("aLife", this.lifeAttr);
    this.particleGeo.setAttribute("aDensity", this.densityAttr);

    // --- Particle Depth Shader ---
    this.particleDepthMat = new THREE.ShaderMaterial({
      transparent: false,
      depthWrite: true,
      depthTest: true,
      uniforms: {
        uRadius: { value: PARTICLE_RADIUS },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aInstancePos;
        attribute float aLife;
        attribute float aDensity;
        uniform float uRadius;
        varying vec2 vUv;
        varying vec3 vViewCenter;
        varying float vLife;
        varying float vDensity;

        void main() {
          vUv = uv;
          vLife = aLife;
          vDensity = aDensity;
          vec4 viewCenter = modelViewMatrix * vec4(aInstancePos, 1.0);
          vViewCenter = viewCenter.xyz;
          // Camera-facing billboard quad in view space
          vec3 viewPos = viewCenter.xyz + vec3((uv - 0.5) * (uRadius * 2.2), 0.0);
          gl_Position = projectionMatrix * vec4(viewPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uRadius;
        varying vec2 vUv;
        varying vec3 vViewCenter;
        varying float vLife;
        varying float vDensity;

        void main() {
          // Strictly discard dead particles and isolated single particles (rest density ~32, isolated self-density ~1.3)
          // Only cohesive fluid clusters/streams are rendered; isolated particles never render as bubbles!
          if (vLife <= 0.0 || vDensity < 14.0) discard;
          vec2 n = vUv * 2.0 - 1.0;
          float r2 = dot(n, n);
          if (r2 > 1.0) discard;
          float zOffset = sqrt(1.0 - r2) * uRadius;
          float linearZ = -(vViewCenter.z + zOffset);
          gl_FragColor = vec4(linearZ, 0.0, 0.0, 1.0);
        }
      `,
    });

    // --- Particle Thickness Shader ---
    this.particleThicknessMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uRadius: { value: PARTICLE_RADIUS },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aInstancePos;
        attribute float aLife;
        attribute float aDensity;
        uniform float uRadius;
        varying vec2 vUv;
        varying float vLife;
        varying float vDensity;

        void main() {
          vUv = uv;
          vLife = aLife;
          vDensity = aDensity;
          vec4 viewCenter = modelViewMatrix * vec4(aInstancePos, 1.0);
          vec3 viewPos = viewCenter.xyz + vec3((uv - 0.5) * (uRadius * 2.2), 0.0);
          gl_Position = projectionMatrix * vec4(viewPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uRadius;
        varying vec2 vUv;
        varying float vLife;
        varying float vDensity;

        void main() {
          if (vLife <= 0.0 || vDensity < 14.0) discard;
          vec2 n = vUv * 2.0 - 1.0;
          float r2 = dot(n, n);
          if (r2 > 1.0) discard;
          float z = sqrt(1.0 - r2) * uRadius * 2.0;
          gl_FragColor = vec4(z, z, z, 1.0);
        }
      `,
    });

    this.particleMesh = new THREE.Mesh(this.particleGeo, this.particleDepthMat);
    this.particleMesh.frustumCulled = false;
    this.fluidScene = new THREE.Scene();
    this.fluidScene.add(this.particleMesh);

    // --- Bilateral Depth-Aware Smoothing Pass ---
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blurScene = new THREE.Scene();
    this.blurMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uDepthTex: { value: this.fluidDepthTarget.texture },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uDepthTex;
        uniform vec2 uTexelSize;
        varying vec2 vUv;

        void main() {
          float centerZ = texture2D(uDepthTex, vUv).r;
          if (centerZ <= 0.001) {
            gl_FragColor = vec4(0.0);
            return;
          }

          float sum = 0.0;
          float totalW = 0.0;
          // 2D bilateral kernel (radius 4)
          const int R = 4;
          for (int y = -R; y <= R; y++) {
            for (int x = -R; x <= R; x++) {
              vec2 off = vec2(float(x), float(y)) * uTexelSize;
              float sampleZ = texture2D(uDepthTex, vUv + off).r;
              if (sampleZ > 0.001) {
                float r2 = float(x * x + y * y);
                float spatialW = exp(-r2 / 10.0);
                float depthDiff = abs(sampleZ - centerZ);
                // Depth preservation: strictly avoid blurring across silhouette jumps (> 0.28m)
                float depthW = exp(-depthDiff * depthDiff / 0.045);
                float w = spatialW * depthW;
                sum += sampleZ * w;
                totalW += w;
              }
            }
          }
          float res = totalW > 0.0 ? sum / totalW : centerZ;
          gl_FragColor = vec4(res, 0.0, 0.0, 1.0);
        }
      `,
    });
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.blurScene.add(this.blurQuad);

    // --- Composite SSFR Shader ---
    this.compositeScene = new THREE.Scene();
    this.compositeMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSceneColor: { value: this.sceneTarget.texture },
        uSceneDepth: { value: this.sceneTarget.depthTexture },
        uSmoothedDepth: { value: this.smoothedDepthTarget.texture },
        uThickness: { value: this.fluidThicknessTarget.texture },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
        uInvProj: { value: new THREE.Matrix4() },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 1000.0 },
        uSunDir: { value: new THREE.Vector3(0.5, 0.4, -0.6) },
        uSkyColor: { value: new THREE.Color(0x8fa3b5) },
        uSunColor: { value: new THREE.Color(0xffd9a8) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSceneColor;
        uniform sampler2D uSceneDepth;
        uniform sampler2D uSmoothedDepth;
        uniform sampler2D uThickness;
        uniform vec2 uTexelSize;
        uniform mat4 uInvProj;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform vec3 uSunDir;
        uniform vec3 uSkyColor;
        uniform vec3 uSunColor;
        uniform float uTime;
        varying vec2 vUv;

        // Linearize hardware depth buffer
        float linearizeDepth(float d) {
          float z_ndc = d * 2.0 - 1.0;
          return 2.0 * uCameraNear * uCameraFar / (uCameraFar + uCameraNear - z_ndc * (uCameraFar - uCameraNear));
        }

        // Reconstruct view position from linear view-space depth
        vec3 reconstructViewPos(vec2 uv, float linearZ) {
          vec4 clip = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
          vec4 ray = uInvProj * clip;
          ray /= ray.w;
          return normalize(ray.xyz) * linearZ;
        }

        void main() {
          vec4 bgCol = texture2D(uSceneColor, vUv);
          float fluidZ = texture2D(uSmoothedDepth, vUv).r;

          if (fluidZ <= 0.001) {
            gl_FragColor = bgCol;
            return;
          }

          float rawSceneD = texture2D(uSceneDepth, vUv).r;
          float sceneZ = linearizeDepth(rawSceneD);

          // Fluid is occluded by solid foreground geometry (e.g. terrain bump, player)
          if (fluidZ > sceneZ - 0.01) {
            gl_FragColor = bgCol;
            return;
          }

          float thickness = texture2D(uThickness, vUv).r;

          // Fluid volume cutoff: require at least 8 cm of continuous liquid thickness
          // Isolated single droplets or noise are strictly discarded and never rendered as bubbles!
          if (thickness < 0.08) {
            gl_FragColor = bgCol;
            return;
          }

          // Reconstruct normal via screen-space depth finite differences
          vec3 posC = reconstructViewPos(vUv, fluidZ);
          float zR = texture2D(uSmoothedDepth, vUv + vec2(uTexelSize.x, 0.0)).r;
          float zL = texture2D(uSmoothedDepth, vUv - vec2(uTexelSize.x, 0.0)).r;
          float zT = texture2D(uSmoothedDepth, vUv + vec2(0.0, uTexelSize.y)).r;
          float zB = texture2D(uSmoothedDepth, vUv - vec2(0.0, uTexelSize.y)).r;

          if (zR <= 0.001) zR = fluidZ;
          if (zL <= 0.001) zL = fluidZ;
          if (zT <= 0.001) zT = fluidZ;
          if (zB <= 0.001) zB = fluidZ;

          vec3 posR = reconstructViewPos(vUv + vec2(uTexelSize.x, 0.0), zR);
          vec3 posL = reconstructViewPos(vUv - vec2(uTexelSize.x, 0.0), zL);
          vec3 posT = reconstructViewPos(vUv + vec2(0.0, uTexelSize.y), zT);
          vec3 posB = reconstructViewPos(vUv - vec2(0.0, uTexelSize.y), zB);

          vec3 dX = posR - posL;
          vec3 dY = posT - posB;
          vec3 N = normalize(cross(dX, dY));
          if (N.z < 0.0) N = -N;

          // Screen-space optical refraction
          vec2 refrOffset = N.xy * 0.038 * clamp(thickness * 1.8, 0.0, 1.0);
          vec2 refrUv = vUv + refrOffset;
          float refrSceneD = texture2D(uSceneDepth, refrUv).r;
          float refrSceneZ = linearizeDepth(refrSceneD);
          if (refrSceneZ < fluidZ) refrUv = vUv; // Reject foreground occlusion bleeding

          vec3 sceneSample = texture2D(uSceneColor, refrUv).rgb;

          // Beer-Lambert Optical Absorption (Red light absorbs first -> Caribbean teal)
          vec3 absorption = vec3(1.35, 0.45, 0.16);
          vec3 transmission = exp(-absorption * thickness * 2.4);
          vec3 waterCol = sceneSample * transmission;

          // Timberborn 3D Water Palette (turquoise shallows -> deep sapphire)
          vec3 shalCol = vec3(0.20, 0.78, 0.82);
          vec3 deepCol = vec3(0.03, 0.22, 0.38);
          vec3 waterTint = mix(shalCol, deepCol, smoothstep(0.04, 0.55, thickness));
          waterCol = mix(waterCol, waterTint, clamp(thickness * 0.80, 0.0, 0.86));

          // Fresnel Sky Reflection
          vec3 viewDir = normalize(-posC);
          float fresnel = pow(1.0 - max(dot(N, viewDir), 0.0), 3.0);
          waterCol = mix(waterCol, uSkyColor * 1.15, fresnel * 0.55);

          // Sun Specular Highlights
          vec3 sunView = normalize(uSunDir);
          vec3 halfVec = normalize(sunView + viewDir);
          float spec = pow(max(dot(N, halfVec), 0.0), 48.0);
          waterCol += uSunColor * spec * 0.75;

          // Stylized aeration and splash crest foam (modulated by ambient scene lighting)
          float foamMask = smoothstep(0.14, 0.09, thickness) * smoothstep(0.06, 0.09, thickness);
          vec3 ambientL = mix(uSkyColor, uSunColor, 0.3);
          float lightInt = clamp(length(ambientL) * 1.2, 0.05, 1.0);
          vec3 foamCol = mix(vec3(0.92, 0.96, 1.0), uSkyColor, 0.35) * lightInt;
          waterCol = mix(waterCol, foamCol, foamMask * 0.40);

          gl_FragColor = vec4(waterCol, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    this.compositeScene.add(this.compositeQuad);
  }

  // -----------------------------------------------------------------------------
  // Particle Spawning & Emitters
  // -----------------------------------------------------------------------------
  spawnParticle(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    ttl = 4.5
  ): boolean {
    if (this.activeCount >= MAX_PARTICLES) return false;
    const idx = this.activeCount++;
    this.pX[idx] = x;
    this.pY[idx] = y;
    this.pZ[idx] = z;
    this.vX[idx] = vx;
    this.vY[idx] = vy;
    this.vZ[idx] = vz;
    this.life[idx] = ttl;
    this.maxLife[idx] = ttl;
    return true;
  }

  spawnStream(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    speed: number,
    spread = 0.05,
    count = 3
  ) {
    for (let i = 0; i < count; i++) {
      const rx = (Math.random() - 0.5) * spread;
      const ry = (Math.random() - 0.5) * spread;
      const rz = (Math.random() - 0.5) * spread;
      const dir = direction.clone().add(new THREE.Vector3(rx, ry, rz)).normalize();
      const spd = speed * (0.92 + Math.random() * 0.16);
      this.spawnParticle(
        origin.x + rx * 0.5,
        origin.y + ry * 0.5,
        origin.z + rz * 0.5,
        dir.x * spd,
        dir.y * spd,
        dir.z * spd,
        5.0
      );
    }
  }

  // -----------------------------------------------------------------------------
  // SPH Simulation Step
  // -----------------------------------------------------------------------------
  update(
    dt: number,
    elapsed: number,
    cam: THREE.Camera,
    playerPos: THREE.Vector3,
    playerYaw: number,
    sunDir: THREE.Vector3,
    skyColor: THREE.Color,
    sunColor: THREE.Color,
    rainIntensity = 0
  ) {
    // Emitter 1: Continuous Mountain Waterfall at the Tarn Source (245, 58, 236)
    this.waterfallTimer += dt;
    const tarnDist = Math.hypot(playerPos.x - (245 - WORLD_SIZE / 2), playerPos.z - (236 - WORLD_SIZE / 2));
    if (this.waterfallTimer > 0.06 && tarnDist < 140) {
      this.waterfallTimer = 0;
      const tX = 245 - WORLD_SIZE / 2 + (Math.random() - 0.5) * 1.8;
      const tZ = 236 - WORLD_SIZE / 2 + (Math.random() - 0.5) * 1.8;
      const tY = sampleHeight(this.terrain, tX + WORLD_SIZE / 2, tZ + WORLD_SIZE / 2) + 0.6;
      this.spawnParticle(tX, tY, tZ, 1.2 + (Math.random() - 0.5) * 0.4, 0.4, 1.8 + (Math.random() - 0.5) * 0.4, 6.0);
    }

    // Emitter 2: Interactive Player Water Jet / Stream
    if (this.streamActive) {
      this.streamTimer += dt;
      if (this.streamTimer > 0.035) {
        this.streamTimer = 0;
        const forward = new THREE.Vector3(Math.sin(playerYaw), 0.22, Math.cos(playerYaw)).normalize();
        const origin = playerPos.clone().add(new THREE.Vector3(0, 1.2, 0)).addScaledVector(forward, 0.4);
        this.spawnStream(origin, forward, 9.5, 0.08, 2);
      }
    }

    if (this.activeCount === 0) return;

    // Sub-stepping for stable SPH simulation
    const SUBSTEPS = 2;
    const subDt = Math.min(dt / SUBSTEPS, 0.033);

    for (let step = 0; step < SUBSTEPS; step++) {
      // 1. Build Spatial Hash Table
      this.hashHead.fill(-1);
      for (let i = 0; i < this.activeCount; i++) {
        const cx = Math.floor(this.pX[i] / HASH_CELL);
        const cy = Math.floor(this.pY[i] / HASH_CELL);
        const cz = Math.floor(this.pZ[i] / HASH_CELL);
        const h = (((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) & HASH_MASK);
        this.hashNext[i] = this.hashHead[h];
        this.hashHead[h] = i;
      }

      // 2. Compute SPH Densities & Pressures
      for (let i = 0; i < this.activeCount; i++) {
        let rho = SPH_MASS * POLY6 * Math.pow(SPH_H, 6); // Self density
        const xi = this.pX[i], yi = this.pY[i], zi = this.pZ[i];
        const cx0 = Math.floor(xi / HASH_CELL);
        const cy0 = Math.floor(yi / HASH_CELL);
        const cz0 = Math.floor(zi / HASH_CELL);

        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const h = ((((cx0 + dx) * 73856093) ^ ((cy0 + dy) * 19349663) ^ ((cz0 + dz) * 83492791)) & HASH_MASK);
              let j = this.hashHead[h];
              while (j !== -1) {
                if (j !== i) {
                  const dX = xi - this.pX[j], dY = yi - this.pY[j], dZ = zi - this.pZ[j];
                  const r2 = dX * dX + dY * dY + dZ * dZ;
                  if (r2 < SPH_H2 && r2 > 1e-6) {
                    rho += SPH_MASS * POLY6 * Math.pow(SPH_H2 - r2, 3);
                  }
                }
                j = this.hashNext[j];
              }
            }
          }
        }
        this.density[i] = Math.max(rho, SPH_REST_DENSITY * 0.5);
        this.pressure[i] = Math.max(0, SPH_GAS_K * (this.density[i] - SPH_REST_DENSITY));
      }

      // 3. Compute Forces & Integrate
      for (let i = 0; i < this.activeCount; i++) {
        let fX = 0, fY = GRAVITY * SPH_MASS, fZ = 0;
        const xi = this.pX[i], yi = this.pY[i], zi = this.pZ[i];
        const vxi = this.vX[i], vyi = this.vY[i], vzi = this.vZ[i];
        const rhoI = this.density[i];
        const presI = this.pressure[i];

        const cx0 = Math.floor(xi / HASH_CELL);
        const cy0 = Math.floor(yi / HASH_CELL);
        const cz0 = Math.floor(zi / HASH_CELL);

        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const h = ((((cx0 + dx) * 73856093) ^ ((cy0 + dy) * 19349663) ^ ((cz0 + dz) * 83492791)) & HASH_MASK);
              let j = this.hashHead[h];
              while (j !== -1) {
                if (j !== i) {
                  const dX = xi - this.pX[j], dY = yi - this.pY[j], dZ = zi - this.pZ[j];
                  const r2 = dX * dX + dY * dY + dZ * dZ;
                  if (r2 < SPH_H2 && r2 > 1e-6) {
                    const r = Math.sqrt(r2);
                    const q = SPH_H - r;
                    const rhoJ = this.density[j];
                    const presJ = this.pressure[j];

                    // Pressure repulsion force
                    const pTerm = -SPH_MASS * (presI + presJ) / (2.0 * rhoJ) * SPIKY_GRAD * (q * q) / r;
                    fX += pTerm * dX;
                    fY += pTerm * dY;
                    fZ += pTerm * dZ;

                    // Viscosity force
                    const vTerm = SPH_VISC * SPH_MASS / rhoJ * VISC_LAP * q;
                    fX += vTerm * (this.vX[j] - vxi);
                    fY += vTerm * (this.vY[j] - vyi);
                    fZ += vTerm * (this.vZ[j] - vzi);
                  }
                }
                j = this.hashNext[j];
              }
            }
          }
        }

        // Integrate Velocity
        const invRho = 1.0 / rhoI;
        this.vX[i] += (fX * invRho) * subDt;
        this.vY[i] += (fY * invRho) * subDt;
        this.vZ[i] += (fZ * invRho) * subDt;

        // Integrate Position
        this.pX[i] += this.vX[i] * subDt;
        this.pY[i] += this.vY[i] * subDt;
        this.pZ[i] += this.vZ[i] * subDt;

        // Terrain Collision & Flow Friction
        const wx = this.pX[i] + WORLD_SIZE / 2;
        const wz = this.pZ[i] + WORLD_SIZE / 2;
        if (wx >= 0 && wx <= WORLD_SIZE && wz >= 0 && wz <= WORLD_SIZE) {
          const groundH = sampleHeight(this.terrain, wx, wz) + this.ground.dynLiftBilerp(this.pX[i], this.pZ[i]);
          const floorY = groundH + PARTICLE_RADIUS * 0.9;
          if (this.pY[i] < floorY) {
            this.pY[i] = floorY;
            terrainNormal(this.terrain, wx, wz, this.tempNrm);
            const nX = this.tempNrm[0], nY = this.tempNrm[2], nZ = this.tempNrm[1];
            const vn = this.vX[i] * nX + this.vY[i] * nY + this.vZ[i] * nZ;
            if (vn < 0) {
              // Separate normal and tangent velocity
              this.vX[i] -= vn * nX;
              this.vY[i] -= vn * nY;
              this.vZ[i] -= vn * nZ;
              // Slide downhill along slope with viscous friction
              this.vX[i] = this.vX[i] * 0.88 - nX * vn * 0.12;
              this.vY[i] = this.vY[i] * 0.88 - nY * vn * 0.12;
              this.vZ[i] = this.vZ[i] * 0.88 - nZ * vn * 0.12;
            }
          }
        }
      }
    }

    // Age and prune dead particles
    for (let i = 0; i < this.activeCount; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0 || this.pY[i] < -20) {
        // Swap with last active particle
        const last = --this.activeCount;
        this.pX[i] = this.pX[last];
        this.pY[i] = this.pY[last];
        this.pZ[i] = this.pZ[last];
        this.vX[i] = this.vX[last];
        this.vY[i] = this.vY[last];
        this.vZ[i] = this.vZ[last];
        this.life[i] = this.life[last];
        this.maxLife[i] = this.maxLife[last];
        this.density[i] = this.density[last];
        this.pressure[i] = this.pressure[last];
        i--;
      }
    }

    // Update Three.js Instanced Attributes
    const pArr = this.posAttr.array as Float32Array;
    const lArr = this.lifeAttr.array as Float32Array;
    const dArr = this.densityAttr.array as Float32Array;
    for (let i = 0; i < this.activeCount; i++) {
      pArr[i * 3] = this.pX[i];
      pArr[i * 3 + 1] = this.pY[i];
      pArr[i * 3 + 2] = this.pZ[i];
      lArr[i] = this.life[i];
      dArr[i] = this.density[i];
    }
    this.posAttr.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
    this.densityAttr.needsUpdate = true;
    this.particleGeo.instanceCount = this.activeCount;

    // Update Composite Material Uniforms
    const u = this.compositeMat.uniforms;
    if (cam instanceof THREE.PerspectiveCamera) {
      u.uInvProj.value.copy(cam.projectionMatrixInverse);
      u.uCameraNear.value = cam.near;
      u.uCameraFar.value = cam.far;
    }
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uSkyColor.value as THREE.Color).copy(skyColor);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    u.uTime.value = elapsed;
  }

  // -----------------------------------------------------------------------------
  // Screen-Space Fluid Rendering (SSFR) Pipeline Pass
  // -----------------------------------------------------------------------------
  render(cam: THREE.Camera) {
    let hasNearby = false;
    if (this.activeCount > 0) {
      const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      for (let i = 0; i < this.activeCount; i++) {
        const dx = this.pX[i] - cx, dy = this.pY[i] - cy, dz = this.pZ[i] - cz;
        if (dx * dx + dy * dy + dz * dz < 120 * 120) {
          hasNearby = true;
          break;
        }
      }
    }

    if (!hasNearby) {
      // Direct pass if no fluid particles are nearby / on screen
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, cam);
      return;
    }

    // Pass 1: Render background world into scene target (with depth texture)
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(this.scene, cam);

    // Pass 2: Render fluid particle depth
    this.renderer.setRenderTarget(this.fluidDepthTarget);
    this.renderer.clear();
    this.particleMesh.material = this.particleDepthMat;
    this.renderer.render(this.fluidScene, cam);

    // Pass 3: Render fluid particle thickness (additive accumulation)
    this.renderer.setRenderTarget(this.fluidThicknessTarget);
    this.renderer.clear();
    this.particleMesh.material = this.particleThicknessMat;
    this.renderer.render(this.fluidScene, cam);

    // Pass 4: Bilateral depth-aware smoothing
    this.renderer.setRenderTarget(this.smoothedDepthTarget);
    this.renderer.render(this.blurScene, this.postCam);

    // Pass 5: Final Composite shader to screen
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.postCam);
  }

  resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    this.targetW = w;
    this.targetH = h;
    this.sceneTarget.setSize(w, h);
    this.fluidDepthTarget.setSize(w, h);
    this.fluidThicknessTarget.setSize(w, h);
    this.smoothedDepthTarget.setSize(w, h);

    const ts = new THREE.Vector2(1 / w, 1 / h);
    this.blurMat.uniforms.uTexelSize.value.copy(ts);
    this.compositeMat.uniforms.uTexelSize.value.copy(ts);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.fluidDepthTarget.dispose();
    this.fluidThicknessTarget.dispose();
    this.smoothedDepthTarget.dispose();
    this.particleGeo.dispose();
    this.particleDepthMat.dispose();
    this.particleThicknessMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
  }
}

