"""
Simulation state: terrain, soil maps, atmospheric environment and all
prognostic fields.

Grid conventions
----------------
* atmosphere fields: (nz, ny, nx); layer k is above local ground
* ground fields:     (ny, nx)
* soil fields:       (n_soil, ny, nx); layer 0 is the top 10 cm
* y index 0 = south, x index 0 = west; wind u>0 blows eastward.
"""
import numpy as np

from .config import SOIL_TEXTURES, TEXTURE_ORDER, EngineConfig


def _spectral_noise(nx, ny, dx, n_octaves, rng):
    """Smooth 2-D noise by summing random-phase sinusoids (no scipy needed)."""
    x = np.arange(nx) * dx
    y = np.arange(ny) * dx
    X, Y = np.meshgrid(x, y)
    h = np.zeros((ny, nx))
    for i in range(n_octaves):
        k = (2.0 * np.pi) / (40e3 / (2 ** i))          # wavelengths 40 km .. ~1.2 km
        phi_x, phi_y = rng.uniform(0, 2 * np.pi, 2)
        h += (6.0 / (i + 1)) * np.sin(k * X * np.cos(phi_x) + k * Y * np.sin(phi_y) + phi_x)
    return h


def build_terrain(cfg: EngineConfig):
    """Synthetic catchment: regional west->east rise, a ridge and a valley."""
    rng = np.random.default_rng(cfg.seed)
    Lx = cfg.nx * cfg.dx
    Ly = cfg.ny * cfg.dx
    x = np.linspace(0.0, Lx, cfg.nx)
    y = np.linspace(0.0, Ly, cfg.ny)
    X, Y = np.meshgrid(x, y)                            # (ny, nx)

    z = np.zeros((cfg.ny, cfg.nx))
    z += 90.0 * (X / Lx)                                # regional slope, rises east
    z += 110.0 * np.exp(-((Y - 0.68 * Ly) ** 2) / (2 * (8.5e3) ** 2))   # ridge (south)
    z -= 35.0 * np.exp(-((Y - 0.28 * Ly) ** 2) / (2 * (6.0e3) ** 2))    # valley (north)
    z += 45.0 * np.exp(-(((X - 0.35 * Lx) ** 2) / (2 * (5.5e3) ** 2) +
                         ((Y - 0.45 * Ly) ** 2) / (2 * (4.5e3) ** 2)))  # hill
    z += 30.0 * np.exp(-(((X - 0.70 * Lx) ** 2) / (2 * (6e3) ** 2) +
                         ((Y - 0.40 * Ly) ** 2) / (2 * (5e3) ** 2)))    # second hill
    z += _spectral_noise(cfg.nx, cfg.ny, cfg.dx, 5, rng)
    z -= z.min()
    return z


def build_texture_map(z_sfc, cfg: EngineConfig):
    """Coarser/wetter soils in valleys, coarser granular soil on uplands."""
    rng = np.random.default_rng(cfg.seed + 1)
    zj = z_sfc + rng.normal(0.0, 12.0, z_sfc.shape)
    q75, q35 = np.quantile(zj, 0.70), np.quantile(zj, 0.30)
    tex = np.zeros(z_sfc.shape, dtype=int)              # 0 sandy loam (upland)
    tex[(zj < q75) & (zj >= q35)] = 1                   # 1 loam (slopes)
    tex[zj < q35] = 2                                   # 2 silty clay loam (valley)
    return tex


class SoilMaps:
    """Per-cell soil parameter maps assembled from the texture library."""

    def __init__(self, texture_map, cfg: EngineConfig):
        t = texture_map
        get = lambda key: np.array([SOIL_TEXTURES[n][key] for n in TEXTURE_ORDER])[t]
        self.theta_s = get("theta_s")                   # porosity
        self.psi_s_mm = get("psi_s_mm")
        self.b = get("b")
        self.k_sat_mm_h = get("k_sat_mm_h")
        self.phi_deg = get("phi_deg")
        self.c_eff_kpa = get("c_eff_kpa")
        self.LL = get("LL")
        self.PL = get("PL")
        self.rel_dens = get("rel_dens")
        self.sand = get("sand"); self.silt = get("silt"); self.clay = get("clay")
        # Clapp-Hornberger retention curve:  psi(theta) = psi_s (theta/ths)^(-b)
        # field capacity at 33 kPa, wilting point at 1500 kPa
        self.theta_fc = self.theta_s * (self.psi_s_mm / 3367.0) ** (1.0 / self.b)
        self.theta_wp = self.theta_s * (self.psi_s_mm / 153000.0) ** (1.0 / self.b)
        # geotech granular state
        self.phi_eff = self.phi_deg + 8.0 * (self.rel_dens - 0.5)   # density effect
        self.e_void = self.theta_s / (1.0 - self.theta_s)           # void ratio
        self.rho_dry = 2650.0 * (1.0 - self.theta_s)               # kg/m3
        self.gamma_dry = self.rho_dry * 9.81e-3                     # kN/m3


