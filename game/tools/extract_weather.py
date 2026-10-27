#!/usr/bin/env python3
"""Extract per-minute weather timelines from the rwengine for the 3D game.

- drizzle / thunderstorm / monsoon: parse existing outputs CSVs (real runs)
- clear_sky / cold_front: run the engine headless (no figures) and dump records

Output: game/public/weather/<preset>.json with per-minute entries:
  t_min, rain_mmh, wind_ms, wind_dir_deg, temp_c, cloud_frac, pond_mm

Run from anywhere; paths are resolved relative to this file:
  ground-physics/
    rwengine/                 <- the physics core (ROOT)
    outputs/<preset>/...      <- reference run CSVs
    game/tools/this script
    game/public/weather/      <- destination
"""
import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.dirname(HERE)
ROOT = os.path.dirname(GAME)              # ground-physics/ (rwengine lives here)
OUT = os.path.join(GAME, "public", "weather")
sys.path.insert(0, ROOT)

os.makedirs(OUT, exist_ok=True)

CSV_PRESETS = ["drizzle", "thunderstorm", "monsoon"]
RUN_PRESETS = ["clear_sky", "cold_front"]


def wind_dir_from_uv(u, v):
    """Meteorological direction the wind blows FROM, degrees."""
    return (270.0 - np.degrees(np.arctan2(v, u))) % 360.0


def df_to_timeline(df: pd.DataFrame, preset: dict) -> list:
    t = df["t_h"].to_numpy() * 60.0
    # the player stands under the storm: use the local cell peak (storm core),
    # smoothed with the domain mean so passing cells feel like a train of bursts
    rain = 0.75 * df["rain_max"].to_numpy() + 0.25 * df["rain_mean"].to_numpy()
    wind = df["wind_ms"].to_numpy()
    pond = df["pond_max_mm"].to_numpy() * 0.5
    T0 = preset["T_sfc0_C"]
    # cloudiness: ramps fast with rain (heavy rain = near-overcast), then
    # decays slowly after the rain stops (front clearing behind the band)
    rmax = max(float(np.nanmax(rain)), 1e-6)
    cloud = np.clip(rain / 20.0, 0.0, 1.0) * 0.88 + 0.05
    n = len(t)
    for i in range(1, n):
        cloud[i] = max(cloud[i], cloud[i - 1] * 0.965)   # slow clearing
    cloud = np.minimum(cloud, 0.96)
    out = []
    for i in range(n):
        out.append(dict(
            t=float(t[i]),
            rain=float(max(rain[i], 0.0)),
            wind=float(np.clip(wind[i], 0.2, 25.0)),
            temp=float(T0 - 6.0 * cloud[i] * 0.5),   # cooler under cloud
            cloud=float(cloud[i]),
            pond=float(pond[i]),
        ))
    return out


def main():
    from rwengine.config import EngineConfig, get_preset

    # ---- 1. parse the existing CSV runs -----------------------------------
    for name in CSV_PRESETS:
        path = os.path.join(ROOT, "outputs", name, "timeseries.csv")
        df = pd.read_csv(path)
        tl = df_to_timeline(df, get_preset(name))
        with open(os.path.join(OUT, f"{name}.json"), "w") as f:
            json.dump(tl, f, separators=(",", ":"))
        peak = max(e["rain"] for e in tl)
        print(f"{name:14s} {len(tl):4d} min  peak rain {peak:7.1f} mm/h")

    # ---- 2. headless runs for the other two presets -----------------------
    from rwengine.engine import WeatherEngine

    for name in RUN_PRESETS:
        preset = get_preset(name)
        eng = WeatherEngine(name, EngineConfig())
        eng.run(duration_h=None, verbose=False)
        df = pd.DataFrame(eng.records)
        tl = df_to_timeline(df, preset)
        with open(os.path.join(OUT, f"{name}.json"), "w") as f:
            json.dump(tl, f, separators=(",", ":"))
        peak = max(e["rain"] for e in tl)
        print(f"{name:14s} {len(tl):4d} min  peak rain {peak:7.1f} mm/h")

    print("\nwrote 5 timelines to", OUT)


if __name__ == "__main__":
    main()
