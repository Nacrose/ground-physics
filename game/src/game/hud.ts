/**
 * HUD: RDR2-flavoured minimal interface — circular minimap with a live
 * wetness/mud overlay, weather readout, wagon trafficability verdict,
 * the soil inspector card (E), cinematic letterbox / grain / vignette / flash
 * overlays, and the boot screen.
 */
import { GRID, WORLD_SIZE, TerrainData } from "./terrain";
import { Ground } from "./ground";

export interface HUDState {
  tMin: number;
  presetLabel: string;
  presetKey: string;
  rainMmH: number;
  rainAtPlayer: number;
  windMs: number;
  tempC: number;
  cloudiness: number;
  timescale: number;
  fps: number;
  playerX: number;
  playerZ: number;
  playerYaw: number;
  wagonVerdict: string;
  wagonRutCm: number;
  mudHere: number;
}

const MM = 188; // minimap px

export class HUD {
  root: HTMLElement;
  private mapBase: HTMLCanvasElement;
  private mapOverlay: HTMLCanvasElement;
  private mapView: HTMLCanvasElement;
  private timeEl!: HTMLElement;
  private weatherWordEl!: HTMLElement;
  private rainEl!: HTMLElement;
  private windEl!: HTMLElement;
  private tempEl!: HTMLElement;
  private presetEl!: HTMLElement;
  private tsEl!: HTMLElement;
  private fpsEl!: HTMLElement;
  private wagonEl!: HTMLElement;
  private inspectorEl!: HTMLElement;
  private flashEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private bootEl!: HTMLElement;
  private overlayTimer = 0;

  constructor(container: HTMLElement, terrain: TerrainData) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    container.appendChild(this.root);

    // ---- minimap -------------------------------------------------------------
    this.mapBase = document.createElement("canvas");
    this.mapBase.width = GRID; this.mapBase.height = GRID;
    this.paintMapBase(terrain);
    this.mapOverlay = document.createElement("canvas");
    this.mapOverlay.width = GRID; this.mapOverlay.height = GRID;
    this.mapView = document.createElement("canvas");
    this.mapView.width = MM; this.mapView.height = MM;

    const mapWrap = document.createElement("div");
    mapWrap.className = "hud-map";
    mapWrap.appendChild(this.mapView);
    const nLabel = document.createElement("div");
    nLabel.className = "hud-map-n";
    nLabel.textContent = "N";
    mapWrap.appendChild(nLabel);
    this.root.appendChild(mapWrap);

    // ---- weather panel ---------------------------------------------------------
    const panel = document.createElement("div");
    panel.className = "hud-weather";
    this.weatherWordEl = div("hud-weather-word", "CLEAR");
    this.timeEl = div("hud-time", "DAY 1 — 00:00");
    const meta = document.createElement("div");
    meta.className = "hud-meta";
    this.presetEl = div("hud-line", "");
    this.rainEl = div("hud-line", "");
    this.windEl = div("hud-line", "");
    this.tempEl = div("hud-line", "");
    this.tsEl = div("hud-line hud-dim", "");
    this.wagonEl = div("hud-line hud-wagon", "");
    this.fpsEl = div("hud-fps", "");
    meta.append(this.presetEl, this.rainEl, this.windEl, this.tempEl, this.tsEl, this.wagonEl);
    panel.append(this.weatherWordEl, this.timeEl, meta, this.fpsEl);
    this.root.appendChild(panel);

    // ---- inspector ---------------------------------------------------------------
    this.inspectorEl = document.createElement("div");
    this.inspectorEl.className = "hud-inspector";
    this.inspectorEl.style.display = "none";
    this.root.appendChild(this.inspectorEl);

