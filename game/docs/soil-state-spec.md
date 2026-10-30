# Soil State Specification — ground-physics "Real Soil" Phase 1

> The ground is not a surface. It is a stateful, deforming, hysteretic material.
> Locomotion and digging are two ways of *writing* to one shared terrain state;
> rain, relaxation and biology are the world writing back.
> This document is the machine contract for that principle on this codebase.

## 1. Simulation tiers

| Tier | Extent | Cell size | Rate | Lives in | Status |
|---|---|---|---|---|---|
| **Contact / micro** | 16 m × 16 m window following the actor | 6.25 cm (256²) | strokes/footfalls event-driven; slope relaxation 2 Hz | `MicroTerrain` (contact.ts) | **Phase 1 (this update)** |
| **Fine world** | 768 m catchment | 4 m (192²) | 2 Hz real, weather-scaled game time | `Ground` (ground.ts) | existing |
| **Coarse world** | 2–8 km² | 1–4 m, sleeping tiles | Phase 2 | — | planned |

Only the micro tier owns **deforming geometry**. The fine tier owns evolving
per-cell state (moisture, crust, ruts, compaction, disturbance). The render
mesh of the world stays static; the micro window is a scrolling overlay mesh
whose vertices displace from a RGBA8 delta texture, and the base terrain
discards fragments inside the window so holes are true holes.

## 2. State fields

### Micro cell (6.25 cm) — authoritative `Float32Array` + `Uint8Array` flags
| Field | Type | Meaning |
|---|---|---|
| `delta` | f32 [m] | surface height offset from base terrain (±0.5 m) |
| `flags` | u8 bitmask | b0 churned (relax candidate + tint), b1 spoil (loose re-dig), b2 wet-ring (suction mark) |

Render encoding (RGBA8 texture): R = `(delta+0.5)/1.0` (3.9 mm steps),
G = churn 0..1, B = spoil 0..1, A = wet-ring. The f32 array stays authoritative;
the texture is a display quantisation only.

### Fine cell (4 m) — additions in Phase 1
| Field | Type | Meaning |
|---|---|---|
| `branch` | u8 | retention branch: 0 drying (main curve), 1 wetting (scanning) |
| `traffic` | u8 | cumulative traffic/compaction memory (hysteretic, slow decay) |
| `disturbed` | u8 | dig/till disturbance: Ks × 1.7, crust broken, layers mixed |

Effects: `Ks_eff = Ks × seal × (1 − 0.12·min(traffic,5)) × (disturbed ? 1.7 : 1)`;
compaction also raises `q_ult` slightly and reduces footprint sink (hard path).

## 3. Hysteresis — wetting ≠ drying

Clapp–Hornberger `ψ(θ) = ψs·(θ/θs)^−b` is the **main drying** curve. On the
wetting branch suction is `× 0.42` (scanning-curve ratio, within the measured
0.35–0.5 range):

- getting wet *fast* collapses suction (and Fredlund c_app) quickly,
- drying recovers suction on the steep main curve → the **drying crust** —
  a stiff false floor over still-wet soil beneath, exactly the trap the design
  doc describes.

Branch flips are set by the sign of the top-layer moisture tendency
(infiltration > 0 → wetting; evaporation > 0 → drying).

## 4. Conservation rules (non-negotiable)

1. **Micro relaxation conserves volume by construction.** Slope relaxation
   moves height between adjacent cells in pairwise transfers; Σdelta can only
   change through stamps/digs/spoil, never through relax.
2. **Footprints conserve locally.** A boot stamp removes a crater volume and
   redistributes it as a rim ridge of equal volume (bulk density unchanged at
   print scale).
3. **Digging conserves mass, not bulk volume.** A stroke removes bulk volume V
   from the crater and places the *same dry mass* as spoil; because spoil is
   loose (fill factor 0.8 → bulk +25%), the pile occupies `1.25·V`. The surface
   genuinely rises — loosened soil takes more space. Re-digging flagged spoil
   applies fill factor 1.0 (loosening is not infinite).
4. **Ledger.** `microAudit()` returns cumulative `{removedM3, addedM3, massIn,
   massOut}`; acceptance: `|massIn − massOut| < 1e-6 · massIn`.
5. **Fine tier:** water balance already closes to 0.00 mm (rwengine port);
   traffic/disturbed flags change *rates*, never masses.

## 5. State-dependent contact & digging (the four resistances)

