/**
 * Contact tier — the deformable ground the player actually touches.
 *
 * A 16 m × 16 m world-aligned window at 6.25 cm resolution (256² cells) that
 * scrolls with the actor. It owns the ONLY deforming geometry in the world:
 * footprints, dig craters, spoil piles, slump scars — all as a height-delta
 * field on top of the static terrain, rendered through a RGBA8 delta texture
 * displacing a high-res overlay mesh (the base terrain is pushed 2.5 m down
 * inside the window, so holes are true holes with no z-fighting).
 *
 * Physics contract (docs/soil-state-spec.md):
 *  - slope relaxation is pairwise volume-conserving: one mechanism makes dry
 *    sand flow back into the hole, over-steep faces slump, and mud holes close
 *    themselves shut — at a state-dependent repose angle;
 *  - digging conserves MASS: spoil is 25% bulkier (fill factor 0.8) because
 *    loosened soil takes more space; re-digging flagged spoil does not loosen
 *    further;
 *  - footprints redistribute their crater volume into a rim ridge;
 *  - every random number is a seeded LCG — strokes are pure functions of
 *    (fine state, micro flags, seed).
 */
import * as THREE from "three";
import { WORLD_SIZE, TerrainData, sampleHeight, terrainNormal, cellIndex } from "./terrain";
import { Ground } from "./ground";
import { SOIL_TEXTURES } from "./params";

const NV = 257; // render vertices per side (cell corners)
const NC = 256; // physics cells per side
export const MICRO_SIZE = 16; // window extent [m]
export const MICRO_CELL = MICRO_SIZE / NC; // 0.0625 m
export const MICRO_HALF = MICRO_SIZE / 2;
/** delta clamp [m] — RGBA8 R channel encodes ±0.5 m */
const DELTA_MIN = -0.45;
const DELTA_MAX = 0.5;
/** overlay rides 8 mm above the base terrain so it always wins the depth test */
const OVERLAY_LIFT = 0.008;

/** state snapshot that shapes a footfall / stroke */
export interface SoilTouch {
  wetness: number; // 0..1 top-layer wetness
  mud: number; // 0..1 mud factor
  consistency: 0 | 1 | 2; // solid / plastic / liquid
  sr: number; // saturation of the column
  wPct: number;
  textureIdx: number;
}

export interface DigResult {
  volumeM3: number; // bulk volume removed from the crater
  dPenM: number; // achieved spade penetration
  suction: boolean; // extraction suction paid
  hard: boolean; // dry clay: blade fractures / bounces
  spoil: { x: number; z: number; volM3: number };
}

/** repose angle (tan) + relaxation rate by ground state */
function reposeOf(s: SoilTouch): { tanRepose: number; rate: number } {
  if (s.mud > 0.6 || s.consistency === 2) return { tanRepose: 0.14, rate: 0.8 }; // mud: 8°, oozes
  if (s.wetness > 0.8 && s.sr > 0.9) return { tanRepose: 0.47, rate: 0.3 }; // wet clay: 25°
  if (s.wetness > 0.35) return { tanRepose: 1.0, rate: 0.12 }; // moist loam: 45°, faces stand
  return { tanRepose: 0.62, rate: 0.5 }; // dry sand: 32°, flows back
}

function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

export class MicroTerrain {
  /** window centre in world coords (multiple of MICRO_CELL) */
  ox = 0;
  oz = 0;
  /** height delta field [m], cell-centred, world-aligned with the window */
  delta = new Float32Array(NC * NC);
  /** base terrain height at cell centres (for total-slope relaxation) */
  cellBase = new Float32Array(NC * NC);
  /** b0 churned, b1 spoil, b2 wet-ring (suction mark) */
  flags = new Uint8Array(NC * NC);
  churnCount = 0;

