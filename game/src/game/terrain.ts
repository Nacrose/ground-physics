/**
 * Terrain: 768 m walkable catchment generated the same way as rwengine's
 * state.py (regional rise + Gaussian ridge/valley/hills + spectral noise),
 * with soil texture zones by elevation quantiles and a winding dirt road
 * through the valley floor (the trafficability stage).
 */

export const WORLD_SIZE = 768; // m
export const GRID = 192; // physics cells per side (4 m cells)
export const MESH_SEG = 256; // render mesh segments

export interface TerrainData {
  /** height (m) on (GRID+1)^2 node grid, row-major, y*=(GRID+1) */
  height: Float32Array;
  soil: Uint8Array; // texture id per GRID^2 cell
  road: Float32Array; // 0..1 road mask per cell
  minY: number;
  maxY: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** smooth value noise */
function valueNoise(rng: () => number): (x: number, y: number) => number {
  const N = 64;
  const g = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) g[i] = rng() * 2 - 1;
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const idx = (xx: number, yy: number) => g[((yy % N + N) % N) * N + ((xx % N + N) % N)];
    const a = idx(xi, yi), b = idx(xi + 1, yi), c = idx(xi, yi + 1), d = idx(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

export function buildTerrain(seed = 7): TerrainData {
  const rng = mulberry32(seed);
  const n1 = valueNoise(rng), n2 = valueNoise(rng), n3 = valueNoise(rng);
  const S = WORLD_SIZE;

  // rwengine terrain recipe, rescaled from 64 km to 768 m
  const gauss = (x: number, y: number, cx: number, cy: number, sx: number, sy: number) =>
    Math.exp(-((x - cx) ** 2) / (2 * sx * sx) - ((y - cy) ** 2) / (2 * sy * sy));

  const height = new Float32Array((GRID + 1) * (GRID + 1));
  const cell = S / GRID;
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const x = i * cell, y = j * cell;
      let z = 0;
      z += 9.0 * (x / S) - 4.5; // regional west→east rise
      z += 11.0 * gauss(x, y, S * 0.5, S * 0.78, 120, 170); // southern ridge
      z -= 5.5 * gauss(x, y, S * 0.5, S * 0.30, 110, 200); // northern valley axis
      z += 7.0 * gauss(x, y, S * 0.33, S * 0.45, 90, 80); // western hill
      z += 5.0 * gauss(x, y, S * 0.72, S * 0.42, 100, 85); // eastern hill
      // the clay bank — a steep little knoll north of the road bend (45 m off
      // the corridor, clear of the wagon story): the one piece of ground steep
      // enough to drive an adit into (~17° flanks vs the ≤10° regional slopes)
      z += 4.5 * gauss(x, y, S * 0.3125, S * 0.4297, 11, 9);
      // fractal detail (3 octaves)
      z += 1.6 * n1(x / 96, y / 96) + 0.8 * n2(x / 48, y / 48) + 0.4 * n3(x / 24, y / 24);
      height[j * (GRID + 1) + i] = z;
    }
  }
  // flatten the road corridor BEFORE normalising
  const road = new Float32Array(GRID * GRID);
  // road: sine curve roughly following the valley, west→east
  const roadY = (x: number) => S * (0.30 + 0.08 * Math.sin((x / S) * Math.PI * 1.7 + 0.4));
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      const dy = Math.abs(y - roadY(x));
      const r = Math.max(0, 1 - dy / 9.0); // 9 m half-width, soft edges
      road[j * GRID + i] = Math.min(r * 1.6, 1);
      if (r > 0) {
        // pull terrain toward the local road centre height
        const ci = i, cj = Math.max(0, Math.min(GRID, Math.round(roadY(x) / cell - 0.5)));
        const ch = height[Math.min(GRID, cj) * (GRID + 1) + Math.min(GRID, ci)];
        const k = 0.55 * Math.min(r * 1.6, 1);
        const idxs = [j * (GRID + 1) + i, j * (GRID + 1) + i + 1, (j + 1) * (GRID + 1) + i, (j + 1) * (GRID + 1) + i + 1];
        for (const idxx of idxs) height[idxx] = height[idxx] * (1 - k) + ch * k;
      }
    }
  }

  let mn = Infinity, mx = -Infinity;
  for (const z of height) { mn = Math.min(mn, z); mx = Math.max(mx, z); }
  for (let k = 0; k < height.length; k++) height[k] -= mn;
  const maxY = mx - mn;

  // soil texture by elevation quantiles (valley clay, slope loam, upland sand)
  const cellH = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const h = (height[j * (GRID + 1) + i] + height[j * (GRID + 1) + i + 1] +
        height[(j + 1) * (GRID + 1) + i] + height[(j + 1) * (GRID + 1) + i + 1]) / 4;
      cellH[j * GRID + i] = h;
    }
  }
  const sorted = Float32Array.from(cellH).sort();
  const q30 = sorted[Math.floor(0.3 * sorted.length)];
  const q70 = sorted[Math.floor(0.7 * sorted.length)];
  const soil = new Uint8Array(GRID * GRID);
  for (let k = 0; k < cellH.length; k++) {
    soil[k] = cellH[k] < q30 ? 2 : cellH[k] < q70 ? 1 : 0;
    // the dirt road is built on better-draining loam borrow material
    if (road[k] > 0.35) soil[k] = 1;
  }
  return { height, soil, road, minY: 0, maxY };
}

/** bilinear height sampling in world coords */
export function sampleHeight(t: TerrainData, x: number, y: number): number {
  const cell = WORLD_SIZE / GRID;
  const fx = Math.max(0, Math.min(GRID - 1e-6, x / cell));
  const fy = Math.max(0, Math.min(GRID - 1e-6, y / cell));
  const i = Math.floor(fx), j = Math.floor(fy);
  const u = fx - i, v = fy - j;
  const h = t.height;
  const h00 = h[j * (GRID + 1) + i], h10 = h[j * (GRID + 1) + i + 1];
  const h01 = h[(j + 1) * (GRID + 1) + i], h11 = h[(j + 1) * (GRID + 1) + i + 1];
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}

/** terrain normal via central differences */
export function terrainNormal(t: TerrainData, x: number, y: number, out: [number, number, number]): void {
  const e = 1.5;
  const dx = sampleHeight(t, x + e, y) - sampleHeight(t, x - e, y);
  const dy = sampleHeight(t, x, y + e) - sampleHeight(t, x, y - e);
  const nx = -dx, ny = -dy, nz = 2 * e;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
}

/** world-coords (−HALF..HALF) → cell index */
export function cellIndex(x: number, y: number): number {
  const cell = WORLD_SIZE / GRID;
  const i = Math.max(0, Math.min(GRID - 1, Math.floor((x + WORLD_SIZE / 2) / cell)));
  const j = Math.max(0, Math.min(GRID - 1, Math.floor((y + WORLD_SIZE / 2) / cell)));
  return j * GRID + i;
}

export function cellToWorld(k: number): [number, number] {
  const cell = WORLD_SIZE / GRID;
  const j = Math.floor(k / GRID), i = k % GRID;
  return [(i + 0.5) * cell, (j + 0.5) * cell];
}
