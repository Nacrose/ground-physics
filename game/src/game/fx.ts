/**
 * Storm FX: rain as GPU-billboarded motion-blur streaks — each drop is a
 * persistent particle that really falls at its Marshall-Palmer speed and
 * drifts with the wind; the streak quad is stretched along the velocity and
 * faces the camera in the vertex shader (JS only integrates positions).
 * Landing splash rings, a dynamic puddle mesh grown from the ground-physics
 * ponding field (per-vertex depth → feathered edges + a Beer-Lambert
 * wet-earth → sky-water colour ramp), and fully procedural WebAudio
 * (rain hiss, wind, thunder rumbles).
 */
import * as THREE from "three";
import { GRID, WORLD_SIZE, TerrainData, sampleHeight, cellIndex } from "./terrain";
import { Ground } from "./ground";
import { dropFallSpeed, medianDropMm } from "./params";
import { MicroTerrain, MICRO_HALF } from "./contact";
import { WATER_SURFACE_GLSL, WATER_WAVE_GLSL } from "./shaderlib";

const HALF = WORLD_SIZE / 2;
/** scratch buffers for the puddle water-table pass (see rebuildPuddles) —
 *  module-level so a per-tick rebuild allocates nothing */
const PUD_WET = new Float32Array(GRID * GRID);
const PUD_SURF = new Float32Array(GRID * GRID);
const PUD_SURFB = new Float32Array(GRID * GRID);
const COR_TABLE = new Float32Array((GRID + 1) * (GRID + 1));
const COR_GROUND = new Float32Array((GRID + 1) * (GRID + 1));

export type StepKind = "dry" | "moist" | "wet" | "mud";

export class StormFX {
  scene: THREE.Scene;
  terrain: TerrainData;
  ground: Ground;
  micro: MicroTerrain | null;

  rainMesh: THREE.Mesh;
  splash: THREE.InstancedMesh;
  dust: THREE.InstancedMesh;
  puddleMesh: THREE.Mesh;
  /** the river as a true 3-D water volume — a ribbon mesh whose surface
   *  rides the water table down the channel (see buildRiver) */
  riverMesh: THREE.Mesh;
  /** the river's flow field as a world texture (RG = dir·speed, B = vigour)
   *  — ONE texture shared by this sheet and the contact film sheet so the
   *  current reads identically across the window edge */
  flowTex: THREE.DataTexture;
  private rainGeo: THREE.InstancedBufferGeometry;

  /** quality-level cap on visible drops (setRainQuality) */
  private rainCap: number;
  private baseRainCount: number;
  private splashCount = 240;
  private splashLife: Float32Array;
  private splashPos: Float32Array;
  private splashScale: Float32Array;
  private splashIdx = 0;
  private dustCount = 96;
  private dustLife: Float32Array;
  private dustPos: Float32Array;
  private dustIdx = 0;
  // persistent rain state: world position + velocity per drop. Positions
  // survive between frames — the drops actually fall, wrap in a camera-box
  // and respawn at the top when they land.
  private dropPos: Float32Array;
  private dropVel: Float32Array;
  private dropRand: Float32Array;
  private aPosAttr!: THREE.InstancedBufferAttribute;
  private aVelAttr!: THREE.InstancedBufferAttribute;
  private activeDrops = 0;
  private boxR = 14; // horizontal wrap radius around the camera [m]
  /** mud churn droplets: ballistic brown globules (boot / wheel / spade) */
  private mudDrops: THREE.InstancedMesh;
  private mudDropCount = 64;
  private mudLife: Float32Array;
  private mudPos: Float32Array;
  private mudVel: Float32Array;
  private mudIdx = 0;
  private lastSuction = 0;

  // audio
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;
  /** master volume 0..1 (settings slider) */
  volume = 0.8;

  constructor(scene: THREE.Scene, terrain: TerrainData, ground: Ground, rainCount = 5200,
    micro?: MicroTerrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.ground = ground;
    this.micro = micro ?? null;
    this.baseRainCount = rainCount;
    this.rainCap = rainCount;

    this.buildRain();
    this.buildSplashes();
    this.buildDust();
    this.buildMudDrops();
    this.buildPuddles();
    this.buildRiver();
    // the contact-tier film sheet rides the SAME flow field (set once — the
    // river doesn't move, it just travels along itself)
    if (this.micro) this.micro.setFlowTexture(this.flowTex);

    this.splashLife = new Float32Array(this.splashCount).fill(-1);
    this.splashPos = new Float32Array(this.splashCount * 3);
    this.splashScale = new Float32Array(this.splashCount).fill(1);
    this.dustLife = new Float32Array(this.dustCount).fill(-1);
    this.dustPos = new Float32Array(this.dustCount * 3);
    this.mudLife = new Float32Array(this.mudDropCount).fill(-1);
    this.mudPos = new Float32Array(this.mudDropCount * 3);
    this.mudVel = new Float32Array(this.mudDropCount * 3);
  }

