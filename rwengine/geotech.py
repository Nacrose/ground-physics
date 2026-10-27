"""
Soil mechanics (approximate geotechnical response to wetting).

Granular state
    void ratio e, porosity n, degree of saturation Sr, bulk unit weight.
Suction & effective stress
    matric suction from the Clapp-Hornberger retention curve,
    apparent cohesion c_app = c' + Sr * s * tan(phi_b)  (Fredlund et al.),
    positive pore pressure under ponding reduces effective stress.
Strength
    Mohr-Coulomb  tau_f = c_eff + sigma' * tan(phi_eff).
Bearing capacity
    Terzaghi square surface footing:
        q_ult = 1.2 c_eff Nc + 0.4 gamma_eff B Ngamma
        Nq = exp(pi tan phi) tan^2(45 + phi/2),
        Nc = (Nq - 1) cot phi,  Ngamma = 2 (Nq + 1) tan phi.
Consistency (Atterberg)
    w < PL: solid/semi-solid (firm), PL <= w < LL: plastic (soft),
    w >= LL: liquid -> MUD: cohesive strength collapses, rutting explodes.
Trafficability
    rut sinkage = elastic settlement + plastic punching when the applied
    contact pressure exceeds q_ult; vehicles bog down in liquid-consistency
    ground.  Ruts add depression storage that ponds water (feedback).
"""
import numpy as np


DEG = np.pi / 180.0


def texture_strength_curve(tex, cfg, w_grid):
    """
    Sweep gravimetric water content w (%) for one texture dict and return the
    full geotechnical response (used for calibration / curve figures).
    Returns dict of arrays over w_grid.
    """
    w = np.asarray(w_grid, dtype=float)
    rho_dry = 2650.0 * (1.0 - tex["theta_s"])
    th = np.minimum(w / 100.0 * rho_dry / 1000.0, tex["theta_s"])
    th = np.maximum(th, 0.02)
    Sr = np.clip(th / tex["theta_s"], 0.0, 1.0)
    with np.errstate(over="ignore"):
        psi_mm = tex["psi_s_mm"] * (th / tex["theta_s"]) ** (-tex["b"])
    suction = np.minimum(psi_mm * 9.81e-3, cfg.suction_cap_kpa)
    suction = np.where(Sr >= 0.999, 0.0, suction)
    c_app = np.minimum(tex["c_eff_kpa"] + Sr * suction * np.tan(cfg.phi_b_deg * DEG),
                       cfg.c_app_cap_kpa)
    over_liq = np.maximum(w - tex["LL"], 0.0)
    soft = np.minimum(over_liq / 15.0, 1.0)
    c_eff = c_app * np.maximum(1.0 - soft, 0.10)
    phi_eff = np.maximum(tex["phi_deg"] + 8.0 * (tex["rel_dens"] - 0.5) - 12.0 * soft, 8.0)
    Nq, Nc, Ng = Geotech.bearing_factors(phi_eff)
    n = tex["theta_s"]
    gamma_bulk = rho_dry * 9.81e-3 + n * Sr * cfg.gamma_w_kn
    q_ult = 1.2 * c_eff * Nc + 0.4 * gamma_bulk * cfg.footing_B_m * Ng
    q_ult = np.maximum(q_ult, 2.0)
    return dict(w=w, theta=th, Sr=Sr, suction_kpa=suction, c_app=c_app,
                c_eff=c_eff, phi_eff=phi_eff, q_ult=q_ult,
                cbr=np.clip(100.0 * q_ult / 6900.0, 0.05, 150.0))


