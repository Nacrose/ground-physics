"""
Atmospheric column & transport physics.

* Horizontal advection: conservative flux-form upwind scheme with
  CFL sub-stepping (wind can exceed dx/dt in storms).
* Vertical transport: upwind advection of moisture by resolved w
  (orographic + convective updrafts), with moist-adiabatic cooling in
  ascent and dry-adiabatic warming in subsidence.
* Column physics: saturation adjustment (condensation / evaporation with
  latent heat) + Kessler warm-rain microphysics + rain sedimentation.
* Boundary conditions: prescribed environmental inflow (with frontal
  moisture boost / cold anomaly), zero-gradient outflow.

Potential temperature theta is the advected thermodynamic variable;
T = theta * (p/1e5)^kappa is diagnosed for the moist physics.
"""
import numpy as np

from . import microphysics as mp


class Atmosphere:
    def __init__(self, state, cfg, weather):
        self.st = state
        self.cfg = cfg
        self.weather = weather

    # ------------------------------------------------------------------ utils
    def _theta_to_T(self, theta):
        return theta * (self.st.p / 1e5) ** self.cfg.kappa_air

    def _T_to_theta(self, T):
        return T * (1e5 / self.st.p) ** self.cfg.kappa_air

    def _T_to_theta_at(self, T, p):
        """Temperature -> potential temperature using an explicit pressure."""
        return T * (1e5 / p) ** self.cfg.kappa_air

    # ------------------------------------------------------------ advection
    def advect(self, dt):
        """Advect theta, q_v, q_c, q_r horizontally (flux-form upwind)."""
        st, cfg = self.st, self.cfg
        u, v = st.u_wind, st.v_wind                    # (ny,nx) surface wind
        umax = max(np.abs(u).max(), np.abs(v).max())
        n_sub = max(1, int(np.ceil(umax * dt / cfg.dx / 0.85)))
        dt_sub = dt / n_sub
        for _ in range(n_sub):
            for q in (st.theta, st.q_v, st.q_c, st.q_r):
                self._advect_one(q, u, v, dt_sub)
        return n_sub

    def _advect_one(self, q, u, v, dt):
        """One upwind sub-step, in place, for a (nz,ny,nx) field."""
        dx = self.cfg.dx
        # -- x direction: fluxes at interfaces between j and j+1
        ui = 0.5 * (u[:, :-1] + u[:, 1:])                          # (ny,nx-1)
        flux = np.where(ui > 0.0, ui * q[..., :-1], ui * q[..., 1:])
        div = np.zeros_like(q)
        div[..., :-1] -= flux
        div[..., 1:] += flux
        q += dt * div / dx
        # -- y direction
        vi = 0.5 * (v[:-1, :] + v[1:, :])                          # (ny-1,nx)
        flux = np.where(vi > 0.0, vi * q[..., :-1, :], vi * q[..., 1:, :])
        div = np.zeros_like(q)
        div[..., :-1, :] -= flux
        div[..., 1:, :] += flux
        q += dt * div / dx

    # ---------------------------------------------------- boundary conditions
    def apply_bc(self, t_s):
        st, cfg = self.st, self.cfg
        u, v = st.u_wind, st.v_wind
        boost, fy = self.weather.inflow_moisture_boost(t_s)
        dT = self.weather.cold_anomaly_K(t_s)
        nz = cfg.nz
        # WEST boundary
        if np.mean(u[:, 0]) > 0:                                    # inflow
            qs_env = mp.qs_mixratio(st.T_env[:, :, 0], st.p[:, :, 0])
            q_env = np.clip(st.preset["rh_env"] * qs_env
                            * (1.0 + boost * fy[None, :]), 0.0, 1.05 * qs_env)
            st.q_v[:, :, 0] = q_env
            st.q_c[:, :, 0] = 0.0
            st.q_r[:, :, 0] = 0.0
            st.theta[:, :, 0] = self._T_to_theta_at(
                st.T_env[:, :, 0] + dT, st.p[:, :, 0])
        else:
            st.q_v[:, :, 0] = st.q_v[:, :, 1]
            st.q_c[:, :, 0] = st.q_c[:, :, 1]
            st.q_r[:, :, 0] = st.q_r[:, :, 1]
            st.theta[:, :, 0] = st.theta[:, :, 1]
        # EAST boundary: zero-gradient (outflow when u>0)
        st.q_v[:, :, -1] = st.q_v[:, :, -2]
        st.q_c[:, :, -1] = st.q_c[:, :, -2]
        st.q_r[:, :, -1] = st.q_r[:, :, -2]
        st.theta[:, :, -1] = st.theta[:, :, -2]
        # SOUTH boundary
        if np.mean(v[0, :]) > 0:                                    # inflow
            qs_env = mp.qs_mixratio(st.T_env[:, 0, :], st.p[:, 0, :])
            q_env = np.clip(st.preset["rh_env"] * qs_env * (1.0 + 0.5 * boost), 0.0, 1.05 * qs_env)
            st.q_v[:, 0, :] = q_env
            st.q_c[:, 0, :] = 0.0
            st.q_r[:, 0, :] = 0.0
            st.theta[:, 0, :] = st.theta_env[:, 0, :]
        else:
            st.q_v[:, 0, :] = st.q_v[:, 1, :]
            st.q_c[:, 0, :] = st.q_c[:, 1, :]
            st.q_r[:, 0, :] = st.q_r[:, 1, :]
            st.theta[:, 0, :] = st.theta[:, 1, :]
        # NORTH boundary: zero-gradient
        st.q_v[:, -1, :] = st.q_v[:, -2, :]
        st.q_c[:, -1, :] = st.q_c[:, -2, :]
        st.q_r[:, -1, :] = st.q_r[:, -2, :]
        st.theta[:, -1, :] = st.theta[:, -2, :]

    # ---------------------------------------------------- vertical transport
    def vertical_transport(self, dt):
        """Mass-conserving vertical advection of moisture by w + adiabatic T."""
        st, cfg = self.st, self.cfg
        q_list = [st.q_v, st.q_c, st.q_r]
        w = st.w_up
        dz = st.dz_atm
        rho = st.rho_air
        nz = cfg.nz
        # flux at interface between layer k and k+1, per water species
        for k in range(nz - 1):
            wk = w[k]
            for q in q_list:
                qf = np.where(wk > 0.0, wk * q[k], wk * q[k + 1])  # m/s * kg/kg
                mass = qf * dt * rho[k]                        # kg/m2 across interface
                q[k] -= mass / (rho[k] * dz[k])
                q[k + 1] += mass / (rho[k + 1] * dz[k + 1])
        # top boundary: moisture leaving the column top is lost (anvil outflow)
        wtop = w[nz - 1]
        for q in q_list:
            q[nz - 1] -= np.maximum(wtop, 0.0) * q[nz - 1] * dt / dz[nz - 1]
        # adiabatic temperature change from vertical motion
        T = self._theta_to_T(st.theta)
        gamma = np.where(w > 0.0, cfg.lapse_moist, cfg.lapse_dry)
        T = T - w * gamma * dt
        st.theta = self._T_to_theta(T)

    # -------------------------------------------------------- column physics
    def column_physics(self, dt):
        """Saturation adjustment + Kessler microphysics + rain fallout."""
        st, cfg = self.st, self.cfg
        T = self._theta_to_T(st.theta)
        T, st.q_v, st.q_c = mp.saturation_adjustment(
            T, st.p, st.q_v, st.q_c)
        st.q_v, st.q_c, st.q_r, T = mp.kessler_step(
            T, st.p, st.q_v, st.q_c, st.q_r, dt,
            cfg.kessler_qc0, cfg.kessler_k1, cfg.kessler_k2, cfg.rain_evap_coef)
        st.theta = self._T_to_theta(T)

    # -------------------------------------------------------- rain fallout
    def rain_fallout(self, dt):
        """
        Sediment rain water downward; returns the water depth reaching the
        ground this step (kg/m2 == mm) and updates q_r.
        """
        st, cfg = self.st, self.cfg
        nz = cfg.nz
        dz = st.dz_atm
        rho = st.rho_air
        rain_depth = np.zeros((cfg.ny, cfg.nx))            # mm (= kg/m2) this step
        for k in range(nz - 1, -1, -1):
            v = mp.bulk_fall_speed(st.q_r[k], rho[k])
            frac = np.minimum(v * dt / dz[k], 1.0)          # fraction leaving layer k
            dq = st.q_r[k] * frac                           # kg/kg leaving
            mass_out = dq * rho[k] * dz[k]                  # kg/m2 leaving
            st.q_r[k] -= dq
            if k == 0:
                rain_depth += mass_out                      # reaches the ground
            else:
                st.q_r[k - 1] += mass_out / (rho[k - 1] * dz[k - 1])
        return rain_depth                                    # mm this step

    # -------------------------------------------------- relaxation & hygiene
    def relax_to_env(self, dt):
        """Weak relaxation of theta toward the environment (radiative damping)."""
        st, cfg = self.st, self.cfg
        tau = cfg.tau_relax_h * 3600.0
        st.theta += (st.theta_env - st.theta) * dt / tau

    def add_surface_evapor(self, E_kg_m2_s):
        """Add evaporated water to the lowest atmospheric layer (capped at qs)."""
        st, cfg = self.st, self.cfg
        T = self._theta_to_T(st.theta)
        qs0 = mp.qs_mixratio(T[0], st.p[0])
        dq = E_kg_m2_s / (st.rho_air[0] * st.dz_atm[0])
        st.q_v[0] = np.minimum(st.q_v[0] + dq, 0.99 * qs0)

    def hygiene(self):
        st = self.st
        np.clip(st.q_v, 0.0, 0.05, out=st.q_v)
        np.clip(st.q_c, 0.0, 0.02, out=st.q_c)
        np.clip(st.q_r, 0.0, 0.05, out=st.q_r)
        np.nan_to_num(st.theta, copy=False, nan=float(st.theta_env.mean()))
        np.nan_to_num(st.q_v, copy=False, nan=0.0)
        np.nan_to_num(st.q_c, copy=False, nan=0.0)
        np.nan_to_num(st.q_r, copy=False, nan=0.0)
