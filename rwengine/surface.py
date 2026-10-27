"""
Surface water: ponding, depression storage, D8 runoff routing.

Water on the ground:
  * rain and routed inflow fill per-cell depression storage
    (micro-roughness + wheel ruts) -> puddles;
  * excess routes to the steepest downhill neighbour (D8) with a
    Manning overland-flow law  q = (1/n) h^(5/3) sqrt(S);
  * domain-edge outlets discharge out of the catchment (hydrograph);
  * local minima of the water surface naturally pond (puddles, including
    ruts, which then re-wet the surrounding soil -- the mud feedback).
"""
import numpy as np

# neighbour offsets: E, W, N, S, NE, NW, SE, SW
_OFFS = np.array([(0, 1), (0, -1), (-1, 0), (1, 0),
                  (-1, 1), (-1, -1), (1, 1), (1, -1)])
_DIST = np.array([1.0, 1.0, 1.0, 1.0, np.sqrt(2), np.sqrt(2), np.sqrt(2), np.sqrt(2)])


class Surface:
    def __init__(self, state, cfg):
        self.st = state
        self.cfg = cfg
        self.outflow_mm = 0.0        # cumulative discharge out of domain (mm, domain-mean)
        self.outlet_rate = 0.0       # mm/h current

    # ------------------------------------------------------------- depression
    def depression_storage(self):
        """Storage depth (m) held against micro-topography and ruts."""
        return self.cfg.micro_dep_storage_mm * 1e-3 + self.st.rut_depth

    # ---------------------------------------------------------------- routing
    def route(self, dt, n_hops=3):
        """
        D8 Manning overland routing.  Water above depression storage moves to
        the steepest downhill neighbour; executed in sub-hops (n_hops per
        step) so puddles spread gradually instead of sloshing.  Outflow at
        each hop is capped at 50% of the mobile water for stability.
        """
        dt_sub = dt / n_hops
        for _ in range(n_hops):
            self._route_once(dt_sub)

    def _route_once(self, dt):
        st, cfg = self.st, self.cfg
        ny, nx = cfg.ny, cfg.nx
        dx = cfg.dx
        area = dx * dx

        z_eff = st.z_sfc + st.h_pond                       # water surface (m)
        dep = self.depression_storage()
        h_flow = np.maximum(st.h_pond - dep, 0.0)          # mobile water (m)

        # ---- steepest descent among 8 neighbours -----------------------------
        best_slope = np.zeros((ny, nx))
        best_dir = np.full((ny, nx), -1, dtype=int)
        for d, (di, dj) in enumerate(_OFFS):
            zs = np.full((ny, nx), np.inf)
            # cells (i,j) whose neighbour (i+di, j+dj) is inside the domain
            ti0, ti1 = max(-di, 0), ny + min(-di, 0)
            tj0, tj1 = max(-dj, 0), nx + min(-dj, 0)
            si0, si1 = max(di, 0), ny + min(di, 0)
            sj0, sj1 = max(dj, 0), nx + min(dj, 0)
            zs[ti0:ti1, tj0:tj1] = z_eff[si0:si1, sj0:sj1]
            slope = (z_eff - zs) / (_DIST[d] * dx)
            better = slope > best_slope
            best_slope = np.where(better, slope, best_slope)
            best_dir = np.where(better, d, best_dir)

        has_recv = (best_dir >= 0) & (best_slope > 1e-6) & (h_flow > 0)
        slope = np.where(has_recv, np.maximum(best_slope, 1e-6), 0.0)

        # ---- Manning overland flux (capped at half the mobile water) ----------
        q_unit = (1.0 / cfg.manning_n) * h_flow ** (5.0 / 3.0) * np.sqrt(slope)  # m2/s
        vol_out = np.minimum(q_unit * dx * dt, 0.5 * h_flow * area)
        h_out = np.where(has_recv, vol_out / area, 0.0)                         # m leaving cell

        # ---- move water: scatter to receivers (vectorised) ---------------------
        inflow = np.zeros((ny, nx))
        out_of_domain = 0.0
        iy, ix = np.nonzero(h_out > 0)
        if iy.size:
            dirs = best_dir[iy, ix]
            ri = iy + _OFFS[dirs, 0]
            rj = ix + _OFFS[dirs, 1]
            inside = (ri >= 0) & (ri < ny) & (rj >= 0) & (rj < nx)
            np.add.at(inflow, (ri[inside], rj[inside]), h_out[iy, ix][inside])
            out_of_domain = float(h_out[iy, ix][~inside].sum()) * area
        st.h_pond = np.maximum(st.h_pond - h_out + inflow, 0.0)
        self.outflow_mm += out_of_domain / (ny * nx * area) * 1000.0
        self.outlet_rate = (out_of_domain / (ny * nx * area) * 1000.0
                            / (dt / 3600.0))
        st.cum_runoff_in += inflow * 1000.0
        return inflow
