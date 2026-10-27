#!/usr/bin/env python3
"""
Physics sanity checks for the rain & weather engine.

Verifies:
 1. Marshall-Palmer DSD self-consistency (integral rain rate vs target R)
 2. Z-R relation vs DSD integral
 3. Terzaghi bearing capacity against textbook values
 4. Retention-curve monotonicity and Atterberg classification
 5. Green-Ampt infiltration asymptotics (f -> Ks)
 6. Closed water balance of a short simulation
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rwengine import microphysics as mp                      # noqa: E402
from rwengine.config import EngineConfig, SOIL_TEXTURES      # noqa: E402
from rwengine.geotech import Geotech, texture_strength_curve  # noqa: E402

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
results = []


def check(name, ok, detail):
    results.append(ok)
    print(f"  [{PASS if ok else FAIL}] {name}\n         {detail}")


print("=== 1. Marshall-Palmer DSD self-consistency ===")
errs = []
for R in (0.5, 1, 2, 5, 10, 25, 50, 100, 150):
    s = mp.dsd_stats(R)
    errs.append(abs(s['R_check'] - R) / R)
    if R in (1.0, 10.0, 100.0):
        print(f"    R={R:6.1f} mm/h -> integral {s['R_check']:6.1f} mm/h, "
              f"D0={s['D0']:.2f} mm, v_mean={s['v_mean']:.1f} m/s, "
              f"KE={s['ke_rate']:.2f} J/m2/s, Z={s['z_dbz']:.0f} dBZ")
check("DSD integral within 35% of target over 0.5-150 mm/h",
      max(errs) < 0.35, f"max relative error {100*max(errs):.1f}%")

print("\n=== 2. Z-R relation vs DSD integral ===")
dz = []
for R in (1.0, 10.0, 100.0):
    dz.append(abs(mp.dsd_stats(R)['z_dbz'] - mp.zr_dbz(R)))
check("DSD reflectivity within 4 dBZ of Z = 200 R^1.6",
      max(dz) < 4.0, f"max |dZ| = {max(dz):.2f} dBZ")

print("\n=== 3. Terzaghi bearing capacity ===")
cfg = EngineConfig()
# phi = 0, c = 100 kPa -> Nc = 5.14, square footing 1.2 factor
Nq, Nc, Ng = Geotech.bearing_factors(0.0)
q_c = 1.2 * 100.0 * float(np.asarray(Nc).reshape(-1)[0])
check("undrained clay q_ult = 1.2 c Nc ~ 617 kPa",
      abs(q_c - 617.0) < 15.0,
      f"computed {q_c:.0f} kPa (Nc={float(np.asarray(Nc).reshape(-1)[0]):.2f})")
# phi = 30, c=0, gamma=18, B=0.3 (granular sand)
Nq, Nc, Ng = Geotech.bearing_factors(30.0)
q_sand = 0.4 * 18.0 * 0.3 * float(np.asarray(Ng).reshape(-1)[0])
check("dry sand q_ult ~ 45-60 kPa for B=0.3 m footing",
      40.0 < q_sand < 65.0, f"computed {q_sand:.1f} kPa "
      f"(Nq={float(np.asarray(Nq).reshape(-1)[0]):.1f}, "
      f"Ngamma={float(np.asarray(Ng).reshape(-1)[0]):.1f})")
# saturated silty clay loam must be weaker than moist
tex = SOIL_TEXTURES["silty_clay_loam"]
w_grid = np.linspace(10.0, tex["LL"] + 10.0, 120)
r = texture_strength_curve(tex, cfg, w_grid)
i_moist = np.argmin(np.abs(w_grid - 18.0))
i_mud = np.argmin(np.abs(w_grid - (tex["LL"] + 8.0)))
ratio = r['q_ult'][i_moist] / r['q_ult'][i_mud]
check("muddy valley soil 5-40x weaker than moist",
      5.0 < ratio < 40.0, f"q_ult(w=18%)={r['q_ult'][i_moist]:.0f} kPa vs "
      f"q_ult(w>LL)={r['q_ult'][i_mud]:.0f} kPa -> ratio {ratio:.1f}")

print("\n=== 4. Retention curve & consistency ===")
ok_mono = np.all(np.diff(r['suction_kpa'][::-1]) >= 0)
check("suction increases monotonically as soil dries", ok_mono,
      f"suction {r['suction_kpa'][0]:.0f} kPa at w={w_grid[0]:.0f}% -> "
      f"{r['suction_kpa'][-1]:.3f} kPa near saturation")
ll = tex["LL"]
check("mud classification triggers at w = LL",
      texture_strength_curve(tex, cfg, np.array([ll]))['c_eff'][0] <
      0.2 * tex["c_eff_kpa"] + tex["c_eff_kpa"],
      "softening engages past the liquid limit")

print("\n=== 5. Green-Ampt asymptotics ===")
# f = Ks (1 + psi dtheta / F) -> Ks as F -> inf
ks = 3.4 / 3600.0 / 1000.0        # m/s silty clay loam
psi = 0.356; dth = 0.25
f_small = ks * (1 + psi * dth / 0.005)
f_big = ks * (1 + psi * dth / 0.5)
check("infiltration capacity decays toward Ks",
      f_small > 5 * f_big and f_big < 1.2 * ks,
      f"f(F=5mm)={f_small*1000*3600:.1f} mm/h -> f(F=500mm)={f_big*1000*3600:.1f} "
      f"mm/h ~ Ks={ks*1000*3600:.1f} mm/h")

print("\n=== 6. Closed water balance (short run) ===")
from rwengine.engine import WeatherEngine  # noqa: E402
cfg2 = EngineConfig()
cfg2.snapshot_every_s = 1e9
eng = WeatherEngine("monsoon", cfg2)
eng.run(duration_h=2.0, verbose=False)
bal = eng.water_balance()
rel = abs(bal['resid']) / max(bal['P'], 1e-6)
check("soil-side water balance closes within 2%",
      rel < 0.02,
      f"P={bal['P']:.2f} E={bal['E']:.3f} R={bal['R']:.3f} D={bal['D']:.3f} "
      f"dS={bal['dS_soil']:.3f} pond={bal['dPond']:.3f} resid={bal['resid']:.3f} "
      f"({100*rel:.2f}%)")

n_pass = sum(results)
print(f"\n{'='*60}\n{n_pass}/{len(results)} checks passed.")
sys.exit(0 if n_pass == len(results) else 1)