Per stroke at aim point (state sampled from the fine cell + micro flags):

1. **Penetration** — spade depth `dPen = clamp(0.30·(45/q_pen), 0.02, 0.30) m`,
   `q_pen ≈ q_ult · (1 + 0.06·traffic)`; dry dense clay resists, mud accepts.
2. **Cutting** — bite volume `V = 0.22 m × 0.18 m × dPen`; cutting effort scales
   with `c_eff + σ′·tanφ′` (moist plastic loam is the cheap optimum).
3. **Adhesion** — wet plastic+ clay adds blade drag (slows the swing) ∝ `c_app`.
4. **Extraction suction** — saturated fines (Sr > 0.9, w > PL): stroke
   cooldown +0.3 s, audible pop, wet-ring flag where the blade pulled free.

Spoil is tossed 0.7–1.1 m to the side of the facing as a cone; angle of
repose by state: dry sand 32°, moist loam 45°, wet clay 25°, mud 8°.

**One mechanism makes sand flow back, faces slump and mud close its own
hole:** pairwise slope relaxation toward the state-dependent repose angle,
run over churned cells at 2 Hz. Conservation is structural (rule 1).

## 6. Determinism

Fixed sim steps (existing), seeded LCG everywhere (no `Math.random` in sim
paths — FX visuals excepted), pairwise ordered relax sweeps (i asc, j asc),
no GPU atomics (single-thread TS; a future Metal port must keep deterministic
reduction orders). Footfall/stroke outcomes are pure functions of
(fine state, micro flags, seed).

## 7. Phase 1 acceptance

- [ ] `microAudit()` mass conservation < 1e-6 relative after 20 dig strokes
- [ ] Four states readable at one spot: dry dusty shallow prints → moist crisp
      dark prints → saturated slumping water-filled prints → mud craters with
      welling rims (screenshots, Section 20 of the design doc)
- [ ] Dry sand hole visibly flows back; mud hole slumps shut; moist loam face
      stands (Section 22)
- [ ] Drying crust: after storm, surface strength (suction) recovers on the
      main branch while θ₁ stays wet — inspector shows branch + suction
- [ ] Repeated walking one line: grass trampled, traffic counter rises,
      compaction reduces sink (desire-path seed, Section 30)
- [ ] Console clean; ≥ 30 fps on the QA scene (quality scaler untouched)

## 8. Tunnels — the station-node graph (batch A)

A tunnel is the one case where ground stops being a heightfield: crown and
invert share a column. It is neither voxels nor a heightfield edit — it is a
**station graph**: every 0.5 m of drivage is a node carrying position,
support state and a live handle on the fine-tier soil state.

- **Geometry**: bore 2.0 m span × 0.85 m walls + semicircular crown (1.85 m);
  invert = portal grade − 2.40 m (0.55 m minimum crown cover at the mouth);
  the portal mouth is a rotated smoothstep cut pushed down in BOTH the base
  terrain and the contact overlay shaders (world-anchored — it stays open at
  any distance; the micro window only owns the muck heaps and prints).
- **Drivage**: F at the face is a mining round — one round advances one
  station. No heightfield crater at the face (it would ghost onto the surface
  above); dry dense clay refuses half the rounds, saturated fines add the
  suction cooldown. The four resistances read the live fine-tier column.
- **Conservation (rule 4 extended)**: each round books `area × 0.5` bank m³
  and the same dry mass lands as loose spoil (fill 0.8, +25 % bulk) at the
  portal through the micro-tier pile writer. Muck mined while the portal is
  outside the 16 m micro window waits in `muckPendingM3` and is flushed when
  the window returns — the ledger never forgets.
- **Support**: R raises a timber set (posts + collar + roof lagging) at the
  station the player stands in — allowable 300 kPa.
- **Live Terzaghi panel**: crown load = silo-arched γB/2K·φ cap vs full
  column below 2 spans of cover; capacity = timber + 5.14·c_eff from the
  CURRENT fine state — a storm is a live FS degradation, not a script.
- **The player underground**: the tube owns the floor inside its footprint
  (height-gated so surface walkers above a drive keep the terrain floor);
  the camera pulls in and clamps into the bore; a miner's lantern fades in.
- **Batch A scope note**: FS is computed and displayed only — stand-up
  timers, steel arch sets, seepage/piping and collapse carving arrive with
  batches B–D (`carveRect` on the micro tier is the collapse writer).
