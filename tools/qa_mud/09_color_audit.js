// 09_color_audit.js — quantify the GROUND COLOR by moisture state.
// Ports the EXACT static-mesh fragment chain (vertex tint -> mudSurface
// -> road -> pond) to JS, evaluates it on every real physics cell, and
// reports mean albedo per moisture state. EXPECTED ordering after the
// fix: DRY > OMC-moist > DAMP > WET-plastic > SATURATED > MUD > PONDED.
// Result lands on window.__qaColorLog.
(() => {
  const g = window.__game;
  if (!g) return "NO GAME";
  const N = 192;                       // physics grid
  const WS = 768;                      // world size (m)
  const d = g.ground.texData;          // R wet G pond B mud A road
  const d2 = g.ground.texData2;        // R gel G crust B stick A soilId
  const H = g.terrain.height;          // (N+1)^2 node grid, 4 m spacing

  // ---- exact shNoise port (JS float precision differs from GPU on big
  // args, but per-state MEANS over thousands of cells are stable) -------
  const fract = (x) => x - Math.floor(x);
  const shHash = (px, pz) => fract(Math.sin(px * 127.1 + pz * 311.7) * 43758.5453);
  const shNoise = (px, pz) => {
    const ix = Math.floor(px), iz = Math.floor(pz);
    const fx = px - ix, fz = pz - iz;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    return (shHash(ix, iz) * (1 - ux) + shHash(ix + 1, iz) * ux) * (1 - uz)
         + (shHash(ix, iz + 1) * (1 - ux) + shHash(ix + 1, iz + 1) * ux) * uz;
  };

  // ---- vertex tint (world.ts bake) ------------------------------------
  // ---- vertex tint (biomeTint.vertexTint port — the shared formula the
  // world mesh, contact overlay and mid ring all bake) --------------------
  // biome palette, raw hex/255 (same space the previous audit used)
  const BCOL = [
    [0.7255, 0.5961, 0.3529], // 0 grassland
    [0.3686, 0.4235, 0.2510], // 1 forest
    [0.6588, 0.6039, 0.3686], // 2 hills
    [0.2471, 0.3686, 0.1882], // 3 rainforest
    [0.8510, 0.7098, 0.4863], // 4 desert
    [0.3333, 0.3216, 0.2157], // 5 swamp
    [0.5529, 0.5176, 0.4706], // 6 rocky
    [0.4902, 0.4784, 0.4549], // 7 mountain
    [0.9294, 0.9451, 0.9569], // 8 ice
    [0.4196, 0.3569, 0.2667], // 9 river
  ];
  const ROCKHI = [0.6588, 0.6784, 0.6980], SNOW = [0.9608, 0.9725, 0.9804];
  const MOTTLE = 0.92; // mean of 0.92+0.16*sin*sin
  const BIOME = g.terrain.biome;
  const heightAt = (x, z) => {
    const fx = (x + WS / 2) / 4, fz = (z + WS / 2) / 4;
    const i = Math.min(N, Math.max(0, Math.floor(fx))), j = Math.min(N, Math.max(0, Math.floor(fz)));
    const tx = Math.min(1, fx - i), tz = Math.min(1, fz - j);
    const a = H[j * (N + 1) + i], b = H[j * (N + 1) + Math.min(N, i + 1)];
    const c = H[Math.min(N, j + 1) * (N + 1) + i], e = H[Math.min(N, j + 1) * (N + 1) + Math.min(N, i + 1)];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  };
  const vertexTint = (x, z) => {
    const h = heightAt(x, z);
    // bilinear biome colour (at cell centres this collapses to the cell's
    // own biome — exactly what the mesh bakes there)
    const gx = (x + WS / 2) / 4 - 0.5, gz = (z + WS / 2) / 4 - 0.5;
    const i0 = Math.min(N - 1, Math.max(0, Math.floor(gx))), j0 = Math.min(N - 1, Math.max(0, Math.floor(gz)));
    const i1 = Math.min(N - 1, i0 + 1), j1 = Math.min(N - 1, j0 + 1);
    const u = Math.min(Math.max(gx - i0, 0), 1), v = Math.min(Math.max(gz - j0, 0), 1);
    const c00 = BCOL[BIOME[j0 * N + i0]], c10 = BCOL[BIOME[j0 * N + i1]];
    const c01 = BCOL[BIOME[j1 * N + i0]], c11 = BCOL[BIOME[j1 * N + i1]];
    let c = [0, 1, 2].map(ch => (c00[ch] * (1 - u) + c10[ch] * u) * (1 - v) + (c01[ch] * (1 - u) + c11[ch] * u) * v);
    const hn = Math.min(Math.max(h / 60, 0), 1);
    c = c.map(vv => vv * (0.86 + 0.30 * hn));
    const bm = BIOME[Math.min(N - 1, Math.max(0, Math.floor((z + WS / 2) / 4))) * N
      + Math.min(N - 1, Math.max(0, Math.floor((x + WS / 2) / 4)))];
    if (bm === 7) { const kk = Math.min(Math.max((h - 60) / 55, 0), 0.6); c = c.map((vv, ch) => vv + (ROCKHI[ch] - vv) * kk); }
    if (bm === 8) { const kk = Math.min(Math.max((h - 92) / 18, 0), 0.85); c = c.map((vv, ch) => vv + (SNOW[ch] - vv) * kk); }
    return c.map(vv => vv * MOTTLE);
  };

  // ---- classify + evaluate (mudSurface port, FIXED version) -----------
  const states = {};
  const add = (name, rgb, road) => {
    const s = states[name] || (states[name] = { n: 0, r: 0, gC: 0, b: 0, roadN: 0 });
    s.n++; s.r += rgb[0]; s.gC += rgb[1]; s.b += rgb[2]; if (road > 0.5) s.roadN++;
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const wet = d[k * 4] / 255, pond = d[k * 4 + 1] / 255, mud = d[k * 4 + 2] / 255, road = d[k * 4 + 3] / 255;
      const gel = d2[k * 4] / 255, crust = d2[k * 4 + 1] / 255, soilId = d2[k * 4 + 3] / 255;
      const x = -WS / 2 + (i + 0.5) * 4, z = -WS / 2 + (j + 0.5) * 4;
      let col = vertexTint(x, z);
      // moisture ramp: col *= 1 - 0.60 * wet^0.62
      col = col.map(v => v * (1 - 0.60 * Math.pow(Math.min(Math.max(wet, 0), 1), 0.62)));
      // mud body
      const nP = shNoise(x * 0.55, z * 0.55);
      const nM = shNoise(x * 2.9, z * 2.9);
      const nG = shNoise(x * 11.0, z * 11.0);
      const cov = Math.min(Math.max(mud * (0.55 + 0.60 * nP) * (0.82 + 0.18 * nM), 0), 1);
      const mb = soilId > 0.84 ? [0.055, 0.048, 0.040] : soilId > 0.6 ? [0.22, 0.175, 0.125] : soilId > 0.4 ? [0.096, 0.082, 0.068] : soilId > 0.2 ? [0.138, 0.103, 0.072] : [0.192, 0.152, 0.104];
      let mudCol = mb.map(v => v * (0.87 + 0.26 * nM) * (0.92 + 0.16 * nG));
      mudCol = mudCol.map(v => v * (1 - 0.18 * (1 - gel)));
      mudCol = mudCol.map(v => v * (0.88 + 0.12 * Math.min(Math.max(wet, 0), 1)));
      col = col.map((v, i2) => v + (mudCol[i2] - v) * cov * 0.9);
      // crust
      const crustV = crust * (1 - 0.55 * Math.min(Math.max(wet - 0.35, 0), 1));
      if (crustV > 0.015) col = col.map(v => v + (v * 1.38 + 0.055 - v) * crustV * 0.5);
      // road + pond (world.ts order)
      const roadCol = [0.42, 0.335, 0.24].map(v => v * (1 - 0.5 * wet));
      col = col.map((v, i2) => v + (roadCol[i2] - v) * road * 0.75);
      const pondK = Math.min(Math.max(pond * 1.4, 0), 0.55);
      col = [col[0] + (0.19 - col[0]) * pondK, col[1] + (0.22 - col[1]) * pondK, col[2] + (0.20 - col[2]) * pondK];
      // classify (skip ponded water — the water sheet owns those pixels)
      let name;
      if (pond > 0.02) name = "PONDED";
      else if (mud >= 0.25) name = "MUD";
      else if (wet < 0.15) name = "DRY";
      else if (wet < 0.35) name = "OMC-moist";
      else if (wet < 0.55) name = "DAMP";
      else if (wet < 0.75) name = "WET-plastic";
      else name = "SATURATED";
      add(name, col, road);
    }
  }
  const rep = {};
  for (const [name, s] of Object.entries(states)) {
    const r = s.r / s.n, gc = s.gC / s.n, b = s.b / s.n;
    const lum = 0.2126 * r + 0.7152 * gc + 0.0722 * b;
    rep[name] = {
      cells: s.n, roadCells: s.roadN,
      rgb: [r, gc, b].map(v => +v.toFixed(3)),
      luminance: +lum.toFixed(3),
      "8bit": [r, gc, b].map(v => Math.round(v * 255)),
    };
  }
  window.__qaColorLog = rep;
  return "audit done";
})()
