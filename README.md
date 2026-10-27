# Rain & Weather Simulation Engine

An approximate, physics-based Python engine that simulates ground rain and
weather with most of their real properties — the **full water cycle** on a
64 km synthetic catchment, including realistic **soil mechanics** (mud,
granular behaviour, bearing capacity, cohesion, rutting).

```
atmospheric moisture inflow  ->  condensation (Kessler)
        ->  rain (Marshall-Palmer drop spectrum)
        ->  kinetic energy -> surface crusting
        ->  Green-Ampt infiltration  /  Manning-D8 runoff  ->  puddles
        ->  layered soil moisture  ->  suction, cohesion, q_ult, CBR,
            Atterberg consistency (mud), vehicle rutting
        ->  evaporation  ->  back to the boundary layer
```

Weather fronts build up, peak and decay on their own timeline, sweep across
the terrain, interact with orography (rain on windward slopes, rain shadow),
and the ground responds hour by hour — until trucks start to bog down in the
valley mud.

---

## Quick start

```bash
cd rain-weather-engine
python run_simulation.py --preset thunderstorm      # single event + all figures
python run_simulation.py --demo                     # drizzle + storm + monsoon suite
python validate_physics.py                          # 9 physics sanity checks
```

Requires: `numpy`, `matplotlib`, `pandas`, `pillow`.
Outputs land in `outputs/<preset>/` (PNG figures, GIF animation, CSV series).

As a library:

```python
from rwengine import WeatherEngine, EngineConfig

engine = WeatherEngine("monsoon", EngineConfig())
engine.run(duration_h=12)
print(engine.water_balance())          # closed water budget
print(engine.load_log)                 # trafficability verdicts per pass
```

---

## Weather presets

| preset | character | typical behaviour |
|---|---|---|
| `clear_sky` | quiescent drying | soil dries, suction rebuilds, strength recovers |
| `drizzle` | stratiform band | ~1-5 mm/h, ground barely wets, everything passable |
| `thunderstorm` | 4 convective cells | bursts to ~175 mm/h, 113 mm local totals, 37% of ground turns to mud, truck PASSABLE before / BOGGED after |
| `monsoon` | sustained pulsing band | all-day rain, valley progressively liquefies, ruts half a metre deep |
| `cold_front` | travelling front | narrow rain band sweeps west->east with an 8 K air-mass change |

Each preset drives the same physics, only the forcing differs (wind, moisture
inflow, updraft pattern, lifecycle envelope).

---

## Physics included

### Atmosphere (8-layer terrain-following column, 64x64 grid, 60 s steps)
* horizontal advection of moisture and potential temperature — conservative
  flux-form upwind with CFL sub-stepping; open boundaries with prescribed
  environmental inflow (frontal moisture boost, cold anomaly)
* vertical moisture transport by resolved updrafts (orographic lift
  `w = u dz/dx + v dz/dy` + frontal / convective forcing), moist-adiabatic
  cooling in ascent, dry-adiabatic warming in subsidence
* **saturation adjustment** with full latent-heat feedback (Bolton
  saturation vapor pressure)
* **Kessler (1969) warm-rain microphysics**: autoconversion, accretion,
  rain evaporation in subsaturated air, bulk sedimentation

### Rain microphysics
* **Marshall-Palmer (1948)** drop-size distribution
  `N(D) = N0 exp(-Lambda D)`, `Lambda = 4.1 R^-0.21`
* terminal velocity `v(D) = 3.778 D^0.67` (Gunn & Kinzer style, capped at
  9.2 m/s)
* radar reflectivity `Z = 200 R^1.6` (cross-checked against the DSD integral)
* raindrop kinetic-energy flux — drives **surface crusting** (sealing),
  which reduces infiltration exactly as on real bare soils

### Soil hydrology (4-layer column, USDA textures)
* texture-dependent hydraulic properties after **Clapp-Hornberger (1978) /
  Cosby et al. (1984)**: porosity, air-entry suction, b-exponent, Ksat
* **Green-Ampt infiltration** with wetting-front suction and ponding head
* unsaturated percolation `K(theta) = Ks (theta/thetas)^(2b+3)`
* field capacity (-33 kPa) and wilting point (-1500 kPa) from the retention
  curve; bulk-aerodynamic evaporation, supply-limited by topsoil wetness

### Geotechnics (the "mud" module)
* matric suction from the retention curve; apparent cohesion
  `c_app = c' + Sr * s * tan(phi_b)` (**Fredlund** unsaturated strength) —
  dry soil is strong because of suction, and loses that strength when wet
