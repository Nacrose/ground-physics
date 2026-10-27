"""
Configuration for the Rain & Weather Engine.

Soil hydraulic parameters follow the Clapp & Hornberger (1978) / Cosby et al. (1984)
pedotransfer parameterization; geotechnical parameters are typical textbook values
(Terzaghi, Das "Principles of Geotechnical Engineering").  All values are calibrated
approximations intended for simulation, not for design use.
"""
from dataclasses import dataclass, field

# ----------------------------------------------------------------------------
# Soil texture library
#   theta_s  : saturated volumetric water content (porosity)        [-]
#   psi_s_mm : air-entry suction head (abs) at saturation           [mm H2O]
#   b        : Clapp-Hornberger pore-size distribution exponent     [-]
#   k_sat    : saturated hydraulic conductivity                     [mm/h]
#   phi_deg  : effective friction angle (Mohr-Coulomb)              [deg]
#   c_eff    : effective cohesion                                   [kPa]
#   LL / PL  : Atterberg liquid / plastic limits (gravimetric %)
#   rel_dens : relative density Dr of the granular skeleton         [-]
# ----------------------------------------------------------------------------
SOIL_TEXTURES = {
    "sandy_loam": dict(
        label="Sandy loam", sand=65, silt=25, clay=10,
        theta_s=0.435, psi_s_mm=218.0, b=4.90, k_sat_mm_h=25.9,
        phi_deg=32.0, c_eff_kpa=3.0, LL=21.0, PL=13.0, rel_dens=0.60,
    ),
    "loam": dict(
        label="Loam", sand=40, silt=42, clay=18,
        theta_s=0.451, psi_s_mm=478.0, b=5.25, k_sat_mm_h=13.0,
        phi_deg=28.0, c_eff_kpa=8.0, LL=27.0, PL=18.0, rel_dens=0.50,
    ),
    "silty_clay_loam": dict(
        label="Silty clay loam", sand=15, silt=55, clay=30,
        theta_s=0.500, psi_s_mm=356.0, b=7.75, k_sat_mm_h=3.4,
        phi_deg=24.0, c_eff_kpa=15.0, LL=32.0, PL=20.0, rel_dens=0.40,
    ),
}
TEXTURE_ORDER = ["sandy_loam", "loam", "silty_clay_loam"]


# ----------------------------------------------------------------------------
# Weather presets.  Each preset drives the full water cycle:
#   atmospheric inflow -> condensation -> rain (Marshall-Palmer) ->
#   infiltration (Green-Ampt) / runoff (Manning-D8) -> soil moisture ->
#   geotechnical strength response -> evaporation back to the atmosphere.
#
# forcing spec:
#   kind = "none"  : quiescent conditions (clear sky)
#   kind = "band"  : a frontal rain band sweeping east with the wind
#   kind = "cells" : discrete convective cells with individual lifecycles
# ----------------------------------------------------------------------------
PRESETS = {
    # ---- quiescent reference: drying, strength recovery -------------------
    "clear_sky": dict(
        label="Clear sky (drying cycle)",
        duration_h=6.0,
        T_sfc0_C=22.0, rh_env=0.55,
        wind_uv=(3.0, 0.5), gust_amp=0.10,
        forcing=dict(kind="none"),
        evap_c_e=4.0e-3, sw_factor=1.0,
        soil_init_sat=0.45,
        rh_blob=dict(boost=0.0, sigma_frac=0.15, x=0.5, y=0.5),
        loads=[],
    ),
    # ---- light stratiform rain --------------------------------------------
    "drizzle": dict(
        label="Drizzle (stratiform)",
        duration_h=6.0,
        T_sfc0_C=12.0, rh_env=0.90,
        wind_uv=(4.0, 1.0), gust_amp=0.05,
        forcing=dict(
            kind="band",
            speed_m_s=4.0, x0_frac=-0.15, y_center_frac=0.45,
            sigma_x_m=9000.0, sigma_y_m=18000.0,
            w_peak=0.13, t_start_h=0.5, t_peak_h=2.5,
            tau_rise_h=1.5, tau_decay_h=3.0,
            moisture_boost=0.22, dt_front_K=0.0,
        ),
        evap_c_e=4.0e-3, sw_factor=0.25,
        soil_init_sat=0.50,
        rh_blob=dict(boost=0.04, sigma_frac=0.25, x=0.45, y=0.45),
        loads=[dict(t_h=1.0, x=0.50, y=0.28, q_kpa=150.0, label="truck pass (valley, dry-ish)")],
    ),
    # ---- convective event: our showcase ------------------------------------
    "thunderstorm": dict(
        label="Thunderstorm (convective cells)",
        duration_h=5.0,
        T_sfc0_C=24.0, rh_env=0.80,
        wind_uv=(10.0, 2.0), gust_amp=0.30,
        forcing=dict(
            kind="cells",
            cells=[
                dict(t_start_h=0.8, dur_h=1.05, x=0.50, y=0.30, radius_m=4500.0, w_peak=1.80),
                dict(t_start_h=1.6, dur_h=1.00, x=0.55, y=0.55, radius_m=4500.0, w_peak=2.00),
                dict(t_start_h=2.3, dur_h=0.80, x=0.35, y=0.60, radius_m=4000.0, w_peak=1.60),
                dict(t_start_h=2.8, dur_h=0.75, x=0.62, y=0.42, radius_m=3500.0, w_peak=1.40),
            ],
            moisture_boost=0.25, dt_front_K=0.0,
        ),
        evap_c_e=4.0e-3, sw_factor=0.15,
        soil_init_sat=0.42,
        rh_blob=dict(boost=0.22, sigma_frac=0.25, x=0.50, y=0.45),
        loads=[
            dict(t_h=0.5, x="auto", q_kpa=150.0, label="truck pass (valley, before)"),
            dict(t_h=4.2, x="auto", q_kpa=150.0, label="truck pass (valley, after)"),
        ],
    ),
    # ---- sustained heavy rain ----------------------------------------------
    "monsoon": dict(
        label="Monsoon (sustained heavy rain)",
        duration_h=12.0,
        T_sfc0_C=27.0, rh_env=0.85,
        wind_uv=(12.0, 3.0), gust_amp=0.12,
        forcing=dict(
            kind="band",
            speed_m_s=6.0, x0_frac=-0.10, y_center_frac=0.50,
            sigma_x_m=22000.0, sigma_y_m=26000.0,
            w_peak=0.50, t_start_h=0.5, t_peak_h=5.0,
            tau_rise_h=2.0, tau_decay_h=7.0,
            moisture_boost=0.50, dt_front_K=0.0,
            pulse_period_h=3.0, pulse_amp=0.30,
        ),
        evap_c_e=4.0e-3, sw_factor=0.20,
        soil_init_sat=0.60,
        rh_blob=dict(boost=0.08, sigma_frac=0.30, x=0.50, y=0.50),
        loads=[
            dict(t_h=1.0, x=0.50, y=0.28, q_kpa=150.0, label="truck pass (valley, early)"),
            dict(t_h=6.0, x="auto", q_kpa=150.0, label="truck pass (valley, mid)"),
            dict(t_h=11.0, x="auto", q_kpa=150.0, label="truck pass (valley, late)"),
        ],
    ),
    # ---- travelling cold front ----------------------------------------------
    "cold_front": dict(
        label="Cold front (travelling rain band)",
        duration_h=6.0,
        T_sfc0_C=16.0, rh_env=0.75,
        wind_uv=(14.0, 0.0), gust_amp=0.15,
        forcing=dict(
            kind="band",
            speed_m_s=14.0, x0_frac=-0.10, y_center_frac=0.50,
            sigma_x_m=4500.0, sigma_y_m=24000.0,
            w_peak=0.45, t_start_h=0.5, t_peak_h=2.0,
            tau_rise_h=1.2, tau_decay_h=2.5,
            moisture_boost=0.30, dt_front_K=8.0,
        ),
        evap_c_e=4.0e-3, sw_factor=0.30,
        soil_init_sat=0.45,
        rh_blob=dict(boost=0.05, sigma_frac=0.25, x=0.40, y=0.50),
        loads=[dict(t_h=1.5, x=0.50, y=0.28, q_kpa=150.0, label="truck pass (valley, pre-front)")],
    ),
}


