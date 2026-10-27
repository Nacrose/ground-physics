/**
 * The engine: fixed-step simulation loop, input, weather scenario playback,
 * lightning orchestration, wagon trafficability story, and the M1-targeted
 * quality auto-scaler (30 fps).
 */
import * as THREE from "three";
import { buildTerrain, TerrainData, WORLD_SIZE } from "./terrain";
import { Ground } from "./ground";
import { World } from "./world";
import { StormFX } from "./fx";
import { Player, InputState } from "./player";
import { HUD } from "./hud";
import { WeatherPlayer } from "./weather";
import { PRESETS, WeatherEntry } from "./params";

const HALF = WORLD_SIZE / 2;
const TS_STEPS = [1, 4, 8, 16, 32, 64];

interface QualityLevel {
  name: string;
  grass: number;
  rain: number;
  pixelRatio: number;
  shadowRes: number;
}

const QUALITY: QualityLevel[] = [
  { name: "LOW", grass: 14000, rain: 1600, pixelRatio: 0.9, shadowRes: 1024 },
  { name: "MEDIUM", grass: 26000, rain: 3000, pixelRatio: 1.1, shadowRes: 1536 },
  { name: "HIGH", grass: 40000, rain: 4200, pixelRatio: 1.3, shadowRes: 2048 },
  { name: "ULTRA", grass: 52000, rain: 5600, pixelRatio: 1.5, shadowRes: 2048 },
];

export class Game {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private terrain: TerrainData;
  private ground: Ground;
  private world!: World;
  private fx!: StormFX;
  private player!: Player;
  private hud!: HUD;
  private weather: WeatherPlayer | null = null;
  private timelines = new Map<string, WeatherEntry[]>();

  private input: InputState = { forward: 0, right: 0, sprint: false, jump: false, yaw: 0, pitch: 0, zoom: 6.2 };
  private keys = new Set<string>();
  private started = false;
  private raf = 0;
  private elapsed = 0;
  private lastFrame = 0;

  // sim clocks
  private groundAccum = 0;
  private simAccum = 0;
  private hudAccum = 0;

  // quality
  private qualityIdx = 2;
  private autoQuality = true;
  private fpsEMA = 60;
  private qualityCheck = 0;

  // wagon story
  private wagonBaseY = 0;
  private wagonVerdict = "PASSABLE";
  private wagonRutCm = 0;
  private wagonTimer = 0;

  // lightning
  private flash = 0;
  private muted = false;
  private letterbox = false;
  private inspectorOpen = false;

  private container: HTMLElement;
  private onFatal?: (msg: string) => void;
  private disposed = false;

  constructor(container: HTMLElement, onFatal?: (msg: string) => void) {
    this.container = container;
    this.onFatal = onFatal;
    this.terrain = buildTerrain(7);
    this.ground = new Ground(this.terrain, 0.42);
  }

  async start() {
    // ---- renderer ------------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    if (!this.renderer.getContext()) throw new Error("WebGL unavailable");
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.domElement.className = "game-canvas";
    this.container.appendChild(this.renderer.domElement);

    // ---- fetch the weather timeline BEFORE creating DOM modules --------------
    // (guards the React StrictMode remount race: a disposed instance must not
    //  append a ghost HUD / bind ghost listeners)
    const tl = await this.fetchTimeline("thunderstorm");
    if (this.disposed) return;
    this.weather = new WeatherPlayer(PRESETS.find((p) => p.key === "thunderstorm")!, tl);

    // ---- modules ------------------------------------------------------------
    this.world = new World(this.scene, this.terrain, this.ground, 52000);
    this.fx = new StormFX(this.scene, this.terrain, this.ground, 5600);
    // spawn on the road near the wagon
    const spawnZ = (0.30 + 0.08 * Math.sin((20 / WORLD_SIZE) * Math.PI * 1.7 + 0.4)) * WORLD_SIZE;
    this.player = new Player(this.scene, this.terrain, this.ground, this.fx, 20 - HALF, spawnZ - HALF);
    this.hud = new HUD(this.container, this.terrain);
    this.wagonBaseY = this.world.wagon.position.y;

    this.applyQuality(QUALITY[this.qualityIdx]);

    // ---- events ---------------------------------------------------------------
    this.bindEvents();
    this.resize();

    // initial physics paint
    this.ground.packTexture(this.terrain.road);
    this.world.refreshGroundTexture();
    this.fx.rebuildPuddles();
    this.hud.paintMapOverlay(this.ground);

    this.lastFrame = performance.now();
    // debug / QA hook (window.__game)
    if (typeof window !== "undefined") {
      (window as unknown as { __game?: Game }).__game = this;
    }
    this.loop();
  }

