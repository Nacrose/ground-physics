"""
Rain microphysics.

* Drop-size distribution (DSD):  Marshall & Palmer (1948)
      N(D) = N0 * exp(-Lambda * D),   N0 = 8000 m^-3 mm^-1,
      Lambda = 4.1 * R^-0.21 mm^-1    (R in mm/h)
* Terminal velocity: Gunn & Kinzer power fit  v(D) = 3.778 * D^0.67 (m/s),
  capped at 9.2 m/s (large drops break up).
* Radar reflectivity:  Z = 200 * R^1.6  (Marshall-Palmer Z-R relation)
* Kessler (1969) bulk warm-rain scheme: saturation adjustment,
  autoconversion, accretion, rain evaporation.

All routines are pure-numpy and vectorized over (nz, ny, nx) arrays.
"""
import numpy as np

# --- physical constants ------------------------------------------------------
N0_MP = 8000.0          # m^-3 mm^-1
LAMBDA_A = 4.1          # mm^-1
LAMBDA_B = -0.21        # exponent on R [mm/h]
LV = 2.5e6              # J/kg latent heat of vaporization
CP_AIR = 1005.0         # J/kg/K
EPS_MW = 0.622          # Mw/Md
RHO_W = 1000.0          # kg/m3
D_MIN, D_MAX = 0.05, 7.0   # mm integration range
D_GRID = np.linspace(D_MIN, D_MAX, 400)


# --- water vapor thermodynamics ----------------------------------------------
def es_pa(T):
    """Saturation vapor pressure (Pa) over water, Bolton (1980)."""
    Tc = np.asarray(T) - 273.15
    return 611.2 * np.exp(17.67 * Tc / (Tc + 237.3))


def qs_mixratio(T, p):
    """Saturation mixing ratio (kg/kg) given T (K), p (Pa)."""
    e = es_pa(T)
    return EPS_MW * e / (np.asarray(p) - e)


# --- Marshall-Palmer DSD ------------------------------------------------------
def mp_lambda(R_mm_h):
    """DSD slope Lambda (mm^-1) for rain rate R (mm/h)."""
    R = np.maximum(np.asarray(R_mm_h, dtype=float), 1e-3)
    return LAMBDA_A * R ** LAMBDA_B


def dsd_N(D_mm, R_mm_h):
    """Number density N(D) in m^-3 mm^-1 at drop diameter D (mm)."""
    return N0_MP * np.exp(-mp_lambda(R_mm_h) * D_mm)


def terminal_velocity(D_mm):
    """Gunn & Kinzer style terminal fall speed (m/s), D in mm."""
    v = 3.778 * np.asarray(D_mm, dtype=float) ** 0.67
    return np.minimum(v, 9.2)


def dsd_stats(R_mm_h):
    """
    Integrate the Marshall-Palmer DSD for a scalar rain rate R (mm/h).
    Returns dict with:
      R_check  : rain rate implied by the integral (mm/h)
      D0       : median volume diameter 3.67/Lambda (mm)
      n_drops  : total drop number concentration (m^-3)
      v_mean   : mass-weighted mean fall speed (m/s)
      ke_rate  : kinetic energy flux (J/m2/s)
      z_dbz    : radar reflectivity from the DSD integral (dBZ)
    """
    R = float(np.maximum(R_mm_h, 1e-3))
    lam = mp_lambda(R)
    D = D_GRID
    N = dsd_N(D, R)
    v = terminal_velocity(D)
    vol = (np.pi / 6.0) * D ** 3                       # mm^3
    mass_mg = vol * 1.0e-3                             # grams (1 mm^3 water = 1 mg)
    # number concentration (m^-3)
    n_drops = float(np.trapezoid(N, D))
    # rain rate implied: mass flux through horizontal plane (mm/h)
    flux = np.trapezoid(N * mass_mg * 1e-3 * v, D)     # kg/m2/s
    R_check = flux * 3600.0                            # mm/h (1 kg/m2 = 1 mm)
    # mass-weighted mean fall speed
    v_mean = float(np.trapezoid(N * mass_mg * v, D) / max(np.trapezoid(N * mass_mg, D), 1e-12))
    # kinetic energy flux: sum of 0.5 m v^2 over drops crossing unit area
    ke = np.trapezoid(0.5 * N * (mass_mg * 1e-3) * v ** 3, D)   # J/m2/s
    # radar reflectivity factor Z = integral N D^6 dD  (mm^6/m^3)
    Z = float(np.trapezoid(N * D ** 6, D))
    return dict(
        R=R, lam=lam, R_check=R_check, D0=3.67 / lam,
        n_drops=n_drops, v_mean=v_mean, ke_rate=float(ke),
        z_dbz=10.0 * np.log10(max(Z, 1e-6)),
    )


