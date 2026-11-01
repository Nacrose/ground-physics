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
  const dry = [0.7255, 0.5961, 0.3529], lush = [0.4902, 0.5412, 0.3059], rock = [0.5529, 0.5176, 0.4706];
  const MOTTLE = 0.92; // mean of 0.92+0.16*sin*sin
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
    const hn = Math.min(Math.max(h / 18, 0), 1);
    const c = [0, 1, 2].map(i => dry[i] + (lush[i] - dry[i]) * (1 - hn));
    if (h > 14.5) {
      const k = Math.min((h - 14.5) / 5, 0.6);
      for (let i = 0; i < 3; i++) c[i] += (rock[i] - c[i]) * k;
    }
    return c.map(v => v * MOTTLE);
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
      const mb = soilId > 0.75 ? [0.096, 0.082, 0.068] : soilId > 0.4 ? [0.138, 0.103, 0.072] : [0.192, 0.152, 0.104];
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
