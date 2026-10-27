"""
Storm-dark visualization system for the rain & weather engine.

Dark theme follows the "realistic storm" brief: deep navy background,
slate greys, muted rain-blue accents.  Layout rules: max 4 panels per
canvas, constrained_layout everywhere, legends placed outside the axes,
colorbars shrunk with padding, insight-first titles.
"""
import numpy as np
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, LogNorm
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

# ---------------------------------------------------------------- palette
BG = '#0F172A'
TEXT = '#F1F5F9'
MUT = '#94A3B8'
GRID = '#1E293B'
SPINE = '#334155'
RAIN = '#4FA3E0'      # accent rain blue
CYAN = '#7FC8E8'
DEEP = '#1F6FB2'
AMBER = '#D9A05B'
RED = '#C25850'
GREEN = '#7FB89A'
SLATE = '#7FA3C8'
SLATE_D = '#54718F'
SLATE_DD = '#3A5578'

CONSISTENCY_COLORS = {0: '#7FA3C8', 1: '#D9A05B', 2: '#C25850'}
CONSISTENCY_LABELS = {0: 'solid (firm)', 1: 'plastic (soft)', 2: 'liquid (mud)'}


def _cmap(colors):
    return LinearSegmentedColormap.from_list('storm', colors)


CM_RAIN = _cmap(['#0F172A', '#12355A', '#1F6FB2', '#4FA3E0', '#A8D8F5'])
CM_MOIST = _cmap(['#0F172A', '#14403A', '#2E7D6B', '#7FC8A9', '#DFF3E4'])
CM_POND = _cmap(['#0F172A', '#0E4A6E', '#2286B8', '#6FC8E8', '#D6F2FC'])
CM_TERRAIN = _cmap(['#0F172A', '#1A2E4A', '#2E4A6B', '#54718F', '#8FA8C0', '#C9D6E3'])
CM_STRENGTH = _cmap(['#2A1418', '#6E3B2A', '#A8743D', '#D9B36B', '#F5E6C8'])


def storm_style():
    mpl.rcParams.update({
        'figure.facecolor': BG, 'axes.facecolor': BG, 'savefig.facecolor': BG,
        'text.color': TEXT, 'axes.labelcolor': TEXT,
        'xtick.color': MUT, 'ytick.color': MUT,
        'axes.edgecolor': SPINE, 'axes.linewidth': 0.8,
        'axes.spines.top': False, 'axes.spines.right': False,
        'axes.grid': False,
        'xtick.major.size': 0, 'ytick.major.size': 0,
        'xtick.labelsize': 9, 'ytick.labelsize': 9,
        'axes.labelsize': 10, 'axes.titlesize': 12.5,
        'axes.titleweight': 'bold', 'axes.titlepad': 12,
        'axes.titlecolor': TEXT,
        'legend.frameon': False, 'legend.fontsize': 9,
        'legend.labelcolor': TEXT,
        'figure.dpi': 110, 'savefig.dpi': 200,
        'font.sans-serif': ['DejaVu Sans'],
        'axes.unicode_minus': False,
    })


