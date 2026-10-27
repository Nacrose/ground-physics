"""
Additional figures: soil profile, geotechnical curves, rain microphysics,
preset comparison, and the animated storm GIF.
"""
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

from . import microphysics as mp
from .config import SOIL_TEXTURES, TEXTURE_ORDER
from .geotech import DEG, texture_strength_curve
from .visuals import (AMBER, BG, CM_MOIST, CM_POND, CM_RAIN, CM_STRENGTH,
                      CONSISTENCY_COLORS, CYAN, GRID, MUT, RAIN, RED, SLATE,
                      SLATE_D, SLATE_DD, TEXT, _ext, _grid, _panel_map,
                      _rec, _save, storm_style)


# ============================================================== soil profile
def fig_soil_profile(engine, path):
    """Vertical soil section: moisture and strength before/after the storm."""
    storm_style()
    st = engine.state
    cfg = engine.cfg
    # representative columns: valley, mid-slope, hilltop
    z = st.z_sfc
    tex = st.texture
    iy_v, ix_v = np.unravel_index(np.argmin(np.where(tex == 2, z, np.inf)), z.shape)
    iy_h, ix_h = np.unravel_index(np.argmax(z), z.shape)
    iy_m, ix_m = np.unravel_index(
        np.argsort(z.ravel())[z.size // 2], z.shape)
    cols = [("valley (silty clay loam)", iy_v, ix_v, CYAN),
            ("mid-slope (loam)", iy_m, ix_m, AMBER),
            ("hilltop (sandy loam)", iy_h, ix_h, SLATE)]
    centers = np.cumsum(cfg.soil_dz) - np.array(cfg.soil_dz) / 2.0

    fig, axes = plt.subplots(1, 2, figsize=(14, 7), constrained_layout=True)

    # (a) moisture profiles
    ax = axes[0]
    for label, iy, ix, col in cols:
        ax.plot(st.theta_soil_init[:, iy, ix], centers, color=col, lw=1.2,
                ls='--', alpha=0.75)
        ax.plot(st.theta_soil[:, iy, ix], centers, color=col, lw=2.2,
                label=f"{label}")
    # consistency markers for the valley texture
    s_v = SOIL_TEXTURES[TEXTURE_ORDER[2]]
    rho_dry = 2650.0 * (1.0 - s_v["theta_s"])
    th_ll = s_v["LL"] / 100.0 * rho_dry / 1000.0
    th_pl = s_v["PL"] / 100.0 * rho_dry / 1000.0
    ax.axvline(th_ll, color=RED, lw=1.0, ls=':')
    ax.text(th_ll, 0.98, ' LL (mud)\n', color=RED, fontsize=8.5, va='top')
    ax.axvline(th_pl, color=AMBER, lw=1.0, ls=':')
    ax.text(th_pl, 0.98, ' PL', color=AMBER, fontsize=8.5, va='top')
    ax.set_title("Soil moisture profile: dashed = before, solid = after storm",
                 loc='left')
    ax.set_xlabel(r'$\theta$ [-]')
    ax.set_ylabel('depth [m]')
    ax.set_ylim(1.0, 0.0)
    ax.set_xlim(0.05, 0.52)
    ax.legend(loc='lower right', bbox_to_anchor=(1.02, 0.0))
    _grid(ax)

    # (b) strength profile at the valley column
    ax = axes[1]
    iy, ix = iy_v, ix_v
    st.theta_soil, keep = st.theta_soil_init.copy(), st.theta_soil
    d0, tau0, q0 = engine.geo.strength_profile(ix, iy)
    st.theta_soil = keep
    d1, tau1, q1 = engine.geo.strength_profile(ix, iy)
    ax.plot(tau0, d0, color=SLATE_D, lw=1.2, ls='--')
    ax.plot(tau1, d1, color=CYAN, lw=2.2, label=r'$\tau_f$ (shear strength)')
    ax.plot(q0, d0, color=MUT, lw=1.0, ls=':')
    ax.plot(q1, d1, color=RAIN, lw=2.2, label=r'$q_{ult}$ (bearing, B=0.3 m)')
    drop = 100.0 * (1.0 - q1[0] / max(q0[0], 1e-6))
    ax.set_title(f"Valley column: topsoil bearing capacity lost {drop:.0f}% "
                 "in the storm", loc='left')
    ax.set_xlabel('strength [kPa]')
    ax.set_ylabel('depth [m]')
    ax.set_ylim(1.0, 0.0)
    ax.legend(loc='lower right', bbox_to_anchor=(1.02, 0.0))
    _grid(ax)
    _save(fig, path)


# =========================================================== geotech curves
def fig_geotech_curves(cfg, path):
    """Texture calibration: strength vs moisture, envelopes, retention."""
    storm_style()
    fig, axes = plt.subplots(2, 2, figsize=(14, 9.5), constrained_layout=True)
    colors = {"sandy_loam": SLATE, "loam": AMBER, "silty_clay_loam": CYAN}

    # (a) bearing capacity vs water content
    ax = axes[0, 0]
    for name in TEXTURE_ORDER:
        tex = SOIL_TEXTURES[name]
        w = np.linspace(4.0, tex["LL"] + 14.0, 160)
        r = texture_strength_curve(tex, cfg, w)
        ax.plot(r['w'], r['q_ult'], color=colors[name], lw=2.0,
                label=tex["label"])
        ax.axvline(tex["LL"], color=colors[name], lw=0.8, ls=':', alpha=0.6)
    ax.set_yscale('log')
    ax.set_xlabel('water content w [%]')
    ax.set_ylabel(r'$q_{ult}$ [kPa]')
    ax.set_title("Bearing capacity collapses past the liquid limit (dotted = LL)",
                 loc='left')
    ax.legend(loc='upper right', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)

    # (b) CBR vs water content
    ax = axes[0, 1]
    for name in TEXTURE_ORDER:
        tex = SOIL_TEXTURES[name]
        w = np.linspace(4.0, tex["LL"] + 14.0, 160)
        r = texture_strength_curve(tex, cfg, w)
        ax.plot(r['w'], r['cbr'], color=colors[name], lw=2.0, label=tex["label"])
    ax.set_yscale('log')
    ax.set_xlabel('water content w [%]')
    ax.set_ylabel('CBR [%]')
    ax.set_title("Subgrade strength (CBR) falls 10-100x from dry to muddy",
                 loc='left')
    ax.legend(loc='upper right', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)

    # (c) Mohr-Coulomb envelopes for silty clay loam at 3 wetness states
    ax = axes[1, 0]
    tex = SOIL_TEXTURES["silty_clay_loam"]
    sig = np.linspace(0.0, 100.0, 50)
    for Sr, col, lab in ((0.35, SLATE, 'unsaturated Sr=0.35 (moist)'),
                         (0.75, AMBER, ' Sr=0.75 (wet)'),
                         (1.0, RED, 'saturated Sr=1.0')):
        th = Sr * tex["theta_s"]
        w = 100.0 * th * 1000.0 / (2650.0 * (1.0 - tex["theta_s"]))
        r = texture_strength_curve(tex, cfg, np.array([w]))
        tau = float(r['c_eff'][0]) + sig * np.tan(float(r['phi_eff'][0]) * DEG)
        ax.plot(sig, tau, color=col, lw=2.0, label=lab)
    ax.set_xlabel(r"effective normal stress $\sigma'$ [kPa]")
    ax.set_ylabel(r'shear strength $\tau_f$ [kPa]')
    ax.set_title("Mohr-Coulomb strength envelope vs saturation (silty clay loam)",
                 loc='left')
    ax.legend(loc='upper left', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)

    # (d) soil-water characteristic curves
    ax = axes[1, 1]
    for name in TEXTURE_ORDER:
        tex = SOIL_TEXTURES[name]
        # field capacity / wilting point from the Clapp-Hornberger curve
        theta_fc = tex["theta_s"] * (tex["psi_s_mm"] / 3367.0) ** (1.0 / tex["b"])
        theta_wp = tex["theta_s"] * (tex["psi_s_mm"] / 153000.0) ** (1.0 / tex["b"])
        th = np.linspace(0.9 * theta_wp, tex["theta_s"], 160)
        psi = tex["psi_s_mm"] * (th / tex["theta_s"]) ** (-tex["b"]) * 9.81e-3
        ax.plot(th, psi, color=colors[name], lw=2.0, label=tex["label"])
        ax.plot(theta_fc, tex["psi_s_mm"] * (theta_fc / tex["theta_s"])
                ** (-tex["b"]) * 9.81e-3, 'o', color=colors[name], ms=5)
    ax.set_yscale('log')
    ax.set_xlabel(r'$\theta$ [-]')
    ax.set_ylabel('matric suction [kPa]')
    ax.set_title("Water retention (dots = field capacity, -33 kPa)", loc='left')
    ax.legend(loc='upper right', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)
    _save(fig, path)


# ================================================================ rain DSD
def fig_dsd(path):
    """Marshall-Palmer microphysics: spectra, fall speed, radar, energy."""
    storm_style()
    fig, axes = plt.subplots(2, 2, figsize=(14, 9), constrained_layout=True)
    R_list = [1.0, 5.0, 25.0, 100.0]
    cols = [SLATE_DD, SLATE_D, CYAN, RAIN]

    # (a) drop size spectra
    ax = axes[0, 0]
    D = np.linspace(0.05, 6.0, 300)
    for R, c in zip(R_list, cols):
        N = mp.dsd_N(D, R)
        ax.plot(D, N, color=c, lw=2.0, label=f"R = {R:.0f} mm/h")
    ax.set_yscale('log')
    ax.set_xlabel('drop diameter D [mm]')
    ax.set_ylabel(r'N(D)  [m$^{-3}$ mm$^{-1}$]')
    ax.set_title("Heavier rain: more drops AND bigger drops (Marshall-Palmer)",
                 loc='left')
    ax.legend(loc='upper right', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)

    # (b) terminal velocity
    ax = axes[0, 1]
    D = np.linspace(0.05, 6.0, 300)
    ax.plot(D, mp.terminal_velocity(D), color=RAIN, lw=2.4)
    ax.axhline(9.2, color=MUT, lw=1.0, ls=':')
    ax.text(0.3, 9.35, 'breakup limit 9.2 m/s', color=MUT, fontsize=9)
    ax.set_xlabel('drop diameter D [mm]')
    ax.set_ylabel('fall speed v(D) [m/s]')
    ax.set_title("Terminal velocity: big drops hit the ground first", loc='left')
    _grid(ax)

    # (c) Z-R relation: parameterization vs DSD integral
    ax = axes[1, 0]
    R = np.logspace(-0.5, 2.3, 60)
    ax.plot(R, mp.zr_dbz(R), color=RAIN, lw=2.4,
            label=r'$Z = 200\,R^{1.6}$')
    R_pts = np.array([1.0, 2.0, 5.0, 10.0, 25.0, 50.0, 100.0, 150.0])
    z_pts = [mp.dsd_stats(float(r))['z_dbz'] for r in R_pts]
    ax.plot(R_pts, z_pts, 'o', color=CYAN, ms=6, mec=BG,
            label='DSD integral (engine check)')
    ax.set_xscale('log')
    ax.set_xlabel('rain rate R [mm/h]')
    ax.set_ylabel('radar reflectivity Z [dBZ]')
    ax.set_title("Radar signature of the DSD matches the Z-R law", loc='left')
    ax.legend(loc='upper left', bbox_to_anchor=(0.02, 1.0))
    _grid(ax)

    # (d) kinetic energy
    ax = axes[1, 1]
    R = np.logspace(-0.5, 2.3, 100)
    ke_spec = 0.29 * (1.0 - 0.6 * np.exp(-R / 8.0))
    ax.plot(R, ke_spec, color=AMBER, lw=2.4)
    ax.set_xscale('log')
    ax.set_xlabel('rain rate R [mm/h]')
    ax.set_ylabel(r'KE per rain depth [J m$^{-2}$ mm$^{-1}$]')
    ax.set_title("Raindrop energy saturates near 0.29 J/m$^2$/mm - crusts soil",
                 loc='left')
    _grid(ax)
    _save(fig, path)


# ====================================================== preset comparison
def fig_preset_comparison(engines, path):
    """Side-by-side response of the catchment to different weather."""
    storm_style()
    fig, axes = plt.subplots(2, 2, figsize=(14, 9), constrained_layout=True)
    colors = {n: c for n, c in zip(engines, [SLATE_D, RAIN, CYAN, AMBER])}

    def t(e):
        return _rec(e, 't_h')

    # (a) hyetographs
    ax = axes[0, 0]
    for name, e in engines.items():
        ax.plot(t(e), _rec(e, 'rain_mean'), color=colors[name], lw=2.0,
                label=e.preset["label"])
    ax.set_xlabel('time [h]')
    ax.set_ylabel('mean rain rate [mm/h]')
    ax.set_title("Rain climate of each preset", loc='left')
    ax.legend(loc='upper left', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)

    # (b) topsoil moisture
    ax = axes[0, 1]
    for name, e in engines.items():
        ax.plot(t(e), _rec(e, 'theta1'), color=colors[name], lw=2.0,
                label=e.preset["label"])
    ax.set_xlabel('time [h]')
    ax.set_ylabel(r'topsoil $\theta$ [-]')
    ax.set_title("How fast each storm wets the ground", loc='left')
    _grid(ax)

    # (c) bearing capacity
    ax = axes[1, 0]
    for name, e in engines.items():
        ax.plot(t(e), _rec(e, 'q_ult_mean'), color=colors[name], lw=2.0,
                label=e.preset["label"])
    ax.set_xlabel('time [h]')
    ax.set_ylabel(r'mean $q_{ult}$ [kPa]')
    ax.set_title("Strength loss follows the rain climate", loc='left')
    _grid(ax)

    # (d) cumulative runoff
    ax = axes[1, 1]
    for name, e in engines.items():
        R = np.cumsum(_rec(e, 'outlet_mm_h')) * e.cfg.dt / 3600.0
        ax.plot(t(e), R, color=colors[name], lw=2.0, label=e.preset["label"])
    ax.set_xlabel('time [h]')
    ax.set_ylabel('cumulative runoff [mm]')
    ax.set_title("Runoff generation: infiltration excess in heavy storms",
                 loc='left')
    _grid(ax)
    _save(fig, path)


# =============================================================== animation
def make_gif(engine, path, fps=3):
    """Animated 2x2 storm panel: rain, cloud, ponding, bearing capacity."""
    from matplotlib.animation import FuncAnimation, PillowWriter
    from matplotlib.colors import LogNorm

    storm_style()
    frames = engine.frames
    if len(frames) < 2:
        return
    ext = _ext(engine)
    vmax = lambda key, q: max(float(np.percentile([f[key].max() for f in frames], q)), 1e-6)
    rain_vmax = vmax('rain', 99)
    cloud_vmax = vmax('cloud', 99)
    pond_vmax = vmax('pond', 99)
    q_lo = min(float(np.percentile(f['q_ult'], 2)) for f in frames)
    q_hi = max(float(np.percentile(f['q_ult'], 98)) for f in frames)

    fig, axes = plt.subplots(2, 2, figsize=(11, 10), constrained_layout=True)
    ims = []
    ims.append(axes[0, 0].imshow(frames[0]['rain'], origin='lower', extent=ext,
                                 cmap=CM_RAIN, vmin=0, vmax=rain_vmax))
    axes[0, 0].set_title('rain rate [mm/h]', loc='left', fontsize=11)
    ims.append(axes[0, 1].imshow(frames[0]['cloud'], origin='lower', extent=ext,
                                 cmap=CM_POND, vmin=0, vmax=cloud_vmax))
    axes[0, 1].set_title('cloud water path [g/m$^2$]', loc='left', fontsize=11)
    ims.append(axes[1, 0].imshow(frames[0]['pond'], origin='lower', extent=ext,
                                 cmap=CM_POND, vmin=0, vmax=pond_vmax))
    axes[1, 0].set_title('ponded water [mm]', loc='left', fontsize=11)
    ims.append(axes[1, 1].imshow(frames[0]['q_ult'], origin='lower', extent=ext,
                                 cmap=CM_STRENGTH, norm=LogNorm(
                                     vmin=max(q_lo, 2.0), vmax=max(q_hi, 20.0))))
    axes[1, 1].set_title(r'bearing capacity $q_{ult}$ [kPa]', loc='left',
                         fontsize=11)
    title = fig.suptitle('', color=TEXT, fontsize=14, fontweight='bold')
    for ax in axes.flat:
        ax.set_xlabel('x [km]')
        ax.set_ylabel('y [km]')
        ax.tick_params(labelsize=8)
    for im in ims:
        cb = fig.colorbar(im, ax=im.axes, shrink=0.75, pad=0.05, fraction=0.05)
        cb.ax.tick_params(labelsize=7)
        cb.outline.set_visible(False)

    def update(i):
        f = frames[i]
        ims[0].set_data(f['rain'])
        ims[1].set_data(f['cloud'])
        ims[2].set_data(f['pond'])
        ims[3].set_data(np.maximum(f['q_ult'], 2.0))
        title.set_text(f"{engine.preset['label']}   -   t = {f['t_h']:.1f} h")
        return ims + [title]

    anim = FuncAnimation(fig, update, frames=len(frames), blit=False)
    anim.save(path, writer=PillowWriter(fps=fps), dpi=90)
    plt.close(fig)
    print(f"  [gif] {path}")
