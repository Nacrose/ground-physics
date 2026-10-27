"""
Weather system: synoptic forcing that drives the engine's own weather.

The forcing module produces, at every timestep:
* wind field (u, v) with gusts
* vertical motion w (orographic lift + convective cells / frontal bands)
* boundary-inflow moisture boost and cold-air anomaly (fronts)

Storm lifecycle: logistic rise to a peak followed by exponential decay --
fronts build up, peak, and clear, as requested for "weather fronts" behaviour.
"""
import numpy as np


def lifecycle(t_h, t_peak, tau_rise, tau_decay):
    """Smooth storm envelope: logistic rise * exponential decay, peak = 1."""
    rise = 1.0 / (1.0 + np.exp(-(t_h - t_peak) / max(tau_rise, 1e-3)))
    decay = np.exp(-np.maximum(t_h - t_peak, 0.0) / max(tau_decay, 1e-3))
    return rise * decay


class WeatherSystem:
    def __init__(self, preset, cfg, state):
        self.cfg = cfg
        self.preset = preset
        self.forcing = preset["forcing"]
        self.state = state
        ny, nx = cfg.ny, cfg.nx
        Lx, Ly = nx * cfg.dx, ny * cfg.dx
        self.X, self.Y = np.meshgrid(np.linspace(0, Lx, nx), np.linspace(0, Ly, ny))
        self.rng = np.random.default_rng(cfg.seed + 2)
        # terrain gradients for orographic lift
        self.dzdx, self.dzdy = state.terrain_gradient()
        # precompute vertical decay of w with height
        self.w_decay = np.exp(-state.z_mid / 5000.0)                # (nz,)

    # ------------------------------------------------------------------ wind
    def update_wind(self, t_s):
        t_h = t_s / 3600.0
        u0, v0 = self.preset["wind_uv"]
        gust = self.preset.get("gust_amp", 0.0)
        phase = 2.0 * np.pi * t_s / 1200.0
        # travelling gust pattern (smooth in space, oscillating in time)
        g = (np.sin(phase + self.X / 12e3) * np.cos(phase * 0.63 + self.Y / 15e3))
        u = u0 * (1.0 + gust * g)
        v = v0 * (1.0 + gust * np.sin(phase * 0.71 + self.Y / 10e3))
        self.state.u_wind = u
        self.state.v_wind = v
        return u, v

    # ------------------------------------------------------------- updrafts
    def update_updraft(self, t_s, u, v):
        """Vertical motion field: orographic lift + storm forcing."""
        st = self.state
        # -- orographic: wind running up/down terrain slopes
        w_oro = u * self.dzdx + v * self.dzdy
        w_oro = np.clip(w_oro, -0.6, 0.6)
        # -- forcing uplift
        w_f = np.zeros((self.cfg.ny, self.cfg.nx))
        f = self.forcing
        if f["kind"] == "band":
            w_f = self._band_updraft(t_s, u, v)
        elif f["kind"] == "cells":
            for c in f["cells"]:
                w_f += self._cell_updraft(t_s, c, u, v)
        # total w decays with height (convection confined to lower troposphere)
        w2d = np.clip(w_oro + w_f, -0.8, 2.5)
        st.w_up = w2d[None, :, :] * self.w_decay[:, None, None]
        return st.w_up

    def _band_updraft(self, t_s, u, v):
        f = self.forcing
        t_h = t_s / 3600.0
        env = lifecycle(t_h, f["t_peak_h"], f["tau_rise_h"], f["tau_decay_h"])
        env *= float(t_h >= f["t_start_h"])
        if "pulse_period_h" in f and f.get("pulse_amp", 0) > 0:
            env *= 1.0 + f["pulse_amp"] * np.sin(2 * np.pi * t_h / f["pulse_period_h"])
        # band centre travels east with the front speed
        xc = f["x0_frac"] * self.cfg.domain_m + f["speed_m_s"] * max(t_s - f["t_start_h"] * 3600.0, 0.0)
        yc = f["y_center_frac"] * self.cfg.ny * self.cfg.dx
        g = np.exp(-((self.X - xc) ** 2) / (2 * f["sigma_x_m"] ** 2)
                   - (self.Y - yc) ** 2 / (2 * f["sigma_y_m"] ** 2))
        return f["w_peak"] * env * g

    def _cell_updraft(self, t_s, c, u, v):
        t_h = t_s / 3600.0
        if t_h < c["t_start_h"] or t_h > c["t_start_h"] + c["dur_h"]:
            return np.zeros((self.cfg.ny, self.cfg.nx))
        # envelope: 15 min spin-up, plateau, 15 min decay
        tau = c["dur_h"]
        t_in = t_h - c["t_start_h"]
        env = min(1.0, t_in / 0.25) * min(1.0, max(0.0, (tau - t_in) / 0.25))
        # cell drifts with 70% of mean wind
        xc = c["x"] * self.cfg.domain_m + 0.7 * u.mean() * (t_s - c["t_start_h"] * 3600.0)
        yc = c["y"] * self.cfg.ny * self.cfg.dx + 0.7 * v.mean() * (t_s - c["t_start_h"] * 3600.0)
        g = np.exp(-((self.X - xc) ** 2 + (self.Y - yc) ** 2) / (2 * c["radius_m"] ** 2))
        return c["w_peak"] * env * g

    # ---------------------------------------------------- boundary conditions
    def inflow_moisture_boost(self, t_s):
        """Multiplicative q_v boost at the inflow boundary (0 = environment)."""
        f = self.forcing
        if f["kind"] == "none":
            return 0.0, np.zeros(self.cfg.ny)
        t_h = t_s / 3600.0
        if f["kind"] == "band":
            env = lifecycle(t_h, f["t_peak_h"], f["tau_rise_h"], f["tau_decay_h"])
            env *= float(t_h >= f["t_start_h"])
            yc = f["y_center_frac"] * self.cfg.ny * self.cfg.dx
            fy = np.exp(-(self.Y[:, 0] - yc) ** 2 / (2 * f["sigma_y_m"] ** 2))
            return f["moisture_boost"] * env, fy
        if f["kind"] == "cells":
            # broad moist sector feeding the cells from the west
            env = 0.0
            for c in f["cells"]:
                t0 = c["t_start_h"] * 3600.0
                span = c["dur_h"] * 3600.0
                if t0 - 1800.0 <= t_s <= t0 + span:
                    env = max(env, min(1.0, (t_s - (t0 - 1800.0)) / 1800.0))
            return f["moisture_boost"] * env, np.ones(self.cfg.ny) * 0.6
        return 0.0, np.zeros(self.cfg.ny)

    def cold_anomaly_K(self, t_s):
        """Cold-air temperature anomaly (K, negative) behind a front."""
        f = self.forcing
        if f["kind"] != "band" or f.get("dt_front_K", 0.0) == 0.0:
            return 0.0
        t_h = t_s / 3600.0
        env = lifecycle(t_h, f["t_peak_h"], f["tau_rise_h"], f["tau_decay_h"])
        env *= float(t_h >= f["t_start_h"])
        return -abs(f["dt_front_K"]) * env