class State:
    """All prognostic fields plus static environment."""

    def __init__(self, preset: dict, cfg: EngineConfig):
        self.cfg = cfg
        self.preset = preset
        nz, ny, nx = cfg.nz, cfg.ny, cfg.nx

        # ---- terrain & soil -------------------------------------------------
        self.z_sfc = build_terrain(cfg)                          # (ny,nx) m
        self.texture = build_texture_map(self.z_sfc, cfg)
        self.soil = SoilMaps(self.texture, cfg)
        self.z_mean = float(self.z_sfc.mean())

        # ---- atmospheric geometry -------------------------------------------
        z_if = np.array(cfg.z_interfaces)
        self.dz_atm = np.diff(z_if)                              # (nz,) m
        self.z_mid = 0.5 * (z_if[:-1] + z_if[1:])                # (nz,) m AGL
        self.z_abs = self.z_sfc[None, :, :] + self.z_mid[:, None, None]   # (nz,ny,nx)
        # standard-atmosphere pressure at absolute height
        self.p = 101325.0 * (1.0 - 2.25577e-5 * self.z_abs) ** 5.2559      # Pa
        # environment temperature profile (sea-level anchored, lapse 6.5 K/km)
        self.T_sfc0 = preset["T_sfc0_C"] + 273.15
        z_ref = self.z_abs - self.z_mean
        self.T_env = self.T_sfc0 - cfg.lapse_env * z_ref
        self.theta_env = self.T_env * (1e5 / self.p) ** cfg.kappa_air
        # density (static, from environment)
        self.rho_air = self.p / (287.05 * self.T_env)

        # ---- initial moisture ------------------------------------------------
        from .microphysics import qs_mixratio
        qs_env = qs_mixratio(self.T_env, self.p)
        blob = preset.get("rh_blob", dict(boost=0.0, sigma_frac=0.2, x=0.5, y=0.5))
        Ly, Lx = ny * cfg.dx, nx * cfg.dx
        Xg, Yg = np.meshgrid(np.linspace(0, Lx, nx), np.linspace(0, Ly, ny))
        r2 = ((Xg - blob["x"] * Lx) ** 2 + (Yg - blob["y"] * Ly) ** 2)
        blob2d = np.exp(-r2 / (2.0 * (blob["sigma_frac"] * Lx) ** 2))       # (ny,nx)
        rh = np.clip(preset["rh_env"] + blob["boost"] * blob2d, 0.05, 0.995)
        self.q_v = rh * qs_env                                   # (nz,ny,nx)
        self.q_c = np.zeros((nz, ny, nx))
        self.q_r = np.zeros((nz, ny, nx))
        self.theta = self.theta_env.copy()

        # ---- soil column ------------------------------------------------------
        ns = cfg.n_soil
        sat0 = preset["soil_init_sat"]
        theta = self.soil.theta_wp + sat0 * (self.soil.theta_s - self.soil.theta_wp)
        self.theta_soil = np.repeat(theta[None, :, :], ns, axis=0)   # (ns,ny,nx)
        self.theta_soil_init = self.theta_soil.copy()
        self.infilt_F = np.full((ny, nx), 0.01)                     # cumulative infiltration m
        self.ke_cum = np.zeros((ny, nx))                            # J/m2 rain KE

        # ---- surface water ----------------------------------------------------
        self.h_pond = np.zeros((ny, nx))                            # m
        self.rut_depth = np.zeros((ny, nx))                         # m
        self.cum_precip = np.zeros((ny, nx))                        # mm
        self.cum_runoff_in = np.zeros((ny, nx))                     # mm routed in

        # ---- geotech snapshot (filled by engine each step) ---------------------
        self.geo = dict(
            suction_kpa=np.zeros((ny, nx)), c_eff=np.zeros((ny, nx)),
            q_ult_kpa=np.zeros((ny, nx)), cbr=np.zeros((ny, nx)),
            tau_f_kpa=np.zeros((ny, nx)), w_pct=np.zeros((ny, nx)),
            Sr=np.zeros((ny, nx)), consistency=np.zeros((ny, nx), dtype=int),
            gamma_bulk=np.zeros((ny, nx)),
        )

        # ---- wind / forcing (filled by weather module) -------------------------
        self.u_wind = np.zeros((ny, nx))
        self.v_wind = np.zeros((ny, nx))
        self.w_up = np.zeros((nz, ny, nx))

    # -- helpers ---------------------------------------------------------------
    def column_water_mm(self, q):
        """Column-integrated water for mixing-ratio field q (mm)."""
        return (q * self.rho_air * self.dz_atm[:, None, None]).sum(axis=0)

    def soil_water_mm(self):
        dzs = np.array(self.cfg.soil_dz)[:, None, None]
        return (self.theta_soil * dzs).sum(axis=0)

    def terrain_gradient(self):
        """Return (dz/dx, dz/dy) of terrain (m/m)."""
        dzdx = np.gradient(self.z_sfc, self.cfg.dx, axis=1)
        dzdy = np.gradient(self.z_sfc, self.cfg.dx, axis=0)
        return dzdx, dzdy
