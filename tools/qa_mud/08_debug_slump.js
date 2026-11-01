// debug: dump the slurry print profile along the facing axis, then after
// 1 and 20 more relaxation passes, to see how the crater relaxes.
(() => {
  const g = window.__game;
  const m = g.micro;
  const N = 192;
  const fine = (x, z) => Math.floor((z + 384) / 4) * N + Math.floor((x + 384) / 4);
  const base = window.__qaMud || { x: 0, z: 0 };
  const S = { x: base.x + 24, z: base.z };
  const k = fine(S.x, S.z);
  g.ground.wetness[k] = 0.95; g.ground.mudFactor[k] = 0.9; g.ground.consistency[k] = 2;
  g.ground.sr[k] = 1.0; g.ground.gel[k] = 0.15;
  const ss = { wetness: 0.95, mud: 0.9, consistency: 2, sr: 1.0, wPct: 0.2, textureIdx: 0, gel: 0.15 };
  m.centerOn(S.x, S.z);
  m.stampBoot(S.x, S.z, 0, ss, 1);
  const prof = (tag) => {
    const out = [];
    for (let dz = -0.28; dz <= 0.28; dz += 0.0625) {
      out.push(+(m.sampleDelta(S.x, S.z + dz) * 100).toFixed(1));
    }
    return { tag, alongCm: out };
  };
  const p0 = prof("fresh");
  m.relaxFor(30); // 1 pass
  const p1 = prof("pass1");
  m.relaxFor(570); // 19 more
  const p20 = prof("pass20");
  // churn flag coverage + state readback at the print
  const iC = Math.max(0, Math.min(255, Math.floor((S.x - (m.ox - 8)) / 0.0625)));
  const jC = Math.max(0, Math.min(255, Math.floor((S.z - (m.ox - 8)) / 0.0625)));
  const flagsNear = [];
  for (let dj = -4; dj <= 4; dj++) flagsNear.push(m.flags[(jC + dj) * 256 + iC]);
  const t = m.touchAt(S.x, S.z);
  return JSON.stringify({
    p0, p1, p20,
    touch: { mud: +t.mud.toFixed(2), cons: t.consistency, gel: +t.gel.toFixed(2), wet: +t.wetness.toFixed(2) },
    flagsCol: flagsNear,
    churnCount: m.churnCount,
  });
})()