class Geotech:
    def __init__(self, state, cfg):
        self.st = state
        self.cfg = cfg

    # --------------------------------------------------------------- bearing
    @staticmethod
    def bearing_factors(phi_deg):
        """Terzaghi bearing capacity factors Nq, Nc, Ngamma."""
        phi = np.maximum(phi_deg, 0.0) * DEG
        tan_phi = np.tan(phi)
        Nq = np.exp(np.pi * tan_phi) * np.tan(0.25 * np.pi + 0.5 * phi) ** 2
        Nc = np.where(tan_phi > 1e-3, (Nq - 1.0) / np.maximum(tan_phi, 1e-12), 5.14)
        Ng = 2.0 * (Nq + 1.0) * tan_phi
        return Nq, Nc, Ng

    # ------------------------------------------------------------- update all
    def update(self):
        """Recompute the per-cell geotechnical state from soil moisture."""
        st, cfg = self.st, self.cfg
        s = st.soil
        g = st.geo

        # mean moisture of the active zone (top 30 cm)
        th = (0.10 / 0.30) * st.theta_soil[0] + (0.20 / 0.30) * st.theta_soil[1]
        Sr = np.clip(th / s.theta_s, 0.0, 1.0)
        w_pct = 100.0 * th * 1000.0 / s.rho_dry                # gravimetric %

        # ---- matric suction (kPa) from the retention curve ---------------
        with np.errstate(over="ignore", divide="ignore"):
            psi_mm = s.psi_s_mm * np.maximum(th / s.theta_s, 1e-3) ** (-s.b)
        suction = np.minimum(psi_mm * 9.81e-3, cfg.suction_cap_kpa)
        suction = np.where(Sr >= 0.999, 0.0, suction)

        # ---- unit weights (kN/m3) -----------------------------------------
        n = s.theta_s
        gamma_bulk = s.gamma_dry + n * Sr * cfg.gamma_w_kn
        gamma_sat = s.gamma_dry + n * cfg.gamma_w_kn
        submerged = st.h_pond > 5e-3                            # ponded cells
        gamma_eff = np.where(submerged, gamma_sat - cfg.gamma_w_kn, gamma_bulk)

        # ---- apparent cohesion from suction --------------------------------
        c_app = s.c_eff_kpa + Sr * suction * np.tan(cfg.phi_b_deg * DEG)
        c_app = np.minimum(c_app, cfg.c_app_cap_kpa)

        # ---- liquid-consistency (mud) collapse ------------------------------
        over_liquid = np.maximum(w_pct - s.LL, 0.0)
        soft = np.minimum(over_liquid / 15.0, 1.0)              # 0..1
        c_eff = c_app * np.maximum(1.0 - soft, 0.10)
        phi_eff = np.maximum(s.phi_eff - 12.0 * soft, 8.0)

        # ---- bearing capacity ------------------------------------------------
        Nq, Nc, Ng = self.bearing_factors(phi_eff)
        B = cfg.footing_B_m
        q_ult = 1.2 * c_eff * Nc + 0.4 * gamma_eff * B * Ng
        q_ult = np.maximum(q_ult, 2.0)                          # floor: slurry

        # ---- CBR approximation -----------------------------------------------
        cbr = np.clip(100.0 * q_ult / 6900.0, 0.05, 150.0)

        # ---- shear strength at 0.3 m depth ------------------------------------
        sigma_v = gamma_bulk * 0.30
        u_pos = np.where(submerged & (Sr >= 0.999),
                         cfg.gamma_w_kn * st.h_pond * 1000.0, 0.0)   # h in m -> kPa
        sigma_eff = sigma_v - u_pos + Sr * suction
        tau_f = c_eff + sigma_eff * np.tan(phi_eff * DEG)

        # ---- consistency state -------------------------------------------------
        consistency = np.where(w_pct < s.PL, 0, np.where(w_pct < s.LL, 1, 2))

        g.update(dict(
            suction_kpa=suction, c_eff=c_eff, q_ult_kpa=q_ult, cbr=cbr,
            tau_f_kpa=tau_f, w_pct=w_pct, Sr=Sr, consistency=consistency,
            gamma_bulk=gamma_bulk,
        ))
        return g

    # ------------------------------------------------------------------ rutting
    def apply_load(self, ix, iy, q_contact_kpa, label, t_h, log):
        """
        Apply one vehicle pass at grid cell (ix, iy).
        Elastic settlement + plastic punching shear + mud bogging.
        Records the trafficability verdict into `log`.
        """
        st, cfg = self.st, self.cfg
        g = st.geo
        q_ult = float(g["q_ult_kpa"][iy, ix])
        tau_f = max(float(g["tau_f_kpa"][iy, ix]), 1.0)
        w_pct = float(g["w_pct"][iy, ix])
        LL, PL = float(st.soil.LL[iy, ix]), float(st.soil.PL[iy, ix])
        consist = int(g["consistency"][iy, ix])

        # elastic settlement (m)
        E = 120.0 * tau_f                                        # kPa stiffness
        s_el = q_contact_kpa * cfg.footing_B_m * (1.0 - 0.3 ** 2) / max(E, 1.0)
        # plastic punching
        gamma_bulk = float(g["gamma_bulk"][iy, ix])
        Nq, _, _ = self.bearing_factors(float(st.soil.phi_eff[iy, ix]))
        excess = max(q_contact_kpa - q_ult, 0.0)
        s_pl = excess / max(gamma_bulk * float(Nq), 1.0) if excess > 0 else 0.0
        s_pl = min(s_pl, cfg.max_rut_m)
        # bogging in liquid-consistency ground
        if consist == 2:
            s_pl = max(s_pl, 0.35)
        s_total = float(np.clip(s_el + s_pl, 0.0, cfg.max_rut_m))
        st.rut_depth[iy, ix] = min(st.rut_depth[iy, ix] + s_total, cfg.max_rut_m + 0.2)

        verdict = ("PASSABLE" if s_total < 0.05 else
                   "MARGINAL (rutting)" if s_total < 0.25 else
                   "BOGGED")
        state_txt = ("solid" if consist == 0 else
                     "plastic" if consist == 1 else "liquid/MUD")
        log.append(dict(t_h=t_h, label=label, q_contact=q_contact_kpa,
                        q_ult=q_ult, w_pct=w_pct, LL=LL, PL=PL,
                        soil_state=state_txt, settlement_m=s_total,
                        rut_total_m=float(st.rut_depth[iy, ix]), verdict=verdict))

    # ------------------------------------------------------------- soil canvas
    def strength_profile(self, ix, iy):
        """Strength vs depth for one soil column (for the profile figure)."""
        st = self.st
        s = st.soil
        ns = self.cfg.n_soil
        depths = np.cumsum(self.cfg.soil_dz)
        tau, q_ult = [], []
        for k in range(ns):
            th = st.theta_soil[k][iy, ix]
            Sr = min(th / s.theta_s[iy, ix], 1.0)
            with np.errstate(over="ignore"):
                psi_mm = s.psi_s_mm[iy, ix] * max(th / s.theta_s[iy, ix], 1e-3) ** (-s.b[iy, ix])
            suction = min(psi_mm * 9.81e-3, self.cfg.suction_cap_kpa)
            if Sr >= 0.999:
                suction = 0.0
            c_app = s.c_eff_kpa[iy, ix] + Sr * suction * np.tan(self.cfg.phi_b_deg * DEG)
            w_pct = 100.0 * th * 1000.0 / s.rho_dry[iy, ix]
            over_liq = max(w_pct - s.LL[iy, ix], 0.0)
            soft = min(over_liq / 15.0, 1.0)
            c_eff = c_app * max(1.0 - soft, 0.10)
            phi_eff = max(s.phi_eff[iy, ix] - 12.0 * soft, 8.0)
            z = depths[k]
            gamma = s.gamma_dry[iy, ix] + s.theta_s[iy, ix] * Sr * self.cfg.gamma_w_kn
            sigma_eff = gamma * z + Sr * suction
            tau.append(c_eff + sigma_eff * np.tan(phi_eff * DEG))
            Nq, Nc, Ng = self.bearing_factors(phi_eff)
            q_ult.append(1.2 * c_eff * Nc + 0.4 * gamma * self.cfg.footing_B_m * Ng)
        return depths, np.array(tau), np.array(q_ult)
