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
 *
 * Flood & spade (spec §9–§11):
 *  - the window is a CACHE, not the world: scrolled-out edits persist in a
 *    sparse world store keyed by 6.25 cm world-cell and are restored on
 *    return — a hole you dig stays dug wherever you walk (spec §11);
 *  - a sub-grid WATER FILM lives here at contact resolution. The fine tier
 *    owns the water mass; while the window covers a fine cell its pond is ON
 *    LOAN down here, routed pairwise toward the lowest local surface — so
 *    water finds dug holes, spills out of them at the rim and hands off to
 *    the fine tier at the window edge. Every transfer is booked (spec §9);
 *  - rain detaches and flow entrains SEDIMENT at this resolution where the
 *    window stands (the fine tier does the same everywhere else): loose
 *    churn/spoil erodes first, deposition re-builds loose ground downhill,
 *    and the kg ledger closes exactly (spec §10).
 */
import * as THREE from "three";
import { WORLD_SIZE, GRID, TerrainData, sampleHeight, terrainNormal, cellIndex } from "./terrain";
import { Ground } from "./ground";
import { SOIL_TEXTURES } from "./params";

const NV = 257; // render vertices per side (cell corners)
const NC = 256; // physics cells per side
export const MICRO_SIZE = 16; // window extent [m]
export const MICRO_CELL = MICRO_SIZE / NC; // 0.0625 m
export const MICRO_HALF = MICRO_SIZE / 2;
const GRID_HALF = WORLD_SIZE / 2; // world → terrain-grid frame shift
/** delta clamp [m] — RGBA8 R channel encodes ±1.5 m (quadratic: sub-cm
 *  resolution near 0 for footprints, ~1.7 cm at full range for tunnel
 *  portal notches, muck heaps and collapse scars) */
const DELTA_MIN = -1.45;
const DELTA_MAX = 1.5;
export const DELTA_ENCODE = 1.5; // encoded magnitude of the R channel
/** overlay rides 8 mm above the base terrain so it always wins the depth test */
const OVERLAY_LIFT = 0.008;
const CELL_AREA = MICRO_CELL * MICRO_CELL; // 3.90625e-3 m²
const FINE_CELL = WORLD_SIZE / GRID; // 4 m
const FINE_AREA = FINE_CELL * FINE_CELL;
/** water-surface offset encode for the film texture R channel (quadratic,
 *  ±2 m: a brim-full 1.45 m hole still encodes) */