# ----------------------------------------------------------------------------
# Engine-wide numerical / physical configuration
# ----------------------------------------------------------------------------
@dataclass
class EngineConfig:
    # grid
    nx: int = 64
    ny: int = 64
    dx: float = 1000.0            # m
    dt: float = 60.0              # s
    # atmospheric column (heights above local ground, m)
    z_interfaces: tuple = (0.0, 250.0, 500.0, 750.0, 1000.0, 1500.0, 2000.0, 3000.0, 5000.0)
    # soil column layer thicknesses (m), top first
    soil_dz: tuple = (0.10, 0.20, 0.30, 0.40)
    # physics constants
    rho_w: float = 1000.0          # kg/m3
    rho_air_ref: float = 1.20      # kg/m3
    gamma_s_kn: float = 26.5       # kN/m3  (Gs = 2.65)
    gamma_w_kn: float = 9.81       # kN/m3
    lapse_env: float = 6.5e-3      # K/m environmental lapse
    lapse_moist: float = 6.0e-3    # K/m  parcel lapse in updrafts
    lapse_dry: float = 9.8e-3      # K/m  subsidence warming
    kappa_air: float = 0.286       # Rd/cp
    # Kessler microphysics
    kessler_qc0: float = 5.0e-4    # kg/kg autoconversion threshold
    kessler_k1: float = 1.0e-3     # 1/s
    kessler_k2: float = 2.742      # 1/s
    rain_evap_coef: float = 6.0e-4 # 1/s
    rain_fall_a: float = 6.0       # bulk fall speed prefactor
    rain_fall_b: float = 0.20      # bulk fall speed exponent
    # atmospheric relaxation
    tau_relax_h: float = 6.0       # h, weak theta relaxation toward environment
    # surface
    manning_n: float = 0.05
    micro_dep_storage_mm: float = 2.0
    # geotech
    footing_B_m: float = 0.30      # reference wheel/footing width
    phi_b_deg: float = 15.0        # Fredlund suction friction angle
    suction_cap_kpa: float = 2000.0
    c_app_cap_kpa: float = 150.0
    max_rut_m: float = 0.50
    # crust sealing by rain kinetic energy
    ke_seal_J: float = 800.0       # J/m2 for full 35% Ks reduction
    ke_seal_frac: float = 0.35
    # snapshot cadence for animation
    snapshot_every_s: float = 900.0
    seed: int = 7

    @property
    def nz(self) -> int:
        return len(self.z_interfaces) - 1

    @property
    def n_soil(self) -> int:
        return len(self.soil_dz)

    @property
    def domain_m(self) -> float:
        return self.nx * self.dx


def get_preset(name: str) -> dict:
    if name not in PRESETS:
        raise KeyError(f"unknown preset '{name}'; available: {list(PRESETS)}")
    return PRESETS[name]
