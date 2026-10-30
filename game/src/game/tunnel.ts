/**
 * Tunnel — the sparse non-heightfield overlay (design doc §13, spec §1).
 *
 * A tunnel is THE case where ground geometry stops being a heightfield:
 * crown and invert share one column. So it is NOT voxels and NOT a
 * heightfield edit — it is a STATION GRAPH: every 0.5 m of advance is a
 * node carrying position, support state and a live handle on the fine-tier
 * soil state. Hundreds of nodes cost nothing; only failure (a later batch)
 * ever writes back to the heightfield.
 *
 * Structural model (design §8, underground edition — batch A computes and
 * displays it live; timers and collapse come later):
 *  - ARCHING: above ~2 spans of cover the ground does not hang over the
 *    opening as dead weight — shear along the silo walls transfers load to
 *    the sides. Terzaghi's silo formula caps the crown load well below
 *    gamma*C. Shallow cover (<2 spans) takes the full weight.
 *  - STAND-UP: cohesive soil holds an unsupported span for minutes to hours
 *    (the 4c/gamma critical-face family); sand and silt hold ~zero.
 *    Timber sets are the player's answer.
 *  - SUPPORT: a timber set + lagging pushes back with ~300 kPa allowable.
 *  - WATER IS THE KILLER: the factor of safety is recomputed from the LIVE
 *    fine-tier state every query — rain raises pore pressure, the Fredlund
 *    chain drops c_eff, and a tunnel that stood all dry season decays after
 *    one storm. No scripted failure: it falls out of shared state.
 *
 * Conservation: excavation books bulk volume in this.audit and places the
 * same dry mass as loose spoil (fill factor 0.8, +25% bulk) at the portal
 * through the micro-tier ledger. Muck mined while the portal is outside the
 * 16 m micro window waits in muckPendingM3 and is flushed the moment the
 * window covers the portal again — the ledger never forgets (spec §4).
 */
import * as THREE from "three";
import { TerrainData, sampleHeight } from "./terrain";
import { Ground } from "./ground";
import { MicroTerrain, SoilTouch } from "./contact";

const ADVANCE_M = 0.5; // station spacing along the axis
export const TUNNEL_SPAN = 2.0; // arch width [m]
export const TUNNEL_WALL_H = 0.85; // vertical sidewall height [m]
export const TUNNEL_R = TUNNEL_SPAN / 2; // crown semicircle radius [m]
export const TUNNEL_HEIGHT = TUNNEL_WALL_H + TUNNEL_R; // 1.85 m
const MAX_STATIONS = 240; // 120 m of drivage — enough for this world
const TIMBER_Q = 300; // allowable pressure of a timber set + lagging [kPa]
const PORTAL_COVER_MIN = 0.55; // crown cover required at the mouth [m]

/** cross-section ring (lateral s, height h) — closed loop, invert → crown → invert */
const RING: [number, number][] = (() => {
  const pts: [number, number][] = [];
  pts.push([-TUNNEL_R, 0]);
  pts.push([-TUNNEL_R, TUNNEL_WALL_H]);
  for (let a = 1; a <= 8; a++) {
    const th = Math.PI - (Math.PI * a) / 8;
    pts.push([Math.cos(th) * TUNNEL_R, TUNNEL_WALL_H + Math.sin(th) * TUNNEL_R]);
  }
  pts.push([TUNNEL_R, 0]);
  pts.push([TUNNEL_R * 0.5, 0]);
  pts.push([0, 0]);
  pts.push([-TUNNEL_R * 0.5, 0]);
  return pts;
})();

export interface TunnelStroke {
  volumeM3: number;
  hard: boolean;
  suction: boolean;
  stations: number;
}

export interface StationFS {
  index: number;
  coverM: number;
  loadKpa: number;
  capKpa: number;
  fs: number;
  supported: boolean;
}

export class Tunnel {
  private stations: {
    x: number; z: number;
    support: 0 | 1;
  }[] = [];
  private dirX = 0;
  private dirZ = 1;
  private yaw = 0;
  private invertY = 0;
  private portalX = 0;
  private portalZ = 0;
  /** terrain push at the portal cut [m] and the cut box (centre offsets from portal) */
  private portalPush = 0;
  private boxBack = -0.7; // box centre along-axis offset from the portal [m]
  private boxHalfAlong = 0.85;
  private boxHalfAcross = TUNNEL_R + 0.5;

