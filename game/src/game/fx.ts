/**
 * Storm FX: GPU-friendly rain streaks wrapped in a box around the camera
 * (Marshall-Palmer fall speeds), ground splash rings, a dynamic puddle mesh
 * grown from the ground-physics ponding field with an animated ripple shader,
 * and fully procedural WebAudio (rain hiss, wind, thunder rumbles).
 */
import * as THREE from "three";
import { GRID, WORLD_SIZE, TerrainData, sampleHeight } from "./terrain";
import { Ground } from "./ground";
import { dropFallSpeed, medianDropMm } from "./params";
import { MicroTerrain } from "./contact";

const HALF = WORLD_SIZE / 2;

export type StepKind = "dry" | "moist" | "wet" | "mud";

export class StormFX {
  scene: THREE.Scene;
  terrain: TerrainData;
  ground: Ground;
  micro: MicroTerrain | null;

  rainMesh: THREE.InstancedMesh;
  splash: THREE.InstancedMesh;
  dust: THREE.InstancedMesh;
  puddleMesh: THREE.Mesh;
  private rainGeo: THREE.BufferGeometry;

  private rainCount: number;
  private baseRainCount: number;
  private splashCount = 240;
  private splashLife: Float32Array;
  private splashPos: Float32Array;
  private splashIdx = 0;
  private dustCount = 96;
  private dustLife: Float32Array;
  private dustPos: Float32Array;
  private dustIdx = 0;
  private rainSeeds: Float32Array; // per-drop random phase
  private dropSpeed = 8.5;
  private lastSuction = 0;

  // audio
  private audioCtx: AudioContext | null = null;
  private rainGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  constructor(scene: THREE.Scene, terrain: TerrainData, ground: Ground, rainCount = 5200,
    micro?: MicroTerrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.ground = ground;
    this.micro = micro ?? null;
    this.baseRainCount = rainCount;
    this.rainCount = rainCount;

    this.buildRain();
    this.buildSplashes();
    this.buildDust();
    this.buildPuddles();

    this.splashLife = new Float32Array(this.splashCount).fill(-1);
    this.splashPos = new Float32Array(this.splashCount * 3);
    this.dustLife = new Float32Array(this.dustCount).fill(-1);
    this.dustPos = new Float32Array(this.dustCount * 3);
  }

