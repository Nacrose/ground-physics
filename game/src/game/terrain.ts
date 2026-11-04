/**
 * Terrain: 768 m walkable biome world.
 *
 * A NW mountain massif (ridged, ice-capped on the highest peaks) falls into
 * foothills and a central valley; the prevailing SW wind wets its flank
 * (rainforest) and leaves the east basin + NE corner in the lee (desert with
 * longitudinal dunes). The RIVER is born at a tarn (the water source) carved
 * into the massif's SE flank, cuts a channel SE across the valley and exits
 * at the south map edge; its flat lowland reaches grow swamp. The water
 * itself VISIBLY TRAVELS — a flow field (direction + slope-fed vigour) drives
 * downstream crest motion, drifting streaks and rapids foam on the surface —
 * and the bed FINES downstream like a real river: gravel bars in the gorge,
 * noise-dithered gravel-into-sand through the middle reaches, alluvial sand
 * on the lowland bed. Mid elevations
 * carry forest on the wet side, dry grassy hills on the lee; steep ground is
 * rocky. Soils follow biome (loam grass, clay loam rainforest, dune sand
 * desert, muck swamp), and the dirt road still winds through the valley —
 * fording the river where it crosses.
 *
 * The physics contract with the old single-valley world is kept: same node
 * grid, same soil texture tables, road mask semantics, and the spawn meadow
 * stays loam so the QA mud cells keep their references.
 */

export const WORLD_SIZE = 768; // m
export const GRID = 192; // physics cells per side (4 m cells)
export const MESH_SEG = 512; // render mesh segments — 1.5 m quads, smooth shading

// ------------------------------------------------------------------- biomes
export interface BiomeDef {
  key: string;
  label: string;
  /** painterly vertex-tint base colour */
  color: number;
  /** grass blade tint */
  grassColor: number;
  /** grass placement probability (per candidate cell) */
  grassP: number;
  /** grass height scale */
  grassH: number;
  /** broadleaf trees per candidate cell (expected) */
  treeP: number;
  /** conifer trees per candidate cell */
  coniferP: number;
  /** cacti per candidate cell */
  cactusP: number;
}

export const BIOMES: BiomeDef[] = [
  { key: "grassland", label: "GRASSLAND", color: 0xb9985a, grassColor: 0xc8a356, grassP: 0.9, grassH: 1.0, treeP: 0.05, coniferP: 0.0, cactusP: 0.0 },
  { key: "forest", label: "FOREST", color: 0x5e6c40, grassColor: 0x6d7a44, grassP: 0.42, grassH: 1.0, treeP: 0.55, coniferP: 0.28, cactusP: 0.0 },
  { key: "hills", label: "HILLS", color: 0xa89a5e, grassColor: 0xbfae62, grassP: 0.55, grassH: 0.85, treeP: 0.1, coniferP: 0.06, cactusP: 0.0 },
  { key: "rainforest", label: "RAINFOREST", color: 0x3f5e30, grassColor: 0x2f5c26, grassP: 0.95, grassH: 1.55, treeP: 1.0, coniferP: 0.0, cactusP: 0.0 },
  { key: "desert", label: "DESERT", color: 0xd9b57c, grassColor: 0xc7b06a, grassP: 0.05, grassH: 0.45, treeP: 0.0, coniferP: 0.0, cactusP: 0.35 },
  { key: "swamp", label: "SWAMP", color: 0x555237, grassColor: 0x7c8a4e, grassP: 0.62, grassH: 1.85, treeP: 0.12, coniferP: 0.0, cactusP: 0.0 },
  { key: "rocky", label: "ROCKY", color: 0x8d8478, grassColor: 0x9a9160, grassP: 0.16, grassH: 0.6, treeP: 0.02, coniferP: 0.05, cactusP: 0.0 },
  { key: "mountain", label: "MOUNTAIN", color: 0x7d7a74, grassColor: 0x8c8a6c, grassP: 0.05, grassH: 0.5, treeP: 0.0, coniferP: 0.1, cactusP: 0.0 },
  { key: "ice", label: "ICE", color: 0xedf1f4, grassColor: 0xffffff, grassP: 0.0, grassH: 0.3, treeP: 0.0, coniferP: 0.0, cactusP: 0.0 },
  { key: "river", label: "RIVER", color: 0x6b5b44, grassColor: 0x7c8a4e, grassP: 0.0, grassH: 0.8, treeP: 0.0, coniferP: 0.0, cactusP: 0.0 },
];
export const B_GRASSLAND = 0, B_FOREST = 1, B_HILLS = 2, B_RAINFOREST = 3,
  B_DESERT = 4, B_SWAMP = 5, B_ROCKY = 6, B_MOUNTAIN = 7, B_ICE = 8, B_RIVER = 9;

