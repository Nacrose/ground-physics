// Mud material physics — thixotropy (remold → rest → recovery), viscoplastic
// creep, sticky-limit adhesion, boot-mud pickup, desiccation crust.
// Heavy work stays in-page; result lands on window.__qaMudLog.
(() => {
  const g = window.__game;
  if (!g) return "NO GAME";
  g.started = true;
  g.hud.hideBoot();
  const N = 192;
  const log = {};

  g.loadPreset("thunderstorm", true).then(() => {
    g.fastForward(45); // storm peak (reference QA: ~38% mud fraction)

    // ---- 1. find the wettest cell + intact state --------------------------
    let best = -1, bestM = -1;
    for (let k = 0; k < N * N; k++) {
      const m = g.ground.mudFactor[k];
      if (m > bestM) { bestM = m; best = k; }
    }
    const fi = best % N, fj = Math.floor(best / N);
    const x = fi * 4 - 384 + 2, z = fj * 4 - 384 + 2;
    window.__qaMud = { x, z };
    const rep0 = g.ground.cellReport(x, z);
    log.peak = {
      mud: +bestM.toFixed(2), cons: rep0.consistencyLabel, w: +rep0.wPct.toFixed(1),
      li: +rep0.li.toFixed(2), stick: +rep0.stick.toFixed(2), gel0: +rep0.gel.toFixed(2),
      q0: +rep0.qUltKpa.toFixed(0), soil: rep0.texture.key,
    };

    // ---- 2. remold: 3 DYNAMIC wheel passes through the mud ----------------
    let sinkA = 0;
    for (let i = 0; i < 3; i++) sinkA = g.ground.applyWheelLoad(x, z, 150, false).sinkage;
    g.fastForward(1); // recompute geotech with the knocked-down gel
    const rep1 = g.ground.cellReport(x, z);
    log.remolded = {
      gel: +rep1.gel.toFixed(2), q: +rep1.qUltKpa.toFixed(0),
      qRatio: +(rep1.qUltKpa / rep0.qUltKpa).toFixed(2), state: rep1.gelState,
      sinkCm: +(sinkA * 100).toFixed(1),
    };

    // ---- 3. dwell creep: the same load, but resting 60 s ------------------
    const sinkB = g.ground.applyWheelLoad(x, z, 150, false, 60).sinkage;
    log.creep = { instantCm: +(sinkA * 100).toFixed(1), dwelledCm: +(sinkB * 100).toFixed(1) };

    // ---- 4. walk the mud: boot pickup + churn prints ----------------------
    g.player.pos.x = x; g.player.pos.z = z; g.player.pos.y += 2;
    g.micro.centerOn(x, z);
    g.input.forward = 1; g.input.yaw = 0.8; g.input.sprint = true;
    const boot0 = g.player.bootMud;
    const rut0 = g.ground.rut[best];
    for (let i = 0; i < 180; i++) g.player.update(1 / 30, g.input, 0); // 6 s sprint
    g.input.forward = 0; g.input.sprint = false;
    log.walk = {
      boot0: +boot0.toFixed(2), boot1: +g.player.bootMud.toFixed(2),
      rutGrowCm: +((g.ground.rut[best] - rut0) * 100).toFixed(1),
      gelAfterWalk: +g.ground.gel[best].toFixed(2),
    };

    // ---- 5. stand still: creepSink under a resting boot --------------------
    const rutS0 = g.ground.rut[best];
    g.player.pos.x = x; g.player.pos.z = z;
    for (let i = 0; i < 300; i++) g.player.update(1 / 30, g.input, 0); // 10 s standing
    log.stand = { rutGrowCm: +((g.ground.rut[best] - rutS0) * 100).toFixed(2) };

    // ---- 6. sticky window on a PLASTIC cell --------------------------------
    let plast = -1;
    for (let k = 0; k < N * N; k++) {
      if (g.ground.consistency[k] === 1 && g.ground.mudFactor[k] > 0.2) { plast = k; break; }
    }
    log.stickyCell = plast >= 0 ? +g.ground.stick[plast].toFixed(2) : -1;

    // ---- 7. rest: gel recovery clock (independent of the weather) ----------
    g.fastForward(360); // ~6 game-hours
    const rep2 = g.ground.cellReport(x, z);
    log.recovered = {
      gel: +rep2.gel.toFixed(2), q: +rep2.qUltKpa.toFixed(0), state: rep2.gelState,
      mud: +rep2.mudFactor.toFixed(2),
    };

    // ---- 8. desiccation: clear-sky drying leaves a cracked crust -----------
    g.loadPreset("clear_sky", true).then(() => {
      g.fastForward(700); // ~11.7 h drying
      let crustCells = 0, crustMax = 0, crustAt = -1;
      for (let k = 0; k < N * N; k++) {
        const c = g.ground.mudCrust[k];
        if (c > 0.1) crustCells++;
        if (c > crustMax) { crustMax = c; crustAt = k; }
      }
      log.crust = { cells: crustCells, max: +crustMax.toFixed(2) };
      if (crustAt >= 0) {
        const ci = crustAt % N, cj = Math.floor(crustAt / N);
        log.crust.cell = { x: +(ci * 4 - 384 + 2).toFixed(1), z: +(cj * 4 - 384 + 2).toFixed(1) };
        window.__qaCrustCell = log.crust.cell;
      }
      window.__qaMudLog = log;
    });
  });
  return "STARTED";
})()