def zr_dbz(R_mm_h):
    """Marshall-Palmer Z-R relation in dBZ (R in mm/h)."""
    R = np.maximum(np.asarray(R_mm_h, dtype=float), 1e-4)
    Z = 200.0 * R ** 1.6
    return 10.0 * np.log10(Z)


def rain_ke_rate(R_mm_h):
    """Kinetic-energy flux (J/m2/s) for array of rain rates (mm/h)."""
    R = np.maximum(np.asarray(R_mm_h, dtype=float), 1e-3)
    # closed-form-friendly numeric fit of the DSD integral (valid 0.1..200 mm/h):
    #   KE[Hz/m2/mm] ~ 0.29 * (1 - 0.6 exp(-R/8))  after Uijlenhoet (1982)-style scaling
    ke_specific = 0.29 * (1.0 - 0.6 * np.exp(-R / 8.0))   # J per m2 per mm of rain
    return ke_specific * R / 3600.0                        # J/m2/s


# --- Kessler bulk warm-rain scheme -------------------------------------------
def saturation_adjustment(T, p, q_v, q_c, n_iter=3, relax=0.8):
    """
    Adjust (T, q_v, q_c) toward saturation, condensing/evaporating cloud water
    with latent heating/cooling.  Iterated because heating feeds back on qs.
    Mass-conserving: condensation moves water q_v -> q_c, evaporation q_c -> q_v.
    """
    T = T.copy(); q_v = q_v.copy(); q_c = q_c.copy()
    for _ in range(n_iter):
        qs = qs_mixratio(T, p)
        excess = q_v - qs
        cond = np.where(excess > 0.0, excess * relax, 0.0)
        q_v = q_v - cond
        q_c = q_c + cond
        T = T + (LV / CP_AIR) * cond
        # evaporate cloud water where subsaturated (with updated T and q_v)
        qs = qs_mixratio(T, p)
        deficit = qs - q_v
        evap = np.where((deficit > 0.0) & (q_c > 0.0),
                        np.minimum(q_c, deficit * relax), 0.0)
        q_v = q_v + evap
        q_c = q_c - evap
        T = T - (LV / CP_AIR) * evap
    return T, q_v, q_c


def kessler_step(T, p, q_v, q_c, q_r, dt, qc0, k1, k2, c_evap):
    """
    One Kessler microphysics step:
      1. autoconversion  cloud -> rain   (rate k1 (qc - qc0))
      2. accretion       cloud -> rain   (rate k2 qc qr^0.875)
      3. rain evaporation in subsaturated air -> vapor + cooling
    Returns updated (q_v, q_c, q_r, T).
    """
    q_v = q_v.copy(); q_c = q_c.copy(); q_r = q_r.copy(); T = T.copy()
    # autoconversion
    excess_qc = np.maximum(q_c - qc0, 0.0)
    auto = np.minimum(k1 * excess_qc * dt, q_c)
    q_c = q_c - auto
    q_r = q_r + auto
    # accretion (rain sweeping out cloud water)
    accr = np.minimum(k2 * q_c * np.maximum(q_r, 0.0) ** 0.875 * dt, q_c)
    q_c = q_c - accr
    q_r = q_r + accr
    # rain evaporation in subsaturated air
    qs = qs_mixratio(T, p)
    rh = np.clip(q_v / qs, 0.0, 1.0)
    evap = np.minimum(c_evap * (1.0 - rh) * np.sqrt(np.maximum(q_r, 0.0)) * dt, q_r)
    q_r = q_r - evap
    q_v = q_v + evap
    T = T - (LV / CP_AIR) * evap
    # hygiene
    q_c = np.maximum(q_c, 0.0)
    q_r = np.maximum(q_r, 0.0)
    return q_v, q_c, q_r, T


def bulk_fall_speed(q_r, rho_air):
    """Mass-flux bulk rain fall speed (m/s) from rain mixing ratio."""
    lwc = np.maximum(q_r * rho_air * 1000.0, 0.0)     # g/m3
    v = 6.0 * np.maximum(lwc, 1e-3) ** 0.20
    return np.minimum(v, 9.5)