* effective stress with positive pore pressure under ponding (**Terzaghi**)
* Mohr-Coulomb shear strength `tau_f = c_eff + sigma' tan(phi_eff)`
* **Terzaghi bearing capacity** for a square 0.3 m footing:
  `q_ult = 1.2 c Nc + 0.4 gamma B Ngamma`
* granular state: void ratio, relative density -> friction angle,
  bulk/saturated unit weight
* **Atterberg consistency**: solid -> plastic -> **liquid (mud)** as w passes
  the liquid limit; past LL, cohesion and friction collapse (softening)
* CBR correlation `CBR ~ 100 q_ult / 6900`
* **trafficability**: scheduled vehicle passes; elastic settlement +
  plastic punching shear when contact pressure exceeds q_ult; vehicles BOG
  in liquid-consistency ground; ruts add depression storage that ponds
  water, which re-wets the soil — a genuine mud feedback loop

### Surface water
* per-cell depression storage (micro-roughness + ruts) -> puddles
* **D8 steepest-descent runoff routing** with Manning overland flow
  `q = (1/n) h^(5/3) sqrt(S)`, sub-stepped hops, outlet hydrograph
* puddles fill wheel ruts and topographic lows, then infiltrate under head

---

## Outputs per run

| file | content |
|---|---|
| `timeseries.csv` | 22 diagnostics per minute: rain, stores, ponding, runoff, theta per layer, q_ult, CBR, suction, mud fraction, ruts, wind |
| `timeseries_hydro.png` | hyetograph, atmospheric stores, surface water, cumulative water balance |
| `timeseries_ground.png` | soil moisture, bearing capacity collapse, consistency states, traffic verdicts |
| `maps_storm.png` | terrain, storm total, residual cloud, ponding depth |
| `maps_ground.png` | topsoil moisture, suction, q_ult (log scale), consistency map + rut contours |
| `soil_profile.png` | moisture and strength profiles before/after at valley, slope, hilltop columns |
| `storm_evolution.gif` | animated 4-panel storm: rain, cloud, ponding, bearing capacity |

Shared figures (`outputs/`): `rain_microphysics.png` (DSD, fall speed, Z-R,
kinetic energy), `soil_strength_curves.png` (q_ult/CBR vs water content,
Mohr-Coulomb envelopes, retention curves), `preset_comparison.png`.

---

## Validation

`python validate_physics.py` runs 9 checks — all passing:

1. Marshall-Palmer DSD integral reproduces target rain rate (max error 17%)
2. DSD reflectivity matches `Z = 200 R^1.6` within 1.7 dBZ
3. Terzaghi: undrained clay `q_ult = 1.2 c Nc = 617 kPa` (Nc = 5.14);
   dry sand footing 48 kPa (textbook range); muddy soil ~30x weaker than moist
4. Retention curve monotonic; mud classification triggers at w = LL
5. Green-Ampt capacity decays toward Ks
6. **Soil-side water balance closes to < 0.01 mm** over a full run
   (P = E + runoff + deep percolation + dSoil + ponding)

---

## Package layout

```
rwengine/
  config.py         soil texture library, weather presets, numerical config
  microphysics.py   Marshall-Palmer DSD, Kessler scheme, vapor thermodynamics
  state.py          terrain, soil maps, atmospheric grid, initialisation
  weather.py        wind, orographic lift, convective cells, frontal bands
  atmosphere.py     advection, vertical transport, column physics, fallout
  soil.py           Green-Ampt, crusting, percolation, evaporation
  geotech.py        suction, Mohr-Coulomb, Terzaghi, Atterberg, CBR, rutting
  surface.py        depression storage, D8 Manning routing, hydrograph
  engine.py         WeatherEngine orchestrator, diagnostics, water balance
  visuals.py        storm-dark theme, time series and map figures
  visuals_more.py   profiles, geotech curves, DSD plots, comparison, GIF
run_simulation.py   CLI (--preset / --demo / --hours / --no-gif)
validate_physics.py physics sanity suite
```

## Limitations (by design, "approximately simulates")

* single-phase (warm rain) bulk microphysics — no ice/snow/lightning
* no vegetation interception or canopy, no groundwater table dynamics
* Terzaghi bearing is for a surface square footing; rut sinkage uses a
  punching-shear approximation, not full Bekker terramechanics
* 2-D horizontal grid with terrain-following columns, hydrostatic pressure
* geotechnical parameters are typical textbook values calibrated for the
  demonstration textures — not for engineering design use

## References

Marshall & Palmer (1948); Kessler (1969); Gunn & Kinzer (1948);
Clapp & Hornberger (1978); Cosby et al. (1984); Green & Ampt (1911);
Terzaghi (1943); Fredlund, Morgenstern & Widger (1978); Bolton (1980).