  // -------------------------------------------------------------------- rain
  private buildRain() {
    // A unit quad stretched per-instance into a motion-blur streak. The
    // streak is built IN THE VERTEX SHADER from the drop's own velocity and
    // faces the camera — no per-drop matrices, no edge-on flicker, and the
    // lean into the wind is physical (it IS the velocity vector).
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    const n = this.baseRainCount;
    this.dropPos = new Float32Array(n * 3);
    this.dropVel = new Float32Array(n * 3);
    this.dropRand = new Float32Array(n);
    for (let i = 0; i < n; i++) this.seedDrop(i, 0, 6, 0);
    this.aPosAttr = new THREE.InstancedBufferAttribute(this.dropPos, 3);
    this.aVelAttr = new THREE.InstancedBufferAttribute(this.dropVel, 3);
    this.aPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.aVelAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPos", this.aPosAttr);
    geo.setAttribute("aVel", this.aVelAttr);
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(this.dropRand, 1));
    geo.instanceCount = 0; // nothing until it rains
    this.rainGeo = geo;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uIntensity: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: `
        attribute vec3 aPos;   // drop head, world space
        attribute vec3 aVel;   // drop velocity (y < 0)
        attribute float aRand; // per-drop variance 0..1
        uniform vec3 uCamPos;
        varying vec2 vUv;
        varying float vFade;
        varying float vRand;
        void main(){
          vUv = uv;
          vRand = aRand;
          vec3 vel = aVel;
          float speed = max(length(vel), 0.001);
          vec3 dir = vel / speed;             // streak points along the track
          // ~80 ms exposure: streak length IS the motion blur
          float len = clamp(speed * 0.08, 0.30, 1.10);
          vec3 toCam = uCamPos - aPos;
          // camera-facing width axis: perpendicular to streak and view ray
          vec3 side = cross(dir, toCam);
          float sl = length(side);
          side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
          float w = 0.016 + 0.014 * aRand;    // 1.6–3.0 cm wide
          vec3 world = aPos - dir * (uv.y * len) + side * (position.x * w);
          float d = length(toCam);
          vFade = smoothstep(0.55, 2.1, d);   // never loom over the lens
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: `
        uniform float uIntensity;
        varying vec2 vUv;
        varying float vFade;
        varying float vRand;
        void main(){
          // bright head, tapering tail (motion blur), soft cross-section
          float a = pow(1.0 - vUv.y, 1.7);
          a *= 0.30 + 0.70 * (1.0 - abs(vUv.x - 0.5) * 2.0);
          a *= vFade * (0.55 + 0.45 * vRand);
          gl_FragColor = vec4(vec3(0.80, 0.85, 0.93), a * (0.30 + 0.38 * uIntensity));
        }`,
    });
    this.rainMesh = new THREE.Mesh(geo, mat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 5;
    this.scene.add(this.rainMesh);
  }

  /** place drop i (fresh spawn) around (cx, cy, cz) */
  private seedDrop(i: number, cx: number, cy: number, cz: number) {
    const i3 = i * 3;
    this.dropPos[i3] = cx + (Math.random() * 2 - 1) * this.boxR;
    this.dropPos[i3 + 1] = cy + Math.random() * 11;
    this.dropPos[i3 + 2] = cz + (Math.random() * 2 - 1) * this.boxR;
    this.dropRand[i] = Math.random();
  }

  /** respawn drop i above the camera with an MP-consistent velocity */
  private respawnDrop(i: number, cam: THREE.Vector3, fall: number, windX: number, windZ: number) {
    const i3 = i * 3;
    this.dropPos[i3] = cam.x + (Math.random() * 2 - 1) * this.boxR;
    this.dropPos[i3 + 1] = cam.y + 5 + Math.random() * 8;
    this.dropPos[i3 + 2] = cam.z + (Math.random() * 2 - 1) * this.boxR;
    this.dropVel[i3] = windX * (0.7 + 0.6 * Math.random());
    this.dropVel[i3 + 1] = -fall * (0.8 + 0.4 * Math.random());
    this.dropVel[i3 + 2] = windZ * (0.7 + 0.6 * Math.random());
    this.dropRand[i] = Math.random();
  }

  // ---------------------------------------------------------------- splashes
  private buildSplashes() {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec2 vUv;
        void main(){
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          float ring = smoothstep(0.55, 0.8, r) * (1.0 - smoothstep(0.85, 1.0, r));
          float dots = smoothstep(0.9, 1.0, r);
          // die exactly at the quad rim — no faint square corners
          float a = (ring + dots * 0.6) * (1.0 - smoothstep(0.82, 1.0, r));
          gl_FragColor = vec4(vec3(0.86, 0.90, 0.94), a * 0.42);
        }`,
    });
    this.splash = new THREE.InstancedMesh(geo, mat, this.splashCount);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 6;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.splashCount; i++) {
      m.makeTranslation(0, -999, 0);
      this.splash.setMatrixAt(i, m);
    }
    this.scene.add(this.splash);
  }

  spawnSplash(x: number, y: number, z: number, scale = 1) {
    const i = this.splashIdx = (this.splashIdx + 1) % this.splashCount;
    this.splashLife[i] = 0;
    this.splashPos[i * 3] = x; this.splashPos[i * 3 + 1] = y; this.splashPos[i * 3 + 2] = z;
    this.splashScale[i] = scale;
  }

  // -------------------------------------------------------------------- dust
  private buildDust() {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform vec3 uTint;
        void main(){
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          float core = 1.0 - smoothstep(0.15, 1.0, r);
          float a = core * (1.0 - r * 0.45);
          gl_FragColor = vec4(uTint, clamp(a, 0.0, 1.0) * 0.5);
        }`,
      uniforms: { uTint: { value: new THREE.Color(0xb39868) } },
    });
    this.dust = new THREE.InstancedMesh(geo, mat, this.dustCount);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 6;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.dustCount; i++) {
      m.makeTranslation(0, -999, 0);
      this.dust.setMatrixAt(i, m);
    }
    this.scene.add(this.dust);
  }

  /** a dry dust puff at a footfall / landing / spoil landing */
  spawnDust(x: number, y: number, z: number, scale = 1) {
    const i = this.dustIdx = (this.dustIdx + 1) % this.dustCount;
    this.dustLife[i] = 0;
    this.dustPos[i * 3] = x; this.dustPos[i * 3 + 1] = y; this.dustPos[i * 3 + 2] = z;
    void scale;
  }

  // ---------------------------------------------------------------- mud drops
  private buildMudDrops() {
    const geo = new THREE.SphereGeometry(0.038, 6, 5);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a1d12, roughness: 0.42, metalness: 0 });
    this.mudDrops = new THREE.InstancedMesh(geo, mat, this.mudDropCount);
    this.mudDrops.frustumCulled = false;
    this.mudDrops.renderOrder = 6;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.mudDropCount; i++) {
      m.makeTranslation(0, -999, 0);
      this.mudDrops.setMatrixAt(i, m);
    }
    this.scene.add(this.mudDrops);
  }

  /** a churn strike in soft mud — brown droplets fly (boot, wheel, spade) */
  spawnMudChurn(x: number, y: number, z: number, power = 1) {
    const n = Math.min(3 + Math.round(power * 3), 6);
    for (let d = 0; d < n; d++) {
      const i = this.mudIdx = (this.mudIdx + 1) % this.mudDropCount;
      const a = Math.random() * Math.PI * 2;
      const spd = (0.5 + Math.random() * 0.9) * power;
      this.mudLife[i] = 0;
      this.mudPos[i * 3] = x + Math.cos(a) * 0.1;
      this.mudPos[i * 3 + 1] = y + 0.05;
      this.mudPos[i * 3 + 2] = z + Math.sin(a) * 0.1;
      this.mudVel[i * 3] = Math.cos(a) * spd;
      this.mudVel[i * 3 + 1] = (1.4 + Math.random() * 1.6) * power;
      this.mudVel[i * 3 + 2] = Math.sin(a) * spd;
    }
  }

  // ----------------------------------------------------------------- puddles
  private buildPuddles() {
    // the flow field texture: RG = world-space dir·speed (−1..1), B = vigour
    // 0..1. Ponds / dry ground encode (0,0,0) — the shader's wind look. 4 m
    // texels, linear-filtered: the current bends smoothly with the channel
    const fdat = new Uint8Array(GRID * GRID * 4);
    for (let k = 0; k < GRID * GRID; k++) {
      const fxv = this.terrain.flow[k * 2], fyv = this.terrain.flow[k * 2 + 1];
      fdat[k * 4] = Math.max(0, Math.min(255, Math.round(fxv * 127.5 + 127.5)));
      fdat[k * 4 + 1] = Math.max(0, Math.min(255, Math.round(fyv * 127.5 + 127.5)));
      fdat[k * 4 + 2] = Math.max(0, Math.min(255, Math.round(Math.hypot(fxv, fyv) * 255)));
      fdat[k * 4 + 3] = 255;
    }
    this.flowTex = new THREE.DataTexture(fdat, GRID, GRID, THREE.RGBAFormat);
    this.flowTex.minFilter = THREE.LinearFilter;
    this.flowTex.magFilter = THREE.LinearFilter;
    this.flowTex.needsUpdate = true;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setAttribute("aDepth", new THREE.BufferAttribute(new Float32Array(0), 1));
    geo.setIndex(null);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uRain: { value: 0 }, // local rain intensity for rain-ripple sparkle
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uSky: { value: new THREE.Color(0x8fa3b5) },
        uSun: { value: new THREE.Color(0xffd9a8) },
        uSunDir: { value: new THREE.Vector3(0.5, 0.4, -0.6) },
        uWet: { value: new THREE.Color(0x23281f) }, // wet-earth absorption tint
        uFogColor: { value: new THREE.Color(0xe6d2ac) },
        uFogDensity: { value: 0.0026 },
        uCamPos: { value: new THREE.Vector3() },
        // the contact window's film sheet owns the water INSIDE the window —
        // the fine-tier sheet dissolves over the EXACT same 0.45 m band the
        // film fades out over (7.45 -> 7.90 m): the two weights sum to one,
        // so no thinned-water square ring follows the player
        uWinOrigin: { value: new THREE.Vector2(0, 0) },
        uWinHalf: { value: MICRO_HALF - 0.55 },
        uFlowTex: { value: this.flowTex },
        uFlowTexV: { value: this.flowTex },
      },
      vertexShader: `
        attribute float aDepth; // pond depth at this vertex [m]
        uniform vec2 uWinOrigin;
        uniform float uWinHalf;
        uniform float uTime;
        uniform vec2 uWindDir;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vWin;
        ${WATER_WAVE_GLSL}
        void main(){
          vDepth = aDepth;
          // 0 inside the micro window -> 1 across the same 0.45 m band the
          // contact film sheet fades OUT over (the weights sum to one)
          float wd = max(abs(position.x - uWinOrigin.x), abs(position.z - uWinOrigin.y));
          vWin = smoothstep(uWinHalf, uWinHalf + 0.45, wd);
          vec3 wp = position;
          // physical 3D waves on open water, gentle shore fade
          float shoreFade = smoothstep(0.015, 0.18, aDepth);
          wp.y += waterWaveY(position.xz, shoreFade);
          vWorld = wp;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime, uRain, uFogDensity;
        uniform vec3 uSky, uSun, uSunDir, uFogColor, uCamPos;
        uniform vec2 uWindDir;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vWin;
        ${WATER_SURFACE_GLSL}
        void main(){
          if (vDepth < 0.020) discard;
          // the shared water look — identical constants to the contact film
          // sheet, so water reads the same on either side of the window edge
          vec3 col;
          float alpha;
          waterLook(vWorld, vDepth, col, alpha);
          // Only genuine pooled water (>2-5 cm) shows volumetric body
          alpha *= smoothstep(0.015, 0.045, vDepth);
          if (alpha < 0.004) discard;
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dot(uCamPos - vWorld, uCamPos - vWorld));
          col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
          gl_FragColor = vec4(col, alpha);
          // SAME tone-map + output-encode as the terrain (see the film sheet)
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.puddleMesh = new THREE.Mesh(geo, mat);
    this.puddleMesh.renderOrder = 4;
    this.puddleMesh.frustumCulled = false;
    this.scene.add(this.puddleMesh);
  }

  /** rebuild puddle quads from the ponding field (every physics tick).
   *  The sheet now sits at the SMOOTHED WATER TABLE: cell surfaces (ground +
   *  depth) are blurred horizontally, wet-weighted, before emission — so a
   *  pond or the tarn reads as a flat-ish body of water that found its level,
   *  not a film draped over every bed bump (the drape read the tarn and every
   *  wheel-rut puddle as a shiny groove in the ground). River cells are
   *  excluded from the sheet entirely: the 3-D ribbon owns the channel, so
   *  the two never double-layer. */
  rebuildPuddles() {
    const hPond = this.ground.hPond;
    const ruts = this.ground.rut;
    const cell = WORLD_SIZE / GRID;
    const N = GRID * GRID;
    const verts: number[] = [];
    const depths: number[] = [];
    // ---- pass 1: the water table — surface elevation per wet cell.
    // River-channel cells (riverMask > 0.15) stay out entirely: the 3-D
    // ribbon owns the channel, and their bed-following surfaces would both
    // double-layer under it and print phantom water up the banks
    const wet = PUD_WET, surf = PUD_SURF, surfB = PUD_SURFB;
    const riverMask = this.terrain.river;
    const pondCap = this.terrain.pondCap;
    const H = this.terrain.height;
    const G1 = GRID + 1;
    for (let k = 0; k < N; k++) {
      const depth = hPond[k]; // ONLY actual liquid water from ponding (never dry wheel ruts!)
      const j = Math.floor(k / GRID), i = k - j * GRID;
      const cx = (i + 0.5) * cell, cz = (j + 0.5) * cell;
      surf[k] = sampleHeight(this.terrain, cx, cz)
        + this.ground.dynLiftBilerp(cx - HALF, cz - HALF) + depth;
      // Slope check: standing water CANNOT form on slopes!
      const c00 = j * G1 + i, c10 = c00 + 1, c01 = c00 + G1, c11 = c01 + 1;
      const sx = Math.abs((H[c10] + H[c11]) - (H[c00] + H[c01])) / (2 * cell);
      const sz = Math.abs((H[c01] + H[c11]) - (H[c00] + H[c10])) / (2 * cell);
      const cellSlope = Math.hypot(sx, sz);
      // ONLY allow standing water tables in genuine deep basins (tarn lake) or deep pools (>8 cm of water on flat ground)
      const isLake = (this.terrain.riverIn && this.terrain.riverIn[k] > 0.5) || (pondCap && pondCap[k] > 0.9);
      const canPond = isLake || (cellSlope < 0.035 && depth >= 0.08);
      wet[k] = canPond && riverMask[k] <= 0.15 ? Math.min(depth / 0.20, 1) : 0;
    }
    // ---- pass 2: four wet-weighted 3×3 blur passes (effective ~5 m) —
    // flattens the table ACROSS a water body (the tarn's bowl-following
    // dome relaxes to one level; bed bumps stop printing through the
    // surface geometry) while a big pond's along-slope survives. A solo
    // wet cell has no wet neighbours and keeps its own surface — thin
    // rain puddles are untouched
    for (let pass = 0; pass < 4; pass++) {
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          let sw = 0, s = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= GRID) continue;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              if (ii < 0 || ii >= GRID) continue;
              const kk = jj * GRID + ii;
              sw += wet[kk];
              s += wet[kk] * surf[kk];
            }
          }
          surfB[j * GRID + i] = sw > 1e-4 ? s / sw : surf[j * GRID + i];
        }
      }
      surf.set(surfB);
    }
    // ---- pass 3: corner values — table level (wet cells at full weight,
    // dry neighbours at 0.15 so the waterline tapers out) and ground height
    // (terrain + fine lift + micro relief: the same stack the contact
    // overlay renders, so film and ground agree; ground is only evaluated
    // where a wet cell touches the corner — everywhere else no quad emits)
    const micro = this.micro;
    const cT = COR_TABLE, cG = COR_GROUND;
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        let s = 0, sw = 0, sWet = 0, anyWet = false;
        for (let dj = -1; dj <= 0; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= GRID) continue;
          for (let di = -1; di <= 0; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= GRID) continue;
            const kk = jj * GRID + ii;
            const w = wet[kk] > 0 ? wet[kk] : 0.15;
            s += w * surf[kk];
            sw += w;
            if (wet[kk] > 0) { anyWet = true; sWet += wet[kk]; }
          }
        }
        const c = j * (GRID + 1) + i;
        // ONLY a corner touched by genuinely wet cells carries a level —
        // dry corners must read depth 0, or the cell-centre-vs-corner
        // curvature mismatch alone emits phantom water over the whole map
        cT[c] = sWet > 0.02 ? s / sw : 0;
        cG[c] = 0;
        if (anyWet) {
          const x = i * cell - HALF, z = j * cell - HALF;
          const microD = micro ? micro.sampleDelta(x, z) : 0;
          const worldD = micro && microD === 0 ? micro.sampleWorldDelta(x, z) : 0;
          cG[c] = sampleHeight(this.terrain, i * cell, j * cell)
            + this.ground.dynLiftBilerp(x, z) + microD + worldD;
        }
      }
    }
    // ---- pass 4: emit — one quad per cell whose corners carry water; the
    // corner DEPTH is table − ground (a bump poking through the table just
    // shoals, the way real bedrock does)
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const c00 = j * (GRID + 1) + i, c10 = c00 + 1;
        const c01 = c00 + (GRID + 1), c11 = c01 + 1;
        const d00 = Math.max(cT[c00] - cG[c00], 0), d10 = Math.max(cT[c10] - cG[c10], 0);
        const d01 = Math.max(cT[c01] - cG[c01], 0), d11 = Math.max(cT[c11] - cG[c11], 0);
        // Only emit quads for genuine water bodies with liquid depth (never thin rain films on slopes)
        if (d00 < 0.030 && d10 < 0.030 && d01 < 0.030 && d11 < 0.030) continue;
        const x0 = i * cell - HALF, x1 = x0 + cell;
        const z0 = j * cell - HALF, z1 = z0 + cell;
        // per-corner surface = level water table, flush with ground at shorelines (never hovering in air)
        const y00 = Math.min(cT[c00], cG[c00] + d00) + 0.001;
        const y10 = Math.min(cT[c10], cG[c10] + d10) + 0.001;
        const y11 = Math.min(cT[c11], cG[c11] + d11) + 0.001;
        const y01 = Math.min(cT[c01], cG[c01] + d01) + 0.001;
        verts.push(x0, y00, z0, x1, y10, z0, x1, y11, z1, x0, y00, z0, x1, y11, z1, x0, y01, z1);
        depths.push(d00, d10, d11, d00, d11, d01);
      }
    }
    const geo = this.puddleMesh.geometry as THREE.BufferGeometry;
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setAttribute("aDepth", new THREE.BufferAttribute(new Float32Array(depths), 1));
    geo.setIndex(null);
    geo.computeBoundingSphere();
  }

  // ------------------------------------------------------------------- river
  /** The river as a true 3-D water volume (the Timberborn read): a ribbon
   *  mesh skinned from the terrain's station chain. Its SURFACE rides the
   *  water table down the channel — near-flat ACROSS the channel, gently
   *  sloped ALONG it — not the parabolic bed, so the river reads as a body
   *  of water between its banks instead of a wet film draping every bed
   *  bump (the old drape made the channel a shiny groove in the ground).
   *  The vertex stage gives it real travelling waves (WATER_WAVE_GLSL);
   *  the fragment shades it with the ONE shared water look, so the current,
   *  foam and colour match the pond sheet and the contact film sheet
   *  everywhere the three hand over. Built ONCE — the spring-fed channel is
   *  permanent; the physics pond field beneath it keeps its own water
   *  accounting untouched. */
  private buildRiver() {
    const pts = this.terrain.riverPts;
    const NA = 26; // cross-section vertices (~0.4 m gorge .. ~1 m lowland)
    const verts: number[] = [];
    const depths: number[] = [];
    const fades: number[] = [];
    const idx: number[] = [];
    const rowStart: number[] = [];
    const sMax = pts.length ? pts[pts.length - 1].s : 1;

    // Precalculate water level per station directly anchored to the real carved riverbed!
    const wlStation = new Float32Array(pts.length);
    let prevWl = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const bedH = sampleHeight(this.terrain, p.x, p.y);
      const targetDepth = 0.55 + 0.35 * (p.s / sMax); // 0.55m in gorge, 0.90m in lowland
      let wl = bedH + targetDepth;
      // Monotonic downhill flow: water level must never flow uphill
      wl = Math.min(prevWl - 0.005, wl);
      // Ensure water is always at least 0.20m above the carved thalweg bed
      wl = Math.max(wl, bedH + 0.20);
      prevWl = wl;
      wlStation[i] = wl;
    }

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)], b2 = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b2.x - a.x, ty = b2.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl; // downstream tangent
      const nx = -ty, nz = tx; // across-channel normal
      
      const wl = wlStation[i];
      const halfW = p.w * 0.90; // across the carved canyon channel
      // fade in past the tarn — the tarn's own pond sheet owns the lake
      const fade = Math.max(0, Math.min(1, (p.s - 6) / 26));
      rowStart.push(verts.length / 3);
      for (let c = 0; c <= NA; c++) {
        const sc = (2 * c) / NA - 1; // -1..1 across the channel
        const off = halfW * Math.sign(sc) * Math.pow(Math.abs(sc), 0.70);
        const sx = p.x + nx * off, sz = p.y + nz * off; // 0..WORLD_SIZE frame
        const terH = sampleHeight(this.terrain, sx, sz);
        const depth = Math.max(wl - terH, 0);
        
        // 3D Water Volume Shaping:
        // Inside the channel where water has depth (wl > terH):
        //   the water surface sits at the horizontal water table wl.
        // At the banks where terrain rises above water (terH >= wl):
        //   the vertex seamlessly pins flush to the terrain bank (terH + 0.002m), depth = 0.
        // This ensures the river is a true 3D volumetric water body nestled between canyon walls,
        // with ZERO floating paper edges and realistic bank shoreline feathering.
        const y = depth > 0 ? wl : terH + 0.002;
        
        verts.push(sx - HALF, y, sz - HALF);
        depths.push(depth);
        fades.push(fade);
      }
    }
    // indices — skip quads where all 4 corners are on dry banks
    for (let i = 0; i < pts.length - 1; i++) {
      for (let c = 0; c < NA; c++) {
        const r0 = rowStart[i] + c, r1 = rowStart[i] + c + 1;
        const r2 = rowStart[i + 1] + c, r3 = rowStart[i + 1] + c + 1;
        if (Math.max(depths[r0], depths[r1], depths[r2], depths[r3]) < 0.02) continue;
        idx.push(r0, r2, r1, r1, r2, r3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("aDepth", new THREE.Float32BufferAttribute(depths, 1));
    geo.setAttribute("aFade", new THREE.Float32BufferAttribute(fades, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.FrontSide,
      uniforms: {
        uTime: { value: 0 },
        uRain: { value: 0 },
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uSky: { value: new THREE.Color(0x8fa3b5) },
        uSun: { value: new THREE.Color(0xffd9a8) },
        uSunDir: { value: new THREE.Vector3(0.5, 0.4, -0.6) },
        uCamPos: { value: new THREE.Vector3() },
        uFogColor: { value: new THREE.Color(0xe6d2ac) },
        uFogDensity: { value: 0.0026 },
        uFlowTex: { value: this.flowTex },
        // vertex-stage twin of uFlowTex — a sampler shared by both stages
        // never binds for the vertex stage in this three build (see the
        // worldEditV twin in world.ts); SAME texture object, own name
        uFlowTexV: { value: this.flowTex },
      },
      vertexShader: `
        attribute float aDepth;
        attribute float aFade;
        uniform float uTime;
        uniform vec2 uWindDir;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vFade;
        ${WATER_WAVE_GLSL}
        void main(){
          vDepth = aDepth;
          vFade = aFade;
          // waves grow with depth and die at the banks / the tarn handoff
          float shoreFade = smoothstep(0.02, 0.30, aDepth) * aFade;
          vec3 wp = position;
          wp.y += waterWaveY(position.xz, shoreFade);
          vWorld = wp;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime, uRain, uFogDensity;
        uniform vec3 uSky, uSun, uSunDir, uFogColor, uCamPos;
        uniform vec2 uWindDir;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vFade;
        ${WATER_SURFACE_GLSL}
        void main(){
          if (vDepth < 0.0008) discard;
          vec3 col;
          float alpha;
          waterLook(vWorld, vDepth, col, alpha);
          // shoreline: anti-aliased ramp over the depth field (continuous
          // per-fragment) — the ramp WIDENS with camera distance so the
          // waterline stays a smooth curve instead of an aliased polygon
          // stair-step at any range; the foam edge band owns the bright line
          float farR = smoothstep(3.0, 16.0, distance(uCamPos, vWorld));
          alpha *= smoothstep(0.0, mix(0.02, 0.12, farR), vDepth) * vFade;
          if (alpha < 0.004) discard;
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dot(uCamPos - vWorld, uCamPos - vWorld));
          col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
          gl_FragColor = vec4(col, alpha);
          // SAME tone-map + output-encode as the terrain (see the film sheet)
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.riverMesh = new THREE.Mesh(geo, mat);
    this.riverMesh.renderOrder = 6; // above the ground overlay (1), puddles (4) and the film sheet (5)
    this.riverMesh.frustumCulled = false;
    this.scene.add(this.riverMesh);
  }

  setRainQuality(count: number) {
    this.rainCap = Math.min(count, this.baseRainCount);
  }

  /** QA: rain field state — drops persist and fall between frames */
  rainDebug() {
    const drops: number[][] = [];
    const n = Math.min(this.activeDrops, 8);
    for (let i = 0; i < n; i++) {
      drops.push([+this.dropPos[i * 3].toFixed(2), +this.dropPos[i * 3 + 1].toFixed(2),
        +this.dropPos[i * 3 + 2].toFixed(2)]);
    }
    return { active: this.activeDrops, cap: this.rainCap, drops };
  }

  // ------------------------------------------------------------------- audio
  private out(): AudioNode {
    return this.masterGain ?? this.audioCtx!.destination;
  }

  initAudio() {
    if (this.audioCtx) return;
    try {
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      // master gain: ONE fader every sound passes through — mute ramps it
      // to zero (the old code only stopped UPDATING the rain/wind gains, so
      // a live storm kept hissing after "mute")
      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;
      this.masterGain.connect(ctx.destination);
      // 2 s of white noise, looped
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02; // slight brown tint
        d[i] = w * 0.5 + last * 2;
      }
      this.noiseBuf = buf;
      // rain hiss: bandpassed noise
      const rainSrc = ctx.createBufferSource();
      rainSrc.buffer = buf; rainSrc.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 0.6;
      this.rainGain = ctx.createGain();
      this.rainGain.gain.value = 0;
      rainSrc.connect(bp).connect(this.rainGain).connect(this.out());
      rainSrc.start();
      // wind: lowpassed noise
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = buf; windSrc.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 420;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      windSrc.connect(lp).connect(this.windGain).connect(this.out());
      windSrc.start();
    } catch { /* audio unavailable */ }
  }

  /** master volume 0..1 (settings slider) */
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyMaster();
  }

  /** real mute: the master fader ramps to silence in ~40 ms */
  setMuted(m: boolean) {
    this.muted = m;
    this.applyMaster();
  }

  private applyMaster() {
    const g = this.masterGain, ctx = this.audioCtx;
    if (!g || !ctx) return;
    const target = this.muted ? 0 : this.volume;
    g.gain.cancelScheduledValues(ctx.currentTime);
    if (ctx.state === "running") {
      g.gain.setTargetAtTime(target, ctx.currentTime, 0.04);
    } else {
      // suspended context (autoplay policy / headless): apply instantly —
      // the ramp times are frozen while the clock stands still
      g.gain.value = target;
    }
  }

  /** QA: the live master fader value (0 when muted) */
  masterLevel(): number {
    return this.masterGain ? this.masterGain.gain.value : -1;
  }

  playThunder(power: number) {
    const ctx = this.audioCtx;
    if (!ctx || !this.noiseBuf || this.muted) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.32;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, ctx.currentTime);
    lp.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 2.6);
    const g = ctx.createGain();
    const peak = Math.min(0.7, 0.25 + power * 0.5);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 3.4 + power);
    src.connect(lp).connect(g).connect(this.out());
    src.start();
    src.stop(ctx.currentTime + 4.5);
  }

  /** a footfall, by ground state (dry crunch → wet squelch → mud suck) */
  playStep(kind: StepKind, power = 1) {
    const ctx = this.audioCtx;
    if (!ctx || !this.noiseBuf || this.muted) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    let dur = 0.09;
    if (kind === "dry") {
      f.type = "highpass"; f.frequency.value = 1400;
      src.playbackRate.value = 1.9;
      g.gain.setValueAtTime(0.05 * power, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    } else if (kind === "moist") {
      f.type = "bandpass"; f.frequency.setValueAtTime(420, t0);
      f.frequency.exponentialRampToValueAtTime(680, t0 + 0.07);
      f.Q.value = 0.9;
      g.gain.setValueAtTime(0.07 * power, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    } else if (kind === "wet") {
      f.type = "bandpass"; f.frequency.setValueAtTime(260, t0);
      f.frequency.exponentialRampToValueAtTime(760, t0 + 0.11);
      f.Q.value = 1.4;
      g.gain.setValueAtTime(0.09 * power, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    } else { // mud: low thump + downward squelch
      dur = 0.16;
      f.type = "bandpass"; f.frequency.setValueAtTime(300, t0);
      f.frequency.exponentialRampToValueAtTime(110, t0 + 0.14);
      f.Q.value = 1.1;
      g.gain.setValueAtTime(0.11 * power, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    }
    src.connect(f).connect(g).connect(this.out());
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /** boot pulled out of saturated fines — the suction pop */
  playSuction(strength: number) {
    const ctx = this.audioCtx;
    if (!ctx || !this.noiseBuf || this.muted) return;
    if (ctx.currentTime - this.lastSuction < 0.25) return;
    this.lastSuction = ctx.currentTime;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.2;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass"; f.Q.value = 2.2;
    f.frequency.setValueAtTime(700, t0);
    f.frequency.exponentialRampToValueAtTime(130, t0 + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.min(0.16, 0.07 + strength * 0.1), t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    src.connect(f).connect(g).connect(this.out());
    src.start(t0);
    src.stop(t0 + 0.2);
    // the pop itself: short low sine
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95, t0 + 0.02);
    osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.1 * strength, t0 + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    osc.connect(og).connect(this.out());
    osc.start(t0 + 0.02);
    osc.stop(t0 + 0.12);
  }

  /** spade stroke: cut / hard clay clink / suction heave */
  playDigHit(kind: "cut" | "hard" | "suck" | "spoil") {
    const ctx = this.audioCtx;
    if (!ctx || !this.noiseBuf || this.muted) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    if (kind === "cut") {
      f.type = "bandpass"; f.frequency.setValueAtTime(900, t0);
      f.frequency.exponentialRampToValueAtTime(350, t0 + 0.07);
      f.Q.value = 0.8;
      g.gain.setValueAtTime(0.12, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    } else if (kind === "hard") {
      f.type = "highpass"; f.frequency.value = 2000;
      g.gain.setValueAtTime(0.08, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    } else if (kind === "suck") {
      f.type = "bandpass"; f.Q.value = 2.0;
      f.frequency.setValueAtTime(620, t0);
      f.frequency.exponentialRampToValueAtTime(150, t0 + 0.16);
      g.gain.setValueAtTime(0.13, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    } else { // spoil landing
      f.type = "lowpass"; f.frequency.value = 420;
      g.gain.setValueAtTime(0.09, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    }
    src.connect(f).connect(g).connect(this.out());
    src.start(t0);
    src.stop(t0 + 0.25);
  }

  // ------------------------------------------------------------------- update
  update(dt: number, elapsed: number, camPos: THREE.Vector3, playerPos: THREE.Vector3,
    rainAtPlayer: number, windMs: number, windDirRad: number, cloudiness: number,
    sunDir: THREE.Vector3, fogColor: THREE.Color, fogDensity: number) {
    // ---- rain: integrate persistent drops; streaks billboard on the GPU ---
    const mat = this.rainMesh.material as THREE.ShaderMaterial;
    const intensityNorm = Math.min(Math.sqrt(Math.max(rainAtPlayer, 0) / 60), 1);
    mat.uniforms.uIntensity.value = Math.min(intensityNorm * 1.6, 1.0);
    (mat.uniforms.uCamPos.value as THREE.Vector3).copy(camPos);
    // Marshall-Palmer drop size from local intensity → fall speed
    const dMed = medianDropMm(Math.max(rainAtPlayer, 0.05));
    const fall = dropFallSpeed(dMed);
    // drops drift with the wind (≈55% of wind speed: real terminal-streak tilt)
    const windX = Math.cos(windDirRad) * windMs * 0.55;
    const windZ = Math.sin(windDirRad) * windMs * 0.55;
    const active = intensityNorm > 0.01
      ? Math.max(24, Math.floor(this.rainCap * Math.min(intensityNorm * 1.25, 1)))
      : 0;
    // newly visible drops enter around the camera
    for (let i = this.activeDrops; i < active; i++) this.respawnDrop(i, camPos, fall, windX, windZ);
    this.activeDrops = active;
    this.rainGeo.instanceCount = active;
    const micro = this.micro;
    for (let i = 0; i < active; i++) {
      const i3 = i * 3;
      this.dropPos[i3] += this.dropVel[i3] * dt;
      this.dropPos[i3 + 1] += this.dropVel[i3 + 1] * dt;
      this.dropPos[i3 + 2] += this.dropVel[i3 + 2] * dt;
      // wrap horizontally in the camera box (while: survives teleports)
      let dx = this.dropPos[i3] - camPos.x;
      while (dx > this.boxR) { this.dropPos[i3] -= 2 * this.boxR; dx -= 2 * this.boxR; }
      while (dx < -this.boxR) { this.dropPos[i3] += 2 * this.boxR; dx += 2 * this.boxR; }
      let dz = this.dropPos[i3 + 2] - camPos.z;
      while (dz > this.boxR) { this.dropPos[i3 + 2] -= 2 * this.boxR; dz -= 2 * this.boxR; }
      while (dz < -this.boxR) { this.dropPos[i3 + 2] += 2 * this.boxR; dz += 2 * this.boxR; }
      // landing? (terrain + micro window, so drops find dug holes too)
      const gy = sampleHeight(this.terrain, this.dropPos[i3] + HALF, this.dropPos[i3 + 2] + HALF)
        + (micro ? micro.sampleDelta(this.dropPos[i3], this.dropPos[i3 + 2]) : 0);
      if (this.dropPos[i3 + 1] <= gy + 0.03) {
        const ddx = this.dropPos[i3] - playerPos.x, ddz = this.dropPos[i3 + 2] - playerPos.z;
        if (ddx * ddx + ddz * ddz < 81 && Math.random() < 0.22) {
          // rings read larger on standing water
          const onPond = this.ground.hPond[cellIndex(this.dropPos[i3], this.dropPos[i3 + 2])] > 0.002;
          this.spawnSplash(this.dropPos[i3], gy + 0.03, this.dropPos[i3 + 2], onPond ? 1.5 : 0.95);
        }
        this.respawnDrop(i, camPos, fall, windX, windZ);
      }
    }
    this.aPosAttr.needsUpdate = true;
    this.aVelAttr.needsUpdate = true;

    // splash lifecycle
    const m = new THREE.Matrix4();
    const sm = new THREE.Matrix4();
    const sq = new THREE.Quaternion();
    const ss = new THREE.Vector3();
    const sp = new THREE.Vector3();
    for (let i = 0; i < this.splashCount; i++) {
      const life = this.splashLife[i];
      if (life < 0) {
        m.makeTranslation(0, -999, 0);
        this.splash.setMatrixAt(i, m);
        continue;
      }
      const age = life;
      const scale = this.splashScale[i] * (0.09 + age * 0.55);
      const alpha = Math.max(0, 1 - age / 0.4);
      sp.set(this.splashPos[i * 3], this.splashPos[i * 3 + 1], this.splashPos[i * 3 + 2]);
      sq.identity();
      ss.set(scale, 1, scale);
      // shrink alpha → emulate by shrinking scale near end
      ss.multiplyScalar(alpha * 0.75 + 0.25);
      sm.compose(sp, sq, ss);
      this.splash.setMatrixAt(i, sm);
      this.splashLife[i] = age + dt >= 0.4 ? -1 : age + dt;
    }
    this.splash.instanceMatrix.needsUpdate = true;

    // dust lifecycle: expands, drifts up, fades
    const dm = new THREE.Matrix4();
    const dq = new THREE.Quaternion();
    const ds = new THREE.Vector3();
    const dp = new THREE.Vector3();
    for (let i = 0; i < this.dustCount; i++) {
      const life = this.dustLife[i];
      if (life < 0) {
        dm.makeTranslation(0, -999, 0);
        this.dust.setMatrixAt(i, dm);
        continue;
      }
      const age = life;
      const scale = 0.22 + age * 1.4;
      const alpha = Math.max(0, 1 - age / 0.85);
      dp.set(
        this.dustPos[i * 3] + Math.sin(age * 7 + i) * 0.08,
        this.dustPos[i * 3 + 1] + age * 0.55,
        this.dustPos[i * 3 + 2] + Math.cos(age * 6 + i) * 0.08);
      dq.identity();
      ds.set(scale * (alpha * 0.6 + 0.4), 1, scale * (alpha * 0.6 + 0.4));
      dm.compose(dp, dq, ds);
      this.dust.setMatrixAt(i, dm);
      this.dustLife[i] = age + dt >= 0.85 ? -1 : age + dt;
    }
    this.dust.instanceMatrix.needsUpdate = true;

    // mud droplets: ballistic arcs, shrink as they fly
    const mdm = new THREE.Matrix4();
    const mdq = new THREE.Quaternion();
    const mds = new THREE.Vector3();
    const mdp = new THREE.Vector3();
    for (let i = 0; i < this.mudDropCount; i++) {
      const life = this.mudLife[i];
      if (life < 0) {
        mdm.makeTranslation(0, -999, 0);
        this.mudDrops.setMatrixAt(i, mdm);
        continue;
      }
      const age = life + dt;
      this.mudVel[i * 3 + 1] -= 9.8 * dt;
      this.mudPos[i * 3] += this.mudVel[i * 3] * dt;
      this.mudPos[i * 3 + 1] += this.mudVel[i * 3 + 1] * dt;
      this.mudPos[i * 3 + 2] += this.mudVel[i * 3 + 2] * dt;
      const fade = Math.max(0, 1 - age / 0.7);
      mdp.set(this.mudPos[i * 3], this.mudPos[i * 3 + 1], this.mudPos[i * 3 + 2]);
      mdq.identity();
      mds.setScalar(0.6 + 0.55 * fade);
      mdm.compose(mdp, mdq, mds);
      this.mudDrops.setMatrixAt(i, mdm);
      this.mudLife[i] = age >= 0.7 ? -1 : age;
    }
    this.mudDrops.instanceMatrix.needsUpdate = true;

    // puddle shader
    const pm = this.puddleMesh.material as THREE.ShaderMaterial;
    pm.uniforms.uTime.value = elapsed;
    pm.uniforms.uRain.value = Math.min(rainAtPlayer / 50, 1);
    pm.uniforms.uWindDir.value.set(Math.cos(windDirRad), Math.sin(windDirRad));
    // the fine sheet dissolves inside the contact window (film owns it there)
    if (this.micro) {
      (pm.uniforms.uWinOrigin.value as THREE.Vector2).set(this.micro.ox, this.micro.oz);
    }
    pm.uniforms.uSky.value.setRGB(
      0.62 - 0.42 * cloudiness, 0.72 - 0.38 * cloudiness, 0.82 - 0.33 * cloudiness);
    pm.uniforms.uSun.value.setRGB(1.0, 0.85, 0.62).multiplyScalar(1 - 0.92 * cloudiness);
    pm.uniforms.uSunDir.value.copy(sunDir);
    pm.uniforms.uFogColor.value.copy(fogColor);
    pm.uniforms.uFogDensity.value = fogDensity;
    pm.uniforms.uCamPos.value.copy(camPos);

    // river ribbon — the SAME environment as the pond sheet (one water look)
    const rm = this.riverMesh.material as THREE.ShaderMaterial;
    rm.uniforms.uTime.value = elapsed;
    rm.uniforms.uRain.value = Math.min(rainAtPlayer / 50, 1);
    rm.uniforms.uWindDir.value.set(Math.cos(windDirRad), Math.sin(windDirRad));
    (rm.uniforms.uSky.value as THREE.Color).copy(pm.uniforms.uSky.value as THREE.Color);
    (rm.uniforms.uSun.value as THREE.Color).copy(pm.uniforms.uSun.value as THREE.Color);
    rm.uniforms.uSunDir.value.copy(sunDir);
    rm.uniforms.uFogColor.value.copy(fogColor);
    rm.uniforms.uFogDensity.value = fogDensity;
    rm.uniforms.uCamPos.value.copy(camPos);

    // the mud sheen rides the SAME sky/sun environment, on the contact
    // overlay too — every frame, film or no film (mud still glows after
    // the water dries into it)
    if (this.micro) {
      this.micro.setSkySheen(
        pm.uniforms.uSky.value as THREE.Color, sunDir, pm.uniforms.uSun.value as THREE.Color);
    }

    // the contact-tier film sheet rides the same sky/sun/fog environment
    if (this.micro) {
      this.micro.setWaterEnv(elapsed, Math.min(rainAtPlayer / 50, 1), camPos, sunDir,
        pm.uniforms.uSky.value as THREE.Color, pm.uniforms.uSun.value as THREE.Color,
        fogColor, fogDensity, windDirRad);
    }

    // audio levels — always tracked; the master fader owns mute/volume
    if (this.rainGain) {
      const target = Math.min(rainAtPlayer / 90, 1) * 0.24;
      this.rainGain.gain.value += (target - this.rainGain.gain.value) * Math.min(dt * 3, 1);
    }
    if (this.windGain) {
      const target = Math.min(windMs / 25, 1) * 0.16;
      this.windGain.gain.value += (target - this.windGain.gain.value) * Math.min(dt * 3, 1);
    }
  }
}