  // -------------------------------------------------------------------- rain
  private buildRain() {
    // vertical streak quad — chunky enough to read at 5–25 m distance
    const geo = new THREE.PlaneGeometry(0.17, 1.35);
    this.rainGeo = geo;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uIntensity: { value: 0 },
        uWindShear: { value: new THREE.Vector2(0.12, 0.03) },
        uFogColor: { value: new THREE.Color(0x99a5ad) },
      },
      vertexShader: `
        uniform vec2 uWindShear;
        varying vec2 vUv;
        void main(){
          vUv = uv;
          vec3 p = position;
          // streak leans with the wind; lean grows toward the top
          p.x += uWindShear.x * (uv.y - 0.5) * 0.85;
          p.y += uWindShear.y * (uv.y - 0.5) * 0.85;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uIntensity;
        varying vec2 vUv;
        void main(){
          // NOTE: no reversed-edge smoothstep — undefined behaviour on some GPUs
          float a = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          a *= 0.5 + 0.5 * vUv.x * (1.0 - vUv.x) * 4.0;
          gl_FragColor = vec4(vec3(0.85, 0.9, 0.96), a * 0.45 * uIntensity);
        }`,
    });
    this.rainMesh = new THREE.InstancedMesh(geo, mat, this.rainCount);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 5;
    const m = new THREE.Matrix4();
    let seed = 17;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    this.rainSeeds = new Float32Array(this.rainCount);
    for (let i = 0; i < this.rainCount; i++) {
      this.rainSeeds[i] = rnd();
      m.makeTranslation(0, -999, 0); // parked below the world until needed
      this.rainMesh.setMatrixAt(i, m);
    }
    this.scene.add(this.rainMesh);
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
          float a = (ring + dots * 0.6) * (1.0 - r * 0.4);
          gl_FragColor = vec4(vec3(0.82, 0.88, 0.92), a * 0.6);
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
    void scale;
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
    geo.setIndex(null);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uRain: { value: 0 }, // local rain intensity for rain-ripple sparkle
        uSky: { value: new THREE.Color(0x8fa3b5) },
        uSun: { value: new THREE.Color(0xffd9a8) },
        uSunDir: { value: new THREE.Vector3(0.5, 0.4, -0.6) },
        uFogColor: { value: new THREE.Color(0xe6d2ac) },
        uFogDensity: { value: 0.0026 },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: `
        varying vec3 vWorld;
        varying float vPond;
        void main(){
          vWorld = position;
          vPond = 1.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime, uRain, uFogDensity;
        uniform vec3 uSky, uSun, uSunDir, uFogColor, uCamPos;
        varying vec3 vWorld;
        varying float vPond;
        void main(){
          // animated normal: two travelling wave fields + rain prickle
          vec2 p = vWorld.xz;
          float w1 = sin(p.x * 1.7 + uTime * 1.9) * cos(p.y * 1.3 - uTime * 1.4);
          float w2 = sin((p.x + p.y) * 2.6 + uTime * 2.7) * 0.5;
          float prickle = uRain * (sin(p.x * 23.0 + uTime * 12.0) * sin(p.y * 19.0 - uTime * 10.0));
          vec3 n = normalize(vec3(w1 * 0.05 + w2 * 0.05 + prickle * 0.09, 1.0, w2 * 0.05 - w1 * 0.04 + prickle * 0.08));
          vec3 v = normalize(uCamPos - vWorld);
          float fres = pow(1.0 - max(dot(v, n), 0.0), 2.2);
          // sky reflection tinted by sun glint
          float glint = pow(max(dot(reflect(-v, n), normalize(uSunDir)), 0.0), 60.0);
          vec3 col = uSky * (0.65 + 0.85 * fres);
          col += uSun * glint * 1.5;
          col = mix(col, uFogColor, 0.08);
          float alpha = 0.82;
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

  /** rebuild puddle quads from the ponding field (every physics tick) */
  rebuildPuddles() {
    const hPond = this.ground.hPond;
    const cell = WORLD_SIZE / GRID;
    const verts: number[] = [];
    const ruts = this.ground.rut;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const depth = hPond[k] + ruts[k] * 0.35;
        if (depth < 0.0016) continue; // ~1.6 mm minimum film
        const x0 = i * cell - HALF, x1 = x0 + cell;
        const z0 = j * cell - HALF, z1 = z0 + cell;
        const xc = (x0 + x1) / 2, zc = (z0 + z1) / 2;
        const yC = sampleHeight(this.terrain, xc + HALF, zc + HALF) +
          (this.micro ? this.micro.sampleDelta(xc, zc) : 0) +
          0.015 + Math.min(depth, 0.3) * 0.35;
        verts.push(x0, yC, z0, x1, yC, z0, x1, yC, z1, x0, yC, z0, x1, yC, z1, x0, yC, z1);
      }
    }
    const geo = this.puddleMesh.geometry as THREE.BufferGeometry;
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex(null);
    geo.computeBoundingSphere();
  }

  setRainQuality(count: number) {
    this.rainMesh.count = Math.min(count, this.baseRainCount);
  }

  // ------------------------------------------------------------------- audio
  initAudio() {
    if (this.audioCtx) return;
    try {
      const ctx = new AudioContext();
      this.audioCtx = ctx;
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
      rainSrc.connect(bp).connect(this.rainGain).connect(ctx.destination);
      rainSrc.start();
      // wind: lowpassed noise
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = buf; windSrc.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 420;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      windSrc.connect(lp).connect(this.windGain).connect(ctx.destination);
      windSrc.start();
    } catch { /* audio unavailable */ }
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
    src.connect(lp).connect(g).connect(ctx.destination);
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
    src.connect(f).connect(g).connect(ctx.destination);
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
    src.connect(f).connect(g).connect(ctx.destination);
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
    osc.connect(og).connect(ctx.destination);
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
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + 0.25);
  }

  // ------------------------------------------------------------------- update
  update(dt: number, elapsed: number, camPos: THREE.Vector3, playerPos: THREE.Vector3,
    rainAtPlayer: number, windMs: number, windDirRad: number, cloudiness: number,
    sunDir: THREE.Vector3, fogColor: THREE.Color, fogDensity: number) {
    const visible = this.rainMesh.count;
    // Marshall-Palmer drop size from local intensity → fall speed
    const dMed = medianDropMm(Math.max(rainAtPlayer, 0.05));
    this.dropSpeed = dropFallSpeed(dMed);
    const mat = this.rainMesh.material as THREE.ShaderMaterial;
    const intensityNorm = Math.min(Math.sqrt(rainAtPlayer / 60), 1);
    mat.uniforms.uIntensity.value = Math.min(intensityNorm * 1.6, 1.0);
    mat.uniforms.uWindShear.value.set(
      Math.cos(windDirRad) * windMs * 0.016, Math.sin(windDirRad) * windMs * 0.016);

    // move drops inside a 26 m box centred on the camera
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const boxR = 13, boxH = 17;
    // deterministic pseudo-random per drop from seeds
    const active = Math.floor(visible * Math.min(intensityNorm * 1.5, 1));
    for (let i = 0; i < visible; i++) {
      const seed = this.rainSeeds[i];
      const inUse = i < active;
      if (!inUse) {
        m.makeTranslation(0, -999, 0);
        this.rainMesh.setMatrixAt(i, m);
        continue;
      }
      const r1 = seed * 7.13, r2 = seed * 3.71;
      let dx = ((r1 % 1) * 2 - 1) * boxR;
      let dz = ((r2 % 1) * 2 - 1) * boxR;
      let dy = ((seed * 9.91) % 1) * boxH;
      // fall: wrapped in the box (camera-anchored)
      dy -= this.dropSpeed * dt * (0.75 + 0.5 * ((seed * 5.3) % 1));
      if (dy < 0) dy += boxH;
      const gx = camPos.x + dx, gy = camPos.y - 7 + dy, gz = camPos.z + dz;
      p.set(gx, gy, gz);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), elapsed * 0.0 + seed * 6.283);
      m.compose(p, q, s);
      this.rainMesh.setMatrixAt(i, m);
      // land splashes for a subset near the player
      if (gy < sampleHeight(this.terrain, gx + HALF, gz + HALF) +
          (this.micro ? this.micro.sampleDelta(gx, gz) : 0) + 0.4 && Math.random() < 0.05) {
        this.spawnSplash(gx, sampleHeight(this.terrain, gx + HALF, gz + HALF) +
          (this.micro ? this.micro.sampleDelta(gx, gz) : 0) + 0.03, gz);
      }
    }
    this.rainMesh.instanceMatrix.needsUpdate = true;

    // splash lifecycle
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
      const scale = 0.14 + age * 1.1;
      const alpha = Math.max(0, 1 - age / 0.45);
      sp.set(this.splashPos[i * 3], this.splashPos[i * 3 + 1], this.splashPos[i * 3 + 2]);
      sq.identity();
      ss.set(scale, 1, scale);
      // shrink alpha → emulate by shrinking scale near end
      ss.multiplyScalar(alpha * 0.8 + 0.2);
      sm.compose(sp, sq, ss);
      this.splash.setMatrixAt(i, sm);
      this.splashLife[i] = age + dt >= 0.45 ? -1 : age + dt;
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
    pm.uniforms.uSky.value.setRGB(
      0.62 - 0.42 * cloudiness, 0.72 - 0.38 * cloudiness, 0.82 - 0.33 * cloudiness);
    pm.uniforms.uSun.value.setRGB(1.0, 0.85, 0.62).multiplyScalar(1 - 0.92 * cloudiness);
    pm.uniforms.uSunDir.value.copy(sunDir);
    pm.uniforms.uFogColor.value.copy(fogColor);
    pm.uniforms.uFogDensity.value = fogDensity;
    pm.uniforms.uCamPos.value.copy(camPos);
    void playerPos;

    // the contact-tier film sheet rides the same sky/sun/fog environment
    if (this.micro) {
      this.micro.setWaterEnv(elapsed, Math.min(rainAtPlayer / 50, 1), camPos, sunDir,
        pm.uniforms.uSky.value as THREE.Color, pm.uniforms.uSun.value as THREE.Color,
        fogColor, fogDensity);
    }

    // audio levels
    if (this.rainGain && !this.muted) {
      const target = Math.min(rainAtPlayer / 90, 1) * 0.24;
      this.rainGain.gain.value += (target - this.rainGain.gain.value) * Math.min(dt * 3, 1);
    }
    if (this.windGain && !this.muted) {
      const target = Math.min(windMs / 25, 1) * 0.16;
      this.windGain.gain.value += (target - this.windGain.gain.value) * Math.min(dt * 3, 1);
    }
  }
}
