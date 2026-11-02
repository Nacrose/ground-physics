// 10_materials.js — gravel, bedrock, mixed-soil QA.
// Verifies the three new ground materials behave as designed:
//   gravel: drains at ~310 mm/h (rain never muds it), soil byte 255
//   bedrock: spade REFUSES on bare rock (volume 0), bearing raft boosts q_ult
//   mixed:   border cells carry a blended pedotransfer (key "mixed", label
//            "A + n% B", properties between the neighbours)
// Result lands on window.__qaMatLog.
(() => {
  const g = window.__game;
  if (!g) return "NO GAME";
  const N = 192;
  const log = {};

  // ---- 1. gravel ----------------------------------------------------------
  let gravelCells = [], gravelSubmergedMud = 0;
  for (let k = 0; k < N * N; k++) {
    if (g.terrain.soil[k] === 5) gravelCells.push(k);
  }
  const gr = gravelCells[Math.floor(gravelCells.length / 2)];
  const grTex = g.ground.cellTex[gr];
  // controlled experiment: a dry upland cell FORCED to pure gravel, driven
  // through 45 game-minutes of 135 mm/h broad rain — rain alone must never
  // mud it (kSat 310 mm/h drinks the storm whole; only submersion can)
  let pureInChannel = 0, pureMudMax = 0;
  let pureTex = null;
  for (let k = 0; k < N * N; k++) {
    const t = g.ground.cellTex[k];
    if (t && t.key === "gravel") { pureTex = t; if (g.terrain.river[k] > 0.3) pureInChannel++; pureMudMax = Math.max(pureMudMax, g.ground.mudFactor[k]); }
  }
  let rainOnlyMud = null;
  if (pureTex) {
    // find a quiet grassland cell away from river/road/rock
    let kT = -1;
    for (let k = 0; k < N * N && kT < 0; k++) {
      if (g.terrain.biome[k] === 0 && g.terrain.river[k] === 0 && g.terrain.road[k] === 0
        && g.terrain.rockFrac[k] === 0) kT = k;
    }
    if (kT >= 0) {
      const saveTex = g.ground.cellTex[kT], saveTheta = [0, 1, 2, 3].map((L) => g.ground.theta[L][kT]);
      g.ground.cellTex[kT] = pureTex;
      for (let L = 0; L < 4; L++) g.ground.theta[L][kT] = pureTex.thetaS * 0.3;
      g.ground.hPond[kT] = 0; g.ground.infiltF[kT] = 0; g.ground.keCum[kT] = 0;
      g.ground.branch[kT] = 0; g.ground.disturbed[kT] = 0; g.ground.traffic[kT] = 0;
      const f = (t) => g.ground.update({
        coreRainMmH: 135, windMs: 10, tempC: 18, rh: 0.8, sw: 0.15,
        pattern: "broad", driftU: 0, driftV: 0, dtGame: 60, dtReal: 60,
        playerX: 0, playerZ: 0,
      });
      for (let i = 0; i < 20; i++) f();
      rainOnlyMud = +g.ground.mudFactor[kT].toFixed(3);
      // restore
      g.ground.cellTex[kT] = saveTex;
      for (let L = 0; L < 4; L++) g.ground.theta[L][kT] = saveTheta[L];
    }
  }
  log.gravel = {
    cells: gravelCells.length,
    label: grTex.label,
    kSatMmH: +grTex.kSatMmH.toFixed(0),
    pureCells: pureInChannel, // all in-channel: the submerged river bed
    pureInChannelMudMax: +pureMudMax.toFixed(2),
    rainOnlyMudForced: rainOnlyMud, // expected ~0 — rain alone cannot mud gravel
  };

  // ---- 2. bedrock ---------------------------------------------------------
  // find a bare-rock cell (>0.9) and a soil cell near it for the pair test
  let rockK = -1, soilK = -1;
  for (let k = 0; k < N * N && rockK < 0; k++) if (g.terrain.rockFrac[k] > 0.9) rockK = k;
  for (let k = 0; k < N * N && soilK < 0; k++) if (g.terrain.rockFrac[k] === 0 && g.terrain.river[k] === 0) soilK = k;
  const cellXY = (k) => [ (k % N) * 4 - 384 + 2, Math.floor(k / N) * 4 - 384 + 2 ];
  const [rx, rz] = cellXY(rockK);
  const [sx, sz] = cellXY(soilK);
  g.micro.centerOn(rx, rz);
  const digRock = g.micro.digStroke(rx, rz, 0, 1);
  g.micro.centerOn(sx, sz);
  const digSoil = g.micro.digStroke(sx, sz, 0, 1);
  let rockCells = 0, rockHigh = 0;
  for (let k = 0; k < N * N; k++) {
    if (g.terrain.rockFrac[k] > 0.5) rockCells++;
    if (g.terrain.rockFrac[k] > 0.9) rockHigh++;
  }
  log.bedrock = {
    cellsOver05: rockCells, cellsOver09: rockHigh,
    refused: !!digRock.refused, refusedVolume: +digRock.volumeM3.toFixed(3),
    soilVolume: +digSoil.volumeM3.toFixed(4),
    qUltRock: +g.ground.qUlt[rockK].toFixed(0),
    rockFracThere: +g.terrain.rockFrac[rockK].toFixed(2),
  };

  // ---- 3. mixed soils -----------------------------------------------------
  let mixedCells = 0, sample = null;
  for (let k = 0; k < N * N; k++) {
    const t = g.ground.cellTex[k];
    if (t && t.key === "mixed") {
      mixedCells++;
      // prefer a real blend (dominant < 0.8) so the label shows the mix
      if (!sample && g.terrain.rockFrac[k] < 0.05) sample = k;
    }
  }
  // find the most-blended low-rock cell for the report
  let bestFrac = 1;
  for (let k = 0; k < N * N; k++) {
    const t = g.ground.cellTex[k];
    if (!t || t.key !== "mixed" || g.terrain.rockFrac[k] > 0.05) continue;
    let dom = 0;
    for (let s = 0; s < 6; s++) dom = Math.max(dom, g.terrain.soilMix[k * 6 + s]);
    if (dom < bestFrac) { bestFrac = dom; sample = k; }
  }
  if (sample !== null) {
    const st = g.ground.cellTex[sample];
    log.mixed = {
      cells: mixedCells,
      dominantFraction: +bestFrac.toFixed(2),
      label: st.label,
      sand: +st.sand.toFixed(0), clay: +st.clay.toFixed(0),
      kSatMmH: +st.kSatMmH.toFixed(1),
      LL: +st.LL.toFixed(0), PL: +st.PL.toFixed(0),
    };
  } else {
    log.mixed = { cells: mixedCells, label: "no clean sample" };
  }

  window.__qaMatLog = log;
  return "materials audit done";
})()