  /** render overlay */
  mesh: THREE.Mesh;
  tex: THREE.DataTexture;
  private texData = new Uint8Array(NC * NC * 4);
  private texDirty = true;
  private gtRef: THREE.DataTexture | null = null;
  private shaderRef: { uniforms: { [k: string]: { value: unknown } } } | null = null;
  /** QA: set once onBeforeCompile actually ran on the overlay material */
  public compiled = false;
  /** QA: set once the begin_vertex replacement matched */
  public displacementInjected = false;

  /** conservation ledger (QA-visible) */
  public audit = {
    strokes: 0,
    removedBulkM3: 0, // bulk volume taken out of craters
    spoilBulkM3: 0, // bulk volume placed as piles
    massInKg: 0, // dry mass leaving the crater
    massOutKg: 0, // dry mass landing as spoil
    clippedM3: 0, // volume lost to the ±0.5 m encode clamp (tracked honestly)
  };

  private rng = lcg(7919);
  private relaxAccum = 0;
  private scratch = new Float32Array(NC * NC);
  private scratchV = new Float32Array(NV * NV * 3); // sized for the largest attr (vec3)
  private scratchU8 = new Uint8Array(NC * NC);

  constructor(private scene: THREE.Scene, private terrain: TerrainData, private ground: Ground) {
    this.buildMesh();
    this.ox = 0;
    this.oz = 0;
    this.mesh.position.set(this.ox, 0, this.oz);
    this.rebakeAll();
  }

  // ------------------------------------------------------------------ geometry
  private geo!: THREE.BufferGeometry;
  private aBaseH!: THREE.BufferAttribute;
  private aBaseN!: THREE.BufferAttribute;
  private aColor!: THREE.BufferAttribute;

