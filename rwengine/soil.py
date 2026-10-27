"""
Soil hydrology.

* Infiltration: Green-Ampt with a Philip-style suction head, driven by
  ponded water and rain; surface sealing (crusting) from raindrop kinetic
  energy progressively reduces Ks, as observed on real bare soils.
* Percolation: gravity drainage between layers through the unsaturated
  conductivity K(theta) = Ks (theta/theta_s)^(2b+3)  (Clapp-Hornberger).
* Evaporation: bulk-aerodynamic potential rate, supply-limited by the
  top-layer moisture between field capacity and wilting point.
"""
import numpy as np

from . import microphysics as mp


class Soil:
    def __init__(self, state, cfg):
        self.st = state
        self.cfg = cfg
        s = state.soil
        self.dz = np.array(cfg.soil_dz)[:, None, None]        # (ns,1,1)
        self.theta_s = s.theta_s
        self.theta_fc = s.theta_fc
        self.theta_wp = s.theta_wp
        self.b = s.b
        self.psi_s_m = s.psi_s_mm / 1000.0                    # m
        self.k_sat_m_s = s.k_sat_mm_h * 1e-3 / 3600.0         # m/s
        # cumulative deep percolation (mm, domain mean)
        self.deep_perc_mm = 0.0
        self.cum_infil_mm = 0.0
        self.cum_evap_mm = 0.0

    # ------------------------------------------------------------ infiltration
    def infiltrate(self, dt):
        """
        Green-Ampt infiltration of the available surface (ponded) water.
        Returns infiltration rate (m/s per cell).
        """
        st = self.st
        avail = st.h_pond                                     # m available
        # crusting: cumulative rain KE seals the surface
        seal = 1.0 - self.cfg.ke_seal_frac * np.minimum(
            st.ke_cum / self.cfg.ke_seal_J, 1.0)
        ks_eff = self.k_sat_m_s * seal                          # (ny,nx)
        dtheta = np.maximum(self.theta_s - st.theta_soil[0], 1e-3)
        F = np.maximum(st.infilt_F, 2e-3)                       # m
        # suction head at the wetting front (Clapp-Hornberger at mean theta)
        psi_f = np.clip(self.psi_s_m * (0.55 * self.theta_s / np.maximum(
            st.theta_soil[0], self.theta_wp)) ** (-self.b), 0.02, 0.60)
        head = psi_f * dtheta + st.h_pond
        f_cap = ks_eff * (1.0 + head / F)                       # m/s
        infil = np.minimum(f_cap * dt, avail)
        # capacity of layer 1 to accept water
        cap1 = np.maximum(self.theta_s - st.theta_soil[0], 0.0) * self.dz[0, 0, 0]
        infil = np.minimum(infil, cap1)
        # apply
        st.h_pond = np.maximum(st.h_pond - infil, 0.0)
        st.theta_soil[0] = np.minimum(st.theta_soil[0] + infil / self.dz[0, 0, 0],
                                      self.theta_s)
        st.infilt_F = st.infilt_F + infil
        self.cum_infil_mm += float(infil.mean()) * 1000.0
        return infil / dt                                       # m/s

    # ------------------------------------------------------------ percolation
    def percolate(self, dt):
        """Gravity drainage layer -> layer, then deep percolation."""
        st = self.st
        th = st.theta_soil
        ns = self.cfg.n_soil
        def k_unsat(theta):
            return self.k_sat_m_s * np.maximum(theta / self.theta_s, 1e-3) ** (2.0 * self.b + 3.0)
        for k in range(ns - 1):
            excess = np.maximum(th[k] - self.theta_fc, 0.0)
            drainable = k_unsat(th[k]) * (excess / np.maximum(self.theta_s - self.theta_fc, 1e-3))
            flux = np.minimum(drainable * dt, excess * self.dz[k, 0, 0])
            # acceptance of the layer below
            cap = np.maximum(self.theta_s - th[k + 1], 0.0) * self.dz[k + 1, 0, 0]
            flux = np.minimum(flux, cap)
            th[k] -= flux / self.dz[k, 0, 0]
            th[k + 1] += flux / self.dz[k + 1, 0, 0]
        # bottom boundary: deep percolation out of the profile
        excess = np.maximum(th[ns - 1] - self.theta_fc, 0.0)
        flux = np.minimum(k_unsat(th[ns - 1]) * dt, excess * self.dz[ns - 1, 0, 0])
        th[ns - 1] -= flux / self.dz[ns - 1, 0, 0]
        self.deep_perc_mm += float(flux.mean()) * 1000.0

    # ------------------------------------------------------------ evaporation
    def evaporate(self, dt, wind, T_air_K, rh_air, sw_factor, c_e):
        """
        Bulk-aerodynamic evaporation: from puddles first, then from the top
        soil layer (supply-limited between field capacity and wilting point).
        Returns actual evaporation (m/s per cell).
        """
        st = self.st
        T_sfc = T_air_K - 1.0                                   # surface slightly cooler
        qs_sfc = mp.qs_mixratio(T_sfc, st.p[0])
        qa = rh_air * mp.qs_mixratio(T_air_K, st.p[0])
        dq = np.maximum(qs_sfc - qa, 0.0)
        E_pot = (c_e * sw_factor * (1.0 + 0.35 * wind) * dq * st.rho_air[0]
                 / 1000.0)                                    # m/s of water
        # puddle evaporation at full potential
        e_pond = np.minimum(E_pot * dt, st.h_pond)
        st.h_pond -= e_pond
        # soil evaporation: supply-limited
        beta = np.clip((st.theta_soil[0] - self.theta_wp) /
                       np.maximum(self.theta_fc - self.theta_wp, 1e-3), 0.0, 1.0)
        e_soil = np.minimum(E_pot * beta * dt,
                            np.maximum(st.theta_soil[0] - self.theta_wp, 0.0) * self.dz[0, 0, 0])
        st.theta_soil[0] -= e_soil / self.dz[0, 0, 0]
        E_actual = (e_pond + e_soil) / dt                       # m/s
        self.cum_evap_mm += float((e_pond + e_soil).mean()) * 1000.0
        return E_actual

    # --------------------------------------------------- moisture diagnostics
    def theta_top30(self):
        """Mean volumetric water content of the top 30 cm (layers 0-1)."""
        st = self.st
        w = (0.10 / 0.30) * st.theta_soil[0] + (0.20 / 0.30) * st.theta_soil[1]
        return w

    def wilting_stress(self):
        """Fraction of domain where topsoil is at/below wilting point."""
        return float(np.mean(self.st.theta_soil[0] <= self.theta_wp + 0.01))