const WATER_ENCODE = 2.0;
/** water depth encode for the film texture G channel [m] */
const WATER_DEPTH_ENCODE = 0.75;
/** world-cell index range at 6.25 cm over ±384 m → 0..12288 */
const WCELLS = Math.round(WORLD_SIZE / MICRO_CELL); // 12288
/** world-cell index offset (signed ±6144 → unsigned 0..12288) */
const WOFF = WCELLS / 2;

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

  /** ------------------------------------------------------------------ water film
   *  sub-grid ponded water [m depth] — mass ON LOAN from the fine tier.
   *  Routed pairwise toward the lowest local surface (base + delta + film),
   *  so water physically finds dug holes and spills at their rims. */
  hWater = new Float32Array(NC * NC);
  /** suspended sediment load per micro cell [kg] (spec §10) */
  sedLoad = new Float32Array(NC * NC);
  /** routed water volume through each cell this tick [m³] (erosion shear) */
  flowMag = new Float32Array(NC * NC);
  /** water ledger (QA-visible; the fine tier stays the mass owner) */
  public waterLedger = {
    loanNetM3: 0, // net fine → micro transfers (negative: returned)
    edgeOutM3: 0, // micro → fine handoffs at the window edge
    evapM3: 0, // film evaporated to the atmosphere
    infiltM3: 0, // film infiltrated into the fine soil column
  };
  /** sediment ledger (spec §10 — closes to the kg) */
  public sedLedger = {
    detachedKg: 0, // raindrop + flow detachment from the bed
    depositedKg: 0, // load dropped where capacity fell
    handoffKg: 0, // load returned to the fine tier (edge / scroll-out)
  };
  /** world-persistent edits: key = world cell (6.25 cm grid), value packs
   *  (delta_mm + 1600) * 8 + flags — the window is a cache, this is the disk */
  private worldEdits = new Map<number, number>();

  /** water render overlay (shares the ground overlay's static geometry) */
  waterMesh: THREE.Mesh;
  waterTex: THREE.DataTexture;
  private waterTexData = new Uint8Array(NC * NC * 4);
  private waterUniforms: { [k: string]: { value: unknown } };

  /** conservation ledger (QA-visible) */
  public audit = {
    strokes: 0,
    removedBulkM3: 0, // bulk volume taken out of craters
    spoilBulkM3: 0, // bulk volume placed as piles
    massInKg: 0, // dry mass leaving the crater
    massOutKg: 0, // dry mass landing as spoil
    clippedM3: 0, // volume lost to the ±0.5 m encode clamp (tracked honestly)
    persistDriftM3: 0, // mm-quantisation drift from the world store (booked)
  };

  private rng = lcg(7919);
  private relaxAccum = 0;
  private scratch = new Float32Array(NC * NC);
  private scratchV = new Float32Array(NV * NV * 3); // sized for the largest attr (vec3)
  private scratchU8 = new Uint8Array(NC * NC);
  private scratchW = new Float32Array(NC * NC);
  private scratchS = new Float32Array(NC * NC);
  /** micro column/row → fine-cell index (rebuilt each couple tick) */
  private colFine = new Uint16Array(NC);
  private rowFine = new Uint16Array(NC);
  /** monotone per-fine-cell column/row ranges inside the window */
  private colLo = new Int16Array(GRID);
  private colHi = new Int16Array(GRID);
  private rowLo = new Int16Array(GRID);
  private rowHi = new Int16Array(GRID);
  /** per-fine-cell accumulators for the loan relaxation */
  private accSurf = new Float32Array(GRID * GRID);
  private accDepth = new Float32Array(GRID * GRID);
  private accCnt = new Float32Array(GRID * GRID);

  constructor(private scene: THREE.Scene, private terrain: TerrainData, private ground: Ground) {
    this.buildMesh();
    this.buildWaterMesh();
    this.ox = 0;
    this.oz = 0;
    this.mesh.position.set(this.ox, 0, this.oz);
    this.waterMesh.position.set(this.ox, 0, this.oz);
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
      // portal cut (tunnel.ts): the same rotated smoothstep box the terrain
      // shader uses — the overlay must open where the hillside is cut, or a
      // flat sheet of fake ground would cap the adit mouth
      shader.uniforms.uPortal = { value: new THREE.Vector4(0, 0, 0, 0) };
      shader.uniforms.uPortalDir = { value: new THREE.Vector2(0, 1) };
      shader.uniforms.uPortalPush = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          attribute float aBaseH;
          attribute vec3 aBaseN;
          uniform sampler2D uMicroTex;
          uniform vec2 uMicroOrigin;
          uniform float uMicroEdge;
          uniform vec4 uPortal;
          uniform vec2 uPortalDir;
          uniform float uPortalPush;
          varying vec2 vGroundUv;
          varying float vChurn;
          varying float vSpoil;
          varying float vRing;
          // quadratic decode: byte 128 = 0 m, ±127 = ±1.5 m; sub-cm near 0
          float microD(in vec2 u){
            float b = texture2D(uMicroTex, clamp(u, 0.0, 1.0)).r;
            return sign(b - 0.5) * ${DELTA_ENCODE.toFixed(1)} * pow(abs(b - 0.5) * 2.0, 2.0);
          }`)
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
          // portal cut mask (matches the terrain shader's, rotated to the
          // adit axis — uPortalDir is the unit heading, .zw the half-extents)
          vec2 prel = wpos2 - uPortal.xy;
          vec2 prot = vec2(prel.x * uPortalDir.x + prel.y * uPortalDir.y,
                           -prel.x * uPortalDir.y + prel.y * uPortalDir.x);
          vec2 dpo = vec2(abs(prot.x) - uPortal.z, abs(prot.y) - uPortal.w);
          float inPortal = 1.0 - smoothstep(0.0, 0.6, max(dpo.x, dpo.y));
          transformed = vec3(position.x, aBaseH + microD(mUv) * edge + ${(OVERLAY_LIFT).toFixed(3)} - uPortalPush * inPortal, position.z);`);
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
      if (this.pendingPortal) {
        const p = this.pendingPortal;
        (shader.uniforms.uPortal.value as THREE.Vector4).set(p.cx, p.cz, p.halfAlong, p.halfAcross);
        (shader.uniforms.uPortalDir.value as THREE.Vector2).set(p.dirX, p.dirZ);
        shader.uniforms.uPortalPush.value = p.push;
        this.pendingPortal = null;
      }
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.scene.add(mesh);
  }

  /**
   * The water film render: a transparent sheet sharing the ground overlay's
   * static geometry, displaced per-vertex by a RGBA8 film texture —
   * R = surface offset above base terrain (quadratic ±2 m, same trick as the
   * delta channel), G = depth (0..0.75 m). The sheet exists only inside the
   * 16 m window; outside it the fine-tier puddle mesh owns the water.
   */
  private buildWaterMesh() {
    this.waterTex = new THREE.DataTexture(this.waterTexData, NC, NC, THREE.RGBAFormat);
    this.waterTex.minFilter = THREE.LinearFilter;
    this.waterTex.magFilter = THREE.LinearFilter;
    this.waterTex.needsUpdate = true;
    const uniforms: { [k: string]: { value: unknown } } = {
      uWaterTex: { value: this.waterTex },
      uMicroOrigin: { value: new THREE.Vector2(0, 0) },
      uMicroEdge: { value: MICRO_HALF - 0.55 },
      uTime: { value: 0 },
      uRain: { value: 0 },
      uSky: { value: new THREE.Color(0x8fa3b5) },
      uSun: { value: new THREE.Color(0xffd9a8) },
      uSunDir: { value: new THREE.Vector3(0.5, 0.4, -0.6) },
      uFogColor: { value: new THREE.Color(0xe6d2ac) },
      uFogDensity: { value: 0.0026 },
      uCamPos: { value: new THREE.Vector3() },
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms,
      vertexShader: `
        attribute float aBaseH;
        uniform sampler2D uWaterTex;
        uniform vec2 uMicroOrigin;
        uniform float uMicroEdge;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vEdge;
        float surfOff(in vec2 u){
          float b = texture2D(uWaterTex, clamp(u, 0.0, 1.0)).r;
          return sign(b - 0.5) * ${WATER_ENCODE.toFixed(1)} * pow(abs(b - 0.5) * 2.0, 2.0);
        }
        void main(){
          vec2 mUv = (position.xz + vec2(${MICRO_HALF.toFixed(1)})) / ${MICRO_SIZE.toFixed(1)};
          vec4 wInfo = texture2D(uWaterTex, mUv);
          vDepth = wInfo.g * ${WATER_DEPTH_ENCODE.toFixed(2)};
          vEdge = 1.0 - smoothstep(uMicroEdge, uMicroEdge + 0.45, max(abs(position.x), abs(position.z)));
          vec3 wp = vec3(position.x + uMicroOrigin.x, aBaseH + surfOff(mUv) + 0.02, position.z + uMicroOrigin.y);
          vWorld = wp;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, aBaseH + surfOff(mUv) + 0.02, position.z, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime, uRain, uFogDensity;
        uniform vec3 uSky, uSun, uSunDir, uFogColor, uCamPos;
        varying vec3 vWorld;
        varying float vDepth;
        varying float vEdge;
        void main(){
          if (vDepth < 0.0003) discard;
          // animated normal: two travelling wave fields + rain prickle
          vec2 p = vWorld.xz;
          float w1 = sin(p.x * 1.7 + uTime * 1.9) * cos(p.y * 1.3 - uTime * 1.4);
          float w2 = sin((p.x + p.y) * 2.6 + uTime * 2.7) * 0.5;
          float prickle = uRain * (sin(p.x * 23.0 + uTime * 12.0) * sin(p.y * 19.0 - uTime * 10.0));
          vec3 n = normalize(vec3(w1 * 0.05 + w2 * 0.05 + prickle * 0.09, 1.0, w2 * 0.05 - w1 * 0.04 + prickle * 0.08));
          vec3 v = normalize(uCamPos - vWorld);
          float fres = pow(1.0 - max(dot(v, n), 0.0), 2.2);
          float glint = pow(max(dot(reflect(-v, n), normalize(uSunDir)), 0.0), 60.0);
          vec3 col = uSky * (0.62 + 0.9 * fres);
          col += uSun * glint * 1.4;
          // shallow films read as a dark wet sheen; depth ramps to full water
          float dNorm = clamp((vDepth - 0.0003) / 0.05, 0.0, 1.0);
          float alpha = (0.46 + 0.46 * dNorm) * vEdge;
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dot(uCamPos - vWorld, uCamPos - vWorld));
          col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    const wm = new THREE.Mesh(this.geo, mat);
    wm.renderOrder = 5; // above the ground overlay (1) and fine puddles (4)
    wm.frustumCulled = false;
    wm.visible = false;
    this.waterUniforms = uniforms;
    this.waterMesh = wm;
    this.scene.add(wm);
  }

  /** per-frame visual env for the film (camera, sun, fog, rain) — engine wires it */
  setWaterEnv(t: number, rain: number, camPos: THREE.Vector3, sunDir: THREE.Vector3,
    sky: THREE.Color, sun: THREE.Color, fogColor: THREE.Color, fogDensity: number) {
    if (!this.waterMesh.visible) return;
    const u = this.waterUniforms;
    u.uTime.value = t;
    u.uRain.value = rain;
    (u.uCamPos.value as THREE.Vector3).copy(camPos);
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uSky.value as THREE.Color).copy(sky);
    (u.uSun.value as THREE.Color).copy(sun);
    (u.uFogColor.value as THREE.Color).copy(fogColor);
    u.uFogDensity.value = fogDensity;
  }

  /** World wires the shared ground-state texture in (single source of truth) */
  setGroundTexture(gt: THREE.DataTexture) {
    this.gtRef = gt;
    if (this.shaderRef) this.shaderRef.uniforms.uGroundTex.value = gt;
  }

  /** micro-window origin in world coords (tunnel muck routing queries it) */
  originX() { return this.ox; }
  originZ() { return this.oz; }

  /** the tunnel wires its portal cut in — overlay opens with the terrain */
  setPortalBox(cx: number, cz: number, halfAlong: number, halfAcross: number, push: number, dirX: number, dirZ: number) {
    if (!this.shaderRef) {
      this.pendingPortal = { cx, cz, halfAlong, halfAcross, push, dirX, dirZ };
      return;
    }
    (this.shaderRef.uniforms.uPortal.value as THREE.Vector4).set(cx, cz, halfAlong, halfAcross);
    (this.shaderRef.uniforms.uPortalDir.value as THREE.Vector2).set(dirX, dirZ);
    this.shaderRef.uniforms.uPortalPush.value = push;
  }
  private pendingPortal: { cx: number; cz: number; halfAlong: number; halfAcross: number; push: number; dirX: number; dirZ: number } | null = null;

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
        this.cellBase[j * NC + i] = sampleHeight(this.terrain, wx + GRID_HALF, wz + GRID_HALF);
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
        const h = sampleHeight(this.terrain, wx + GRID_HALF, wz + GRID_HALF);
        bh[v] = h;
        terrainNormal(this.terrain, wx + GRID_HALF, wz + GRID_HALF, nrm);
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
    const w = this.hWater, sl = this.sedLoad;
    this.scratch.set(d); this.scratchU8.set(f); this.scratchW.set(w); this.scratchS.set(sl);
    // cells about to LEAVE the window: persist their edits to the world store
    // and return loaned water / suspended load to the fine tier (the ledger
    // never forgets, and the world never forgets either — spec §9, §11)
    for (let sj = 0; sj < n; sj++) {
      for (let si = 0; si < n; si++) {
        const ni = si - dcx, nj = sj - dcz;
        if (ni >= 0 && ni < n && nj >= 0 && nj < n) continue;
        const v = sj * n + si;
        this.persistCell(si, sj);
        if (w[v] > 1e-7) {
          const vol = w[v] * CELL_AREA;
          this.ground.returnWater(vol,
            this.ox - MICRO_HALF + (si + 0.5) * MICRO_CELL,
            this.oz - MICRO_HALF + (sj + 0.5) * MICRO_CELL);
          this.waterLedger.loanNetM3 -= vol;
        }
        if (sl[v] > 1e-9) {
          this.ground.returnSediment(sl[v],
            this.ox - MICRO_HALF + (si + 0.5) * MICRO_CELL,
            this.oz - MICRO_HALF + (sj + 0.5) * MICRO_CELL);
          this.sedLedger.handoffKg += sl[v];
          sl[v] = 0;
        }
      }
    }
    for (let j = 0; j < n; j++) {
      const sj = j + dcz;
      for (let i = 0; i < n; i++) {
        const si = i + dcx;
        const v = j * n + i;
        if (si < 0 || si >= n || sj < 0 || sj >= n) {
          d[v] = 0; f[v] = 0; w[v] = 0; sl[v] = 0; continue;
        }
        d[v] = this.scratch[sj * n + si];
        f[v] = this.scratchU8[sj * n + si];
        w[v] = this.scratchW[sj * n + si];
        sl[v] = this.scratchS[sj * n + si];
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
    // cells ENTERING the window (new frame): restore their world-store edits
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const si = i + dcx, sj = j + dcz;
        if (si >= 0 && si < n && sj >= 0 && sj < n) continue;
        this.restoreCell(i, j);
      }
    }
    this.mesh.position.set(this.ox, 0, this.oz);
    this.waterMesh.position.set(this.ox, 0, this.oz);
    if (this.shaderRef) {
      (this.shaderRef.uniforms.uMicroOrigin.value as THREE.Vector2).set(this.ox, this.oz);
    }
    (this.waterUniforms.uMicroOrigin.value as THREE.Vector2).set(this.ox, this.oz);
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
    this.uploadWaterTexture();
    // recount churn
    let cc = 0;
    for (let v = 0; v < n * n; v++) if (f[v] & 1) cc++;
    this.churnCount = cc;
  }

  // -------------------------------------------------------------- world store
  /** pack a leaving cell into the sparse world store (mm-quantised, booked) */
  private persistCell(i: number, j: number) {
    const v = j * NC + i;
    const dl = this.delta[v];
    const fl = this.flags[v] & 7;
    // world cell = floor(world coords / 6.25 cm); ox is grid-aligned so the
    // arithmetic is exact: wci = ox/CELL − 128 + i (signed), + WOFF → 0..12287
    const wci = Math.round(this.ox / MICRO_CELL) - 128 + i + WOFF;
    const wcj = Math.round(this.oz / MICRO_CELL) - 128 + j + WOFF;
    if (wci < 0 || wci >= WCELLS || wcj < 0 || wcj >= WCELLS) return;
    const key = wci * 16384 + wcj;
    if (dl === 0 && fl === 0) { this.worldEdits.delete(key); return; }
    const q = Math.round(dl * 1000);
    // the store is mm-quantised: book the rounding so the volume ledger stays honest
    this.audit.persistDriftM3 += (q / 1000 - dl) * CELL_AREA;
    this.worldEdits.set(key, (q + 1600) * 8 + fl);
  }

  /** restore an entering cell from the world store (if it was ever edited) */
  private restoreCell(i: number, j: number) {
    const wci = Math.round(this.ox / MICRO_CELL) - 128 + i + WOFF;
    const wcj = Math.round(this.oz / MICRO_CELL) - 128 + j + WOFF;
    if (wci < 0 || wci >= WCELLS || wcj < 0 || wcj >= WCELLS) return;
    const val = this.worldEdits.get(wci * 16384 + wcj);
    if (val === undefined) return;
    this.delta[j * NC + i] = (Math.floor(val / 8) - 1600) / 1000;
    this.flags[j * NC + i] = val & 7;
    this.texDirty = true;
  }

  /** QA: how many world cells carry persisted edits */
  persistedEdits() { return this.worldEdits.size; }

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
    // 0) ground condition at the blade: churn flags + spoil + disturbance.
    // Broken ground opens up — the first strokes crack a hard crust, the
    // next ones bite deep (substantial digging, spec §11). Scan the BLADE
    // footprint (0.30 × 0.26 m), not a wider halo, so the fraction reads
    // the crater itself.
    let churnCells = 0;
    let spoilCells = 0;
    let nCell = 0;
    const [ci0, ci1, cj0, cj1] = this.cellRect(x, z, 0.16);
    for (let j = cj0; j <= cj1; j++) {
      for (let i = ci0; i <= ci1; i++, nCell++) {
        const fl = this.flags[j * NC + i];
        if (fl & 1) churnCells++;
        if (fl & 2) spoilCells++;
      }
    }
    const churnFrac = nCell > 0 ? churnCells / nCell : 0;
    // 1) penetration — mud accepts, dry dense clay refuses, broken bites
    let qPen = qUlt * (1 + 0.06 * Math.min(traffic, 5));
    if (s.consistency === 2) qPen *= 0.35;
    if (this.ground.disturbed[k] > 0) qPen *= 0.6; // structure broken
    qPen *= 1 - 0.5 * churnFrac; // cracked crust accepts the blade
    const hard = s.consistency === 0 && s.wPct < tex.PL * 0.75 && qPen > 260
      && churnFrac < 0.35; // broken ground is no longer virgin: the spade works
    const dPen = Math.max(0.03, Math.min(0.35 * (45 / Math.max(qPen, 45)), 0.35)) * (hard ? 0.45 : 1);
    // 2) cut volume — a proper long-handled spade: 0.30 m blade × 0.26 m
    // bite, ~2× the old bite at twice the cadence (substantial digging)
    const bite = 0.30 * 0.26 * dPen * (hard ? 0.6 : 1);
    // crater: the blade's own footprint (0.22 m wide × 0.18 m bite). The
    // paraboloid peak 1.9·dPen makes the GEOMETRIC crater volume match the
    // ledger bite exactly (mean of D√(1-r²) over the ellipse is (2/3)D).
    const yaw = Math.atan2(dirX, dirZ);
    const craterPeak = dPen * 1.9 * (hard ? 0.6 : 1);
    const removed = -this.addProfile(x, z, yaw, 0.15, 0.13, craterPeak, -1, false, false);
    void removed; // crater shape is written; ledger uses the analytic bite
    // 3) spoil — same dry MASS, looser bulk (fill factor), unless already spoil
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

  /**
   * Cut an oriented rect (a machine-cut notch — portal mouth, collapse scar)
   * down to an ABSOLUTE floor elevation; never raises ground. Unlike a spade
   * crater the cut is clean: cells are not churn-flagged, so slope relaxation
   * leaves the notch alone (the timbered headwall conceptually retains it —
   * free-sloughing portals arrive with the collapse batch).
   * Returns bank volume removed [m³] (0 where ground was already lower).
   */
  carveRect(
    cx: number, cz: number, yaw: number,
    halfLateral: number, alongA: number, alongB: number, floorY: number,
  ): number {
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const reach = Math.max(halfLateral, Math.abs(alongA), Math.abs(alongB)) * 1.35;
    const [i0, i1, j0, j1] = this.cellRect(cx, cz, reach);
    const area = MICRO_CELL * MICRO_CELL;
    let vol = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const wx = this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL;
        const wz = this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL;
        const dx = wx - cx, dz = wz - cz;
        const along = dx * sa + dz * ca;
        const lateral = -dx * ca + dz * sa;
        if (along < alongA || along > alongB) continue;
        if (Math.abs(lateral) > halfLateral) continue;
        const v = j * NC + i;
        const target = floorY - this.cellBase[v]; // delta that puts surface AT floorY
        if (target >= this.delta[v]) continue;   // already at/below the floor
        const before = this.delta[v];
        let after = Math.max(target, DELTA_MIN);
        if (target < DELTA_MIN) this.audit.clippedM3 += (DELTA_MIN - target) * area;
        this.delta[v] = after;
        vol += (before - after) * area;
      }
    }
    if (vol > 0) this.texDirty = true;
    return vol;
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
      if (h > 0.34) { h = 0.34; r = Math.sqrt((3 * v) / (2 * Math.PI * h)); }
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

  // ------------------------------------------------------------------ water film
  /**
   * One physics tick of the sub-grid water film (engine calls this right
   * after ground.update, with the SAME dtGame). Order: loan relaxation
   * against the grid → routing passes (water seeks the low ground) →
   * infiltration + evaporation at game-time rates → sediment → texture
   * upload. Every drop moved between tiers is booked in waterLedger.
   */
  coupleGround(dtGame: number, f: { tempC: number; rh: number; windMs: number; sw: number }) {
    // micro column/row → fine-cell map (centres; monotone, one 256 pass each)
    const n = NC;
    const x0 = this.ox - MICRO_HALF, z0 = this.oz - MICRO_HALF;
    const cf = this.colFine, rf = this.rowFine;
    for (let i = 0; i < n; i++)
      cf[i] = Math.max(0, Math.min(GRID - 1, Math.floor((x0 + (i + 0.5) * MICRO_CELL + 384) / FINE_CELL)));
    for (let j = 0; j < n; j++)
      rf[j] = Math.max(0, Math.min(GRID - 1, Math.floor((z0 + (j + 0.5) * MICRO_CELL + 384) / FINE_CELL)));
    // fast bail-out: dry window, no suspended load, no rain, and no grid pond
    // waiting above a covered cell → nothing to do (keeps the couple tick
    // near-free in the common dry case)
    let anyFilm = false;
    const hW = this.hWater;
    for (let v = 0; v < n * n; v++) { if (hW[v] > 1e-6) { anyFilm = true; break; } }
    const rainMmH = this.ground.rainAt(this.ox, this.oz);
    let anyLoad = false;
    if (!anyFilm) {
      const sl = this.sedLoad;
      for (let v = 0; v < n * n; v++) { if (sl[v] > 1e-9) { anyLoad = true; break; } }
    }
    // grid pond standing above a covered fine cell: water wants to come DOWN
    let gridPond = false;
    {
      const g0 = this.ground;
      const fiMin = cf[0], fiMax = cf[n - 1], fjMin = rf[0], fjMax = rf[n - 1];
      outer: for (let fj = fjMin; fj <= fjMax; fj++) {
        for (let fi = fiMin; fi <= fiMax; fi++) {
          if (g0.hPond[fj * GRID + fi] > 1e-4) { gridPond = true; break outer; }
        }
      }
    }
    const splashErosion = rainMmH > 0.5 && this.churnCount > 0;
    if (!anyFilm && !anyLoad && !splashErosion && !gridPond) {
      this.ground.loanPond.fill(0); // nothing on loan
      this.uploadWaterTexture();
      return;
    }
    this.loanRelax();
    this.routeWater(6);
    this.filmSoilWater(dtGame, f);
    this.sedimentTick(dtGame);
    this.uploadWaterTexture();
  }

  /**
   * Two-way surface-elevation relaxation with the fine tier, per fully
   * covered 4 m cell: the grid's pond is ON LOAN down here. Pull when the
   * grid water surface sits above the film's mean surface (rain/runon
   * arriving), push back when the film stands proud (mass exported uphill
   * of the grid's notion). Uniform lifts keep the exchange book-keeping
   * exact; a 1 mm deadband stops micro-sloshing.
   */
  private loanRelax() {
    const g = this.ground;
    g.loanPond.fill(0);
    const n = NC;
    const x0 = this.ox - MICRO_HALF, z0 = this.oz - MICRO_HALF;
    const x1 = this.ox + MICRO_HALF, z1 = this.oz + MICRO_HALF;
    const cf = this.colFine, rf = this.rowFine;
    // monotone maps → per-fine-cell column/row RANGES (one 256 pass each;
    // region writes below become bounded 64-wide strips, not 256² scans)
    const colLo = this.colLo, colHi = this.colHi, rowLo = this.rowLo, rowHi = this.rowHi;
    colLo.fill(-1); colHi.fill(-1); rowLo.fill(-1); rowHi.fill(-1);
    for (let i = 0; i < n; i++) {
      const fi = cf[i];
      if (colLo[fi] < 0) colLo[fi] = i;
      colHi[fi] = i;
    }
    for (let j = 0; j < n; j++) {
      const fj = rf[j];
      if (rowLo[fj] < 0) rowLo[fj] = j;
      rowHi[fj] = j;
    }
    // per-fine-cell accumulators over the window (≤ 5×5 cells touched)
    const accS = this.accSurf, accD = this.accDepth, accC = this.accCnt;
    accS.fill(0); accD.fill(0); accC.fill(0);
    for (let j = 0; j < n; j++) {
      const fj = rf[j];
      for (let i = 0; i < n; i++) {
        const k = fj * GRID + cf[i];
        const v = j * n + i;
        accS[k] += this.cellBase[v] + this.delta[v] + this.hWater[v];
        accD[k] += this.hWater[v];
        accC[k]++;
      }
    }
    // fine cells whose FULL 4 m extent lies inside the window: loan/push
    const fi0 = Math.max(0, Math.ceil((x0 + 384) / FINE_CELL));
    const fi1 = Math.min(GRID - 1, Math.floor((x1 + 384 - FINE_CELL) / FINE_CELL));
    const fj0 = Math.max(0, Math.ceil((z0 + 384) / FINE_CELL));
    const fj1 = Math.min(GRID - 1, Math.floor((z1 + 384 - FINE_CELL) / FINE_CELL));
    for (let fj = fj0; fj <= fj1; fj++) {
      const jLo = rowLo[fj], jHi = rowHi[fj];
      if (jLo < 0) continue;
      for (let fi = fi0; fi <= fi1; fi++) {
        const k = fj * GRID + fi;
        const cnt = accC[k];
        if (cnt < 16) continue; // no meaningful coverage
        const iLo = colLo[fi], iHi = colHi[fi];
        if (iLo < 0) continue;
        const regionArea = cnt * CELL_AREA;
        const mean = accS[k] / cnt;
        const target = g.nodeH(fi, fj) + g.hPond[k];
        if (mean < target - 1e-3 && g.hPond[k] > 1e-7) {
          // grid surface stands proud: loan water down (uniform lift)
          const dv = Math.min((target - mean) * regionArea, g.hPond[k] * FINE_AREA);
          if (dv > 0) {
            const lift = dv / regionArea;
            g.hPond[k] -= dv / FINE_AREA;
            for (let j = jLo; j <= jHi; j++) {
              const row = j * n;
              for (let i = iLo; i <= iHi; i++) this.hWater[row + i] += lift;
            }
            this.waterLedger.loanNetM3 += dv;
          }
        } else if (mean > target + 1e-3 && accD[k] > 1e-7) {
          // film stands proud of the grid: hand the excess back (uniform drop,
          // clamped at zero — book the ACTUAL removed volume so the identity
          // stays exact when shallow rim cells can't pay their share)
          const dv = Math.min((mean - target) * regionArea, accD[k] / cnt * regionArea);
          if (dv > 0) {
            const drop = dv / regionArea;
            let removed = 0;
            for (let j = jLo; j <= jHi; j++) {
              const row = j * n;
              for (let i = iLo; i <= iHi; i++) {
                const before = this.hWater[row + i];
                const after = Math.max(0, before - drop);
                this.hWater[row + i] = after;
                removed += (before - after) * CELL_AREA;
              }
            }
            if (removed > 0) {
              g.hPond[k] += removed / FINE_AREA;
              this.waterLedger.loanNetM3 -= removed;
            }
          }
        }
        // display depth for the minimap / ground texture
        g.loanPond[k] = accD[k] / cnt;
      }
    }
  }

  /**
   * Route the film pairwise toward the lower local surface (base + delta +
   * film), Gauss-Seidel ordered like relaxPass (deterministic, spec §6).
   * Multiple passes per tick let a sheet travel ~1 m/s toward a hole. Water
   * reaching the window edge hands off to the fine tier's pond — booked.
   */
  private routeWater(passes: number) {
    const n = NC;
    const hW = this.hWater, d = this.delta, bh = this.cellBase, fm = this.flowMag;
    fm.fill(0);
    for (let p = 0; p < passes; p++) {
      for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          const v = j * n + i;
          // pair right
          {
            const sa = bh[v] + d[v] + hW[v];
            const sb = bh[v + 1] + d[v + 1] + hW[v + 1];
            if (sa - sb > 1e-5 && hW[v] > 2e-5) {
              const dq = Math.min((sa - sb) * 0.5 * 0.85, hW[v]);
              hW[v] -= dq; hW[v + 1] += dq;
              fm[v] += dq * CELL_AREA; fm[v + 1] += dq * CELL_AREA;
            } else if (sb - sa > 1e-5 && hW[v + 1] > 2e-5) {
              const dq = Math.min((sb - sa) * 0.5 * 0.85, hW[v + 1]);
              hW[v + 1] -= dq; hW[v] += dq;
              fm[v] += dq * CELL_AREA; fm[v + 1] += dq * CELL_AREA;
            }
          }
          // pair down
          {
            const sa = bh[v] + d[v] + hW[v];
            const sb = bh[v + n] + d[v + n] + hW[v + n];
            if (sa - sb > 1e-5 && hW[v] > 2e-5) {
              const dq = Math.min((sa - sb) * 0.5 * 0.85, hW[v]);
              hW[v] -= dq; hW[v + n] += dq;
              fm[v] += dq * CELL_AREA; fm[v + n] += dq * CELL_AREA;
            } else if (sb - sa > 1e-5 && hW[v + n] > 2e-5) {
              const dq = Math.min((sb - sa) * 0.5 * 0.85, hW[v + n]);
              hW[v + n] -= dq; hW[v] += dq;
              fm[v] += dq * CELL_AREA; fm[v + n] += dq * CELL_AREA;
            }
          }
        }
      }
      this.edgeOutflow();
    }
  }

  /** window-edge spillover: the film hands water to the grid pond outside */
  private edgeOutflow() {
    const n = NC;
    const hW = this.hWater, d = this.delta, bh = this.cellBase;
    const g = this.ground;
    const tryOut = (v: number, wx: number, wz: number) => {
      if (hW[v] <= 2e-4) return;
      const k = cellIndex(wx, wz);
      const gi = k % GRID, gj = Math.floor(k / GRID);
      const surfOut = g.nodeH(gi, gj) + g.hPond[k];
      const surfIn = bh[v] + d[v] + hW[v];
      if (surfIn - surfOut > 2e-4) {
        const dq = Math.min((surfIn - surfOut) * 0.5 * 0.8, hW[v] - 1e-4);
        if (dq <= 0) return;
        hW[v] -= dq;
        g.hPond[k] += (dq * CELL_AREA) / FINE_AREA;
        this.waterLedger.edgeOutM3 += dq * CELL_AREA;
      }
    };
    for (let i = 0; i < n; i++) {
      tryOut(i, this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL, this.oz - MICRO_HALF - 0.05);
      tryOut((n - 1) * n + i, this.ox - MICRO_HALF + (i + 0.5) * MICRO_CELL, this.oz + MICRO_HALF + 0.05);
    }
    for (let j = 0; j < n; j++) {
      tryOut(j * n, this.ox - MICRO_HALF - 0.05, this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL);
      tryOut(j * n + n - 1, this.ox + MICRO_HALF + 0.05, this.oz - MICRO_HALF + (j + 0.5) * MICRO_CELL);
    }
  }

  /**
   * Film → soil: infiltration at the local state's Ks_eff (churn/spoil take
   * water faster — loose structure, spec §2), evaporation at the same
   * bulk-aerodynamic potential as the fine tier. Both write straight into
   * the fine column (θ₀, F) so there is exactly ONE soil moisture state.
   */
  private filmSoilWater(dtGame: number, f: { tempC: number; rh: number; windMs: number; sw: number }) {
    if (dtGame <= 0) return;
    const g = this.ground;
    const soil = this.terrain.soil;
    const theta0 = g.theta[0];
    const n = NC;
    // bulk-aerodynamic evaporation potential [m/s] (same fit as ground.ts)
    const esS = 0.6108 * Math.exp((17.27 * (f.tempC - 1)) / (f.tempC - 1 + 237.3));
    const ea = f.rh * 0.6108 * Math.exp((17.27 * f.tempC) / (f.tempC + 237.3));
    const qsS = 0.622 * esS / (101.3 - esS);
    const qa = 0.622 * ea / (101.3 - ea);
    const dq = Math.max(qsS - qa, 0);
    const ePot = (4e-3 * f.sw * (1 + 0.35 * f.windMs) * dq * 1.2) / 1000;
    const eD = ePot * dtGame; // m this tick
    // per fine-cell pass: one texture / state lookup, then its micro cells
    // (region = micro cells whose CENTRE falls in the fine cell — colFine map)
    const cf = this.colFine, rf = this.rowFine;
    const dz0 = 0.1; // top layer thickness (CFG.soilDz[0])
    for (let fj = 0; fj < GRID; fj++) {
      let anyRow = false;
      for (let j = 0; j < n; j++) { if (rf[j] === fj) { anyRow = true; break; } }
      if (!anyRow) continue;
      for (let fi = 0; fi < GRID; fi++) {
        const k = fj * GRID + fi;
        const tex = SOIL_TEXTURES[soil[k]];
        const seal = 1 - 0.35 * Math.min(g.keCum[k] / 800, 1);
        const kTraffic = 1 - 0.12 * Math.min(g.traffic[k], 5);
        const kDig = g.disturbed[k] > 0 ? 1.7 : 1;
        // storage cap: how much water the top layer can still accept [m³]
        const deficit = Math.max(tex.thetaS - theta0[k], 0) * dz0 * FINE_AREA;
        let infilVol = 0;
        let regionCells = 0;
        const microShare = deficit / (64 * 64); // per micro cell [m]
        for (let j = 0; j < n; j++) {
          if (rf[j] !== fj) continue;
          const row = j * n;
          for (let i = 0; i < n; i++) {
            if (cf[i] !== fi) continue;
            const v = row + i;
            regionCells++;
            if (this.hWater[v] <= 1e-6) continue;
            const loose = (this.flags[v] & 3) !== 0 ? 1.7 : 1; // churn/spoil drink fast
            const ks = (tex.kSatMmH / 3600 / 1000) * seal * kTraffic * kDig * loose;
            const infil = Math.min(this.hWater[v], ks * dtGame, microShare);
            this.hWater[v] -= infil;
            infilVol += infil * CELL_AREA;
            const evap = Math.min(this.hWater[v], eD);
            this.hWater[v] -= evap;
            this.waterLedger.evapM3 += evap * CELL_AREA;
          }
        }
        if (regionCells === 0) continue;
        if (infilVol > 0) {
          theta0[k] = Math.min(theta0[k] + infilVol / (dz0 * FINE_AREA), tex.thetaS);
          g.infiltF[k] += infilVol / FINE_AREA;
          g.wetFlux[k] = infilVol / FINE_AREA; // branch flip: this IS infiltration
          this.waterLedger.infiltM3 += infilVol;
        }
      }
    }
  }

  /**
   * Sediment tick (spec §10): raindrop detachment + flow entrainment where
   * the film routed volume gives shear above the state's critical value;
   * deposition where the load outruns capacity. Bed erosion writes the
   * delta field (real scars); deposition re-builds loose ground. The kg
   * ledger closes exactly: detached = deposited + handoff + Σload.
   */
  private sedimentTick(dtGame: number) {
    const n = NC;
    const g = this.ground;
    const soil = this.terrain.soil;
    const hW = this.hWater, d = this.delta, bh = this.cellBase, f = this.flags;
    const load = this.sedLoad, fm = this.flowMag;
    const dth = dtGame / 3600;
    // rain KE at the window centre (same Marshall-Palmer chain as ground.ts)
    const rainMmH = g.rainAt(this.ox, this.oz);
    const dMed = Math.max(3.67 / (4.1 * Math.pow(Math.max(rainMmH, 0.01), -0.21)), 0.5);
    const vFall = Math.min(3.778 * Math.pow(dMed, 0.67), 9.2);
    const kePerMm = 0.5 * 0.5 * vFall * vFall * 0.5; // J/m²/mm
    const keFlux = (rainMmH / 1000) * kePerMm * dtGame; // J/m² this tick
    const x0 = this.ox - MICRO_HALF, z0 = this.oz - MICRO_HALF;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = j * n + i;
        const wx = x0 + (i + 0.5) * MICRO_CELL;
        const wz = z0 + (j + 0.5) * MICRO_CELL;
        const k = cellIndex(wx, wz);
        const tex = SOIL_TEXTURES[soil[k]];
        const churn = (f[v] & 1) !== 0;
        const spoil = (f[v] & 2) !== 0;
        // one shear + one critical-shear per cell (Hjulström-lite, spec §10)
        const slope = this.localSlope(i, j);
        const tau = 1000 * 9.81 * hW[v] * Math.max(slope, 0.01); // Pa
        // critical shear: texture base, loosened by churn/spoil/disturbed,
        // hardened by a rain-sealed crust
        const armor = Math.min(g.keCum[k] / 800, 1) * (g.disturbed[k] > 0 ? 0.25 : 1);
        let tauC = 0.12 + 0.5 * (1 - tex.sand / 100); // sand 0.15 .. clay 0.62 Pa
        if (churn || spoil) tauC *= 0.35;
        if (g.disturbed[k] > 0) tauC *= 0.5;
        tauC *= 1 + armor * 2.5;
        // transport capacity: concentration-limited, ~5 kg/m³ of flow + a
        // thin bedload — settling dominates wherever the film thins
        const cap = 0.1 + 5 * hW[v]; // kg/m² the flow can hold
        // --- detachment -----------------------------------------------------
        let detachKg = 0;
        // raindrop detachment: bare loose ground only — a sealed crust or
        // standing water armors the surface (water depth damps drop KE)
        const dropDamp = Math.exp(-Math.min(hW[v] / 0.02, 1) * 3);
        if (keFlux > 0 && hW[v] < 0.03) {
          const looseF = (churn || spoil ? 1.0 : 0.22) * (1 - 0.75 * armor);
          const kDrop = 0.0009; // kg/(J) detachability scale
          detachKg += kDrop * keFlux * looseF * dropDamp * CELL_AREA;
        }
        // flow entrainment: CONCENTRATED flow only (a routed volume this
        // tick beyond a sheet), shear above the state's critical value —
        // ordinary interrill sheets flow clear, rills and gullies cut
        if (fm[v] > 1e-4 && tau > tauC) {
          const kFlow = 0.04; // kg/(m²·Pa·h)
          detachKg += kFlow * (tau - tauC) * dth * CELL_AREA;
        }
        if (detachKg > 0) {
          // bed lowers: bank density in-situ, loose density on spoil piles
          const rhoBed = tex.rhoDry * (spoil ? 0.8 : 1);
          const vol = detachKg / rhoBed;
          let after = d[v] - vol;
          if (after < DELTA_MIN) {
            this.audit.clippedM3 += (DELTA_MIN - after) * CELL_AREA;
            detachKg -= (DELTA_MIN - after) * CELL_AREA * rhoBed;
            after = DELTA_MIN;
          }
          d[v] = after;
          f[v] |= 1; // fresh scar → relaxation will smooth it
          load[v] += detachKg;
          this.sedLedger.detachedKg += detachKg;
        }
        // --- deposition -----------------------------------------------------
        if (load[v] > 1e-9) {
          // load above the flow's capacity settles (fast in still water,
          // slower while rolling); deposited sediment is LOOSE (fill 0.8)
          const excess = Math.max(load[v] / CELL_AREA - cap, 0);
          const settle = tau < tauC || fm[v] < 1e-4 ? Math.min(dth * 24, 1) : Math.min(dth * 6, 1);
          const depKg = Math.min(excess * settle * CELL_AREA, load[v]);
          if (depKg > 1e-9) {
            const vol = depKg / (tex.rhoDry * 0.8);
            let after = d[v] + vol;
            if (after > DELTA_MAX) {
              this.audit.clippedM3 += (after - DELTA_MAX) * CELL_AREA;
              after = DELTA_MAX;
            }
            d[v] = after;
            f[v] |= 3; // churn + spoil: fresh loose deposit
            load[v] -= depKg;
            this.sedLedger.depositedKg += depKg;
          }
        }
      }
    }
    // --- transport: the load rides the routed water (advection by share) ----
    // movement is proportional to the routed volume; direction = steepest
    // water-surface neighbour (surface array precomputed once — no closures)
    const nl = load;
    const moveBuf = this.scratchS;
    const surf = this.scratchW; // water-surface elevation per cell
    moveBuf.set(nl);
    for (let v = 0; v < n * n; v++) surf[v] = bh[v] + d[v] + hW[v];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const v = j * n + i;
        if (moveBuf[v] <= 1e-9) continue;
        let best = -1;
        let bestS = surf[v];
        if (surf[v + 1] < bestS - 1e-5) { best = v + 1; bestS = surf[v + 1]; }
        if (surf[v + n] < bestS - 1e-5) { best = v + n; bestS = surf[v + n]; }
        if (v >= n && surf[v - n] < bestS - 1e-5) { best = v - n; bestS = surf[v - n]; }
        if (v % n > 0 && surf[v - 1] < bestS - 1e-5) { best = v - 1; bestS = surf[v - 1]; }
        if (best < 0) continue;
        const share = Math.min(fm[v] / (CELL_AREA * 2), 0.9); // routed fraction
        const moveKg = moveBuf[v] * share;
        if (moveKg <= 1e-9) continue;
        nl[v] -= moveKg;
        nl[best] += moveKg;
      }
    }
    if (this.sedLedger.detachedKg > 0 || this.sedLedger.depositedKg > 0) this.texDirty = true;
  }

  /** local surface slope magnitude (base + delta) at a micro cell */
  private localSlope(i: number, j: number): number {
    const n = NC;
    const d = this.delta, bh = this.cellBase;
    const v = j * n + i;
    const sx = (bh[v + (i < n - 1 ? 1 : 0)] + d[v + (i < n - 1 ? 1 : 0)])
      - (bh[v - (i > 0 ? 1 : 0)] + d[v - (i > 0 ? 1 : 0)]);
    const sy = (bh[v + (j < n - 1 ? n : 0)] + d[v + (j < n - 1 ? n : 0)])
      - (bh[v - (j > 0 ? n : 0)] + d[v - (j > 0 ? n : 0)]);
    return Math.hypot(sx, sy) / (2 * MICRO_CELL);
  }

  /** water depth at a world position (bilinear; player wading) */
  waterAt(x: number, z: number): number {
    const fx = (x - (this.ox - MICRO_HALF)) / MICRO_CELL - 0.5;
    const fz = (z - (this.oz - MICRO_HALF)) / MICRO_CELL - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= NC - 1 || j >= NC - 1) return 0;
    const u = fx - i, v = fz - j;
    const w = this.hWater;
    const d00 = w[j * NC + i], d10 = w[j * NC + i + 1];
    const d01 = w[(j + 1) * NC + i], d11 = w[(j + 1) * NC + i + 1];
    return d00 * (1 - u) * (1 - v) + d10 * u * (1 - v) + d01 * (1 - u) * v + d11 * u * v;
  }

  /** pack the film render texture (R surface offset quadratic ±2 m, G depth) */
  private uploadWaterTexture() {
    const t = this.waterTexData;
    let any = false;
    for (let v = 0; v < NC * NC; v++) {
      const off = this.delta[v] + this.hWater[v];
      const m = Math.min(Math.abs(off), WATER_ENCODE) / WATER_ENCODE;
      const b = 128 + (off < 0 ? -1 : 1) * Math.round(127 * Math.sqrt(m));
      t[v * 4] = Math.max(0, Math.min(255, b));
      const dep = Math.min(this.hWater[v] / WATER_DEPTH_ENCODE, 1);
      t[v * 4 + 1] = dep >= 1 / 255 ? Math.max(1, Math.round(dep * 255)) : 0;
      t[v * 4 + 2] = 0;
      t[v * 4 + 3] = 255;
      if (this.hWater[v] > 6e-4) any = true;
    }
    this.waterTex.needsUpdate = true;
    this.waterMesh.visible = any;
  }

  /** QA: water conservation identity for the film */
  waterAudit() {
    let nowM3 = 0;
    for (let v = 0; v < NC * NC; v++) nowM3 += this.hWater[v] * CELL_AREA;
    const l = this.waterLedger;
    return {
      ...l,
      filmNowM3: nowM3,
      errM3: Math.abs(nowM3 - (l.loanNetM3 - l.edgeOutM3 - l.evapM3 - l.infiltM3)),
    };
  }

  /** QA: sediment conservation identity */
  sedAudit() {
    let nowKg = 0;
    for (let v = 0; v < NC * NC; v++) nowKg += this.sedLoad[v];
    const l = this.sedLedger;
    return {
      ...l,
      loadNowKg: nowKg,
      errKg: Math.abs(l.detachedKg - l.depositedKg - l.handoffKg - nowKg),
    };
  }

  private uploadTexture() {
    const t = this.texData;
    let cc = 0;
    for (let v = 0; v < NC * NC; v++) {
      const dl = this.delta[v];
      // quadratic encode: byte = 128 ± 127·sqrt(|d|/1.5)
      const m = Math.min(Math.abs(dl), DELTA_ENCODE) / DELTA_ENCODE;
      const b = 128 + (dl < 0 ? -1 : 1) * Math.round(127 * Math.sqrt(m));
      t[v * 4] = Math.max(0, Math.min(255, b));
      t[v * 4 + 1] = (this.flags[v] & 1) ? 255 : 0;
      t[v * 4 + 2] = (this.flags[v] & 2) ? 255 : 0;
      t[v * 4 + 3] = (this.flags[v] & 4) ? 255 : 0;
      if (this.flags[v] & 1) cc++;
    }
    this.churnCount = cc;
    this.tex.needsUpdate = true;
    this.texDirty = false;
    // the film rides on the delta: keep its surface sheet in step
    this.uploadWaterTexture();
  }

  /** reset (weather scenario switch — a fresh world forgets its edits) */
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
    this.audit.persistDriftM3 = 0;
    this.worldEdits.clear();
    this.hWater.fill(0);
    this.sedLoad.fill(0);
    this.waterLedger.loanNetM3 = 0;
    this.waterLedger.edgeOutM3 = 0;
    this.waterLedger.evapM3 = 0;
    this.waterLedger.infiltM3 = 0;
    this.sedLedger.detachedKg = 0;
    this.sedLedger.depositedKg = 0;
    this.sedLedger.handoffKg = 0;
    this.ground.loanPond.fill(0);
    this.uploadTexture();
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.waterMesh);
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
    (this.waterMesh.material as THREE.Material).dispose();
    this.tex.dispose();
    this.waterTex.dispose();
  }
}