export interface TerrainData {
  /** height (m) on (GRID+1)^2 node grid, row-major, y*=(GRID+1) */
  height: Float32Array;
  soil: Uint8Array; // texture id per GRID^2 cell
  road: Float32Array; // 0..1 road mask per cell
  /** biome id per cell (BIOMES index) */
  biome: Uint8Array;
  /** climate moisture 0..1 per cell (drives init saturation + veg) */
  moisture: Float32Array;
  /** static temperature °C per cell (lapse + south gradient; ice line) */
  tempC: Float32Array;
  /** river channel intensity 0..1 per cell (1 = thalweg) */
  river: Float32Array;
  /** the river's station chain — densified path with post-normalisation bed
   *  heights. The 3-D water ribbon (fx.buildRiver) skins its surface from
   *  this: the water level rides bed + a depth that grows downstream. */
  riverPts: RiverPoint[];
  /** the CURRENT: per-cell world-space flow vector (unit dir × vigour 0..1,
   *  two-component stride) — visual only. Rasterised from the river station
   *  chain (downstream tangent, Manning-ish slope vigour) so the water sheets
   *  can move their wave crests, streaks and foam DOWNSTREAM: a river that
   *  reads as flowing instead of a ribbon ripbling in place. Ponds, the tarn
   *  and dry ground carry no entry (0,0) and keep the wind-ripple look. */
  flow: Float32Array;
  /** per-cell depression cap [m] — river/tarn cells hold real water */
  pondCap: Float32Array;
  /** river source (tarn) cells — the spring discharges here */
  riverIn: Uint8Array;
  /** bare-rock fraction 0..1 per cell (crags: dig refusal, shed rain,
   *  bearing raft — the mountain finally has stone IN the ground) */
  rockFrac: Float32Array;
  /** per-cell soil fractions over SOIL_TEXTURES (6 per cell, sums to 1) —
   *  biome borders blend the pedotransfer instead of switching soils on a
   *  line (Ground builds one mixed SoilTexture per cell from these) */
  soilMix: Float32Array;
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

/** ridged noise 0..1 — crest lines for the massif */
function ridgedNoise(rng: () => number): (x: number, y: number) => number {
  const v = valueNoise(rng);
  return (x: number, y: number) => {
    const r = 1 - Math.abs(v(x, y));
    return Math.pow(Math.max(r, 0), 1.6);
  };
}

export interface RiverPoint { x: number; y: number; s: number; bed: number; w: number; }

/**
 * The river: waypoints from the tarn down to the south map edge, densified
 * with meander noise. The BED PROFILE is adaptive — sampled from the actual
 * terrain lows along the route and forced strictly descending — so the
 * channel is always cut below its surroundings and always flows downhill,
 * whatever the relief it crosses. Width grows downstream.
 */
function buildRiverPath(rng: () => number, height: Float32Array, cell: number): RiverPoint[] {
  const ctrl: Array<[number, number]> = [
    [245, 236], [272, 276], [318, 318], [382, 358], [420, 430],
    [408, 502], [442, 568], [436, 648], [472, 722], [496, 768],
  ];
  // meander jitter at interior control points
  for (let i = 1; i < ctrl.length - 1; i++) {
    ctrl[i][0] += (rng() - 0.5) * 22;
    ctrl[i][1] += (rng() - 0.5) * 16;
  }
  // densify: Catmull-Rom through control points, ~4 m steps
  const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const raw: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1],
      p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.round(segLen / 4));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      raw.push({ x: catmull(p0[0], p1[0], p2[0], p3[0], t), y: catmull(p0[1], p1[1], p2[1], p3[1], t) });
    }
  }
  raw.push({ x: ctrl[ctrl.length - 1][0], y: ctrl[ctrl.length - 1][1] });

  // adaptive monotone bed: each sample sits below its local terrain low AND
  // below the previous sample (strict descent — water always has a way out)
  const pts: RiverPoint[] = [];
  let s = 0, prevBed = Infinity;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) s += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    const u = Math.min(s / 900, 1);
    const w = 8.5 + 7.5 * u; // half-width: 8.5 m mountain gorge -> 16 m lowland
    // local terrain low in a disc of 2.2 channel widths
    let localLow = Infinity;
    const R = w * 2.2;
    const i0 = Math.max(0, Math.floor((raw[i].x - R) / cell)), i1 = Math.min(GRID, Math.ceil((raw[i].x + R) / cell));
    const j0 = Math.max(0, Math.floor((raw[i].y - R) / cell)), j1 = Math.min(GRID, Math.ceil((raw[i].y + R) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let ii = i0; ii <= i1; ii++) {
        const dx = ii * cell - raw[i].x, dy = j * cell - raw[i].y;
        if (dx * dx + dy * dy <= R * R) localLow = Math.min(localLow, height[j * (GRID + 1) + ii]);
      }
    }
    let bed = Math.min(prevBed - 0.16, localLow - 2.4);
    bed = Math.max(bed, -20); // absolute guard (pre-normalisation)
    prevBed = bed;
    pts.push({ x: raw[i].x, y: raw[i].y, s, bed, w });
  }
  return pts;
}