def _grid(ax):
    ax.grid(True, alpha=0.35, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def _save(fig, path):
    fig.savefig(path, facecolor=BG)
    plt.close(fig)
    print(f"  [fig] {path}")


def _ext(engine):
    cfg = engine.cfg
    return (0, cfg.nx * cfg.dx / 1000.0, 0, cfg.ny * cfg.dx / 1000.0)


def _rec(engine, key):
    return np.array([r[key] for r in engine.records])


# ============================================================ time series
def fig_timeseries_hydro(engine, path):
    """Storm hydrology: rain, atmospheric stores, surface water, balance."""
    storm_style()
    t = _rec(engine, 't_h')
    fig, axes = plt.subplots(2, 2, figsize=(14, 9), constrained_layout=True)

    # (a) hyetograph
    ax = axes[0, 0]
    ax.fill_between(t, _rec(engine, 'rain_mean'), color=RAIN, alpha=0.22, zorder=2)
    ax.plot(t, _rec(engine, 'rain_mean'), color=RAIN, lw=2.2, zorder=3)
    ax.plot(t, _rec(engine, 'rain_max'), color=CYAN, lw=1.0, alpha=0.8, zorder=3)
    peak = _rec(engine, 'rain_max').max()
    total = float(engine.state.cum_precip.mean())
    ax.set_title(f"Rain peaks at {peak:.0f} mm/h - domain total {total:.0f} mm",
                 loc='left')
    ax.set_ylabel('rain rate [mm/h]')
    ax.set_ylim(0, max(peak * 1.2, 1.0))
    ax.legend(handles=[Line2D([], [], color=RAIN, lw=2, label='domain mean'),
                       Line2D([], [], color=CYAN, lw=1, label='max cell')],
              loc='upper left', bbox_to_anchor=(0.55, 1.0))
    _grid(ax)

    # (b) atmospheric water stores
    ax = axes[0, 1]
    ax.plot(t, _rec(engine, 'vapor_path'), color=SLATE_D, lw=1.2)
    ax.plot(t, _rec(engine, 'cloud_path'), color=CYAN, lw=1.4)
    ax.plot(t, _rec(engine, 'rain_path'), color=RAIN, lw=2.2)
    cwp_peak = _rec(engine, 'cloud_path').max()
    ax.set_title(f"Cloud water builds to {cwp_peak:.0f} g/m$^2$ at peak", loc='left')
    ax.set_ylabel('column water [mm equiv.]')
    ax.legend(handles=[Line2D([], [], color=SLATE_D, lw=1.2, label='vapour path'),
                       Line2D([], [], color=CYAN, lw=1.4, label='cloud water'),
                       Line2D([], [], color=RAIN, lw=2.2, label='rain water')],
              loc='upper left', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)

    # (c) surface water
    ax = axes[1, 0]
    ax.fill_between(t, _rec(engine, 'pond_mean_mm'), color=CYAN, alpha=0.22)
    ax.plot(t, _rec(engine, 'pond_mean_mm'), color=CYAN, lw=2.0)
    ax.plot(t, _rec(engine, 'pond_max_mm'), color=DEEP, lw=1.0, alpha=0.85)
    ax.plot(t, _rec(engine, 'outlet_mm_h'), color=AMBER, lw=1.4, ls='--')
    pond_pk = _rec(engine, 'pond_max_mm').max()
    ax.set_title(f"Ponding peaks at {pond_pk:.0f} mm; runoff responds after fill-up",
                 loc='left')
    ax.set_ylabel('depth / rate  [mm, mm/h]')
    ax.set_xlabel('time [h]')
    ax.legend(handles=[Line2D([], [], color=CYAN, lw=2, label='ponding mean'),
                       Line2D([], [], color=DEEP, lw=1, label='ponding max'),
                       Line2D([], [], color=AMBER, lw=1.4, ls='--',
                              label='outlet runoff')],
              loc='upper left', bbox_to_anchor=(0.55, 1.0))
    _grid(ax)

    # (d) cumulative water balance
    ax = axes[1, 1]
    bal = engine.water_balance()
    P = float(engine.state.cum_precip.mean())
    E = np.cumsum(_rec(engine, 'evap_mm_h')) * engine.cfg.dt / 3600.0
    R = np.array([0.0])
    # cumulative runoff: integrate outlet rate
    R = np.cumsum(_rec(engine, 'outlet_mm_h')) * engine.cfg.dt / 3600.0
    dS = bal['dS_soil']
    ax.plot(t, np.full_like(t, P), color=RAIN, lw=2.2)
    ax.plot(t, E, color=AMBER, lw=1.6)
    ax.plot(t, R, color=CYAN, lw=1.6)
    ax.axhline(dS, color=MUT, lw=1.2, ls=':')
    share = 100.0 * (P - R[-1] - float(np.mean(engine.state.h_pond)) * 1000.0) / max(P, 1e-6)
    ax.set_title(f"Water balance: {share:.0f}% of rainfall stored in the soil",
                 loc='left')
    ax.set_xlabel('time [h]')
    ax.set_ylabel('cumulative [mm]')
    ax.legend(handles=[Line2D([], [], color=RAIN, lw=2.2, label='precipitation'),
                       Line2D([], [], color=AMBER, lw=1.6, label='evaporation'),
                       Line2D([], [], color=CYAN, lw=1.6, label='runoff (outlet)'),
                       Line2D([], [], color=MUT, lw=1.2, ls=':', label='soil storage change')],
              loc='upper left', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)
    _save(fig, path)


def fig_timeseries_ground(engine, path):
    """Ground response: moisture, bearing capacity, consistency, traffic."""
    storm_style()
    t = _rec(engine, 't_h')
    fig, axes = plt.subplots(2, 2, figsize=(14, 9), constrained_layout=True)

    # (a) soil moisture per layer
    ax = axes[0, 0]
    for key, col, lab in (('theta1', RAIN, '0-10 cm'),
                          ('theta2', SLATE, '10-30 cm'),
                          ('theta3', SLATE_D, '30-60 cm'),
                          ('theta4', SLATE_DD, '60-100 cm')):
        ax.plot(t, _rec(engine, key), color=col, lw=2.0 if key == 'theta1' else 1.3,
                label=lab)
    th1_0 = engine.state.theta_soil_init[0].mean()
    th1 = _rec(engine, 'theta1')[-1]
    ax.set_title(f"Topsoil wets {th1_0:.2f} -> {th1:.2f} volumetric", loc='left')
    ax.set_ylabel(r'volumetric water content $\theta$')
    ax.set_ylim(0.05, 0.55)
    ax.legend(loc='upper left', bbox_to_anchor=(1.02, 1.0))
    _grid(ax)

    # (b) bearing capacity
    ax = axes[0, 1]
    ax.plot(t, _rec(engine, 'q_ult_mean'), color=RAIN, lw=2.2)
    ax.plot(t, _rec(engine, 'q_ult_min'), color=RED, lw=1.4, ls='--')
    q0 = _rec(engine, 'q_ult_mean')[0]
    qm = _rec(engine, 'q_ult_mean')[-1]
    ax.axhline(150.0, color=AMBER, lw=1.2, ls=':')
    ax.text(t[-1], 150.0, ' 150 kPa truck', color=AMBER, fontsize=9, va='center')
    ax.set_title(f"Bearing capacity drops {q0/max(qm,1):.0f}x as ground wets "
                 f"({q0:.0f} -> {qm:.0f} kPa mean)", loc='left')
    ax.set_ylabel(r'$q_{ult}$ [kPa]')
    ax.legend(handles=[Line2D([], [], color=RAIN, lw=2.2, label='domain mean'),
                       Line2D([], [], color=RED, lw=1.4, ls='--', label='weakest cell')],
              loc='upper left', bbox_to_anchor=(0.56, 1.0))
    _grid(ax)

    # (c) consistency states
    ax = axes[1, 0]
    ax.fill_between(t, _rec(engine, 'mud_frac'), color=RED, alpha=0.25)
    ax.plot(t, _rec(engine, 'mud_frac'), color=RED, lw=2.0)
    ax.plot(t, _rec(engine, 'plastic_frac'), color=AMBER, lw=1.6)
    mud_pk = _rec(engine, 'mud_frac').max()
    ax.set_title(f"Mud (liquid consistency) covers up to {100*mud_pk:.0f}% of ground",
                 loc='left')
    ax.set_ylabel('area fraction')
    ax.set_xlabel('time [h]')
    ax.set_ylim(0, 1.05)
    ax.legend(handles=[Line2D([], [], color=RED, lw=2, label='liquid (mud)'),
                       Line2D([], [], color=AMBER, lw=1.6, label='plastic')],
              loc='upper left', bbox_to_anchor=(0.55, 1.0))
    _grid(ax)

    # (d) trafficability / ruts
    ax = axes[1, 1]
    if engine.load_log:
        ax.plot(t, _rec(engine, 'rut_max_mm'), color=SLATE, lw=1.6)
        verdict_col = {'PASSABLE': GREEN, 'MARGINAL (rutting)': AMBER,
                       'BOGGED': RED}
        for L in engine.load_log:
            c = verdict_col.get(L['verdict'], MUT)
            ax.axvline(L['t_h'], color=c, lw=1.2, ls='--', alpha=0.9)
            ax.text(L['t_h'] + 0.06, 4, f"{L['verdict'].split()[0]}\n{L['settlement_m']*100:.0f} cm",
                    color=c, fontsize=8.5, va='bottom')
        ax.set_title(f"Rutting: {engine.records[-1]['rut_max_mm']:.0f} mm after "
                     f"{len(engine.load_log)} traffic passes", loc='left')
        ax.set_ylabel('max rut depth [mm]')
        ax.set_xlabel('time [h]')
        ax.set_ylim(0, max(engine.records[-1]['rut_max_mm'] * 1.35, 60))
    else:
        ax.plot(t, _rec(engine, 'suction_mean'), color=CYAN, lw=2.0)
        ax.set_title("Matric suction in the active zone", loc='left')
        ax.set_ylabel('suction [kPa]')
        ax.set_xlabel('time [h]')
    _grid(ax)
    _save(fig, path)


# ================================================================== maps
def _panel_map(ax, data, title, cmap, ext, label, log=False, vmin=None, vmax=None):
    if log:
        norm = LogNorm(vmin=max(vmin, 1.0), vmax=max(vmax, 10.0))
        im = ax.imshow(data, origin='lower', extent=ext, cmap=cmap, norm=norm,
                       aspect='equal')
    else:
        im = ax.imshow(data, origin='lower', extent=ext, cmap=cmap,
                       vmin=vmin, vmax=vmax, aspect='equal')
    ax.set_title(title, loc='left', fontsize=12)
    ax.set_xlabel('x [km]')
    ax.set_ylabel('y [km]')
    cb = ax.figure.colorbar(im, ax=ax, shrink=0.8, pad=0.06, fraction=0.05)
    cb.set_label(label, color=MUT, fontsize=9)
    cb.ax.tick_params(labelsize=8)
    cb.outline.set_visible(False)
    return im


def fig_maps_storm(engine, path):
    """Final fields: terrain, storm total, cloud, ponding."""
    storm_style()
    st = engine.state
    ext = _ext(engine)
    fig, axes = plt.subplots(2, 2, figsize=(14, 11.5), constrained_layout=True)

    _panel_map(axes[0, 0], st.z_sfc, "Terrain: ridge south, valley north "
               f"({st.z_sfc.max()-st.z_sfc.min():.0f} m relief)",
               CM_TERRAIN, ext, 'elevation [m]')
    _panel_map(axes[0, 1], st.cum_precip,
               f"Storm total: up to {st.cum_precip.max():.0f} mm on windward slopes",
               CM_RAIN, ext, 'precipitation [mm]', vmin=0)
    _panel_map(axes[1, 0], engine.st.column_water_mm(st.q_c),
               f"Residual cloud water at t = {engine.records[-1]['t_h']:.0f} h",
               CM_POND, ext, 'cloud water path [g/m$^2$]', vmin=0)
    _panel_map(axes[1, 1], st.h_pond * 1000.0,
               f"Ponding: {100*np.mean(st.h_pond > 0.002):.0f}% of ground holds water",
               CM_POND, ext, 'ponded depth [mm]', vmin=0)
    _save(fig, path)


def fig_maps_ground(engine, path):
    """Ground response maps: moisture, suction, bearing, consistency + ruts."""
    storm_style()
    st = engine.state
    g = st.geo
    ext = _ext(engine)
    fig, axes = plt.subplots(2, 2, figsize=(14, 11.5), constrained_layout=True)

    _panel_map(axes[0, 0], st.theta_soil[0],
               f"Topsoil moisture: valleys at {st.theta_soil[0].max():.2f} (saturation)",
               CM_MOIST, ext, r'$\theta$ [-]', vmin=0.05)
    _panel_map(axes[0, 1], g['suction_kpa'],
               "Matric suction collapses where the ground is wet",
               CM_STRENGTH, ext, 'suction [kPa]', vmin=0)
    q = g['q_ult_kpa']
    _panel_map(axes[1, 0], q,
               f"Bearing capacity: weakest cells at {q.min():.0f} kPa "
               f"({100*np.mean(q < 150):.0f}% below trafficable)",
               CM_STRENGTH, ext, r'$q_{ult}$ [kPa]', log=True,
               vmin=np.percentile(q, 2), vmax=np.percentile(q, 98))

    # categorical consistency map with rut contours
    ax = axes[1, 1]
    ny, nx = q.shape
    rgb = np.zeros((ny, nx, 3))
    from matplotlib.colors import to_rgb
    for k, col in CONSISTENCY_COLORS.items():
        m = (g['consistency'] == k)
        rgb[m] = to_rgb(col)
    ax.imshow(rgb, origin='lower', extent=ext, aspect='equal')
    if st.rut_depth.max() > 0.01:
        ax.contour(np.linspace(0, ext[1], nx), np.linspace(0, ext[3], ny),
                   st.rut_depth * 100.0, levels=[5.0, 20.0],
                   colors=[TEXT, TEXT], linewidths=[0.8, 1.2], linestyles=['--', '-'])
        ax.text(0.03, 0.96, 'white contours: rut depth 5 / 20 cm',
                transform=ax.transAxes, fontsize=8.5, color=MUT, va='top')
    nmud = 100 * np.mean(g['consistency'] == 2)
    npl = 100 * np.mean(g['consistency'] == 1)
    ax.set_title(f"Soil consistency: {npl:.0f}% plastic, {nmud:.0f}% liquid (mud)",
                 loc='left', fontsize=12)
    ax.set_xlabel('x [km]')
    ax.set_ylabel('y [km]')
    handles = [Patch(facecolor=CONSISTENCY_COLORS[k], label=CONSISTENCY_LABELS[k])
               for k in (0, 1, 2)]
    ax.legend(handles=handles, loc='upper left', bbox_to_anchor=(1.02, 1.0),
              fontsize=9)
    _save(fig, path)