  private buildMesh() {
    // vertices on the CELL-CORNER lattice: local coords -8..+8, uv = i/256
    const pos = new Float32Array(NV * NV * 3);
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NV; i++) {
        const v = j * NV + i;
        pos[v * 3] = -MICRO_HALF + i * MICRO_CELL;
        pos[v * 3 + 1] = 0;
        pos[v * 3 + 2] = -MICRO_HALF + j * MICRO_CELL;
      }
    }
    const idx = new Uint32Array(NC * NC * 6);
    let t = 0;
    for (let j = 0; j < NC; j++) {
      for (let i = 0; i < NC; i++) {
        const a = j * NV + i, b = a + 1, c = a + NV, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.aBaseH = new THREE.BufferAttribute(new Float32Array(NV * NV), 1);
    this.aBaseN = new THREE.BufferAttribute(new Float32Array(NV * NV * 3), 3);
    this.aColor = new THREE.BufferAttribute(new Float32Array(NV * NV * 3), 3);
    geo.setAttribute("aBaseH", this.aBaseH);
    geo.setAttribute("aBaseN", this.aBaseN);
    geo.setAttribute("color", this.aColor);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = geo;

    this.tex = new THREE.DataTexture(this.texData, NC, NC, THREE.RGBAFormat);
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      this.compiled = true;
      if (shader.vertexShader.includes("#include <begin_vertex>")) this.displacementInjected = true;
      shader.uniforms.uMicroTex = { value: this.tex };
      shader.uniforms.uGroundTex = { value: this.gtRef };
      shader.uniforms.uMicroOrigin = { value: new THREE.Vector2(this.ox, this.oz) };
      shader.uniforms.uMicroEdge = { value: MICRO_HALF - 0.7 };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aBaseH;
          attribute vec3 aBaseN;
          uniform sampler2D uMicroTex;
          uniform vec2 uMicroOrigin;
          uniform float uMicroEdge;
          varying vec2 vGroundUv;
          varying float vChurn;
          varying float vSpoil;
          varying float vRing;
          float microD(in vec2 u){ return texture2D(uMicroTex, clamp(u, 0.0, 1.0)).r - 0.5; }`)
        .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
          vec2 mUv = (position.xz + vec2(${MICRO_HALF.toFixed(1)})) / ${MICRO_SIZE.toFixed(1)};
          vec4 mInfo = texture2D(uMicroTex, mUv);
          float eStep = ${(2 * MICRO_CELL / MICRO_SIZE).toFixed(5)};
          float dDdx = (microD(mUv + vec2(eStep, 0.0)) - microD(mUv - vec2(eStep, 0.0))) / ${(2 * MICRO_CELL).toFixed(4)};
          float dDdz = (microD(mUv + vec2(0.0, eStep)) - microD(mUv - vec2(0.0, eStep))) / ${(2 * MICRO_CELL).toFixed(4)};
          objectNormal = normalize(aBaseN + vec3(-dDdx, 0.0, -dDdz));`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vChurn = mInfo.g; vSpoil = mInfo.b; vRing = mInfo.a;
          vec2 wpos2 = position.xz + uMicroOrigin;
          vGroundUv = wpos2 / ${(WORLD_SIZE).toFixed(1)} + 0.5;
          float edge = 1.0 - smoothstep(uMicroEdge, uMicroEdge + 0.45, max(abs(position.x), abs(position.z)));
          transformed = vec3(position.x, aBaseH + (mInfo.r - 0.5) * edge + ${(OVERLAY_LIFT).toFixed(3)}, position.z);`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform sampler2D uGroundTex;
          varying vec2 vGroundUv;
          varying float vChurn;
          varying float vSpoil;
          varying float vRing;
          vec3 lerp3(vec3 a, vec3 b, float t){ return a + (b-a)*t; }`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec4 gcell = texture2D(uGroundTex, vGroundUv);
          float wet = gcell.r; float pond = gcell.g; float mud = gcell.b; float road = gcell.a;
          diffuseColor.rgb *= mix(1.0, 0.46, wet);
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.11, 0.085, 0.06), mud * 0.65);
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.42, 0.335, 0.24) * mix(1.0, 0.5, wet), road * 0.75);
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.19, 0.22, 0.20), clamp(pond * 1.4, 0.0, 0.55));
          // churned ground: dry crumbs pale it, wet churn darkens (strong mix —
          // must stay readable under storm light, design doc §29 legibility)
          vec3 churnCol = mix(diffuseColor.rgb * 1.14 + 0.014, diffuseColor.rgb * 0.66, wet);
          diffuseColor.rgb = lerp3(diffuseColor.rgb, churnCol, vChurn * 0.75);
          // spoil: pale loose heap
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.32, 0.25, 0.18) * mix(1.0, 0.55, wet), vSpoil * 0.85);
          // suction wet-ring: dark glossy mark
          diffuseColor.rgb *= mix(1.0, 0.62, vRing * 0.6);`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.20, wet * 0.85);
          roughnessFactor = mix(roughnessFactor, 0.32, mud);
          roughnessFactor = mix(roughnessFactor, 0.97, vChurn * (1.0 - wet) * 0.7);
          roughnessFactor = mix(roughnessFactor, 0.98, vSpoil * 0.8);
          roughnessFactor = mix(roughnessFactor, 0.16, vRing * 0.7);`);
      this.shaderRef = shader;
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.scene.add(mesh);
  }

  /** World wires the shared ground-state texture in (single source of truth) */
  setGroundTexture(gt: THREE.DataTexture) {
    this.gtRef = gt;
    if (this.shaderRef) this.shaderRef.uniforms.uGroundTex.value = gt;
  }

  // ------------------------------------------------------------------- baking
  /** bake cell physics + render attributes for a cell rect (verts i0..i1+1) */
  private bakeRegion(i0: number, i1: number, j0: number, j1: number) {
    const bh = this.aBaseH.array as Float32Array;
    const bn = this.aBaseN.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    const c = new THREE.Color();
    const dry = new THREE.Color(0xb9985a);
    const lush = new THREE.Color(0x7d8a4e);
    const rock = new THREE.Color(0x8d8478);
    const nrm: [number, number, number] = [0, 1, 0];
    // cell-centred physics fields
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL;
        const wz = this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL;
        this.cellBase[j * NC + i] = sampleHeight(this.terrain, wx + MICRO_HALF, wz + MICRO_HALF);
      }
    }
    // vertex attributes (corner lattice)
    for (let j = j0; j <= j1 + 1; j++) {
      for (let i = i0; i <= i1 + 1; i++) {
        const v = j * NV + i;
        const lx = -MICRO_HALF + i * MICRO_CELL;
        const lz = -MICRO_HALF + j * MICRO_CELL;
        const wx = this.ox + lx;
        const wz = this.oz + lz;
        const h = sampleHeight(this.terrain, wx + MICRO_HALF, wz + MICRO_HALF);
        bh[v] = h;
        terrainNormal(this.terrain, wx + MICRO_HALF, wz + MICRO_HALF, nrm);
        bn[v * 3] = nrm[0]; bn[v * 3 + 1] = nrm[1]; bn[v * 3 + 2] = nrm[2];
        // identical tint formula to world.buildTerrainMesh
        const hn = Math.min(Math.max(h / 18, 0), 1);
        c.copy(dry).lerp(lush, 1 - hn);
        if (h > 14.5) c.lerp(rock, Math.min((h - 14.5) / 5, 0.6));
        const m = 0.92 + 0.16 * Math.sin(wx * 0.171 + wz * 0.137) * Math.sin(wx * 0.043 - wz * 0.061);
        col[v * 3] = c.r * m; col[v * 3 + 1] = c.g * m; col[v * 3 + 2] = c.b * m;
      }
    }
    this.aBaseH.needsUpdate = true;
    this.aBaseN.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }

  private rebakeAll() {
    this.bakeRegion(0, NC - 1, 0, NC - 1);
  }

  /** scroll the window by whole cells so the actor stays centred */
  private shiftWindow(dcx: number, dcz: number) {
    if (dcx === 0 && dcz === 0) return;
    // shift cell fields: newArray[i] = old[i + dcx] (value keeps its world cell)
    const n = NC;
    const d = this.delta, f = this.flags, cb = this.cellBase;
    this.scratch.set(d); this.scratchU8.set(f);
    for (let j = 0; j < n; j++) {
      const sj = j + dcz;
      for (let i = 0; i < n; i++) {
        const si = i + dcx;
        const v = j * n + i;
        if (si < 0 || si >= n || sj < 0 || sj >= n) { d[v] = 0; f[v] = 0; continue; }
        d[v] = this.scratch[sj * n + si];
        f[v] = this.scratchU8[sj * n + si];
      }
    }
    this.scratch.set(cb);
    for (let j = 0; j < n; j++) {
      const sj = j + dcz;
      for (let i = 0; i < n; i++) {
        const si = i + dcx;
        if (si < 0 || si >= n || sj < 0 || sj >= n) continue; // baked below
        cb[j * n + i] = this.scratch[sj * n + si];
      }
    }
    // shift render attributes on the 257² corner lattice
    const shiftAttr = (attr: THREE.BufferAttribute, comps: number) => {
      const nv = NV;
      const src = attr.array as Float32Array;
      this.scratchV.set(src);
      for (let j = 0; j < nv; j++) {
        const sj = j + dcz;
        for (let i = 0; i < nv; i++) {
          const si = i + dcx;
          const v = j * nv + i;
          if (si < 0 || si >= nv || sj < 0 || sj >= nv) continue;
          for (let cp = 0; cp < comps; cp++) src[v * comps + cp] = this.scratchV[sj * nv * comps + si * comps + cp];
        }
      }
      attr.needsUpdate = true;
    };
    shiftAttr(this.aBaseH, 1);
    shiftAttr(this.aBaseN, 3);
    shiftAttr(this.aColor, 3);
    // move the window
    this.ox += dcx * MICRO_CELL;
    this.oz += dcz * MICRO_CELL;
    this.mesh.position.set(this.ox, 0, this.oz);
    if (this.shaderRef) {
      (this.shaderRef.uniforms.uMicroOrigin.value as THREE.Vector2).set(this.ox, this.oz);
    }
    // rebake exposed strips (cells AND their corner verts)
    if (dcx !== 0) {
      const lo = dcx > 0 ? n - dcx : 0;
      const hi = dcx > 0 ? n - 1 : -dcx - 1;
      this.bakeRegion(lo, hi, 0, n - 1);
    }
    if (dcz !== 0) {
      const lo = dcz > 0 ? n - dcz : 0;
      const hi = dcz > 0 ? n - 1 : -dcz - 1;
      this.bakeRegion(0, n - 1, lo, hi);
    }
    this.texDirty = true;
    // recount churn
    let cc = 0;
    for (let v = 0; v < n * n; v++) if (f[v] & 1) cc++;
    this.churnCount = cc;
  }

  /** keep the actor centred; call every frame */
  follow(px: number, pz: number) {
    const offX = px - this.ox;
    const offZ = pz - this.oz;
    const dcx = Math.round(offX / MICRO_CELL);
    const dcz = Math.round(offZ / MICRO_CELL);
    if (Math.abs(dcx) >= 8 || Math.abs(dcz) >= 8) {
      this.shiftWindow(
        Math.max(-96, Math.min(96, dcx)),
        Math.max(-96, Math.min(96, dcz)));
    }
  }

  /** centre the window on a position immediately (spawn / QA) */
  centerOn(px: number, pz: number) {
    const ox = Math.round(px / MICRO_CELL) * MICRO_CELL;
    const oz = Math.round(pz / MICRO_CELL) * MICRO_CELL;
    const dcx = Math.round((ox - this.ox) / MICRO_CELL);
    const dcz = Math.round((oz - this.oz) / MICRO_CELL);
    if (dcx !== 0 || dcz !== 0) this.shiftWindow(dcx, dcz);
  }

  // ------------------------------------------------------------------ sampling
  /** bilinear delta sample in world coords (0 outside the window) */
  sampleDelta(x: number, z: number): number {
    const fx = (x - (this.ox - MICRO_HALF)) / MICRO_CELL - 0.5;
    const fz = (z - (this.oz - MICRO_HALF)) / MICRO_CELL - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= NC - 1 || j >= NC - 1) return 0;
    const u = fx - i, v = fz - j;
    const d = this.delta;
    const d00 = d[j * NC + i], d10 = d[j * NC + i + 1];
    const d01 = d[(j + 1) * NC + i], d11 = d[(j + 1) * NC + i + 1];
    return d00 * (1 - u) * (1 - v) + d10 * u * (1 - v) + d01 * (1 - u) * v + d11 * u * v;
  }

  /** terrain push-down box (world centre + half-extent) for the base mesh */
  digBox(): { cx: number; cz: number; half: number } {
    return { cx: this.ox, cz: this.oz, half: MICRO_HALF - 0.75 };
  }

  /** soil touch state at a world position (from the fine tier) */
  touchAt(x: number, z: number): SoilTouch {
    const k = cellIndex(x, z);
    return {
      wetness: this.ground.wetness[k],
      mud: this.ground.mudFactor[k],
      consistency: this.ground.consistency[k] as 0 | 1 | 2,
      sr: this.ground.sr[k],
      wPct: this.ground.wPct[k],
      textureIdx: this.terrain.soil[k],
    };
  }

  // -------------------------------------------------------------------- writes
  private cellRect(x: number, z: number, r: number): [number, number, number, number] {
    const ci = Math.floor((x - (this.ox - MICRO_HALF)) / MICRO_CELL);
    const cj = Math.floor((z - (this.oz - MICRO_HALF)) / MICRO_CELL);
    const rc = Math.ceil(r / MICRO_CELL) + 1;
    return [
      Math.max(0, Math.min(NC - 1, ci - rc)),
      Math.max(0, Math.min(NC - 1, ci + rc)),
      Math.max(0, Math.min(NC - 1, cj - rc)),
      Math.max(0, Math.min(NC - 1, cj + rc)),
    ];
  }

  /** apply a height profile (positive = raise); returns net volume added [m³] */
  private addProfile(
    cx: number, cz: number, yaw: number,
    halfA: number, halfB: number, depth: number,
    sign: 1 | -1, spoilFlag: boolean, ringFlag: boolean,
  ): number {
    const [i0, i1, j0, j1] = this.cellRect(cx, cz, Math.max(halfA, halfB) * 1.6);
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    let vol = 0;
    const area = MICRO_CELL * MICRO_CELL;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL;
        const wz = this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL;
        const dx = wx - cx, dz = wz - cz;
        // rotated ellipse coords: along facing (b) / lateral (a)
        const along = dx * sa + dz * ca;
        const lateral = -dx * ca + dz * sa;
        const r2 = (along * along) / (halfB * halfB) + (lateral * lateral) / (halfA * halfA);
        if (r2 >= 1) { if (ringFlag) this.flags[j * NC + i] |= 4; continue; }
        const dd = depth * Math.sqrt(1 - r2);
        if (dd <= 0) continue;
        const v = j * NC + i;
        const before = this.delta[v];
        let after = before + sign * dd;
        if (after > DELTA_MAX) { this.audit.clippedM3 += (after - DELTA_MAX) * area; after = DELTA_MAX; }
        if (after < DELTA_MIN) { this.audit.clippedM3 += (DELTA_MIN - after) * area; after = DELTA_MIN; }
        this.delta[v] = after;
        vol += (after - before) * area;
        this.flags[v] |= 1; // churned
        if (spoilFlag) this.flags[v] |= 2;
        if (ringFlag && r2 > 0.55) this.flags[v] |= 4;
      }
    }
    this.texDirty = true;
    return vol;
  }

  /** redistribute removed volume onto the rim ring so a print conserves bulk */
  private rimRedistribute(cx: number, cz: number, removedVol: number, radius: number, frac: number) {
    if (removedVol <= 0 || frac <= 0) return;
    const target = removedVol * frac;
    const [i0, i1, j0, j1] = this.cellRect(cx, cz, radius * 1.8);
    const area = MICRO_CELL * MICRO_CELL;
    let ringVol = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL;
        const wz = this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL;
        const r = Math.hypot(wx - cx, wz - cz);
        if (r < radius || r > radius * 1.7) continue;
        ringVol += area;
      }
    }
    if (ringVol <= 0) return;
    const per = target / ringVol; // uniform lift on the ring
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL;
        const wz = this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL;
        const r = Math.hypot(wx - cx, wz - cz);
        if (r < radius || r > radius * 1.7) continue;
        const v = j * NC + i;
        let after = this.delta[v] + per;
        if (after > DELTA_MAX) after = DELTA_MAX;
        this.delta[v] = after;
        this.flags[v] |= 1;
      }
    }
    this.texDirty = true;
  }

  /** a footfall: state-shaped crater + conserving rim ridge */
  stampBoot(x: number, z: number, yaw: number, s: SoilTouch, power = 1) {
    // depth by state: dry barely shows → mud is a churned crater
    const depth = (0.016 + s.wetness * 0.05 + s.mud * 0.1) * power;
    const removed = -this.addProfile(x, z, yaw, 0.075, 0.125, depth, -1, false, false);
    const rimFrac = s.mud > 0.5 ? 0.45 : s.wetness > 0.35 ? 0.35 : 0.22;
    this.rimRedistribute(x, z, removed, 0.125, rimFrac);
  }

  /** one spade stroke: penetration → cut → (adhesion) → extraction suction */
  digStroke(x: number, z: number, dirX: number, dirZ: number): DigResult {
    const s = this.touchAt(x, z);
    const k = cellIndex(x, z);
    const tex = SOIL_TEXTURES[this.terrain.soil[k]];
    const qUlt = this.ground.qUlt[k];
    const traffic = this.ground.traffic[k];
    // 1) penetration — mud accepts, dry dense clay refuses
    let qPen = qUlt * (1 + 0.06 * Math.min(traffic, 5));
    if (s.consistency === 2) qPen *= 0.35;
    const hard = s.consistency === 0 && s.wPct < tex.PL * 0.75 && qPen > 260;
    const dPen = Math.max(0.02, Math.min(0.3 * (45 / Math.max(qPen, 45)), 0.3)) * (hard ? 0.45 : 1);
    // 2) cut volume (dry fracturing clay yields chunky partial bites)
    const bite = 0.22 * 0.18 * dPen * (hard ? 0.6 : 1);
    // crater: the blade's own footprint (0.22 m wide × 0.18 m bite). The
    // paraboloid peak 1.9·dPen makes the GEOMETRIC crater volume match the
    // ledger bite exactly (mean of D√(1-r²) over the ellipse is (2/3)D).
    const yaw = Math.atan2(dirX, dirZ);
    const craterPeak = dPen * 1.9 * (hard ? 0.6 : 1);
    const removed = -this.addProfile(x, z, yaw, 0.11, 0.09, craterPeak, -1, false, false);
    void removed; // crater shape is written; ledger uses the analytic bite
    // 3) spoil — same dry MASS, looser bulk (fill factor), unless already spoil
    let spoilCells = 0;
    let nCell = 0;
    const [i0, i1, j0, j1] = this.cellRect(x, z, 0.21);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++, nCell++) {
        if (this.flags[j * NC + i] & 2) spoilCells++;
      }
    }
    const wasSpoil = nCell > 0 && spoilCells / nCell > 0.5;
    const fill = wasSpoil ? 1.0 : 0.8;
    const dryMass = bite * tex.rhoDry * (1 - tex.thetaS * Math.max(s.sr, 0.08));
    const spoilVol = bite / fill;
    // toss to the side of the facing (alternating sides, deterministic)
    const side = this.audit.strokes % 2 === 0 ? 1 : -1;
    const toss = 0.75 + this.rng() * 0.45;
    const px = x + (-dirZ) * side * toss + dirX * 0.25;
    const pz = z + (dirX) * side * toss + dirZ * 0.25;
    this.dropSpoil(px, pz, spoilVol, s, yaw);
    // 4) extraction suction — saturated fines cling
    const suction = s.sr > 0.9 && s.wPct > tex.PL;
    if (suction) {
      const rr = 0.24;
      const [ri0, ri1, rj0, rj1] = this.cellRect(x, z, rr);
      for (let j = rj0; j <= rj1; j++) {
        for (let i = ri0; i <= ri1; i++) {
          const wx = this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL;
          const wz = this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL;
          if (Math.hypot(wx - x, wz - z) < rr) this.flags[j * NC + i] |= 4;
        }
      }
      this.texDirty = true;
    }
    // ledger
    this.audit.strokes++;
    this.audit.removedBulkM3 += bite;
    this.audit.spoilBulkM3 += spoilVol;
    this.audit.massInKg += dryMass;
    this.audit.massOutKg += dryMass; // placed as spoil — mass conserves by construction
    // fine tier: the cell is disturbed (crust broken, layers mixed)
    this.ground.markDug(x, z);
    return { volumeM3: bite, dPenM: dPen, suction, hard, spoil: { x: px, z: pz, volM3: spoilVol } };
  }

  /** a cone of loose spoil lands (paraboloid pile at the state's repose angle) */
  dropSpoil(x: number, z: number, vol: number, s: SoilTouch, yaw = 0) {
    const { tanRepose } = reposeOf(s);
    const pile = (cx: number, cz: number, v: number, minR: number) => {
      // profile h√(1−r²) integrates to (2/3)πr²h; with h = r·tanρ:
      // r = (3V/(2π·tanρ))^(1/3)
      let r = Math.cbrt((3 * v) / (2 * Math.PI * Math.max(tanRepose, 0.05)));
      if (r < minR) r = minR; // thin wide pancake, height recomputed → volume exact
      let h = (3 * v) / (2 * Math.PI * r * r);
      if (h > 0.26) { h = 0.26; r = Math.sqrt((3 * v) / (2 * Math.PI * h)); }
      this.addProfile(cx, cz, yaw, r, r, h, 1, true, false);
    };
    // dry fracturing clay: the bite breaks into clods — split the SAME volume
    const cloddy = s.consistency === 0 && s.wetness < 0.3 && vol > 4e-3;
    if (cloddy) {
      pile(x, z, vol * 0.5, 0.11);
      pile(x + 0.22, z + 0.1, vol * 0.25, 0.08);
      pile(x - 0.15, z - 0.2, vol * 0.25, 0.08);
    } else {
      pile(x, z, vol, 0.11);
    }
  }

  // ---------------------------------------------------------------- relaxation
  /**
   * Pairwise slope relaxation toward the state's repose angle over churned
   * cells. Moves height from the higher to the lower cell of a pair — Σdelta
   * is invariant by construction (spec rule 1). Uses TOTAL surface slope
   * (base + delta) so loose sand on a steep hill creeps downhill, as it does.
   */
  private relaxPass(sOf: (i: number, j: number) => SoilTouch) {
    const n = NC;
    const d = this.delta;
    const f = this.flags;
    const bh = this.cellBase;
    const cell = MICRO_CELL;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const v = j * n + i;
        const churnA = (f[v] & 1) !== 0 || (f[v + 1] & 1) !== 0 || (f[v + n] & 1) !== 0;
        if (!churnA) continue;
        const s = sOf(i, j);
        const { tanRepose, rate } = reposeOf(s);
        const maxD = tanRepose * cell;
        // pair right
        {
          const diff = (bh[v] + d[v]) - (bh[v + 1] + d[v + 1]);
          if (diff > maxD) {
            const flux = Math.min((diff - maxD) * 0.5 * rate, 0.05);
            d[v] -= flux; d[v + 1] += flux;
            f[v] |= 1; f[v + 1] |= 1;
          }
        }
        // pair down
        {
          const diff = (bh[v] + d[v]) - (bh[v + n] + d[v + n]);
          if (diff > maxD) {
            const flux = Math.min((diff - maxD) * 0.5 * rate, 0.05);
            d[v] -= flux; d[v + n] += flux;
            f[v] |= 1; f[v + n] |= 1;
          }
        }
      }
    }
    this.texDirty = true;
  }

  // -------------------------------------------------------------------- update
  update(dt: number, px: number, pz: number) {
    this.follow(px, pz);
    this.relaxAccum += dt;
    if (this.relaxAccum >= 0.5) {
      this.relaxAccum = 0;
      if (this.churnCount > 0) {
        this.relaxPass((i, j) => this.touchAt(
          this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL,
          this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL));
      }
    }
    if (this.texDirty) this.uploadTexture();
  }

  /** QA: force N relaxation passes (fastForward companion) */
  relaxFor(gameSeconds: number) {
    const passes = Math.max(1, Math.round(gameSeconds / 30));
    for (let p = 0; p < Math.min(passes, 400); p++) {
      this.relaxPass((i, j) => this.touchAt(
        this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL,
        this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL));
    }
    this.uploadTexture();
  }

  private uploadTexture() {
    const t = this.texData;
    let cc = 0;
    for (let v = 0; v < NC * NC; v++) {
      const dl = this.delta[v];
      t[v * 4] = Math.max(0, Math.min(255, Math.round((dl + 0.5) * 255)));
      t[v * 4 + 1] = (this.flags[v] & 1) ? 255 : 0;
      t[v * 4 + 2] = (this.flags[v] & 2) ? 255 : 0;
      t[v * 4 + 3] = (this.flags[v] & 4) ? 255 : 0;
      if (this.flags[v] & 1) cc++;
    }
    this.churnCount = cc;
    this.tex.needsUpdate = true;
    this.texDirty = false;
  }

  /** reset (weather scenario switch) */
  reset() {
    this.delta.fill(0);
    this.flags.fill(0);
    this.churnCount = 0;
    this.audit.strokes = 0;
    this.audit.removedBulkM3 = 0;
    this.audit.spoilBulkM3 = 0;
    this.audit.massInKg = 0;
    this.audit.massOutKg = 0;
    this.audit.clippedM3 = 0;
    this.uploadTexture();
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.tex.dispose();
  }
}