export function buildTerrain(seed = 7): TerrainData {
  const rng = mulberry32(seed);
  const n1 = valueNoise(rng), n2 = valueNoise(rng), n3 = valueNoise(rng), n4 = valueNoise(rng);
  const r1 = ridgedNoise(rng), r2 = ridgedNoise(rng);
  const S = WORLD_SIZE;

  const height = new Float32Array((GRID + 1) * (GRID + 1));
  const cell = S / GRID;

  // ---- 1) base relief -------------------------------------------------------
  // the east desert basin mask (dune terrain), and a slightly wider lee mask
  // for climate dryness (the dry ring around the dunes is flat sand plain)
  const desertMaskAt = (x: number, y: number) =>
    Math.exp(-((((x - 620) / 190) ** 2) + (((y - 330) / 230) ** 2)) * 1.4);
  const leeMaskAt = (x: number, y: number) =>
    Math.exp(-((((x - 620) / 150) ** 2) + (((y - 330) / 180) ** 2)) * 1.4);
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const x = i * cell, y = j * cell;
      let z = 0;
      // fractal base (4 octaves)
      z += 8.0 * n1(x / 110, y / 110) + 4.2 * n2(x / 55, y / 55)
        + 2.0 * n3(x / 27, y / 27) + 0.9 * n4(x / 13, y / 13);
      // regional tilt: NW high, SE low
      z += 14 * (1 - (x + y) / (2 * S));
      // NW mountain massif: ridged dome, ~100 m peaks
      const mArg = ((x - 190) / 150) ** 2 + ((y - 168) / 175) ** 2;
      const massif = Math.exp(-mArg * 1.15);
      z += 100 * massif * (0.38 + 0.62 * (0.5 * r1(x / 62, y / 62) + 0.5 * r2(x / 31, y / 31)));
      // north ridge extension (the rain wall that dries the east basin)
      const nrArg = ((x - 330) / 190) ** 2 + ((y - 95) / 95) ** 2;
      z += 46 * Math.exp(-nrArg * 1.2) * (0.5 + 0.5 * r1(x / 48 + 7, y / 48));
      // southern hill belt (rolling, dry) — flanking, never ON, the river
      z += 26 * Math.exp(-(((x - 575) / 150) ** 2 + ((y - 555) / 125) ** 2)) * (0.55 + 0.45 * n2(x / 41 + 3, y / 41));
      z += 16 * Math.exp(-(((x - 250) / 130) ** 2 + ((y - 615) / 120) ** 2));
      // east desert basin: flatten toward a sand plain + longitudinal dunes
      const desert = desertMaskAt(x, y);
      if (desert > 0.01) {
        const dune = 1.9 * Math.sin((x - y) * 0.105 + 3.2 * n3(x / 95 + 11, y / 95))
          + 0.8 * n4(x / 26 + 5, y / 26);
        z = z * (1 - desert * 0.82) + (5.2 + dune) * desert * 0.82;
      }
      height[j * (GRID + 1) + i] = z;
    }
  }

  // ---- 2) the tarn (river source): bowl carved into the massif flank -------
  const TARN = { x: 245, y: 236, R: 15, elev: 58 };
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const x = i * cell, y = j * cell;
      const d = Math.hypot(x - TARN.x, y - TARN.y);
      if (d < TARN.R) {
        const bowl = TARN.elev + 2.4 * ((d / TARN.R) ** 2 - 1);
        const k = j * (GRID + 1) + i;
        height[k] = Math.min(height[k], bowl);
      }
    }
  }

  // ---- 3) the river: adaptive profile, then carve deep 3D gorge + banks ---
  const river = buildRiverPath(rng, height, cell);
  for (const p of river) {
    const w = p.w;
    const i0 = Math.max(0, Math.floor((p.x - w * 2.6) / cell)), i1 = Math.min(GRID, Math.ceil((p.x + w * 2.6) / cell));
    const j0 = Math.max(0, Math.floor((p.y - w * 2.6) / cell)), j1 = Math.min(GRID, Math.ceil((p.y + w * 2.6) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * cell, y = j * cell;
        const d = Math.hypot(x - p.x, y - p.y);
        if (d > w * 2.6) continue;
        const k = j * (GRID + 1) + i;
        if (d < w) {
          // Deep 3D riverbed: carved 2.4m below bank profile (thalweg)
          const bed = p.bed - 2.4 * (1 - (d / w) ** 2);
          height[k] = Math.min(height[k], bed);
        } else {
          // Crisp steep canyon banks rising from riverbed up to surrounding terrain
          const t = (d - w) / (1.6 * w);
          const shoulder = p.bed + (d - w) * 0.90;
          height[k] = height[k] * t + Math.min(height[k], shoulder) * (1 - t);
        }
      }
    }
  }
  // floodplain: the low reach — the valley floor follows the river
  for (const p of river) {
    if (p.bed > 26) continue;
    const R = 68;
    const i0 = Math.max(0, Math.floor((p.x - R) / cell)), i1 = Math.min(GRID, Math.ceil((p.x + R) / cell));
    const j0 = Math.max(0, Math.floor((p.y - R) / cell)), j1 = Math.min(GRID, Math.ceil((p.y + R) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * cell, y = j * cell;
        const d = Math.hypot(x - p.x, y - p.y);
        if (d > R) continue;
        const k = j * (GRID + 1) + i;
        const blend = 0.5 * Math.exp(-(d - p.w) / 40);
        const plain = Math.min(height[k], p.bed + 2.6 + 0.8 * n4(x / 30, y / 30));
        height[k] = height[k] * (1 - blend) + plain * blend;
      }
    }
  }

  // ---- 4) the road: flatten AFTER the river so it fords the channel --------
  const road = new Float32Array(GRID * GRID);
  const roadY = roadCenterY;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      const dy = Math.abs(y - roadY(x));
      const r = Math.max(0, 1 - dy / 9.0); // 9 m half-width, soft edges
      road[j * GRID + i] = Math.min(r * 1.6, 1);
      if (r > 0) {
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
  // station beds: update with the actual ground height at (p.x, p.y) after all carving,
  // roads, floodplain, and normalisation so river stations are 100% anchored to the real terrain
  for (const p of river) {
    p.bed = sampleHeight({ height, minY: 0, maxY } as any, p.x, p.y);
  }

  // ---- 5) per-cell fields: elevation, slope, river mask, distance ---------
  const cellH = new Float32Array(GRID * GRID);
  const slope = new Float32Array(GRID * GRID);
  const riverMask = new Float32Array(GRID * GRID);
  const riverDist = new Float32Array(GRID * GRID).fill(1e9);
  const tarnMask = new Float32Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i;
      const h00 = height[j * (GRID + 1) + i], h10 = height[j * (GRID + 1) + i + 1];
      const h01 = height[(j + 1) * (GRID + 1) + i], h11 = height[(j + 1) * (GRID + 1) + i + 1];
      const h = (h00 + h10 + h01 + h11) / 4;
      cellH[k] = h;
      // steepest gradient across the cell's corners (max descent proxy)
      let smax = 0;
      smax = Math.max(smax, Math.abs(h00 - h10) / cell);
      smax = Math.max(smax, Math.abs(h00 - h01) / cell);
      smax = Math.max(smax, Math.abs(h10 - h11) / cell);
      smax = Math.max(smax, Math.abs(h01 - h11) / cell);
      slope[k] = smax;
    }
  }
  // river mask + distance field (samples are ~4 m apart — direct eval).
  // riverS carries the along-path position of the NEAREST station, so the
  // soil build can fine the bed DOWNSTREAM (rocky gorge -> gravel bars ->
  // alluvial sand) by position along the water, not by absolute elevation.
  // The upper-middle reaches also stamp GRAVEL: a gravel halo of bars and
  // banks around the gorge reach of the channel.
  const gravelMask = new Float32Array(GRID * GRID);
  const riverS = new Float32Array(GRID * GRID).fill(-1);
  const sMax = river.length ? river[river.length - 1].s : 1;
  for (const p of river) {
    const R = Math.max(p.w * 2.6, 14);
    const gR = p.s < sMax * 0.45 ? Math.max(p.w * 2.6, 16) : 0; // gravel halo — upper-middle reaches
    const i0 = Math.max(0, Math.floor((p.x - R) / cell)), i1 = Math.min(GRID - 1, Math.ceil((p.x + R) / cell));
    const j0 = Math.max(0, Math.floor((p.y - R) / cell)), j1 = Math.min(GRID - 1, Math.ceil((p.y + R) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * GRID + i;
        const d = Math.hypot((i + 0.5) * cell - p.x, (j + 0.5) * cell - p.y);
        if (d < riverDist[k]) { riverDist[k] = d; riverS[k] = p.s; }
        if (d < p.w) riverMask[k] = Math.max(riverMask[k], 1 - (d / p.w) ** 2 * 0.55);
        if (gR > 0 && d < gR) gravelMask[k] = Math.max(gravelMask[k], 1 - d / gR);
      }
    }
  }
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i;
      const d = Math.hypot((i + 0.5) * cell - TARN.x, (j + 0.5) * cell - TARN.y);
      if (d < TARN.R + 3) tarnMask[k] = Math.max(0, 1 - d / (TARN.R + 3));
    }
  }

  // ---- 5b) the flow field: where the water visibly MOVES -------------------
  // Rasterised from the station chain (visual only — the physics routes its
  // own water). Direction = downstream tangent; vigour = station bed slope
  // through a Manning-ish sqrt scaling, so the gorge rages (~0.9) and the
  // lowland glides (~0.2). Thalweg carries the current; bank margins trail
  // off to still water. One 3×3 soften removes station-to-station tangent
  // jitter, and the tarn is damped back to near-still (a lake with a drift).
  const flow = new Float32Array(GRID * GRID * 2);
  for (let si = 0; si < river.length - 1; si++) {
    const a = river[si], b = river[si + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const ds = Math.hypot(dx, dy) || 1;
    const S = Math.max(a.bed - b.bed, 0) / ds; // station bed slope
    // floor 0.45: even the flattest reach drifts visibly (~1 m/s of pattern
    // motion) — a river that only moves where it's steep reads as ponds in a
    // row; the gorge rides the cap at 1.0
    const spd = Math.max(0.45, Math.min(0.45 + (S - 0.03) * 9, 1));
    const R = a.w * 1.35;
    const i0 = Math.max(0, Math.floor((a.x - R) / cell)), i1 = Math.min(GRID - 1, Math.ceil((a.x + R) / cell));
    const j0 = Math.max(0, Math.floor((a.y - R) / cell)), j1 = Math.min(GRID - 1, Math.ceil((a.y + R) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * GRID + i;
        const d = Math.hypot((i + 0.5) * cell - a.x, (j + 0.5) * cell - a.y);
        if (d > R) continue;
        const lat = 1 - Math.min(d / a.w, 1) ** 2 * 0.85;
        const v = spd * lat;
        // MAX-wins write: a meander's far-side station stamps this cell later
        // at a bigger d — overwriting would erase the thalweg's own stronger
        // stamp (the flow must not fade wherever the channel bends)
        const cur = Math.hypot(flow[k * 2], flow[k * 2 + 1]);
        if (v > cur) {
          flow[k * 2] = (dx / ds) * v;
          flow[k * 2 + 1] = (dy / ds) * v;
        }
      }
    }
  }
  {
    // soften the DIRECTION (station-to-station tangent jitter) but keep the
    // magnitude as a local MAX — a mean would average a narrow thalweg away
    // into its dry neighbours (a 1-2 cell channel reading 0.03 everywhere
    // was exactly that: the river must stay vigorous where it IS vigorous)
    const tmp = flow.slice();
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        let sx = 0, sy = 0, sm = 0, mx = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || ii >= GRID || jj < 0 || jj >= GRID) continue;
            const kk = jj * GRID + ii;
            const vx = tmp[kk * 2], vy = tmp[kk * 2 + 1];
            const m = Math.hypot(vx, vy);
            sx += vx; sy += vy; sm += m;
            if (m > mx) mx = m;
          }
        }
        const k = j * GRID + i;
        if (sm > 1e-4) {
          const inv = mx / (Math.hypot(sx, sy) || 1); // weighted dir, local-max speed
          flow[k * 2] = sx * inv;
          flow[k * 2 + 1] = sy * inv;
        } else {
          flow[k * 2] = 0;
          flow[k * 2 + 1] = 0;
        }
        // the tarn sits still (a lake with a drift, not a current)
        const still = 1 - 0.92 * tarnMask[k];
        flow[k * 2] *= still;
        flow[k * 2 + 1] *= still;
      }
    }
  }

  // ---- 6) climate: temperature (lapse) + moisture (windward/lee/river) ----
  const tempC = new Float32Array(GRID * GRID);
  const moisture = new Float32Array(GRID * GRID);
  // orographic term: uphill component along the wind (blowing toward NE),
  // gated by local steepness — slopes rain out, flats hardly feel it
  const oro = new Float32Array(GRID * GRID);
  const WX = Math.SQRT1_2, WY = -Math.SQRT1_2; // wind blows toward NE
  for (let j = 1; j < GRID - 1; j++) {
    for (let i = 1; i < GRID - 1; i++) {
      const k = j * GRID + i;
      const gx = (cellH[j * GRID + i + 1] - cellH[j * GRID + i - 1]) / (2 * cell);
      const gy = (cellH[(j + 1) * GRID + i] - cellH[(j - 1) * GRID + i]) / (2 * cell);
      oro[k] = WX * gx + WY * gy;
    }
  }
  // heavy separable blur of the orographic field (mountain-scale)
  const oroB = new Float32Array(GRID * GRID);
  {
    const tmp = new Float32Array(GRID * GRID);
    const R = 9;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        let s = 0, c = 0;
        for (let d = -R; d <= R; d++) {
          const ii = i + d;
          if (ii >= 0 && ii < GRID) { s += oro[j * GRID + ii]; c++; }
        }
        tmp[j * GRID + i] = s / c;
      }
    }
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        let s = 0, c = 0;
        for (let d = -R; d <= R; d++) {
          const jj = j + d;
          if (jj >= 0 && jj < GRID) { s += tmp[jj * GRID + i]; c++; }
        }
        oroB[j * GRID + i] = s / c;
      }
    }
  }
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i;
      const h = cellH[k];
      tempC[k] = 24 - 0.225 * h + 5.5 * (j / GRID - 0.5);
      const swBase = 1 - (i + j) / (2 * GRID); // SW corner 1 -> NE corner 0
      // windward lift to +0.5; leeward dryness capped at -0.3 (the shadow
      // exists but the diagonal gradient carries most of the moisture story)
      const oroT = Math.max(-0.3, Math.min(oroB[k] * 3.2, 0.5)) * Math.min(slope[k] * 4, 1);
      const nearRiver = Math.exp(-Math.min(riverDist[k], 400) / 38);
      const noiseM = 0.09 * n1(((i + 0.5) * cell) / 90, ((j + 0.5) * cell) / 90);
      const leeDry = 0.5 * leeMaskAt((i + 0.5) * cell, (j + 0.5) * cell);
      let m = 0.26 + 0.38 * swBase + 0.42 * oroT + 0.22 * nearRiver + noiseM - leeDry;
      moisture[k] = Math.max(0.02, Math.min(m, 1));
    }
  }

  // ---- 7) biomes ------------------------------------------------------------
  const biome = new Uint8Array(GRID * GRID);
  for (let k = 0; k < GRID * GRID; k++) {
    const h = cellH[k], sl = slope[k], m = moisture[k], t = tempC[k];
    let b: number;
    if (t < 1.5) b = B_ICE;
    else if (h > 58) b = B_MOUNTAIN;
    else if (riverMask[k] > 0.12 || tarnMask[k] > 0.25) b = B_RIVER;
    else if (m > 0.45 && sl < 0.075 && h < 20 && riverDist[k] < 42) b = B_SWAMP;
    else if (m < 0.22) b = B_DESERT;
    else if (m > 0.66 && t > 16 && h < 38 && sl < 0.8) b = B_RAINFOREST;
    else if (sl > 0.5) b = B_ROCKY;
    else if (h >= 30) b = m > 0.42 ? B_FOREST : B_HILLS;
    else b = B_GRASSLAND;
    biome[k] = b;
  }

  // ---- 8) soils by biome (with river-bank alluvium + road borrow) ----------
  const soil = new Uint8Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const k = j * GRID + i;
      const b = biome[k], m = moisture[k], h = cellH[k];
      switch (b) {
        case B_GRASSLAND: soil[k] = m < 0.38 ? 0 : 1; break;
        case B_FOREST: soil[k] = h > 46 ? 0 : 1; break;
        case B_HILLS: soil[k] = 0; break;
        case B_RAINFOREST: soil[k] = 2; break;
        case B_DESERT: soil[k] = 3; break;
        case B_SWAMP: soil[k] = 4; break;
        case B_ROCKY: soil[k] = 0; break;
        case B_MOUNTAIN: soil[k] = 0; break;
        case B_ICE: soil[k] = 0; break;
        default: soil[k] = 1; break; // river bed: alluvial loam
      }
      // river banks get loam alluvium regardless of biome; the upper-middle
      // reaches carry gravel bars and banks instead — stone in and around the
      // river itself. Order matters: the alluvium cap below runs first, the
      // bed-fining override AFTER it (a min(soil,1) cap would otherwise
      // flatten the gravel back to loam)
      if (riverMask[k] > 0.05 || (riverDist[k] < 12 && b !== B_ICE)) soil[k] = Math.min(soil[k], 1);
      if (gravelMask[k] > 0.12) soil[k] = 5;
      // scree fans at the foot of the steep dry slopes — gravelly colluvium
      // (patches wide enough that their interiors stay PURE gravel past the
      // 5×5 soil blend — the inspector can actually show "Gravel")
      else if (b === B_ROCKY && slope[k] > 0.5 && h < 42 && n3(((i + 0.5) * cell) / 26, ((j + 0.5) * cell) / 26) > 0.1) soil[k] = 5;
      // river bed: DOWNSTREAM FINING ALONG THE CHANNEL — position along the
      // water, not absolute elevation. The mountain reach is a rocky gravel
      // gorge, gravel bars fade out through the middle reaches (noise-dithered
      // so bars finger into the sand), and the lowland bed is clean alluvial
      // sand. The 5×5 soil mix feathers each pedotransfer across the bands
      if (riverMask[k] > 0.2 && riverS[k] >= 0) {
        const f = riverS[k] / sMax;
        const dith = n3(((i + 0.5) * cell) / 22, ((j + 0.5) * cell) / 22);
        if (f < 0.5) soil[k] = 5;                                  // rocky gravel gorge
        else if (f < 0.75) soil[k] = dith > (f - 0.5) / 0.25 ? 5 : 3; // bars fade into sand
        else soil[k] = 3;                                          // alluvial sand bed
      }
      // the tarn shore: glacial till — a patchy gravel ring at the waterline
      // (bouldery cirque shore, not mud)
      if (tarnMask[k] > 0.1 && tarnMask[k] < 0.52
        && n3(((i + 0.5) * cell) / 18, ((j + 0.5) * cell) / 18) > -0.08) soil[k] = 5;
      // the dirt road is built on better-draining loam borrow material
      if (road[k] > 0.35) soil[k] = 1;
      // the settler's meadow at the road's west end (the spawn): cleared
      // loam ground so the walk-in QA cells keep their soil references
      const dSp = Math.hypot((i + 0.5) * cell - 20, (j + 0.5) * cell - roadY(20));
      if (dSp < 48) soil[k] = 1;
    }
  }

  // ---- 9) pond caps + the spring --------------------------------------------
  const pondCap = new Float32Array(GRID * GRID).fill(0.25);
  const riverIn = new Uint8Array(GRID * GRID);
  for (let k = 0; k < GRID * GRID; k++) {
    if (riverMask[k] > 0.15) pondCap[k] = 0.55;
    if (tarnMask[k] > 0.35) { pondCap[k] = 1.6; riverIn[k] = 1; }
  }

  // ---- 10) bare-rock fraction: the crags finally have stone IN the ground -
  // rocky scree steepens into bare rock; the massif goes bare with height;
  // the ice cap rides on rock. Everything else keeps its soil mantle.
  const rockFrac = new Float32Array(GRID * GRID);
  for (let k = 0; k < GRID * GRID; k++) {
    const b = biome[k], h = cellH[k], sl = slope[k];
    let r = 0;
    if (b === B_ROCKY) r = 0.45 + 0.55 * Math.min(Math.max((sl - 0.5) / 0.45, 0), 1);
    else if (b === B_MOUNTAIN) r = Math.min(Math.max((sl - 0.35) / 0.35, 0), 1) * Math.min(Math.max((h - 45) / 30, 0), 1);
    else if (b === B_ICE) r = 0.8 * Math.min(Math.max((sl - 0.3) / 0.3, 0), 1) + 0.2;
    // the gorge channel keeps some gravel-on-rock honesty too — and the
    // UPPER reach (first 30% of the path, right below the tarn) runs rocky:
    // bedrock shoals glare through the clear rushing water
    if (gravelMask[k] > 0.6) r = Math.max(r, 0.25);
    if (riverMask[k] > 0.3 && riverS[k] >= 0 && riverS[k] < sMax * 0.3) {
      r = Math.max(r, 0.28 + 0.27 * (1 - (riverS[k] / (sMax * 0.3))));
    }
    rockFrac[k] = Math.min(r, 1);
  }

  // ---- 11) soil fractions: 5×5 blur of the soil map, one channel per
  // texture — biome borders BLEND the pedotransfer instead of switching on
  // a line (interior cells collapse back to their pure base texture)
  const NS = 6;
  const soilMix = new Float32Array(GRID * GRID * NS);
  {
    const tmp = new Float32Array(GRID * GRID * NS);
    for (let k = 0; k < GRID * GRID; k++) tmp[k * NS + soil[k]] = 1;
    // separable box blur, radius 2 (5×5), edge-clamped
    const R = 2;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        for (let s = 0; s < NS; s++) {
          let acc = 0, c = 0;
          for (let d = -R; d <= R; d++) {
            const ii = i + d;
            if (ii < 0 || ii >= GRID) continue;
            acc += tmp[j * GRID * NS + ii * NS + s]; c++;
          }
          soilMix[(j * GRID + i) * NS + s] = acc / c;
        }
      }
    }
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        for (let s = 0; s < NS; s++) {
          let acc = 0, c = 0;
          for (let d = -R; d <= R; d++) {
            const jj = j + d;
            if (jj < 0 || jj >= GRID) continue;
            acc += soilMix[(jj * GRID + i) * NS + s]; c++;
          }
          soilMix[(j * GRID + i) * NS + s] = acc / c;
        }
      }
    }
    // renormalise (edge clamping loses a little mass)
    for (let k = 0; k < GRID * GRID; k++) {
      let sum = 0;
      for (let s = 0; s < NS; s++) sum += soilMix[k * NS + s];
      if (sum > 0) for (let s = 0; s < NS; s++) soilMix[k * NS + s] /= sum;
    }
  }

  return { height, soil, road, biome, moisture, tempC, river: riverMask, riverPts: river, pondCap, riverIn, rockFrac, soilMix, flow, minY: 0, maxY };
}

/** the valley road's centreline — ONE definition shared by the terrain
 *  build, the wagon park and the player spawn (they must agree) */
export function roadCenterY(x: number): number {
  return WORLD_SIZE * (0.44 + 0.07 * Math.sin((x / WORLD_SIZE) * Math.PI * 1.5 + 0.3));
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
