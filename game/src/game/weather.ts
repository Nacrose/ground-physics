/**
 * Weather player: plays back the rwengine-generated timeline (per-minute
 * rain / wind / temperature / cloud from the reference simulation) at an
 * adjustable time scale, and exposes the current forcing to the ground
 * physics, visuals and HUD. Also owns lightning scheduling.
 */
import { WeatherEntry, PresetDef } from "./params";

export type PatternKind = "cells" | "band" | "broad" | "none";

const PATTERN: Record<string, PatternKind> = {
  clear_sky: "none",
  drizzle: "broad",
  thunderstorm: "cells",
  monsoon: "broad",
  cold_front: "band",
};

/** preset-specific extra forcing (ported from rwengine config) */
const EXTRA: Record<string, { rh: number; sw: number }> = {
  clear_sky: { rh: 0.55, sw: 1.0 },
  drizzle: { rh: 0.9, sw: 0.3 },
  thunderstorm: { rh: 0.8, sw: 0.15 },
  monsoon: { rh: 0.85, sw: 0.2 },
  cold_front: { rh: 0.75, sw: 0.3 },
};

export interface WeatherNow {
  tMin: number;
  rainMmH: number; // timeline core intensity
  windMs: number;
  gustMs: number;
  windDirRad: number;
  tempC: number;
  cloud: number; // 0..1
  rh: number;
  sw: number;
  pattern: PatternKind;
  isStorm: boolean; // lightning-capable
  presetKey: string;
  presetLabel: string;
  timescale: number;
}

export class WeatherPlayer {
  timeline: WeatherEntry[] = [];
  preset: PresetDef;
  timescale: number;
  tMin = 0; // game minutes elapsed
  windDirBase: number; // radians

  // lightning state
  lightningTimer = 4;
  flashIntensity = 0; // 0..1 decaying
  thunderQueue: Array<{ delay: number; power: number }> = [];

  constructor(preset: PresetDef, timeline: WeatherEntry[]) {
    this.preset = preset;
    this.timeline = timeline;
    this.timescale = preset.timescale;
    this.windDirBase = preset.key === "cold_front" ? 0 :
      preset.key === "monsoon" ? 0.25 : preset.key === "thunderstorm" ? 0.2 : 0.12;
  }

  /** advance game time by real seconds */
  advance(dtReal: number) {
    const dtGameMin = (dtReal / 60) * this.timescale;
    this.tMin += dtGameMin;
    const total = this.timeline.length ? this.timeline[this.timeline.length - 1].t : 360;
    if (this.tMin > total) this.tMin = this.tMin % total; // loop the scenario
  }

  /** interpolated current conditions */
  now(): WeatherNow {
    const tl = this.timeline;
    const t = this.tMin;
    let a = tl[0], b = tl[tl.length - 1];
    for (let i = 0; i < tl.length - 1; i++) {
      if (t >= tl[i].t && t <= tl[i + 1].t) { a = tl[i]; b = tl[i + 1]; break; }
    }
    const span = Math.max(b.t - a.t, 1e-6);
    const u = Math.max(0, Math.min((t - a.t) / span, 1));
    const rain = a.rain + (b.rain - a.rain) * u;
    const wind = a.wind + (b.wind - a.wind) * u;
    const temp = a.temp + (b.temp - a.temp) * u;
    const cloud = a.cloud + (b.cloud - a.cloud) * u;
    const ex = EXTRA[this.preset.key] ?? { rh: 0.8, sw: 0.5 };
    // gusts: wind + 40% oscillation
    const gust = wind * (1 + 0.35 * Math.sin(t * 1.7) * Math.sin(t * 0.53 + 1.2));
    // wind direction slowly rotates
    const dir = this.windDirBase + 0.25 * Math.sin(t * 0.04 + 2.0);
    return {
      tMin: t,
      rainMmH: rain,
      windMs: Math.max(wind, 0.5),
      gustMs: Math.max(gust, 0.5),
      windDirRad: dir,
      tempC: temp,
      cloud,
      rh: ex.rh,
      sw: ex.sw * (1 - 0.7 * cloud) + 0.05,
      pattern: PATTERN[this.preset.key] ?? "broad",
      isStorm: this.preset.key === "thunderstorm" || (this.preset.key === "cold_front" && rain > 8),
      presetKey: this.preset.key,
      presetLabel: this.preset.label,
      timescale: this.timescale,
    };
  }

  /** schedule lightning flashes while the storm is active */
  updateLightning(dtReal: number, rainMmH: number, active: boolean) {
    this.flashIntensity = Math.max(0, this.flashIntensity - dtReal * 2.2);
    for (const th of this.thunderQueue) th.delay -= dtReal;
    this.thunderQueue = this.thunderQueue.filter((th) => th.delay > -0.1);
    if (!active || rainMmH < 12) return;
    this.lightningTimer -= dtReal * Math.min(rainMmH / 40, 2.5);
    if (this.lightningTimer <= 0) {
      // mean interval shrinks with intensity: 14 s at 40 mm/h … 5 s at 135
      const mean = Math.max(4.5, 16 - rainMmH * 0.08);
      this.lightningTimer = mean * (0.4 + Math.random() * 1.2);
      this.flashIntensity = 0.7 + Math.random() * 0.5;
      // thunder arrives 0.6-3.5 s later (distance feel)
      this.thunderQueue.push({ delay: 0.6 + Math.random() * 2.9, power: 0.5 + Math.random() * 0.7 });
    }
  }

  takeThunder(): { power: number } | null {
    for (let i = 0; i < this.thunderQueue.length; i++) {
      if (this.thunderQueue[i].delay <= 0) {
        const p = this.thunderQueue[i].power;
        this.thunderQueue.splice(i, 1);
        return { power: p };
      }
    }
    return null;
  }
}