  /** conservation ledger (spec §4) */
  audit = {
    excavatedM3: 0, // bulk volume removed from the cavity
    spoilBulkM3: 0, // bulk volume landed as portal spoil (micro ledger)
    muckPendingM3: 0, // bulk spoil waiting for the micro window to cover the portal
    dryMassKg: 0, // dry mass excavated (= mass handed to the micro ledger)
    strokes: 0,
  };
  private rngState = 0x5eed1234;

  private tubeMesh: THREE.Mesh | null = null;
  private faceMesh: THREE.Mesh | null = null;
  private timberPosts!: THREE.InstancedMesh;
  private timberCollars!: THREE.InstancedMesh;
  private timberBoards!: THREE.InstancedMesh;

  constructor(private scene: THREE.Scene, private terrain: TerrainData, private ground: Ground) {
    this.buildTimber();
  }

  get active() { return this.stations.length > 0; }
  get count() { return this.stations.length; }
  get lengthM() { return Math.max(0, (this.stations.length - 1) * ADVANCE_M); }
  crownY() { return this.invertY + TUNNEL_HEIGHT; }
  /** heading unit vector + yaw (engine wires the portal shader boxes) */
  dirVec() { return { x: this.dirX, z: this.dirZ, yaw: this.yaw }; }

  private rng() { // seeded LCG — determinism (spec §6)
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  // ------------------------------------------------------------------ create
  /**
   * Cut a portal into a hillside. Requires rising ground along the facing
   * (arching needs cover to develop) and non-liquid soil (a mud portal
   * slurries shut — Atterberg gate).
   */
  create(portalX: number, portalZ: number, dirX: number, dirZ: number): { ok: boolean; reason?: string } {
    if (this.active) return { ok: false, reason: "One tunnel per world in this build" };
    const len = Math.hypot(dirX, dirZ) || 1;
    this.dirX = dirX / len; this.dirZ = dirZ / len;
    this.yaw = Math.atan2(this.dirX, this.dirZ);
    const thPortal = sampleHeight(this.terrain, portalX + 384, portalZ + 384);
    // the world's regional slopes are gentle (~10°); the gate asks for real
    // cover development within 2.5 m — the clay bank and steeper noses pass
    const thAhead = sampleHeight(this.terrain, portalX + this.dirX * 2.5 + 384, portalZ + this.dirZ * 2.5 + 384);
    if (thAhead - thPortal < 0.3) return { ok: false, reason: "Need a hillside — flat ground gives no cover" };
    const rep = this.ground.cellReport(portalX, portalZ);
    if (rep.consistency === 2) return { ok: false, reason: "LIQUID ground — a portal here would slurry shut" };
    this.portalX = portalX; this.portalZ = portalZ;
    this.invertY = thPortal - TUNNEL_HEIGHT - PORTAL_COVER_MIN;
    this.portalPush = thPortal - this.invertY;
    this.stations = [{ x: portalX, z: portalZ, support: 0 }];
    this.audit = { excavatedM3: 0, spoilBulkM3: 0, muckPendingM3: 0, dryMassKg: 0, strokes: 0 };
    this.rebuildMeshes();
    return { ok: true };
  }

  /** portal cut box for the terrain/overlay shaders + physics ramp */
  portalBox(): { cx: number; cz: number; halfAlong: number; halfAcross: number; push: number } {
    return {
      cx: this.portalX + this.dirX * this.boxBack,
      cz: this.portalZ + this.dirZ * this.boxBack,
      halfAlong: this.boxHalfAlong, halfAcross: this.boxHalfAcross, push: this.portalPush,
    };
  }

  // ----------------------------------------------------------------- advance
  /** one spade-stroke round of drivage: a station, its muck, its sound */
  advance(micro: MicroTerrain): TunnelStroke {
    const last = this.stations[this.stations.length - 1];
    const x = last.x + this.dirX * ADVANCE_M;
    const z = last.z + this.dirZ * ADVANCE_M;
    const s: SoilTouch = micro.touchAt(x, z);
    const rep = this.ground.cellReport(x, z);
    const tex = rep.texture;
    const hard = rep.consistency === 0 && rep.wPct < tex.PL * 0.75;
    const suction = rep.sr > 0.9 && rep.wPct > tex.PL;

    // cavity volume: arch section × advance (walls + semicircular crown)
    const area = TUNNEL_SPAN * TUNNEL_WALL_H + Math.PI * TUNNEL_R * TUNNEL_R * 0.5;
    const bulk = area * ADVANCE_M;
    const dryMass = bulk * tex.rhoDry * (1 - tex.thetaS * Math.max(rep.sr, 0.08));

    // the same dry mass leaves as loose spoil (+25% bulk, fill factor 0.8) —
    // at the portal if the micro window covers it, else into the pending bin
    const spoilBulk = bulk / 0.8;
    const dpx = this.portalX - micro.originX();
    const dpz = this.portalZ - micro.originZ();
    if (Math.abs(dpx) < 7.2 && Math.abs(dpz) < 7.2) {
      this.placeMuck(micro, spoilBulk, s);
    } else {
      this.audit.muckPendingM3 += spoilBulk;
    }

    // fine tier: the ground above a shallow drive is disturbed (structure
    // broken, Ks up) — deep drives leave the surface alone (cover > 1.5 m)
    const thAbove = sampleHeight(this.terrain, x + 384, z + 384);
    if (thAbove - this.crownY() < 1.5) this.ground.markDug(x, z);

    this.stations.push({ x, z, support: 0 });
    this.audit.excavatedM3 += bulk;
    this.audit.dryMassKg += dryMass;
    this.audit.strokes++;
    this.rebuildMeshes();
    return { volumeM3: bulk, hard, suction, stations: this.stations.length };
  }

  /** drop a spoil cone at the portal side (deterministic alternation) */
  private placeMuck(micro: MicroTerrain, bulk: number, s: SoilTouch) {
    const side = this.audit.strokes % 2 === 0 ? 1 : -1;
    const toss = 0.9 + this.rng() * 0.6;
    const px = this.portalX - this.dirZ * side * toss - this.dirX * 1.1;
    const pz = this.portalZ + this.dirX * side * toss - this.dirZ * 1.1;
    micro.dropSpoil(px, pz, Math.min(bulk, 3.2), s, this.yaw);
    this.audit.spoilBulkM3 += Math.min(bulk, 3.2);
  }

  /** flush pending muck when the micro window returns to the portal */
  flushMuck(micro: MicroTerrain) {
    if (this.audit.muckPendingM3 <= 0.01 || !this.active) return;
    const dpx = this.portalX - micro.originX();
    const dpz = this.portalZ - micro.originZ();
    if (Math.abs(dpx) >= 7.2 || Math.abs(dpz) >= 7.2) return;
    const s = micro.touchAt(this.portalX, this.portalZ);
    while (this.audit.muckPendingM3 > 0.01) {
      const v = Math.min(this.audit.muckPendingM3, 3.2);
      this.placeMuck(micro, v, s);
      this.audit.muckPendingM3 -= v;
    }
  }

  /** raise a timber set at the station the player stands in (R) */
  placeTimber(x: number, z: number): { ok: boolean; reason?: string; index?: number } {
    const p = this.project(x, z);
    if (!p || p.t < -0.5 || p.t > this.lengthM + 0.5) return { ok: false, reason: "Not in the tunnel" };
    const idx = Math.max(0, Math.min(Math.round(p.t / ADVANCE_M), this.stations.length - 1));
    if (this.stations[idx].support === 1) return { ok: false, reason: "Set already standing here", index: idx };
    this.stations[idx].support = 1;
    this.rebuildTimber();
    return { ok: true, index: idx };
  }

  // ------------------------------------------------------------------- query
  /** axis projection: t along the tunnel [m], lateral offset [m] */
  project(x: number, z: number): { t: number; lat: number } | null {
    if (!this.active) return null;
    const dx = x - this.portalX, dz = z - this.portalZ;
    return { t: dx * this.dirX + dz * this.dirZ, lat: -dx * this.dirZ + dz * this.dirX };
  }

  /** 2D footprint of the tube (caller gates by height) */
  insideTube(x: number, z: number): boolean {
    const p = this.project(x, z);
    return !!p && p.t >= -0.35 && p.t <= this.lengthM + 0.25 && Math.abs(p.lat) <= TUNNEL_R + 0.2;
  }

  /** is the player close enough to the face to drive it (F)? */
  nearFace(x: number, z: number, radius: number): boolean {
    if (!this.active) return false;
    const p = this.project(x, z);
    if (!p) return false;
    const faceT = this.lengthM;
    return Math.abs(p.t - faceT) <= radius && Math.abs(p.lat) <= TUNNEL_R + 0.6;
  }

  /** four-resistance probe at the live face (engine gates the round on it) */
  probeFace(): { hard: boolean; suction: boolean } {
    if (!this.active) return { hard: false, suction: false };
    const last = this.stations[this.stations.length - 1];
    const rep = this.ground.cellReport(last.x, last.z);
    const tex = rep.texture;
    return {
      hard: rep.consistency === 0 && rep.wPct < tex.PL * 0.75,
      suction: rep.sr > 0.9 && rep.wPct > tex.PL,
    };
  }

  /** current face position + mid-height (dust / audio anchor for the engine) */
  facePos(): { x: number; y: number; z: number } {
    const last = this.stations[this.stations.length - 1];
    return { x: last.x, y: this.invertY + TUNNEL_HEIGHT * 0.5, z: last.z };
  }

  /**
   * Physics floor: the tube invert inside the footprint; the portal cut ramp
   * (matching the shader smoothstep exactly) in the cut box; null elsewhere.
   * Gate the TUBE floor by player height (a surface walker above the drive
   * keeps the terrain floor) — the cut box needs no gate: it is an open cut.
   */
  floorAt(x: number, z: number, terrainH: number, playerY: number): number | null {
    if (!this.active) return null;
    if (this.insideTube(x, z) && playerY < this.crownY() + 0.25) return this.invertY;
    const b = this.portalBox();
    const dx = x - b.cx, dz = z - b.cz;
    const along = dx * this.dirX + dz * this.dirZ;
    const lat = -dx * this.dirZ + dz * this.dirX;
    const m = Math.max(Math.abs(along) - b.halfAlong, Math.abs(lat) - b.halfAcross);
    if (m < 0.6) {
      const tt = Math.min(Math.max((m - 0) / 0.6, 0), 1);
      const sMask = 1 - tt * tt * (3 - 2 * tt); // 1 inside → 0 outside
      return Math.max(this.invertY, terrainH - b.push * sMask);
    }
    return null;
  }

  /** clamp the player into the tube cross-section (walls + face; the mouth
   *  side stays open so the miner can walk back out — entry AND exit) */
  clampToTube(x: number, z: number): { x: number; z: number } {
    if (this.lengthM < ADVANCE_M) return { x, z }; // mouth stub: no walls yet
    const p = this.project(x, z)!;
    const t = Math.min(Math.max(p.t, -0.3), this.lengthM - 0.45);
    const lat = Math.min(Math.max(p.lat, -(TUNNEL_R - 0.35)), TUNNEL_R - 0.35);
    return { x: this.portalX + this.dirX * t - this.dirZ * lat, z: this.portalZ + this.dirZ * t + this.dirX * lat };
  }

  /** clamp the third-person camera into the bore (walls + roof + mouth) */
  clampPointToTube(x: number, y: number, z: number): { x: number; y: number; z: number } {
    if (this.lengthM < 2 * ADVANCE_M) return { x, y, z }; // too short to clamp
    const p = this.project(x, z)!;
    const t = Math.min(Math.max(p.t, -0.1), this.lengthM - 0.3);
    const lat = Math.min(Math.max(p.lat, -(TUNNEL_R - 0.28)), TUNNEL_R - 0.28);
    const yy = Math.min(Math.max(y, this.invertY + 0.5), this.crownY() - 0.14);
    return {
      x: this.portalX + this.dirX * t - this.dirZ * lat,
      y: yy,
      z: this.portalZ + this.dirZ * t + this.dirX * lat,
    };
  }

  /**
   * Live factor of safety at the station nearest the player. Crown load:
   * Terzaghi silo (arching caps it below gamma*C). Capacity: timber set
   * allowable + the soil's own Nc·c_eff. Recomputed from CURRENT fine-tier
   * state — a storm is a live degradation, not a scripted event.
   */
  fsAt(x: number, z: number): StationFS | null {
    const p = this.project(x, z);
    if (!p || !this.active) return null;
    const idx = Math.max(0, Math.min(Math.round(p.t / ADVANCE_M), this.stations.length - 1));
    const st = this.stations[idx];
    const rep = this.ground.cellReport(st.x, st.z);
    const th = sampleHeight(this.terrain, st.x + 384, st.z + 384);
    const cover = th - this.crownY();
    const gamma = rep.texture.gammaDry + rep.texture.thetaS * rep.sr * 9.81; // kN/m3 bulk
    const phi = Math.max(rep.phiEffDeg, 8) * Math.PI / 180;
    const K = 1.0; // at-rest-ish lateral ratio for the silo walls
    const tanp = Math.max(Math.tan(phi), 0.08);
    const B = TUNNEL_SPAN;
    const silo = (gamma * B) / (2 * K * tanp) * (1 - Math.exp((-2 * K * tanp * Math.max(cover, 0)) / B));
    const load = Math.min(silo, gamma * Math.max(cover, 0)); // arching can't exceed the full column
    const cap = (st.support === 1 ? TIMBER_Q : 0) + 5.14 * rep.cEffKpa; // Nc ≈ 5.14
    return {
      index: idx,
      coverM: cover,
      loadKpa: load,
      capKpa: cap,
      fs: cap / Math.max(load, 0.1),
      supported: st.support === 1,
    };
  }

  // ------------------------------------------------------------------ render
  private buildTimber() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4f2e, roughness: 0.92 });
    this.timberPosts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, TUNNEL_WALL_H + 0.1, 0.14), wood, 512);
    this.timberCollars = new THREE.InstancedMesh(new THREE.BoxGeometry(TUNNEL_SPAN - 0.06, 0.16, 0.14), wood, 256);
    this.timberBoards = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 0.05, 0.55), wood.clone(), 768);
    for (const m of [this.timberPosts, this.timberCollars, this.timberBoards]) {
      m.count = 0;
      m.castShadow = true;
      m.frustumCulled = false;
      this.scene.add(m);
    }
  }

  private rebuildTimber() {
    const m4 = new THREE.Matrix4();
    const rotY = new THREE.Matrix4().makeRotationY(this.yaw);
    const base = new THREE.Matrix4();
    let np = 0, nc = 0, nb = 0;
    for (const st of this.stations) {
      if (st.support !== 1) continue;
      base.makeTranslation(st.x, this.invertY, st.z);
      for (const side of [-1, 1]) {
        m4.copy(base).multiply(rotY)
          .multiply(new THREE.Matrix4().makeTranslation(side * (TUNNEL_R - 0.12), (TUNNEL_WALL_H + 0.1) / 2, 0));
        this.timberPosts.setMatrixAt(np++, m4);
      }
      m4.copy(base).multiply(rotY)
        .multiply(new THREE.Matrix4().makeTranslation(0, TUNNEL_WALL_H + 0.08, 0));
      this.timberCollars.setMatrixAt(nc++, m4);
      for (const phiDeg of [90, 135, 45]) {
        const ph = (phiDeg * Math.PI) / 180;
        m4.copy(base).multiply(rotY)
          .multiply(new THREE.Matrix4().makeRotationZ(-ph))
          .multiply(new THREE.Matrix4().makeTranslation(0, TUNNEL_R - 0.06, 0));
        this.timberBoards.setMatrixAt(nb++, m4);
      }
      if (np > 500 || nc > 250 || nb > 750) break;
    }
    this.timberPosts.count = np; this.timberCollars.count = nc; this.timberBoards.count = nb;
    this.timberPosts.instanceMatrix.needsUpdate = true;
    this.timberCollars.instanceMatrix.needsUpdate = true;
    this.timberBoards.instanceMatrix.needsUpdate = true;
  }

  /** rebuild the tube + face cap (hundreds of stations = trivial geometry) */
  private rebuildMeshes() {
    if (this.tubeMesh) { this.scene.remove(this.tubeMesh); this.tubeMesh.geometry.dispose(); }
    if (this.faceMesh) { this.scene.remove(this.faceMesh); this.faceMesh.geometry.dispose(); }
    this.tubeMesh = null; this.faceMesh = null;
    if (!this.active) { this.rebuildTimber(); return; }

    // ring stations: mouth (t=-0.35) + every station
    const ts: number[] = [-0.35];
    for (let i = 0; i < this.stations.length; i++) ts.push(i * ADVANCE_M);
    const rings = ts.map((t) => ({
      x: this.portalX + this.dirX * t,
      z: this.portalZ + this.dirZ * t,
    }));
    const perpX = -this.dirZ, perpZ = this.dirX;
    const pos = new Float32Array(rings.length * RING.length * 3);
    const col = new Float32Array(rings.length * RING.length * 3);
    let v = 0;
    for (let r = 0; r < rings.length; r++) {
      // damp, dark invert rising to slightly warmer crown — readable interior
      const depth = r / (rings.length - 1);
      for (const [s, h] of RING) {
        pos[v * 3] = rings[r].x + perpX * s;
        pos[v * 3 + 1] = this.invertY + h;
        pos[v * 3 + 2] = rings[r].z + perpZ * s;
        const shade = h < 0.05 ? 0.30 : 0.24 + 0.10 * (h / TUNNEL_HEIGHT);
        col[v * 3] = shade * (1 - 0.15 * depth);
        col[v * 3 + 1] = shade * 0.86 * (1 - 0.12 * depth);
        col[v * 3 + 2] = shade * 0.72;
        v++;
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < rings.length - 1; r++) {
      for (let i = 0; i < RING.length; i++) {
        const a = r * RING.length + i;
        const b = r * RING.length + (i + 1) % RING.length;
        const c = (r + 1) * RING.length + i;
        const d = (r + 1) * RING.length + (i + 1) % RING.length;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // DoubleSide: three flips normals on back-facing fragments, so the
    // interior is lit correctly regardless of winding
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, side: THREE.DoubleSide });
    this.tubeMesh = new THREE.Mesh(geo, mat);
    this.tubeMesh.receiveShadow = true;
    this.scene.add(this.tubeMesh);

    // face cap: the arch profile filled, recessed slightly behind the face
    const face = this.stations[this.stations.length - 1];
    const fx = face.x - this.dirX * 0.03, fz = face.z - this.dirZ * 0.03;
    const cPos: number[] = [fx, this.invertY + TUNNEL_HEIGHT * 0.45, fz];
    const cIdx: number[] = [];
    const cCol: number[] = [0.16, 0.13, 0.10];
    for (let i = 0; i < RING.length; i++) {
      const [s, h] = RING[i];
      cPos.push(fx + perpX * s, this.invertY + h, fz + perpZ * s);
      cCol.push(0.17, 0.14, 0.11);
    }
    for (let i = 0; i < RING.length; i++) {
      cIdx.push(0, 1 + i, 1 + ((i + 1) % RING.length));
    }
    const cGeo = new THREE.BufferGeometry();
    cGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cPos), 3));
    cGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cCol), 3));
    cGeo.setIndex(cIdx);
    cGeo.computeVertexNormals();
    this.faceMesh = new THREE.Mesh(cGeo, mat.clone());
    this.faceMesh.receiveShadow = true;
    this.scene.add(this.faceMesh);
    this.rebuildTimber();
  }

  /** station graph + pending muck for the inspector / ledger */
  report() {
    let supported = 0;
    for (const st of this.stations) if (st.support === 1) supported++;
    return {
      stations: this.stations.length,
      lengthM: +this.lengthM.toFixed(1),
      supported,
      unsupported: this.stations.length - supported,
      ...this.audit,
    };
  }

  reset() {
    this.stations = [];
    this.audit = { excavatedM3: 0, spoilBulkM3: 0, muckPendingM3: 0, dryMassKg: 0, strokes: 0 };
    this.rebuildMeshes();
  }

  dispose() {
    this.reset();
    for (const m of [this.timberPosts, this.timberCollars, this.timberBoards]) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