  private async fetchTimeline(key: string): Promise<WeatherEntry[]> {
    if (!this.timelines.has(key)) {
      const res = await fetch(`/weather/${key}.json`);
      if (!res.ok) throw new Error(`timeline ${key} failed`);
      this.timelines.set(key, (await res.json()) as WeatherEntry[]);
    }
    return this.timelines.get(key)!;
  }

  private async loadPreset(key: string) {
    const tl = await this.fetchTimeline(key);
    if (this.disposed || !this.world) return;
    const def = PRESETS.find((p) => p.key === key)!;
    this.weather = new WeatherPlayer(def, tl);
    this.ground.reset(def.initSat);
    this.ground.patternTime = 0;
    this.world.wagon.position.y = this.wagonBaseY;
    this.world.wagon.rotation.z = 0;
    this.ground.packTexture(this.terrain.road);
    this.world.refreshGroundTexture();
    this.fx.rebuildPuddles();
  }

  // ------------------------------------------------------------------ input
  private bindEvents() {
    const canvas = this.renderer.domElement;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.resize);
    canvas.addEventListener("click", () => {
      if (!this.started) {
        this.started = true;
        this.hud.hideBoot();
        this.fx.initAudio();
      }
      canvas.requestPointerLock?.();
    });
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.input.yaw -= e.movementX * 0.0023;
      this.player?.addPitch(e.movementY * 0.0018);
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.player?.addZoom(e.deltaY * 0.0035);
    }, { passive: false });
  }

  /** run the ground physics forward in 1-minute game steps (QA / debug) */
  fastForward(gameMinutes: number) {
    const w = this.weather;
    if (!w) return;
    const now2 = w.now();
    const steps = Math.max(1, Math.min(Math.round(gameMinutes), 720));
    for (let i = 0; i < steps; i++) {
      this.ground.update({
        coreRainMmH: now2.rainMmH,
        windMs: now2.windMs,
        tempC: now2.tempC,
        rh: now2.rh,
        sw: now2.sw,
        pattern: now2.pattern,
        driftU: 0, driftV: 0,
        dtGame: 60,
        dtReal: 60,
        playerX: this.player.pos.x,
        playerZ: this.player.pos.z,
      });
    }
    this.ground.packTexture(this.terrain.road);
    this.world.refreshGroundTexture();
    this.fx.rebuildPuddles();
    this.hud.paintMapOverlay(this.ground);
  }

  private onKeyDown = async (e: KeyboardEvent) => {
    const code = e.code;
    this.keys.add(code);
    if (code === "Space") e.preventDefault();
    if (code === "KeyE") this.toggleInspector();
    if (code === "KeyT") {
      const w = this.weather;
      if (w) {
        const idx = TS_STEPS.indexOf(w.timescale);
        w.timescale = TS_STEPS[(idx + 1) % TS_STEPS.length] ?? 8;
      }
    }
    if (code === "KeyC") {
      this.letterbox = !this.letterbox;
      this.hud.setLetterbox(this.letterbox);
    }
    if (code === "KeyM") {
      this.muted = !this.muted;
      if (this.fx) this.fx.muted = this.muted;
      this.hud.setMuted(this.muted);
    }
    if (code === "KeyG") {
      this.autoQuality = false;
      this.qualityIdx = (this.qualityIdx + 1) % QUALITY.length;
      this.applyQuality(QUALITY[this.qualityIdx]);
    }
    const presetKeys = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"];
    const pi = presetKeys.indexOf(code);
    if (pi >= 0) {
      try { await this.loadPreset(PRESETS[pi].key); } catch { /* keep old */ }
    }
  }

  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };

  private resize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    if (this.player) {
      this.player.camera.aspect = w / h;
      this.player.camera.updateProjectionMatrix();
    }
  };

  private applyQuality(q: QualityLevel) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.world.setGrassQuality(q.grass);
    this.fx.setRainQuality(q.rain);
    this.world.sun.shadow.mapSize.set(q.shadowRes, q.shadowRes);
    // force shadow map realloc
    if (this.world.sun.shadow.map) {
      this.world.sun.shadow.map.dispose();
      (this.world.sun.shadow as unknown as { map: null }).map = null;
    }
    this.resize();
  }

  private toggleInspector() {
    this.inspectorOpen = !this.inspectorOpen;
    if (!this.inspectorOpen) {
      this.hud.showInspector(null);
      return;
    }
    this.renderInspector();
  }

  private renderInspector() {
    const p = this.player.pos;
    const rep = this.ground.cellReport(p.x, p.z);
    const rainHere = this.ground.rainAt(p.x, p.z);
    const tex = rep.texture;
    const stateColor = rep.consistency === 0 ? "#9fc97a" : rep.consistency === 1 ? "#e3c268" : "#e0685c";
    const rows: Array<[string, string]> = [
      ["TEXTURE", `${tex.label} · ${tex.clay}% clay`],
      ["WATER CONTENT", `${rep.wPct.toFixed(1)} %  (PL ${tex.PL} · LL ${tex.LL})`],
      ["CONSISTENCY", rep.consistencyLabel],
      ["MATRIC SUCTION", `${rep.suctionKpa.toFixed(0)} kPa`],
      ["APPARENT COHESION", `${rep.cEffKpa.toFixed(1)} kPa`],
      ["FRICTION φ′", `${rep.phiEffDeg.toFixed(1)}°`],
      ["BEARING q<sub>ult</sub>", `${rep.qUltKpa.toFixed(0)} kPa`],
      ["CBR", `${rep.cbr.toFixed(1)}`],
      ["SHEAR τ<sub>f</sub>", `${rep.tauFKpa.toFixed(0)} kPa`],
      ["INFIL. CAPACITY", `${rep.infilCapMmH.toFixed(1)} mm/h`],
      ["PONDING", `${rep.pondMm.toFixed(1)} mm`],
      ["RUT DEPTH", `${(rep.rutM * 100).toFixed(1)} cm`],
      ["RAIN HERE", `${rainHere.toFixed(1)} mm/h`],
    ];
    const html = `
      <div class="hud-insp-title">SOIL SURVEY</div>
      <div class="hud-insp-sub">Terzaghi · Fredlund · Atterberg — live</div>
      ${rows.map(([k, v], i) => `
        <div class="hud-insp-row"${i === 2 ? ` style="color:${stateColor}"` : ""}>
          <span>${k}</span><span>${v}</span>
        </div>`).join("")}
      <div class="hud-insp-foot">Green-Ampt column · 4 layers · Clapp-Hornberger</div>`;
    this.hud.showInspector(html);
  }

  // -------------------------------------------------------------------- loop
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    let dtReal = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dtReal > 0.25) dtReal = 0.25; // tab-back spike guard
    if (dtReal <= 0) return;
    this.elapsed += dtReal;

    // fps tracking + auto quality
    this.fpsEMA += (1 / dtReal - this.fpsEMA) * Math.min(dtReal * 0.6, 1);
    this.qualityCheck += dtReal;
    if (this.autoQuality && this.qualityCheck > 5) {
      this.qualityCheck = 0;
      if (this.fpsEMA < 27 && this.qualityIdx > 0) {
        this.applyQuality(QUALITY[--this.qualityIdx]);
      } else if (this.fpsEMA > 46 && this.qualityIdx < QUALITY.length - 1) {
        this.applyQuality(QUALITY[++this.qualityIdx]);
      }
    }

    // ---- gather input ---------------------------------------------------------
    const k = this.keys;
    this.input.forward = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    this.input.right = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    this.input.sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    this.input.jump = k.has("Space");

    // ---- weather playback -------------------------------------------------------
    const w = this.weather;
    if (w) {
      w.advance(dtReal);
      const now2 = w.now();
      const rainAtPlayer = this.ground.rainAt(this.player.pos.x, this.player.pos.z);
      w.updateLightning(dtReal, rainAtPlayer, now2.isStorm);
      this.flash = Math.max(this.flash * Math.exp(-dtReal * 5), w.flashIntensity);
      const th = w.takeThunder();
      if (th) this.fx.playThunder(th.power);
    }

    // ---- fixed-step player sim ---------------------------------------------------
    this.simAccum += dtReal;
    const SIM = 1 / 30;
    let steps = 0;
    while (this.simAccum >= SIM && steps < 4) {
      this.player.update(SIM, this.input, this.elapsed);
      this.simAccum -= SIM;
      steps++;
    }
    if (steps === 4) this.simAccum = 0;

    // ---- ground physics tick (0.5 s real → dtGame seconds) ------------------------
    this.groundAccum += dtReal;
    if (this.groundAccum >= 0.5 && w) {
      const dtGame = this.groundAccum * w.timescale;
      const now2 = w.now();
      const drift = 8 + now2.windMs * 0.6; // pattern drift speed (real m/s)
      this.ground.update({
        coreRainMmH: now2.rainMmH,
        windMs: now2.windMs,
        tempC: now2.tempC,
        rh: now2.rh,
        sw: now2.sw,
        pattern: now2.pattern,
        driftU: Math.cos(now2.windDirRad) * drift,
        driftV: Math.sin(now2.windDirRad) * drift,
        dtGame,
        dtReal: this.groundAccum,
        playerX: this.player.pos.x,
        playerZ: this.player.pos.z,
      });
      this.groundAccum = 0;
      this.ground.packTexture(this.terrain.road);
      this.world.refreshGroundTexture();
      this.fx.rebuildPuddles();
      this.hud.paintMapOverlay(this.ground);

      // ---- wagon trafficability story ------------------------------------------
      this.wagonTimer += 0.5;
      if (this.wagonTimer >= 3) {
        this.wagonTimer = 0;
        const wx = this.world.wagon.position.x, wz = this.world.wagon.position.z;
        const res = this.ground.applyWheelLoad(wx, wz, 150, false);
        this.wagonVerdict = res.verdict;
        const rut = this.ground.rut[
          Math.max(0, Math.min(36863, Math.floor((wz + HALF) / 4) * 192 + Math.floor((wx + HALF) / 4)))];
        this.wagonRutCm = rut * 100;
        this.world.wagon.position.y = this.wagonBaseY - rut * 0.8;
        // tilt toward the deeper side
        const rL = this.ground.rut[
          Math.max(0, Math.min(36863, Math.floor((wz + HALF) / 4) * 192 + Math.floor((wx + HALF - 1.5) / 4)))];
        const rR = this.ground.rut[
          Math.max(0, Math.min(36863, Math.floor((wz + HALF) / 4) * 192 + Math.floor((wx + HALF + 1.5) / 4)))];
        this.world.wagon.rotation.z = Math.max(-0.16, Math.min(0.16, (rR - rL) * 0.8));
      }
    }

    // ---- visuals -------------------------------------------------------------------
    const now2 = w ? w.now() : null;
    const cam = this.player.camera;
    const cloud = now2 ? now2.cloud : 0.1;
    const wind = now2 ? now2.gustMs : 3;
    const windDir = now2 ? now2.windDirRad : 0.2;
    this.world.update(dtReal, this.elapsed, cloud, wind, windDir,
      cam.position, this.player.pos, this.flash);
    const rainAtPlayer = this.ground.rainAt(this.player.pos.x, this.player.pos.z);
    const fog = this.scene.fog as THREE.FogExp2;
    this.fx.update(dtReal, this.elapsed, cam.position, this.player.pos,
      rainAtPlayer, wind, windDir, cloud,
      this.world.uniforms.sunDir.value, fog.color, fog.density);
    this.hud.setFlash(this.flash);

    // ---- HUD -------------------------------------------------------------------------
    this.hudAccum += dtReal;
    if (this.hudAccum > 0.1 && now2) {
      this.hudAccum = 0;
      this.hud.update(1, {
        tMin: now2.tMin,
        presetLabel: now2.presetLabel,
        presetKey: now2.presetKey,
        rainMmH: now2.rainMmH,
        rainAtPlayer,
        windMs: now2.windMs,
        tempC: now2.tempC,
        cloudiness: now2.cloud,
        timescale: now2.timescale,
        fps: this.fpsEMA,
        playerX: this.player.pos.x,
        playerZ: this.player.pos.z,
        playerYaw: this.player.yaw,
        wagonVerdict: this.wagonVerdict,
        wagonRutCm: this.wagonRutCm,
        mudHere: this.player.mud,
      });
      if (this.inspectorOpen && Math.floor(now2.tMin * 2) % 2 === 0) {
        this.renderInspector();
      }
    }

    this.renderer.render(this.scene, cam);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("resize", this.resize);
    this.world?.dispose();
    this.renderer?.dispose();
    if (this.renderer?.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
    if (this.hud?.root.parentElement) this.hud.root.parentElement.removeChild(this.hud.root);
  }
}