    // ---- cinematic overlays ---------------------------------------------------
    const grain = document.createElement("div");
    grain.className = "hud-grain";
    this.root.appendChild(grain);
    const vig = document.createElement("div");
    vig.className = "hud-vignette";
    this.root.appendChild(vig);
    this.flashEl = document.createElement("div");
    this.flashEl.className = "hud-flash";
    this.root.appendChild(this.flashEl);
    const bars = document.createElement("div");
    bars.className = "hud-bars";
    bars.innerHTML = '<div class="hud-bar-top"></div><div class="hud-bar-bottom"></div>';
    this.root.appendChild(bars);

    // ---- controls hint ---------------------------------------------------------
    this.hintEl = document.createElement("div");
    this.hintEl.className = "hud-hint";
    this.hintEl.innerHTML = `
      <div class="hud-hint-title">CONTROLS</div>
      <div class="hud-hint-grid">
        <span>W A S D</span><span>move</span>
        <span>SHIFT</span><span>sprint</span>
        <span>SPACE</span><span>jump</span>
        <span>MOUSE</span><span>look (click to capture)</span>
        <span>SCROLL</span><span>camera zoom</span>
        <span>E</span><span>inspect soil</span>
        <span>1 – 5</span><span>weather scenario</span>
        <span>T</span><span>time speed</span>
        <span>C</span><span>cinematic bars</span>
        <span>G</span><span>graphics quality</span>
        <span>M</span><span>mute</span>
      </div>
      <div class="hud-hint-sub">the ground you stand on runs the real soil physics — watch the valley clay</div>`;
    this.root.appendChild(this.hintEl);

