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

const HALF = WORLD_SIZE / 2;

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
    this.buildPuddles();

    this.splashLife = new Float32Array(this.splashCount).fill(-1);
    this.splashPos = new Float32Array(this.splashCount * 3);
    this.splashScale = new Float32Array(this.splashCount).fill(1);
    this.dustLife = new Float32Array(this.dustCount).fill(-1);
    this.dustPos = new Float32Array(this.dustCount * 3);
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

  // ----------------------------------------------------------------- puddles
  private buildPuddles() {
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
        // the fine-tier sheet dissolves approaching it (no double-stacked
        // water square that follows the player)
        uWinOrigin: { value: new THREE.Vector2(0, 0) },
        uWinHalf: { value: MICRO_HALF - 0.5 },
      },
      vertexShader: `
        attribute float aDepth; // pond depth at this vertex [m]
        uniform vec2 uWinOrigin;
        uniform float uWinHalf;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vWin;
        void main(){
          vWorld = position;
          vDepth = aDepth;
          // 0 inside the micro window → 1 beyond a 1.2 m handoff band
          float wd = max(abs(position.x - uWinOrigin.x), abs(position.z - uWinOrigin.y));
          vWin = smoothstep(uWinHalf, uWinHalf + 1.2, wd);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime, uRain, uFogDensity;
        uniform vec3 uSky, uSun, uSunDir, uFogColor, uCamPos, uWet;
        uniform vec2 uWindDir;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vWin;
        void main(){
          if (vDepth < 0.0006) discard;
          // Beer-Lambert-ish depth ramp: shallow film reads as a wet-earth
          // sheen (the soil shows through), depth → full sky-reflecting water
          float dN = 1.0 - exp(-vDepth * 8.0);
          vec2 p = vWorld.xz;
          // wind-aligned capillary waves — deeper water is livelier — + prickle
          float w1 = sin(dot(p, uWindDir) * 2.6 + uTime * 2.2) * cos(p.x * 1.9 - uTime * 1.5);
          float w2 = sin((p.x + p.y) * 3.4 + uTime * 3.0) * 0.5;
          float prickle = uRain * (sin(p.x * 21.0 + uTime * 11.0) * sin(p.y * 17.0 - uTime * 9.0));
          float amp = 0.030 + 0.055 * dN;
          vec3 n = normalize(vec3(w1 * amp + w2 * amp + prickle * 0.10, 1.0,
                                  w2 * amp - w1 * amp * 0.8 + prickle * 0.09));
          vec3 v = normalize(uCamPos - vWorld);
          float fres = pow(1.0 - max(dot(v, n), 0.0), 2.4);
          float glint = pow(max(dot(reflect(-v, n), normalize(uSunDir)), 0.0), 90.0);
          vec3 col = mix(uWet, uSky * (0.60 + 0.90 * fres), dN);
          col += uSun * glint * 1.6;
          // depth-gated veil MATCHING the contact film sheet's ramp: thin
          // films are wet ground (the terrain shading owns that), real
          // accumulation gets the veil — so water looks the same on either
          // side of the contact-window edge (no wet square following you)
          float veil = smoothstep(0.0008, 0.009, vDepth);
          float alpha = veil * (0.30 + 0.58 * dN) * vWin;
          if (alpha < 0.004) discard;
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dot(uCamPos - vWorld, uCamPos - vWorld));
          col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    this.puddleMesh = new THREE.Mesh(geo, mat);
    this.puddleMesh.renderOrder = 4;
    this.puddleMesh.frustumCulled = false;
    this.scene.add(this.puddleMesh);
  }

  /** rebuild puddle quads from the ponding field (every physics tick).
   *  The sheet DRAPES the ground: every quad corner sits at that corner's own
   *  ground height + its corner-interpolated water depth, so adjacent quads
   * share corner heights — a continuous sloping film instead of flat square
   * plates hovering at one cell-centre height (the "voxel water" look). */
  rebuildPuddles() {
    const hPond = this.ground.hPond;
    const ruts = this.ground.rut;
    const cell = WORLD_SIZE / GRID;
    const verts: number[] = [];
    const depths: number[] = [];
    // water depth at a grid CORNER = mean over the (up to four) cells meeting
    // there — shared corner values interpolate smoothly across cell edges,
    // which is what feathers the waterline in the shader
    const cornerDepth = (i: number, j: number): number => {
      let s = 0, c = 0;
      for (let dj = -1; dj <= 0; dj++) {
        for (let di = -1; di <= 0; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || ii >= GRID || jj < 0 || jj >= GRID) continue;
          const k = jj * GRID + ii;
          s += hPond[k] + ruts[k] * 0.35;
          c++;
        }
      }
      return c > 0 ? s / c : 0;
    };
    // ground height (terrain + fine dynamic lift + micro relief) at a corner —
    // the same stack the contact overlay renders, so film and ground agree.
    // Outside the micro window the relief comes from the far-field edit
    // cache, so pond sheets drape into ditches you dug far away too.
    const micro = this.micro;
    const cornerGround = (i: number, j: number): number => {
      const x = i * cell - HALF, z = j * cell - HALF;
      const microD = micro ? micro.sampleDelta(x, z) : 0;
      const worldD = micro && microD === 0 ? micro.sampleWorldDelta(x, z) : 0;
      return sampleHeight(this.terrain, i * cell, j * cell)
        + this.ground.dynLiftAt(x, z)
        + microD + worldD;
    };
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const depth = hPond[k] + ruts[k] * 0.35;
        if (depth < 0.0009) continue; // ~0.9 mm minimum film (matches the contact sheet)
        const x0 = i * cell - HALF, x1 = x0 + cell;
        const z0 = j * cell - HALF, z1 = z0 + cell;
        const d00 = cornerDepth(i, j), d10 = cornerDepth(i + 1, j);
        const d11 = cornerDepth(i + 1, j + 1), d01 = cornerDepth(i, j + 1);
        // per-corner surface = ground + depth (+12 mm z-fight guard)
        const y00 = cornerGround(i, j) + 0.012 + d00;
        const y10 = cornerGround(i + 1, j) + 0.012 + d10;
        const y11 = cornerGround(i + 1, j + 1) + 0.012 + d11;
        const y01 = cornerGround(i, j + 1) + 0.012 + d01;
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
