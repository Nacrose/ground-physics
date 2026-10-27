"""
WeatherEngine: the orchestrator.

Time loop (dt = 60 s by default), each step:
  1. weather system   -> wind, updrafts, boundary forcing
  2. atmosphere       -> advection, vertical transport, phase changes,
                         Kessler microphysics, rain sedimentation
  3. surface          -> rain on the ground, kinetic energy, ponding
  4. soil             -> Green-Ampt infiltration, percolation, evaporation
                         (vapor returned to the boundary layer)
  5. geotechnics      -> suction, cohesion, bearing capacity, consistency
  6. traffic          -> scheduled vehicle passes -> ruts
  7. runoff routing   -> D8 Manning overland flow, outlet hydrograph
  8. diagnostics      -> time series row + animation snapshots
"""
import time as _time

import numpy as np

from . import microphysics as mp
from .atmosphere import Atmosphere
from .config import EngineConfig, get_preset
from .geotech import Geotech
from .soil import Soil
from .state import State
from .surface import Surface
from .weather import WeatherSystem


class WeatherEngine:
    def __init__(self, preset_name: str, cfg: EngineConfig | None = None):
        self.preset_name = preset_name
        self.preset = get_preset(preset_name)
        self.cfg = cfg or EngineConfig()
        self.state = State(self.preset, self.cfg)
        self.weather = WeatherSystem(self.preset, self.cfg, self.state)
        self.atm = Atmosphere(self.state, self.cfg, self.weather)
        self.soil = Soil(self.state, self.cfg)
        self.geo = Geotech(self.state, self.cfg)
        self.surf = Surface(self.state, self.cfg)
        self.records = []           # time-series rows (dicts)
        self.frames = []            # animation snapshots
        self.load_log = []          # vehicle pass records
        self._next_snap = 0.0
        self._load_queue = sorted(self.preset.get("loads", []),
                                  key=lambda L: L["t_h"])

    # --------------------------------------------------------------------- run
    def run(self, duration_h=None, verbose=True):
        duration_h = duration_h or self.preset["duration_h"]
        n_steps = int(round(duration_h * 3600.0 / self.cfg.dt))
        t0 = _time.time()
        self.geo.update()                       # initial geotechnical state
        for n in range(n_steps):
            t_s = n * self.cfg.dt
            self.step(t_s)
        if verbose:
            self._summary(t0)
        return self.state

    # ------------------------------------------------------------------- step
    def step(self, t_s):
        """One full simulation step."""
        st, cfg = self.st, self.cfg
        dt = cfg.dt
        t_h = t_s / 3600.0

        # 1 -- weather forcing
        u, v = self.weather.update_wind(t_s)
        self.weather.update_updraft(t_s, u, v)

        # 2 -- atmosphere: transport + phase changes + rain production
        self.atm.advect(dt)
        self.atm.apply_bc(t_s)
        self.atm.vertical_transport(dt)
        self.atm.column_physics(dt)
        rain_mm_step = self.atm.rain_fallout(dt)             # mm reaching ground
        self.atm.relax_to_env(dt)
        self.atm.hygiene()

        # 3 -- rain reaches the ground
        rain_rate_mm_h = rain_mm_step / dt * 3600.0          # mm/h
        st.cum_precip += rain_mm_step                        # mm
        st.ke_cum += mp.rain_ke_rate(rain_rate_mm_h) * dt   # J/m2
        st.h_pond += rain_mm_step * 1e-3                     # mm -> m

        # 4 -- soil: infiltration, percolation, evaporation
        T_low = self.atm._theta_to_T(st.theta)[0]
        qs_low = mp.qs_mixratio(T_low, st.p[0])
        rh_air = float(np.clip(st.q_v[0].mean() / max(qs_low.mean(), 1e-9), 0.0, 1.0))
        T_air = float(T_low.mean())
        self.soil.infiltrate(dt)
        self.soil.percolate(dt)
        E_actual = self.soil.evaporate(dt, float(np.sqrt(u ** 2 + v ** 2).mean()),
                                       T_air, rh_air,
                                       self.preset["sw_factor"],
                                       self.preset["evap_c_e"])
        self.atm.add_surface_evapor(E_actual * 1000.0)      # m/s -> kg/m2/s

        # 5 -- geotechnical state
        self.geo.update()

        # 6 -- scheduled vehicle passes
        while self._load_queue and self._load_queue[0]["t_h"] <= t_h:
            L = self._load_queue.pop(0)
            if L.get("x") == "auto":
                # target the wettest valley (fine-textured) cell at pass time
                wet = np.where(st.texture == 2, st.cum_precip, -np.inf)
                iy, ix = np.unravel_index(np.argmax(wet), wet.shape)
            else:
                ix = int(np.clip(L["x"] * cfg.nx, 1, cfg.nx - 2))
                iy = int(np.clip(L["y"] * cfg.ny, 1, cfg.ny - 2))
            self.geo.apply_load(ix, iy, L["q_kpa"], L["label"], t_h, self.load_log)

        # 7 -- surface runoff routing
        self.surf.route(dt)

        # 8 -- diagnostics
        self._record(t_s, rain_rate_mm_h, E_actual, u, v)

    # ------------------------------------------------------------------ record
    def _record(self, t_s, rain_mm_h, E_m_s, u, v):
        st = self.st
        g = st.geo
        cw = st.column_water_mm(st.q_c)
        vw = st.column_water_mm(st.q_v)
        rw = st.column_water_mm(st.q_r)
        th = st.theta_soil
        row = dict(
            t_h=t_s / 3600.0,
            rain_mean=float(np.mean(rain_mm_h)), rain_max=float(np.max(rain_mm_h)),
            vapor_path=float(np.mean(vw)), cloud_path=float(np.mean(cw)),
            rain_path=float(np.mean(rw)),
            pond_mean_mm=float(np.mean(st.h_pond)) * 1000.0,
            pond_max_mm=float(np.max(st.h_pond)) * 1000.0,
            outlet_mm_h=self.surf.outlet_rate,
            evap_mm_h=float(np.mean(E_m_s)) * 3600.0 * 1000.0,
            theta1=float(np.mean(th[0])), theta2=float(np.mean(th[1])),
            theta3=float(np.mean(th[2])), theta4=float(np.mean(th[3])),
            q_ult_mean=float(np.mean(g["q_ult_kpa"])),
            q_ult_min=float(np.min(g["q_ult_kpa"])),
            q_ult_p05=float(np.percentile(g["q_ult_kpa"], 5)),
            cbr_mean=float(np.mean(g["cbr"])),
            suction_mean=float(np.mean(g["suction_kpa"])),
            mud_frac=float(np.mean(g["consistency"] == 2)),
            plastic_frac=float(np.mean(g["consistency"] == 1)),
            rut_max_mm=float(np.max(st.rut_depth)) * 1000.0,
            wind_ms=float(np.sqrt(u ** 2 + v ** 2).mean()),
        )
        self.records.append(row)
        # animation snapshot
        if t_s >= self._next_snap:
            self.frames.append(dict(
                t_h=t_s / 3600.0,
                rain=rain_mm_h.copy(),
                cloud=cw.copy(),
                pond=st.h_pond.copy() * 1000.0,
                theta1=th[0].copy(),
                q_ult=g["q_ult_kpa"].copy(),
            ))
            self._next_snap = t_s + self.cfg.snapshot_every_s

    # ----------------------------------------------------------------- summary
    def _summary(self, t0):
        r = self.records[-1] if self.records else {}
        print(f"[{self.preset_name}] {self.preset['label']}")
        print(f"  total precipitation (domain mean) : "
              f"{float(self.state.cum_precip.mean()):7.1f} mm   "
              f"(max {float(self.state.cum_precip.max()):.1f} mm)")
        print(f"  peak rain rate                    : "
              f"{max(x['rain_max'] for x in self.records):7.1f} mm/h")
        print(f"  ponding at end (mean / max)       : "
              f"{r.get('pond_mean_mm', 0):6.1f} / {r.get('pond_max_mm', 0):6.1f} mm")
        print(f"  topsoil moisture (start -> end)   : "
              f"{self.state.theta_soil_init[0].mean():.3f} -> "
              f"{self.state.theta_soil[0].mean():.3f}")
        print(f"  bearing capacity q_ult (min)      : "
              f"{r.get('q_ult_min', 0):6.0f} kPa   "
              f"(mud fraction {100 * r.get('mud_frac', 0):.0f}%)")
        print(f"  runoff discharged                 : {self.surf.outflow_mm:6.1f} mm")
        print(f"  evaporation (cumulative)          : {self.soil.cum_evap_mm:6.1f} mm")
        print(f"  deep percolation                  : {self.soil.deep_perc_mm:6.1f} mm")
        print(f"  wall time                         : {_time.time() - t0:5.1f} s")
        for L in self.load_log:
            print(f"  [traffic t={L['t_h']:4.1f}h] {L['label']:28s} "
                  f"q_ult={L['q_ult']:6.0f} kPa  w={L['w_pct']:4.1f}%  "
                  f"state={L['soil_state']:10s} sinkage={L['settlement_m']*100:5.1f} cm "
                  f"-> {L['verdict']}")

    # ------------------------------------------------------------- properties
    @property
    def st(self):
        return self.state

    def water_balance(self):
        """Soil-side water balance (should close to ~0; residual is numerical)."""
        st = self.st
        dzs = np.array(self.cfg.soil_dz)[:, None, None]
        P = float(st.cum_precip.mean())
        E = self.soil.cum_evap_mm
        R = self.surf.outflow_mm
        D = self.soil.deep_perc_mm
        S0 = float((st.theta_soil_init * dzs).sum(axis=0).mean())
        S1 = float((st.theta_soil * dzs).sum(axis=0).mean())
        dS_soil = (S1 - S0) * 1000.0                            # m -> mm
        dPond = float(np.mean(st.h_pond)) * 1000.0
        resid = P - E - R - D - dS_soil - dPond
        return dict(P=P, E=E, R=R, D=D, dS_soil=dS_soil, dPond=dPond, resid=resid)