    // ---- boot screen -------------------------------------------------------------
    this.bootEl = document.createElement("div");
    this.bootEl.className = "hud-boot";
    this.bootEl.innerHTML = `
      <div class="hud-boot-title">STORMCOUNTRY</div>
      <div class="hud-boot-sub">a living rain &amp; ground-physics engine</div>
      <div class="hud-boot-ctl">CLICK TO RIDE OUT</div>`;
    this.root.appendChild(this.bootEl);
  }

  private paintMapBase(terrain: TerrainData) {
    const ctx = this.mapBase.getContext("2d")!;
    const img = ctx.createImageData(GRID, GRID);
    const cell = WORLD_SIZE / GRID;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        const h = (terrain.height[j * (GRID + 1) + i] + terrain.height[(j + 1) * (GRID + 1) + i + 1]) / 2;
        const soil = terrain.soil[k];
        const hn = Math.min(h / 18, 1);
        let r: number, g: number, b: number;
        if (soil === 2) { r = 122; g = 108; b = 84; } // valley clay
        else if (soil === 1) { r = 138; g = 132; b = 86; } // loam slopes
        else { r = 158; g = 141; b = 92; } // sandy upland
        const shade = 0.72 + hn * 0.5;
        r *= shade; g *= shade; b *= shade;
        if (terrain.road[k] > 0.35) { r = 96; g = 82; b = 62; }
        img.data[k * 4] = r; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = b; img.data[k * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    void cell;
  }

  /** refresh the wetness/mud overlay from live physics (2 Hz) */
  paintMapOverlay(ground: Ground) {
    const ctx = this.mapOverlay.getContext("2d")!;
    const img = ctx.createImageData(GRID, GRID);
    const d = ground.texData;
    for (let k = 0; k < GRID * GRID; k++) {
      const wet = d[k * 4] / 255, pond = d[k * 4 + 1] / 255, mud = d[k * 4 + 2] / 255;
      img.data[k * 4] = 30 + mud * 60; // mud: brown
      img.data[k * 4 + 1] = 60 + pond * 40;
      img.data[k * 4 + 2] = 110 + pond * 90; // pond: blue
      img.data[k * 4 + 3] = Math.min(255, (wet * 90 + pond * 180 + mud * 120));
    }
    ctx.putImageData(img, 0, 0);
  }

  setFlash(v: number) {
    this.flashEl.style.opacity = String(Math.min(v, 1) * 0.55);
  }

  setLetterbox(on: boolean) {
    this.root.classList.toggle("cine", on);
  }

  setMuted(m: boolean) {
    this.root.classList.toggle("muted", m);
  }

  hideBoot() {
    this.bootEl.classList.add("gone");
    this.overlayTimer = performance.now();
  }

  showInspector(html: string | null) {
    if (!html) { this.inspectorEl.style.display = "none"; return; }
    this.inspectorEl.innerHTML = html;
    this.inspectorEl.style.display = "block";
  }

  update(dt: number, s: HUDState) {
    // ---- weather panel text (throttled to ~4 Hz) -------------------------
    this.overlayTimer += dt;
    if (this.overlayTimer > 0.25) {
      this.overlayTimer = 0;
      const day = Math.floor(s.tMin / 1440) + 1;
      const hh = String(Math.floor((s.tMin % 1440) / 60)).padStart(2, "0");
      const mm = String(Math.floor(s.tMin % 60)).padStart(2, "0");
      this.timeEl.textContent = `DAY ${day} — ${hh}:${mm}`;
      const r = s.rainAtPlayer;
      this.weatherWordEl.textContent =
        r < 0.05 ? (s.cloudiness > 0.55 ? "OVERCAST" : s.cloudiness > 0.25 ? "CLOUDING" : "CLEAR")
        : r < 2 ? "DRIZZLE" : r < 15 ? "RAIN" : r < 40 ? "HEAVY RAIN" : "TORRENTIAL";
      this.weatherWordEl.dataset.state =
        r < 0.05 ? "clear" : r < 2 ? "drizzle" : r < 15 ? "rain" : "heavy";
      this.presetEl.textContent = s.presetLabel.toUpperCase();
      this.rainEl.textContent = `RAIN ${r >= 10 ? Math.round(r) : r.toFixed(1)} MM/H`;
      this.windEl.textContent = `WIND ${Math.round(s.windMs)} M/S · ${Math.round(s.tempC)}°C`;
      this.tsEl.textContent = `TIME ×${s.timescale}`;
      this.fpsEl.textContent = `${Math.round(s.fps)} FPS`;
      this.wagonEl.textContent = `WAGON — ${s.wagonVerdict}${s.wagonRutCm > 1 ? ` · ${Math.round(s.wagonRutCm)} CM RUT` : ""}`;
      this.wagonEl.dataset.v = s.wagonVerdict.startsWith("BOGGED") ? "bog" :
        s.wagonVerdict.startsWith("MARGINAL") ? "mar" : "ok";
    }

    // ---- minimap (every frame: cheap) ------------------------------------
    const ctx = this.mapView.getContext("2d")!;
    ctx.clearRect(0, 0, MM, MM);
    ctx.save();
    ctx.beginPath();
    ctx.arc(MM / 2, MM / 2, MM / 2 - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mapBase, 0, 0, MM, MM);
    ctx.drawImage(this.mapOverlay, 0, 0, MM, MM);
    ctx.restore();
    // player arrow
    const px = ((s.playerX + WORLD_SIZE / 2) / WORLD_SIZE) * MM;
    const pz = ((s.playerZ + WORLD_SIZE / 2) / WORLD_SIZE) * MM;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-s.playerYaw + Math.PI);
    ctx.fillStyle = "#f4e9cf";
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -6.5); ctx.lineTo(4.6, 5.4); ctx.lineTo(0, 2.6); ctx.lineTo(-4.6, 5.4);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    // wagon marker (must match world.ts buildWagon placement)
    const wagonZ = (0.30 + 0.08 * Math.sin((40 / WORLD_SIZE) * Math.PI * 1.7 + 0.4)) * WORLD_SIZE;
    const wx = ((40 + WORLD_SIZE / 2) / WORLD_SIZE) * MM;
    const wz = ((wagonZ + WORLD_SIZE / 2) / WORLD_SIZE) * MM;
    ctx.fillStyle = "#d8a05a";
    ctx.fillRect(wx - 2.5, wz - 2.5, 5, 5);
  }
}

function div(cls: string, text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}
