// mud-realism patch QA — boot anatomy (ball/heel/arch), squeeze-out lip,
// plastic-vs-slurry print persistence, bootLift volume conservation,
// trackMud smears + dryMarks drying, decal footprints gone.
// Heavy work stays in-page; result lands on window.__qaRealismLog.
(() => {
  const g = window.__game;
  if (!g) return "NO GAME";
  const N = 192;
  const m = g.micro;
  const C = 0.0625;
  const fineIdx = (x, z) => Math.floor((z + 384) / 4) * N + Math.floor((x + 384) / 4);
  const log = {};
  const base = window.__qaMud || { x: 0, z: 0 };
  // offsets ≡ 2 (mod 4) so every test cell sits at a FINE-CELL CENTRE — a
  // print on a 4 m boundary straddles two cells and half the relax pairs
  // sample the neighbour's state (that bit me on the first run)
  const cells = {
    plastic: { x: base.x + 20, z: base.z - 4 },
    slurry: { x: base.x + 28, z: base.z + 4 },
    dry: { x: base.x + 20, z: base.z + 4 },
    wet: { x: base.x + 28, z: base.z - 4 },
  };
  const setCell = (c, wetness, mud, cons, sr, gel) => {
    const k = fineIdx(c.x, c.z);
    g.ground.wetness[k] = wetness;
    g.ground.mudFactor[k] = mud;
    g.ground.consistency[k] = cons;
    g.ground.sr[k] = sr;
    g.ground.gel[k] = gel;
    return { ...c, mud, wetness, consistency: cons, sr, gel, textureIdx: 0 };
  };
  // window centred between the two print cells so both fit with margin
  m.centerOn((cells.plastic.x + cells.slurry.x) / 2, (cells.plastic.z + cells.slurry.z) / 2);
  const sumBox = (cx, cz, R) => {
    let s = 0;
    const i0 = Math.max(0, Math.floor((cx - R - (m.ox - 8)) / C)), i1 = Math.min(255, Math.ceil((cx + R - (m.ox - 8)) / C));
    const j0 = Math.max(0, Math.floor((cz - R - (m.oz - 8)) / C)), j1 = Math.min(255, Math.ceil((cz + R - (m.oz - 8)) / C));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) s += m.delta[j * 256 + i] * C * C;
    return s;
  };
  const maxRing = (cx, cz, r0, r1) => {
    let mx = -1e9;
    const i0 = Math.max(0, Math.floor((cx - r1 - (m.ox - 8)) / C)), i1 = Math.min(255, Math.ceil((cx + r1 - (m.ox - 8)) / C));
    const j0 = Math.max(0, Math.floor((cz - r1 - (m.oz - 8)) / C)), j1 = Math.min(255, Math.ceil((cz + r1 - (m.oz - 8)) / C));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const wx = m.ox - 8 + (i + 0.5) * C, wz = m.oz - 8 + (j + 0.5) * C;
      const r = Math.hypot(wx - cx, wz - cz);
      if (r >= r0 && r <= r1) mx = Math.max(mx, m.delta[j * 256 + i]);
    }
    return mx;
  };
  const bit4At = (x, z) => {
    const i = Math.max(0, Math.min(255, Math.floor((x - (m.ox - 8)) / C)));
    const j = Math.max(0, Math.min(255, Math.floor((z - (m.oz - 8)) / C)));
    return (m.flags[j * 256 + i] & 4) !== 0;
  };

  // controlled states
  const plastic = setCell(cells.plastic, 0.7, 0.6, 1, 0.85, 0.9); // wet plastic mud (not slurry)
  const slurry = setCell(cells.slurry, 0.95, 0.9, 2, 1.0, 0.15); // past the liquid limit, remoulded
  setCell(cells.dry, 0.1, 0, 0, 0.2, 1);
  setCell(cells.wet, 0.6, 0.15, 1, 0.8, 1);

  // ---- 1. boot anatomy on the plastic print --------------------------------
  m.stampBoot(plastic.x, plastic.z, 0, plastic, 1);
  const dBall = -m.sampleDelta(plastic.x, plastic.z + 0.075);
  const dHeel = -m.sampleDelta(plastic.x, plastic.z - 0.105);
  const dArch = -m.sampleDelta(plastic.x, plastic.z - 0.02);
  log.anatomy = {
    ballCm: +(dBall * 100).toFixed(1), heelCm: +(dHeel * 100).toFixed(1), archCm: +(dArch * 100).toFixed(1),
    archUp: dArch < 0.6 * Math.max(dBall, dHeel), heelBites: dHeel > 0.8 * dBall,
  };

  // ---- 2. squeeze-out lip (tight ring huging the print) --------------------
  log.lip = { ringMaxCm: +(maxRing(plastic.x, plastic.z, 0.20, 0.28) * 100).toFixed(1),
              lipFormed: maxRing(plastic.x, plastic.z, 0.20, 0.28) > 0.01 };

  // ---- 3. plastic walls stand, slurry oozes flat (20 relax passes) --------
  m.stampBoot(slurry.x, slurry.z, 0, slurry, 1);
  const p0 = -m.sampleDelta(plastic.x, plastic.z + 0.075);
  const s0 = -m.sampleDelta(slurry.x, slurry.z + 0.075);
  m.relaxFor(600); // 20 passes ≈ 10 game-minutes of live relax cadence
  const p1 = -m.sampleDelta(plastic.x, plastic.z + 0.075);
  const s1 = -m.sampleDelta(slurry.x, slurry.z + 0.075);
  log.persistence = {
    plasticKeep: +(p1 / p0).toFixed(2), slurryKeep: +(s1 / s0).toFixed(2),
    wallsStand: p1 / p0 > 0.5,
    slurryFlows: s1 / s0 < 0.4 && s1 / s0 < 0.7 * (p1 / p0), // ooze flat AND clearly flatter than plastic
  };

  // ---- 4. bootLift: suction scrape + flung lump, volume books ---------------
  const before = sumBox(plastic.x, plastic.z, 1.5);
  const litres = m.bootLift(plastic.x, plastic.z, 0, plastic, 1);
  const after = sumBox(plastic.x, plastic.z, 1.5);
  const lump = maxRing(plastic.x, plastic.z - 0.21, 0.0, 0.16);
  log.bootLift = {
    litres: +litres.toFixed(3),
    netM3: +((after - before) * 1000).toFixed(3), // litres lost to the boot
    conserved: Math.abs((before - after) * 1000 - litres) < 0.02,
    lumpCm: +(lump * 100).toFixed(1), lumpFormed: lump > 0.01,
    suctionRing: bit4At(plastic.x, plastic.z),
    dryCell: m.bootLift(cells.dry.x, cells.dry.z, 0,
      { wetness: 0.1, mud: 0, consistency: 0, sr: 0.2, wPct: 0.1, textureIdx: 0, gel: 1 }, 1) === 0,
  };

  // ---- 5. trackMud smears: sole-shaped marks that dry on dry ground ---------
  m.centerOn(cells.dry.x, cells.dry.z);
  m.trackMud(cells.dry.x, cells.dry.z, 0, 0.8);
  m.trackMud(cells.wet.x, cells.wet.z, 0, 0.8);
  const dry0 = bit4At(cells.dry.x, cells.dry.z), wet0 = bit4At(cells.wet.x, cells.wet.z);
  for (let i = 0; i < 17; i++) m.update(3.05, m.ox, m.oz); // full window sweep
  log.smears = {
    marked: dry0 && wet0,
    driedOut: !bit4At(cells.dry.x, cells.dry.z),
    wetStays: bit4At(cells.wet.x, cells.wet.z),
  };

  // ---- 6. the decal footprint system is gone --------------------------------
  log.decalRemoved = g.player.footprints === undefined;

  window.__qaRealismLog = log;
  return "DONE";
})()
