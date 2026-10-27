#!/usr/bin/env python3
"""
Run the rain & weather engine.

Examples:
    python run_simulation.py --preset thunderstorm
    python run_simulation.py --preset monsoon --hours 12 --no-gif
    python run_simulation.py --demo          # full suite + comparison figures
"""
import argparse
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rwengine.config import EngineConfig, PRESETS, get_preset   # noqa: E402
from rwengine.engine import WeatherEngine                       # noqa: E402
from rwengine.visuals import (fig_maps_ground, fig_maps_storm,  # noqa: E402
                              fig_timeseries_ground, fig_timeseries_hydro)
from rwengine.visuals_more import (fig_dsd, fig_geotech_curves,  # noqa: E402
                                   fig_preset_comparison, fig_soil_profile,
                                   make_gif)

ROOT = os.path.dirname(os.path.abspath(__file__))


def run_one(preset_name, hours=None, out_root="outputs", gif=True):
    out = os.path.join(ROOT, out_root, preset_name)
    os.makedirs(out, exist_ok=True)
    print(f"\n=== running preset: {preset_name} "
          f"({get_preset(preset_name)['label']}) ===")
    engine = WeatherEngine(preset_name, EngineConfig())
    engine.run(duration_h=hours, verbose=True)

    # time series -> CSV
    df = pd.DataFrame(engine.records)
    df.to_csv(os.path.join(out, "timeseries.csv"), index=False)
    print(f"  [csv] {os.path.join(out, 'timeseries.csv')}")

    # figures
    fig_timeseries_hydro(engine, os.path.join(out, "timeseries_hydro.png"))
    fig_timeseries_ground(engine, os.path.join(out, "timeseries_ground.png"))
    fig_maps_storm(engine, os.path.join(out, "maps_storm.png"))
    fig_maps_ground(engine, os.path.join(out, "maps_ground.png"))
    fig_soil_profile(engine, os.path.join(out, "soil_profile.png"))
    if gif and len(engine.frames) > 1:
        make_gif(engine, os.path.join(out, "storm_evolution.gif"))

    # water balance report
    bal = engine.water_balance()
    print(f"  water balance: P={bal['P']:.1f}  E={bal['E']:.1f}  "
          f"R={bal['R']:.1f}  D={bal['D']:.1f}  dS={bal['dS_soil']:.1f}  "
          f"pond={bal['dPond']:.1f}  residual={bal['resid']:.2f} mm")
    return engine


def run_demo():
    shared = os.path.join(ROOT, "outputs")
    os.makedirs(shared, exist_ok=True)
    engines = {}
    for name in ("drizzle", "thunderstorm", "monsoon"):
        engines[name] = run_one(name)
    fig_dsd(os.path.join(shared, "rain_microphysics.png"))
    fig_geotech_curves(EngineConfig(), os.path.join(shared, "soil_strength_curves.png"))
    fig_preset_comparison(engines, os.path.join(shared, "preset_comparison.png"))
    print("\nDemo suite complete. All outputs under outputs/.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", choices=list(PRESETS), default="thunderstorm",
                    help="weather preset to run")
    ap.add_argument("--hours", type=float, default=None,
                    help="override preset duration")
    ap.add_argument("--demo", action="store_true",
                    help="run the full demo suite (drizzle + thunderstorm + monsoon)")
    ap.add_argument("--no-gif", action="store_true", help="skip the animation")
    args = ap.parse_args()
    if args.demo:
        run_demo()
    else:
        run_one(args.preset, hours=args.hours, gif=not args.no_gif)


if __name__ == "__main__":
    main()
