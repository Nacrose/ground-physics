/**
 * World visuals: terrain mesh with live wetness/mud/road shading driven by the
 * ground-physics DataTexture, RDR2-flavoured golden-hour sky dome, drifting
 * cloud sprites, 48k instanced wind-swayed grass blades, trees, rocks and the
 * valley wagon (the trafficability stage).
 */
import * as THREE from "three";
import { GRID, MESH_SEG, WORLD_SIZE, TerrainData, sampleHeight, terrainNormal, roadCenterY, BIOMES, B_RAINFOREST, B_SWAMP, B_ROCKY, B_DESERT, B_HILLS, B_GRASSLAND, B_MOUNTAIN, B_ICE } from "./terrain";
import { vertexTint } from "./biomeTint";
import { Ground } from "./ground";
import { MicroTerrain, MICRO_SIZE, MICRO_HALF, DELTA_ENCODE, WTEXEL } from "./contact";
import { MidRing } from "./midring";
import { NOISE_GLSL, MUD_SURFACE_GLSL, MUD_NORMAL_GLSL, MUD_SHEEN_GLSL } from "./shaderlib";

const HALF = WORLD_SIZE / 2;
const GRASS_BUCKET = 4; // m — spatial hash cell for trample queries
/** terrain shading-normal texture: one texel per 2 m over the world, the SAME
 *  field both meshes sample per-fragment — vertex density stops mattering, so
 *  the 16 m contact window cannot shade apart from the ground around it */
const NTEX = 384;
/** fine-lift encode: R channel = lift ±0.5 m (linear-filtered over the 4 m
 *  cell centres — the same bilerp the contact overlay bakes) */
const LIFT_ENCODE = 1.0; // full-scale metres encoded by (r - 0.5) * LIFT_ENCODE

export interface WorldUniforms {
  time: { value: number };
  windStrength: { value: number };
  windDir: { value: THREE.Vector2 };
  camPos: { value: THREE.Vector3 };
  sunDir: { value: THREE.Vector3 };
  sunColor: { value: THREE.Color };
  sunIntensity: { value: number };
  cloudiness: { value: number };
  /** sky-hemisphere colour the wet/mud sheen reflects (shaderlib MUD_SHEEN) */
  skySheen: { value: THREE.Color };
  /** sun colour for the mud glint (dimmed floor — a glint survives haze) */
  sheenSun: { value: THREE.Color };
}

export class World {
  scene: THREE.Scene;
  terrain: TerrainData;
  ground: Ground;
  uniforms: WorldUniforms;
  groundTex: THREE.DataTexture;
  /** mud-material view (R gel G crust B stick A soil) — thixotropy,
   *  desiccation, adhesion, texture, packed by ground.packTexture */
  groundTex2: THREE.DataTexture;

  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  clouds: THREE.Group;
  grass: THREE.InstancedMesh;
  treesTrunk: THREE.InstancedMesh;
  treesCanopy: THREE.InstancedMesh;
  /** conifer family (taiga belt + mountain fringe) */
  coniferTrunk: THREE.InstancedMesh;
  coniferCanopy: THREE.InstancedMesh;
  coniferTip: THREE.InstancedMesh;
  /** saguaro cacti (desert) */
  cacti: THREE.InstancedMesh;
  cactiArms: THREE.InstancedMesh;
  rocks!: THREE.InstancedMesh;
  /** dedicated river boulders & rapids standing stones (wet granite/basalt) */
  riverRocks!: THREE.InstancedMesh;
  wagon: THREE.Group;
  terrainMesh: THREE.Mesh;
  /** shared terrain-normal field (see NTEX) — sampled by BOTH ground meshes */
  terrainNormalTex: THREE.DataTexture;
  /** fine-tier dynamic lift (erosion / deposition / consolidation) so the
   *  WHOLE world mesh wears its gullies and settled ground, not just the
   *  16 m contact window — the window edge stays height-continuous */
  liftTex: THREE.DataTexture;
  private liftTexData = new Uint8Array(GRID * GRID);
  private liftTexPrev = new Float32Array(GRID * GRID);

  private cloudMats: THREE.SpriteMaterial[] = [];
  private canopyMat: THREE.MeshStandardMaterial;
  private coniferMat!: THREE.MeshStandardMaterial;
  private cactusMat!: THREE.MeshStandardMaterial;
  private grassCount: number;
  private baseGrassCount: number;
  private micro: MicroTerrain | null;
  /** view-only sharp copy of dug ground out to the EDIT VIEW DISTANCE setting */
  mid: MidRing | null = null;
  /** uniform objects shared by the static mesh and the mid ring */
  private tUni = {
    uDigBox: { value: new THREE.Vector4(0, 0, 0, 0) },
    uMidBox: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPortal: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPortalDir: { value: new THREE.Vector2(0, 1) },
    uPortalPush: { value: 0 },
  };
  private terrainShader: { uniforms: { [k: string]: { value: unknown } } } | null = null;
  private grassShader: { uniforms: { [k: string]: { value: unknown } } } | null = null;
  private grassX!: Float32Array;
  private grassZ!: Float32Array;
  private grassBuckets = new Map<number, number[]>();

  constructor(scene: THREE.Scene, terrain: TerrainData, ground: Ground, grassCount = 48000,
    micro?: MicroTerrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.ground = ground;
    this.baseGrassCount = grassCount;
    this.grassCount = grassCount;
    this.micro = micro ?? null;

    this.uniforms = {
      time: { value: 0 },
      windStrength: { value: 0.5 },
      windDir: { value: new THREE.Vector2(1, 0.2) },
      camPos: { value: new THREE.Vector3() },
      sunDir: { value: new THREE.Vector3(0.55, 0.35, -0.75).normalize() },
      sunColor: { value: new THREE.Color(0xffd9a8) },
      sunIntensity: { value: 1.0 },
      cloudiness: { value: 0.1 },
      skySheen: { value: new THREE.Color(0x8fa3b5) },
      sheenSun: { value: new THREE.Color(0xffd9a8) },
    };

    // ---- ground data texture (R wetness, G pond, B mud, A road) ----------
    this.groundTex = new THREE.DataTexture(ground.texData, GRID, GRID, THREE.RGBAFormat);
    this.groundTex.minFilter = THREE.LinearFilter;
    this.groundTex.magFilter = THREE.LinearFilter;
    this.groundTex.needsUpdate = true;
    // ---- ground texture #2 (R gel, G crust, B stick, A soil idx) — the mud
    // material view: thixotropic structure, desiccation, adhesion, texture
    this.groundTex2 = new THREE.DataTexture(ground.texData2, GRID, GRID, THREE.RGBAFormat);
    this.groundTex2.minFilter = THREE.LinearFilter;
    this.groundTex2.magFilter = THREE.LinearFilter;
    this.groundTex2.needsUpdate = true;
    if (this.micro) {
      this.micro.setGroundTexture(this.groundTex);
      this.micro.setGroundTexture2(this.groundTex2);
    }

    // ---- shared shading-normal texture (2 m texels, world-anchored) ------
    // baked once from the same terrainNormal() both meshes used to bake per
    // vertex — now sampled per FRAGMENT by both, so the 1.5 m static lattice
    // and the 6.25 cm overlay lattice shade through ONE identical field
    {
      const nd = new Uint8Array(NTEX * NTEX * 4);
      const n: [number, number, number] = [0, 1, 0];
      for (let j = 0; j < NTEX; j++) {
        for (let i = 0; i < NTEX; i++) {
          // texel centre -> world metres
          const x = ((i + 0.5) / NTEX) * WORLD_SIZE - HALF;
          const z = ((j + 0.5) / NTEX) * WORLD_SIZE - HALF;
          terrainNormal(terrain, x + HALF, z + HALF, n);
          const k = (j * NTEX + i) * 4;
          nd[k] = Math.round((n[0] * 0.5 + 0.5) * 255);
          nd[k + 1] = Math.round((n[1] * 0.5 + 0.5) * 255);
          nd[k + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
          nd[k + 3] = 255;
        }
      }
      this.terrainNormalTex = new THREE.DataTexture(nd, NTEX, NTEX, THREE.RGBAFormat);
      this.terrainNormalTex.minFilter = THREE.LinearFilter;
      this.terrainNormalTex.magFilter = THREE.LinearFilter;
      this.terrainNormalTex.needsUpdate = true;
      // hand the shared field to the contact overlay (before first render —
      // same pattern as setGroundTexture)
      if (this.micro) this.micro.setTerrainNormalTex(this.terrainNormalTex);
    }

    // ---- fine-lift texture (R = ±0.5 m encode, 4 m cell centres) ---------
    this.liftTexData.fill(128);
    this.liftTex = new THREE.DataTexture(this.liftTexData, GRID, GRID, THREE.RedFormat);
    this.liftTex.minFilter = THREE.LinearFilter;
    this.liftTex.magFilter = THREE.LinearFilter;
    this.liftTex.needsUpdate = true;

    this.mid = this.micro ? new MidRing(terrain, this.micro) : null;
    this.buildTerrainMesh();
    this.buildSky();
    this.buildLights();
    this.buildClouds();
    this.buildGrass();
    this.buildTrees();
    this.buildRocks();
    this.buildWagon();

    // thinner clear-sky haze: the mountain massif has to read from the
    // valley floor (~450 m away) instead of dissolving into golden fog
    scene.fog = new THREE.FogExp2(0xe6d2ac, 0.0011);
  }

  // ------------------------------------------------------------------ terrain
  private buildTerrainMesh() {
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, MESH_SEG, MESH_SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const n: [number, number, number] = [0, 1, 0];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = sampleHeight(this.terrain, x + HALF, z + HALF);
      pos.setY(i, h);
      // analytic normals — the SAME function the contact overlay bakes into
      // aBaseN, so the 16 m deformable window shades exactly like the world
      // around it (no visible seam where the two meshes meet)
      terrainNormal(this.terrain, x + HALF, z + HALF, n);
      nrm.setXYZ(i, n[0], n[1], n[2]);
      // painterly vertex tint: the SHARED biome formula (biomeTint.ts) — the
      // contact overlay and the mid ring bake the exact same field, so all
      // three surfaces shade identically wherever they hand over
      vertexTint(this.terrain, x, z, h, c);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    nrm.needsUpdate = true;

    const mat = this.makeTerrainMaterial(false);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrainMesh = mesh;
    this.scene.add(mesh);
    if (this.mid) {
      this.mid.mesh.material = this.makeTerrainMaterial(true);
      this.scene.add(this.mid.mesh);
    }
  }

  /** terrain material. One shader serves two meshes: the static 1.5 m world
   *  mesh (isMid = false, edit field = coarse far-field cache) and the mid
   *  ring (isMid = true, edit field = the ring's sharp texture). They differ
   *  only in uniforms. */
  private makeTerrainMaterial(isMid: boolean): THREE.MeshStandardMaterial {
    // per-mesh edit field: which texture, where it sits, how big a texel is
    const edit: Record<string, { value: unknown }> = isMid && this.mid ? this.mid.uniforms : {
      uWorldEditTex: { value: this.micro ? this.micro.worldTex : new THREE.DataTexture(new Uint8Array([128, 0, 0, 0]), 1, 1, THREE.RGBAFormat) },
      uWorldEditV: { value: this.micro ? this.micro.worldVertTex : new THREE.DataTexture(new Uint8Array([128, 0, 0, 0]), 1, 1, THREE.RGBAFormat) },
      uEditRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uEditTexelUv: { value: WTEXEL / WORLD_SIZE },
      uEditTexelM: { value: WTEXEL },
      uIsMid: { value: 0 },
    };
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0.0, dithering: true,
    });
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGroundTex = { value: this.groundTex };
      shader.uniforms.uGroundTex2 = { value: this.groundTex2 };
      shader.uniforms.uWorldSize = { value: WORLD_SIZE };
      // the far-field edit cache: every hole, pile and trail you ever made,
      // visible from anywhere in the world (same field the overlay's rim
      // blends into — one continuous surface across the window edge)
      Object.assign(shader.uniforms, edit); // per-mesh edit field (coarse cache or mid ring)
      // vertex-only twin of the far-field cache — the DEDICATED mirror
      // texture (the shared object never binds in the vertex stage; the
      // mirror is refilled in lockstep with every splat)
      // the shared shading-normal + fine-lift fields (see constructor)
      shader.uniforms.uTerrainN = { value: this.terrainNormalTex };
      shader.uniforms.uLiftTex = { value: this.liftTex };
      shader.uniforms.uDigBox = this.tUni.uDigBox; // xy centre, z half, w sink (shared by both meshes)
      shader.uniforms.uMidBox = this.mid ? this.mid.boxUniform : this.tUni.uMidBox;
      // tunnel portal cut: vec4(x, z, halfAlong, halfAcross), separate push
      shader.uniforms.uPortal = this.tUni.uPortal;
      shader.uniforms.uPortalDir = this.tUni.uPortalDir;
      shader.uniforms.uPortalPush = this.tUni.uPortalPush;
      // sheen environment (shared instances — always current)
      shader.uniforms.uSkySheen = u.skySheen;
      shader.uniforms.uSunDirSheen = u.sunDir;
      shader.uniforms.uSunColSheen = u.sheenSun;
      if (!isMid) this.terrainShader = shader;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
varying vec2 vGroundUv;
varying vec3 vWpos;
uniform vec4 uDigBox;
uniform vec4 uPortal;
uniform vec2 uPortalDir;
uniform float uPortalPush;
uniform sampler2D uWorldEditV; // VERTEX-ONLY twin of uWorldEditTex (see note below)
uniform vec4 uEditRect; // world-uv rect of the edit texture (xy origin, zw size)
uniform sampler2D uLiftTex;
// quadratic decode of the far-field edit cache — identical to the contact
// overlay's worldD(), so both meshes read the exact same height field.
// Samples the VERTEX-ONLY sampler: a uniform shared by both stages never
// gets its texture bound for the vertex stage in this three build, and the
// displacement silently read neutral — ditches rendered as flat tints
float worldD(in vec2 wuv){
  float b = texture2D(uWorldEditV, clamp((wuv - uEditRect.xy) / uEditRect.zw, 0.0, 1.0)).r;
  return sign(b - 0.5) * ${DELTA_ENCODE.toFixed(1)} * pow(abs(b - 0.5) * 2.0, 2.0);
}
// fine-tier lift (erosion / deposition / consolidation), bilinear over the
// 4 m cell centres — the exact same field the contact overlay bakes into
// aBaseH, so gullies and settled ground continue across the window edge
float liftAt(in vec2 wuv){
  return (texture2D(uLiftTex, clamp(wuv, 0.0, 1.0)).r - 0.5) * ${LIFT_ENCODE.toFixed(1)};
}`)
        .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
          vGroundUv = vec2(position.x / ${WORLD_SIZE.toFixed(1)} + 0.5, position.z / ${WORLD_SIZE.toFixed(1)} + 0.5);
          // NOTE: shading normals are reconstructed per-FRAGMENT from the
          // shared uTerrainN field (see the fragment shader) — vertex density
          // no longer touches lighting, which is what killed the window square`)
        .replace("#include <begin_vertex>",
          `#include <begin_vertex>
           // world-visible edits: the blurred micro field displaces the whole
           // world mesh — dig a ditch, walk 100 m away, look back: it's there
           float wdel = worldD(vGroundUv);
           // ...and the fine tier's evolving topography rides everywhere too
           float wlift = liftAt(vGroundUv);
           transformed.y += wdel + wlift;
           // tunnel portal cut — rotated anisotropic box (along × across), 0.6 m edge
           vec2 prel = position.xz - uPortal.xy;
           vec2 prot = vec2(prel.x * uPortalDir.x + prel.y * uPortalDir.y,
                            -prel.x * uPortalDir.y + prel.y * uPortalDir.x);
           vec2 dpo = vec2(abs(prot.x) - uPortal.z, abs(prot.y) - uPortal.w);
           float inPortal = 1.0 - smoothstep(0.0, 0.6, max(dpo.x, dpo.y));
           transformed.y -= uPortalPush * inPortal;
           vWpos = vec3(position.x, transformed.y, position.z);`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform sampler2D uGroundTex;
          uniform sampler2D uGroundTex2;   // mud material: R gel G crust B stick A soil
          uniform sampler2D uWorldEditTex;
          uniform sampler2D uTerrainN;
          uniform vec4 uDigBox;
          uniform vec4 uMidBox;      // static mesh: steps aside under the mid ring
          uniform vec4 uEditRect;
          uniform float uEditTexelUv; // edit-texture texel, in world-uv units
          uniform float uEditTexelM;  // ...and in metres
          uniform float uIsMid;
          uniform vec3 uSkySheen;
          uniform vec3 uSunDirSheen;
          uniform vec3 uSunColSheen;
          varying vec2 vGroundUv;
          varying vec3 vWpos;
          vec3 lerp3(vec3 a, vec3 b, float t){ return a + (b-a)*t; }
          // quadratic decode of the far-field edit cache (fragment twin of the
          // vertex function — the normal reconstruction needs it per fragment)
          float worldD(in vec2 wuv){
            float b = texture2D(uWorldEditTex, clamp((wuv - uEditRect.xy) / uEditRect.zw, 0.0, 1.0)).r;
            return sign(b - 0.5) * ${DELTA_ENCODE.toFixed(1)} * pow(abs(b - 0.5) * 2.0, 2.0);
          }
          ${NOISE_GLSL}
          ${MUD_SURFACE_GLSL}
          ${MUD_NORMAL_GLSL}
          ${MUD_SHEEN_GLSL}`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          // the contact window OWNS this ground: the overlay mesh renders the
          // real surface here, so the static mesh simply steps aside (a 0.1 m
          // overlap ring keeps the handoff gapless — both surfaces show the
          // same world field there, the overlay wins by 8 mm + polygon
          // offset). No push-down sink exists anywhere — the sink's
          // resurfacing ring on the coarse 1.5 m vertex lattice was the
          // "square moat" that used to follow the player
          vec2 dwb2 = (vGroundUv - 0.5) * ${WORLD_SIZE.toFixed(1)} - uDigBox.xy;
          if (max(abs(dwb2.x), abs(dwb2.y)) < uDigBox.z - 0.1) discard;
          // the mid ring owns this ground (same trick, bigger box); the ring's own mesh skips this test
          vec2 dmb = (vGroundUv - 0.5) * ${WORLD_SIZE.toFixed(1)} - uMidBox.xy;
          if (uIsMid < 0.5 && max(abs(dmb.x), abs(dmb.y)) < uMidBox.z - 0.15) discard;
          vec4 gcell = texture2D(uGroundTex, vGroundUv);
          vec4 g2 = texture2D(uGroundTex2, vGroundUv);
          float wet = gcell.r; float pond = gcell.g; float mud = gcell.b; float road = gcell.a;
          // the far-field edit channels fetched FIRST: fresh churn SMASHES the
          // desiccation crust (a boot print has no intact plates), so the
          // material stack below must see the broken-through crust — same as
          // the overlay, so a trail keeps its look crossing the window edge
          vec4 we = texture2D(uWorldEditTex, clamp((vGroundUv - uEditRect.xy) / uEditRect.zw, 0.0, 1.0));
          // wet + mud: the shared surface look (identical to the overlay);
          // g2 carries the mud MATERIAL state (gel/crust/stick/soil) so the
          // palette, glisten and desiccation plates are physics-driven
          vec4 g2c = g2;
          g2c.g *= 1.0 - 0.85 * we.g;
          float surfRough = 0.96;
          mudSurface(diffuseColor.rgb, surfRough, vGroundUv, wet, mud, ${WORLD_SIZE.toFixed(1)}, g2c);
          // dirt road: dusty brown track
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.42, 0.335, 0.24) * mix(1.0, 0.5, wet), road * 0.75);
          // water-tinted where ponded
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.19, 0.22, 0.20), clamp(pond * 1.4, 0.0, 0.55));
          // ...and the ponded bed hands its gloss to the water above it: a
          // submerged bed is matte (the film's own surface owns the specular),
          // so water stops reading as "glossy flat ground"
          surfRough = mix(surfRough, 0.62, clamp(pond * 1.3, 0.0, 0.8));
          // churnWet: churned soil is freshly exposed moist ground (surface
          // wet + mud fraction) — MATCHES the overlay's churn tint so a
          // trail keeps exactly its colour crossing the window edge
          float churnWet = clamp(wet + mud * 0.55, 0.0, 1.0);
          vec3 churnCol = mix(diffuseColor.rgb * 1.28 + 0.016, diffuseColor.rgb * 0.8, churnWet);
          // churn/spoil blends (0.85 / 0.75): a dug trail must stay legible
          // from across the valley — MATCH the overlay's rim factors below
          // or the trail changes tint crossing the window edge
          diffuseColor.rgb = lerp3(diffuseColor.rgb, churnCol, we.g * 0.85);
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.32, 0.25, 0.18) * mix(1.0, 0.55, wet), we.b * 0.75);
          surfRough = mix(surfRough, 0.97, we.g * (1.0 - wet) * 0.7);
          surfRough = mix(surfRough, 0.98, we.b * 0.8);`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
          roughnessFactor = surfRough;`)
        .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
          // SHARED SHADING NORMAL: the same uTerrainN field + the same
          // world-edit gradient the contact overlay evaluates per fragment —
          // lighting is mesh-density-independent, so the 16 m window edge
          // cannot shade apart from the world around it (the moving square)
          vec3 wN = texture2D(uTerrainN, vGroundUv).xyz * 2.0 - 1.0;
          float wte = uEditTexelUv;
          float wdX = (worldD(vGroundUv + vec2(wte, 0.0)) - worldD(vGroundUv - vec2(wte, 0.0))) / (2.0 * uEditTexelM);
          float wdZ = (worldD(vGroundUv + vec2(0.0, wte)) - worldD(vGroundUv - vec2(0.0, wte))) / (2.0 * uEditTexelM);
          wN = normalize(wN + vec3(-wdX, 0.0, -wdZ));
          // micro-relief glisten: mud creep + rain-pocked sheen (same
          // function, same inputs as the contact overlay). The perturbation
          // rides the WORLD normal; the shading normal derives from it so
          // lighting and sheen agree on the same surface.
          mudNormal(wN, vGroundUv, gcell.r, gcell.b, ${WORLD_SIZE.toFixed(1)});
          normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
          // wet-earth sheen: sky fresnel + sun glint on the perturbed normal
          // (emissive — a reflection is there even in shadow). wN is the
          // WORLD normal — the fresnel dot mixes it with the world-space
          // view ray; passing the view-space shading normal there read ndv≈0 at
          // every angle and pinned the reflectance at its grazing maximum
          // (a sky glow that shaded this mesh apart from the overlay)
          mudSheen(totalEmissiveRadiance, wN, vWpos, gcell.r, gcell.b,
                   uSkySheen, uSunDirSheen, uSunColSheen);`);
    };
    return mat;
  }

  // ---------------------------------------------------------------------- sky
  private buildSky() {
    const geo = new THREE.SphereGeometry(1500, 32, 18);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uSunDir: this.uniforms.sunDir,
        uCloud: this.uniforms.cloudiness,
        uTime: this.uniforms.time,
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 uSunDir;
        uniform float uCloud;
        uniform float uTime;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.08, 1.0);
          // clear golden-hour palette
          vec3 zenith = vec3(0.32, 0.46, 0.62);
          vec3 mid    = vec3(0.86, 0.70, 0.48);
          vec3 horiz  = vec3(0.99, 0.84, 0.60);
          vec3 col = mix(horiz, mid, smoothstep(0.0, 0.22, h));
          col = mix(col, zenith, smoothstep(0.18, 0.75, h));
          // storm palette
          vec3 sZen = vec3(0.16, 0.19, 0.235);
          vec3 sMid = vec3(0.30, 0.33, 0.37);
          vec3 sHor = vec3(0.44, 0.46, 0.47);
          vec3 scol = mix(sHor, sMid, smoothstep(0.0, 0.22, h));
          scol = mix(scol, sZen, smoothstep(0.18, 0.75, h));
          col = mix(col, scol, uCloud);
          // sun disk & glow
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          float disk = smoothstep(0.9993, 0.9997, sd);
          float glow = pow(sd, 90.0) * 0.85 + pow(sd, 8.0) * 0.28;
          vec3 sunCol = mix(vec3(1.0, 0.86, 0.62), vec3(0.75, 0.77, 0.8), uCloud * 0.8);
          float sunVis = pow(max(1.0 - uCloud, 0.0), 1.6);   // storm kills the sun
          col += sunCol * (disk * 2.2 + glow) * sunVis;
          // faint painterly banding
          col += 0.012 * vec3(sin(d.y * 40.0 + uTime * 0.05), cos(d.x * 30.0), sin(d.z * 26.0));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  private buildLights() {
    this.sun = new THREE.DirectionalLight(0xffd9a8, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90;
    sc.near = 1; sc.far = 480;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.55;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcadbe8, 0x8a6f4d, 0.6);
    this.scene.add(this.hemi);
  }

  // ------------------------------------------------------------------- clouds
  private makeCloudTexture(seed: number): THREE.Texture {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 128;
    const ctx = cv.getContext("2d")!;
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 26; i++) {
      const cx = 30 + rnd() * 196, cy = 40 + rnd() * 58, r = 14 + rnd() * 30;
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(0.6, "rgba(255,255,255,0.28)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildClouds() {
    this.clouds = new THREE.Group();
    const texs = [this.makeCloudTexture(11), this.makeCloudTexture(37), this.makeCloudTexture(73)];
    let seed = 5;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 34; i++) {
      const mat = new THREE.SpriteMaterial({
        map: texs[i % 3], transparent: true, opacity: 0.55,
        depthWrite: false, fog: false,
      });
      const sp = new THREE.Sprite(mat);
      const scale = 150 + rnd() * 190;
      sp.scale.set(scale, scale * 0.42, 1);
      sp.position.set(rnd() * 2600 - 1300, 150 + rnd() * 130, rnd() * 2600 - 1300);
      sp.userData.drift = 0.5 + rnd();
      this.clouds.add(sp);
      this.cloudMats.push(mat);
    }
    this.scene.add(this.clouds);
  }

  // -------------------------------------------------------------------- grass
  private buildGrass() {
    // blade cluster: 3 crossed quads with tapered tops
    const blades: number[] = [];
    const blade = (ang: number) => {
      const w = 0.085, h = 0.62;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const dx = ca * w / 2, dz = sa * w / 2;
      // two triangles, slight taper at top
      const v = [
        -dx, 0, -dz, 0, 0,
        dx, 0, dz, 0, 0,
        dx * 0.25, h, dz * 0.25, 0.55, 0,
        -dx * 0.25, h, dz * 0.25, 0.55, 0,
      ];
      const idx = [0, 1, 2, 0, 2, 3];
      for (const ii of idx) blades.push(v[ii * 5], v[ii * 5 + 1], v[ii * 5 + 2], v[ii * 5 + 3], v[ii * 5 + 4]);
    };
    blade(0); blade(Math.PI / 3); blade((2 * Math.PI) / 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(blades.filter((_, i) => i % 5 !== 3 && i % 5 !== 4), 3));
    // recompute uv attribute properly
    const uvs: number[] = [];
    for (let i = 0; i < blades.length; i += 5) {
      uvs.push(blades[i + 3], blades[i + 4]);
    }
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.uniforms.time,
        uWind: this.uniforms.windStrength,
        uWindDir: this.uniforms.windDir,
        uCamPos: this.uniforms.camPos,
        uSunDir: this.uniforms.sunDir,
        uSunColor: this.uniforms.sunColor,
        uSunI: this.uniforms.sunIntensity,
        uGroundTex: { value: this.groundTex },
        uWorldSize: { value: WORLD_SIZE },
        uMicroTex: { value: this.micro ? this.micro.tex : new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat) },
        uWorldEditTex: { value: this.micro ? this.micro.worldTex : new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1, THREE.RGBAFormat) },
        uMidEditTex: { value: this.mid ? this.mid.texV : new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1, THREE.RGBAFormat) },
        uMidRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uMidOn: { value: 0 },
        uLiftTex: { value: this.liftTex },
        uMicroOrigin: { value: new THREE.Vector2(0, 0) },
        uFogColor: { value: new THREE.Color(0xe6d2ac) },
        uFogDensity: { value: 0.0011 },
        uFadeR: { value: 118.0 },
      },
      vertexShader: `
        attribute float aRand;
        attribute vec3 aTint;
        uniform float uTime, uWind, uWorldSize, uFadeR;
        uniform vec2 uWindDir, uMicroOrigin;
        uniform vec3 uCamPos;
        uniform sampler2D uGroundTex, uMicroTex, uWorldEditTex, uLiftTex, uMidEditTex;
        uniform vec4 uMidRect;
        uniform float uMidOn;
        varying vec2 vUv;
        varying float vRand;
        varying vec3 vTint;
        varying float vWet;
        varying float vWind;
        varying float vViewDist;
        varying float vTrample;
        void main(){
          vUv = uv; vRand = aRand; vTint = aTint;
          vec4 ipos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec2 guv = vec2(ipos.x / uWorldSize + 0.5, ipos.z / uWorldSize + 0.5);
          vec4 g = texture2D(uGroundTex, guv);
          vWet = max(g.r, g.b * 0.7);
          // sink with dig holes in the micro window (quadratic decode, ±DELTA_ENCODE)
          vec2 muv = (ipos.xz - uMicroOrigin + vec2(${MICRO_HALF.toFixed(1)})) / ${MICRO_SIZE.toFixed(1)};
          float mb = texture2D(uMicroTex, clamp(muv, 0.0, 1.0)).r;
          float mdlt = sign(mb - 0.5) * ${DELTA_ENCODE.toFixed(1)} * pow(abs(mb - 0.5) * 2.0, 2.0);
          // ...and with the far-field cache everywhere else — blades ride in
          // ditches you dug on the other side of the world too
          // inside the mid ring, read ITS sharper field (the same one the ground
          // mesh is drawn from), so blades sit on the ditch they can see
          vec2 mu = (guv - uMidRect.xy) / max(uMidRect.zw, vec2(1e-6));
          float inMid = uMidOn * step(0.0, mu.x) * step(mu.x, 1.0) * step(0.0, mu.y) * step(mu.y, 1.0);
          vec4 weC = texture2D(uWorldEditTex, guv);
          vec4 weM = texture2D(uMidEditTex, clamp(mu, 0.0, 1.0));
          vec4 weF = mix(weC, weM, inMid);
          float wb = weF.r;
          float wdlt = sign(wb - 0.5) * ${DELTA_ENCODE.toFixed(1)} * pow(abs(wb - 0.5) * 2.0, 2.0);
          vec2 lpos = ipos.xz - uMicroOrigin;
          // the SAME 4.8-7.3 m band the overlay's rim blend uses — grass
          // sinks into the micro field and hands off to the world cache
          // across one shared gradual band (a mismatched band here drew its
          // own square of popping blades around the player)
          float inWin = 1.0 - smoothstep(4.8, 7.3, max(abs(lpos.x), abs(lpos.y)));
          float sinkD = min(mdlt * inWin, wdlt);
          // trampled trails: churned ground reads THROUGH the grass — blades
          // on churned texels shrink and desaturate toward trampled straw
          // (the far-field twin of crushGrass — footpaths stay visible from
          // across the valley)
          vTrample = clamp(weF.g * 1.7, 0.0, 1.0);
          // wind sway grows with height above blade base
          float ph = uTime * (1.1 + aRand * 0.7) + ipos.x * 0.13 + ipos.z * 0.11;
          float sway = (sin(ph) + 0.5 * sin(ph * 2.3 + aRand * 6.0)) * 0.5;
          vWind = uWind;
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          float bend = pow(uv.y, 1.6) * (0.06 + 0.30 * uWind) * sway;
          wp.x += uWindDir.x * bend; wp.z += uWindDir.y * bend;
          // rain flattens grass; trample shrinks it further
          float flatF = 1.0 - vWet * 0.30 - vTrample * 0.35;
          flatF = max(flatF, 0.3);
          wp.y = ipos.y + (wp.y - ipos.y) * flatF;
          wp.y += min(sinkD + 0.03, 0.0);
          // blades ride the fine tier's evolving topography too (erosion /
          // consolidation), so grass never floats over eroded ground
          wp.y += (texture2D(uLiftTex, guv).r - 0.5) * ${LIFT_ENCODE.toFixed(1)};
          // distance fade: collapse beyond radius
          float d = distance(wp.xyz, uCamPos);
          float fade = 1.0 - smoothstep(uFadeR * 0.72, uFadeR, d);
          wp.xyz = mix(vec3(ipos.x, ipos.y, ipos.z), wp.xyz, fade);
          vViewDist = distance(wp.xyz, uCamPos);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 uSunDir, uSunColor, uFogColor;
        uniform float uSunI, uFogDensity;
        varying vec2 vUv;
        varying float vRand, vWet, vWind, vViewDist, vTrample;
        varying vec3 vTint;
        void main(){
          // biome blade colour: dry face slightly lifted, wet face deep-green
          // (the biome hue carries; moisture only shifts value + hue a touch)
          vec3 dry = vTint * 1.16;
          vec3 lush = vTint * vec3(0.55, 0.74, 0.42);
          vec3 col = mix(dry, lush, vRand * 0.35 + vWet * 0.40);
          col *= 0.8 + 0.45 * vUv.y; // dark base → lit tip
          // trampled: dusty trodden straw — the path reads THROUGH the grass
          vec3 straw = vec3(0.58, 0.47, 0.30);
          col = mix(col, straw, vTrample * 0.75);
          // lighting: wrap-around lambert + sky ambient
          float ndl = max(dot(normalize(vec3(0.0, 1.0, 0.0)), normalize(uSunDir)), 0.0);
          float wrap = pow(ndl, 0.7);
          vec3 light = uSunColor * uSunI * (0.35 + 0.65 * wrap) + vec3(0.30, 0.34, 0.38) * 0.5;
          col *= light;
          // wet blades darken
          col *= mix(1.0, 0.55, vWet);
          // exponential-squared fog matched to the scene fog
          float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vViewDist * vViewDist);
          col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    // fix fog manually in update loop instead (see update())
    this.grass = new THREE.InstancedMesh(geo, mat, this.grassCount);
    this.grass.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const posv = new THREE.Vector3();
    const rands = new Float32Array(this.grassCount);
    const tints = new Float32Array(this.grassCount * 3);
    const grassCols = BIOMES.map((b) => new THREE.Color(b.grassColor));
    let seed = 99;
    const rnd = () => { seed = (seed * 69621) % 2147483647; return seed / 2147483647; };
    let placed = 0;
    const cell = WORLD_SIZE / GRID;
    this.grassX = new Float32Array(this.grassCount);
    this.grassZ = new Float32Array(this.grassCount);
    while (placed < this.grassCount) {
      const i = Math.floor(rnd() * GRID), j = Math.floor(rnd() * GRID);
      const k = j * GRID + i;
      const bd = BIOMES[this.terrain.biome[k]];
      const road = this.terrain.road[k];
      // biome density (grassland/rainforest thick, desert sparse, ice bare),
      // still dodging the road like every version of this meadow
      if (rnd() > bd.grassP * (1 - road * 0.92)) continue;
      const x = (i + rnd()) * cell - HALF;
      const z = (j + rnd()) * cell - HALF;
      const y = sampleHeight(this.terrain, x + HALF, z + HALF) - 0.03;
      const s = (0.55 + rnd() * 0.9) * bd.grassH;
      posv.set(x, y, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      scl.set(s, s * (0.7 + rnd() * 0.75), s);
      m.compose(posv, q, scl);
      this.grass.setMatrixAt(placed, m);
      rands[placed] = rnd();
      const gc = grassCols[this.terrain.biome[k]];
      const jitter = 0.82 + rnd() * 0.36;
      tints[placed * 3] = gc.r * jitter;
      tints[placed * 3 + 1] = gc.g * jitter;
      tints[placed * 3 + 2] = gc.b * jitter;
      this.grassX[placed] = x;
      this.grassZ[placed] = z;
      const bk = Math.floor(x / GRASS_BUCKET) * 4096 + Math.floor(z / GRASS_BUCKET);
      const arr = this.grassBuckets.get(bk);
      if (arr) arr.push(placed); else this.grassBuckets.set(bk, [placed]);
      placed++;
    }
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rands, 1));
    geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));
    this.grass.instanceMatrix.needsUpdate = true;
    this.scene.add(this.grass);
  }

  /** quality scaler: reduce / restore instance draw count */
  setGrassQuality(count: number) {
    this.grass.count = Math.min(count, this.baseGrassCount);
  }

  /**
   * Trample or dig grass near a point — hysteretic (crushed blades stay
   * crushed), the visual seed of desire paths (design doc §30).
   */
  crushGrass(x: number, z: number, r: number, mode: "trample" | "dig") {
    const b0 = Math.floor((x - r) / GRASS_BUCKET), b1 = Math.floor((x + r) / GRASS_BUCKET);
    const c0 = Math.floor((z - r) / GRASS_BUCKET), c1 = Math.floor((z + r) / GRASS_BUCKET);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let touched = false;
    for (let b = b0; b <= b1; b++) {
      for (let c = c0; c <= c1; c++) {
        const arr = this.grassBuckets.get(b * 4096 + c);
        if (!arr) continue;
        for (const gi of arr) {
          const dx = this.grassX[gi] - x, dz = this.grassZ[gi] - z;
          if (dx * dx + dz * dz > r * r) continue;
          this.grass.getMatrixAt(gi, m);
          m.decompose(p, q, s);
          if (s.y < 0.1) continue; // already flattened to the turf
          const f = mode === "dig" ? 0.04 : 0.55;
          s.y = Math.max(s.y * f, 0.03);
          s.x *= 0.9; s.z *= 0.9;
          m.compose(p, q, s);
          this.grass.setMatrixAt(gi, m);
          touched = true;
        }
      }
    }
    if (touched) this.grass.instanceMatrix.needsUpdate = true;
  }

  /** per-frame: terrain push-down box + grass micro-window origin */
  updateDigWindow() {
    const micro = this.micro;
    if (!micro) return;
    const box = micro.digBox();
    // overlay hidden (QA / debug): nothing owns the window ground, so the
    // static mesh must render everywhere — no discard hole in the terrain
    const half = micro.mesh.visible ? box.half : 0.001;
    if (this.terrainShader) {
      (this.terrainShader.uniforms.uDigBox.value as THREE.Vector4).set(box.cx, box.cz, half, 0);
    }
    const gm = this.grass.material as THREE.ShaderMaterial;
    (gm.uniforms.uMicroOrigin.value as THREE.Vector2).set(micro.ox, micro.oz);
    // mid ring: recentre if needed, then point every reader at it (or back
    // at the coarse cache when it is off) in the same frame
    const mid = this.mid;
    if (mid) {
      mid.update(micro.ox, micro.oz);
      const on = mid.active;
      micro.useWorldField(on ? mid.texF : null, on ? mid.texV : null, on ? mid.rect : null, mid.texel);
      (gm.uniforms.uMidRect.value as THREE.Vector4).copy(mid.rect);
      gm.uniforms.uMidOn.value = on ? 1 : 0;
      gm.uniforms.uMidEditTex.value = mid.texV;
    }
  }

  /** EDIT VIEW DISTANCE setting: radius in metres of the sharp ring (0 = off) */
  setEditView(metres: number) {
    this.mid?.setRadius(metres);
  }

  /** tunnel portal cut: push the static terrain down inside the adit box */
  setPortalBox(cx: number, cz: number, halfAlong: number, halfAcross: number, push: number, dirX: number, dirZ: number) {
    if (!this.terrainShader) return;
    (this.terrainShader.uniforms.uPortal.value as THREE.Vector4).set(cx, cz, halfAlong, halfAcross);
    (this.terrainShader.uniforms.uPortalDir.value as THREE.Vector2).set(dirX, dirZ);
    this.terrainShader.uniforms.uPortalPush.value = push;
  }

  // -------------------------------------------------------------------- trees
  /** biome scatter: rejection-sample candidate cells, then place per the
   *  biome's tree/conifer/cactus probabilities. Avoids the road. */
  private scatterByBiome(kind: "tree" | "conifer" | "cactus"):
    Array<{ x: number; y: number; z: number; biome: number; h: number }> {
    const out: Array<{ x: number; y: number; z: number; biome: number; h: number }> = [];
    let seed = kind === "tree" ? 1234 : kind === "conifer" ? 4321 : 777;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    const cell = WORLD_SIZE / GRID;
    const target = kind === "tree" ? 2400 : kind === "conifer" ? 1400 : 400;
    let guard = 0;
    while (out.length < target && guard < target * 80) {
      guard++;
      const i = Math.floor(rnd() * GRID), j = Math.floor(rnd() * GRID);
      const k = j * GRID + i;
      if (this.terrain.road[k] > 0.25 || this.terrain.river[k] > 0.02 || this.terrain.riverIn[k]) continue;
      const b = this.terrain.biome[k];
      const bd = BIOMES[b];
      const p = kind === "tree" ? bd.treeP : kind === "conifer" ? bd.coniferP : bd.cactusP;
      if (p <= 0 || rnd() > p) continue;
      const n = p >= 0.9 ? 2 : 1; // rainforest packs doubles
      for (let c = 0; c < n && out.length < target; c++) {
        const x = (i + rnd()) * cell - HALF, z = (j + rnd()) * cell - HALF;
        const ck = Math.max(0, Math.min(GRID - 1, Math.floor((z + HALF) / cell))) * GRID + Math.max(0, Math.min(GRID - 1, Math.floor((x + HALF) / cell)));
        if (this.terrain.river[ck] > 0.02 || this.terrain.riverIn[ck]) continue;
        const h = sampleHeight(this.terrain, x + HALF, z + HALF);
        out.push({ x, y: h, z, biome: b, h });
      }
    }
    return out;
  }

  private buildTrees() {
    // ---- broadleaf family (grassland, forest, rainforest, swamp, hills) --
    const spots = this.scatterByBiome("tree");
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.30, 3.1, 6);
    trunkGeo.translate(0, 1.55, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9, flatShading: true });
    this.treesTrunk = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const canGeo = new THREE.IcosahedronGeometry(2.1, 1);
    canGeo.scale(1, 0.75, 1);
    canGeo.translate(0, 4.0, 0);
    this.canopyMat = new THREE.MeshStandardMaterial({ color: 0x55603a, roughness: 0.85, flatShading: true });
    this.treesCanopy = new THREE.InstancedMesh(canGeo, this.canopyMat, spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), scl = new THREE.Vector3(), p = new THREE.Vector3();
    let seed = 77;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const canopyCol = new THREE.Color();
    const rainDeep = new THREE.Color(0x2c4a22);
    const temperate = new THREE.Color(0x55603a);
    const swampPale = new THREE.Color(0x6b7a4a);
    spots.forEach((sp, idx) => {
      // rainforest trees run tall + deep green; grassland stocky; swamp pale
      const tropical = sp.biome === B_RAINFOREST;
      const tall = tropical ? 1.35 + rnd() * 0.75 : 0.75 + rnd() * 0.85;
      const sw = sp.biome === B_SWAMP ? 0.85 : 1.0;
      const s = tropical ? 0.9 + rnd() * 0.7 : 0.75 + rnd() * 0.85;
      p.set(sp.x, sp.y - 0.1, sp.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      scl.set(s, tall * sw, s);
      m.compose(p, q, scl);
      this.treesTrunk.setMatrixAt(idx, m);
      this.treesCanopy.setMatrixAt(idx, m);
      canopyCol.copy(temperate);
      if (tropical) canopyCol.lerp(rainDeep, 0.55 + rnd() * 0.35);
      else if (sp.biome === B_SWAMP) canopyCol.copy(swampPale);
      else if (sp.biome === B_GRASSLAND) canopyCol.offsetHSL(0.02, 0.05, 0.04 * rnd());
      canopyCol.offsetHSL((rnd() - 0.5) * 0.02, 0, (rnd() - 0.5) * 0.05);
      this.treesCanopy.setColorAt(idx, canopyCol);
    });
    this.treesTrunk.castShadow = true;
    this.treesCanopy.castShadow = true;
    this.scene.add(this.treesTrunk, this.treesCanopy);

    // ---- conifer family (forest belt, mountain fringe, dry hills) --------
    const cSpots = this.scatterByBiome("conifer");
    const cTrunkGeo = new THREE.CylinderGeometry(0.12, 0.24, 2.6, 6);
    cTrunkGeo.translate(0, 1.3, 0);
    const cTrunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.92, flatShading: true });
    this.coniferTrunk = new THREE.InstancedMesh(cTrunkGeo, cTrunkMat, cSpots.length);
    const coneGeo = new THREE.ConeGeometry(1.55, 4.6, 7);
    coneGeo.translate(0, 4.4, 0);
    const cone2Geo = new THREE.ConeGeometry(1.05, 3.0, 7);
    cone2Geo.translate(0, 6.6, 0);
    this.coniferMat = new THREE.MeshStandardMaterial({ color: 0x2e4632, roughness: 0.88, flatShading: true });
    this.coniferCanopy = new THREE.InstancedMesh(coneGeo, this.coniferMat, cSpots.length);
    this.coniferTip = new THREE.InstancedMesh(cone2Geo, this.coniferMat, cSpots.length);
    const coniferCol = new THREE.Color();
    const taiga = new THREE.Color(0x2e4632);
    const alpine = new THREE.Color(0x46584a);
    let cseed = 31;
    const crnd = () => { cseed = (cseed * 16807) % 2147483647; return cseed / 2147483647; };
    cSpots.forEach((s, idx) => {
      const sc = 0.7 + crnd() * 0.8 + Math.min(s.h / 90, 0.35); // bigger up high
      p.set(s.x, s.y - 0.1, s.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), crnd() * Math.PI * 2);
      scl.set(sc * 0.9, sc, sc * 0.9);
      m.compose(p, q, scl);
      this.coniferTrunk.setMatrixAt(idx, m);
      this.coniferCanopy.setMatrixAt(idx, m);
      this.coniferTip.setMatrixAt(idx, m);
      coniferCol.copy(taiga).lerp(alpine, Math.min(s.h / 70, 0.55) * crnd());
      coniferCol.offsetHSL((crnd() - 0.5) * 0.015, 0, (crnd() - 0.5) * 0.04);
      this.coniferCanopy.setColorAt(idx, coniferCol);
      this.coniferTip.setColorAt(idx, coniferCol);
    });
    this.coniferTrunk.castShadow = true;
    this.coniferCanopy.castShadow = true;
    this.scene.add(this.coniferTrunk, this.coniferCanopy, this.coniferTip);

    // ---- cactus family (desert) ------------------------------------------
    const kSpots = this.scatterByBiome("cactus");
    if (kSpots.length > 0) {
      const kGeo = new THREE.CylinderGeometry(0.28, 0.34, 2.3, 7);
      kGeo.translate(0, 1.15, 0);
      const armGeo = new THREE.CylinderGeometry(0.17, 0.19, 1.0, 6);
      armGeo.translate(0, 0.5, 0);
      this.cactusMat = new THREE.MeshStandardMaterial({ color: 0x4f7a3d, roughness: 0.82, flatShading: true });
      this.cacti = new THREE.InstancedMesh(kGeo, this.cactusMat, kSpots.length);
      this.cactiArms = new THREE.InstancedMesh(armGeo, this.cactusMat, kSpots.length * 2);
      const kcol = new THREE.Color(0x4f7a3d);
      let kseed = 5150;
      const krnd = () => { kseed = (kseed * 48271) % 2147483647; return kseed / 2147483647; };
      let armIdx = 0;
      kSpots.forEach((s, idx) => {
        const sc = 0.7 + krnd() * 0.85;
        p.set(s.x, s.y - 0.05, s.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), krnd() * Math.PI * 2);
        scl.set(sc, sc * (0.8 + krnd() * 0.7), sc);
        m.compose(p, q, scl);
        this.cacti.setMatrixAt(idx, m);
        this.cacti.setColorAt(idx, kcol.clone().offsetHSL(0, (krnd() - 0.5) * 0.06, (krnd() - 0.5) * 0.06));
        for (let a = 0; a < 2; a++) {
          if (krnd() < 0.35) continue;
          const side = krnd() < 0.5 ? 1 : -1;
          p.set(s.x + side * 0.42 * sc, s.y + 0.55 * sc + krnd() * 0.5, s.z);
          q.setFromEuler(new THREE.Euler(0, 0, side * (Math.PI / 2 - 0.5)));
          scl.set(sc * 0.8, sc * 0.9, sc * 0.8);
          m.compose(p, q, scl);
          this.cactiArms.setMatrixAt(armIdx, m);
          armIdx++;
        }
      });
      this.cactiArms.count = armIdx;
      this.cacti.castShadow = true;
      this.scene.add(this.cacti, this.cactiArms);
    }
  }

  // -------------------------------------------------------------------- rocks
  private buildRocks() {
    // 1) General Landscape Rocks & Mountain Scree / Crags:
    // Rocky/mountain/ice get the dense scatter, desert edges, canyon slopes and hills get a sprinkle
    const spots: Array<{ x: number; y: number; z: number; biome: number }> = [];
    let seed = 313;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    const cell = WORLD_SIZE / GRID;
    const target = 1600;
    let guard = 0;
    while (spots.length < target && guard < target * 60) {
      guard++;
      const i = Math.floor(rnd() * GRID), j = Math.floor(rnd() * GRID);
      const k = j * GRID + i;
      if (this.terrain.road[k] > 0.35 || this.terrain.riverIn[k]) continue;
      // Dedicated riverRocks handles in-stream channel boulders; keep landscape rocks out of deep channel
      if (this.terrain.river[k] > 0.40) continue;
      const b = this.terrain.biome[k];
      const p = b === B_ROCKY ? 0.90 : b === B_MOUNTAIN ? 0.85 : b === B_ICE ? 0.45
        : b === B_DESERT ? 0.12 : b === B_HILLS ? 0.25 : 0.08;
      if (rnd() > p) continue;
      const x = (i + rnd()) * cell - HALF, z = (j + rnd()) * cell - HALF;
      spots.push({ x, y: sampleHeight(this.terrain, x + HALF, z + HALF), z, biome: b });
    }
    const geo = new THREE.DodecahedronGeometry(0.75, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x68645e, roughness: 0.92, flatShading: true });
    this.rocks = new THREE.InstancedMesh(geo, mat, spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), scl = new THREE.Vector3(), p = new THREE.Vector3();
    let rseed = 313;
    const rrnd = () => { rseed = (rseed * 48271) % 2147483647; return rseed / 2147483647; };
    const rcol = new THREE.Color();
    const darkSlate = new THREE.Color(0x3a3c40);
    const graniteGray = new THREE.Color(0x5c5d61);
    const screeLight = new THREE.Color(0x787a7f);
    const desertOchre = new THREE.Color(0x8a7058);

    spots.forEach((s, idx) => {
      const isMtn = s.biome === B_MOUNTAIN || s.biome === B_ROCKY;
      const sc = isMtn ? (0.6 + rrnd() * 2.6) : (0.4 + rrnd() * 1.3);
      p.set(s.x, s.y - 0.20 * sc, s.z);
      q.setFromEuler(new THREE.Euler((rrnd() - 0.5) * 0.8, rrnd() * Math.PI * 2, (rrnd() - 0.5) * 0.8));
      scl.set(sc * (0.8 + rrnd() * 0.5), sc * (0.5 + rrnd() * 0.8), sc * (0.7 + rrnd() * 0.6));
      m.compose(p, q, scl);
      this.rocks.setMatrixAt(idx, m);

      rcol.copy(graniteGray);
      if (isMtn) {
        if (rrnd() < 0.45) rcol.lerp(darkSlate, 0.7);
        else rcol.lerp(screeLight, rrnd() * 0.5);
      } else if (s.biome === B_DESERT) {
        rcol.lerp(desertOchre, 0.65 + rrnd() * 0.25);
      }
      this.rocks.setColorAt(idx, rcol);
    });
    this.rocks.castShadow = true;
    this.scene.add(this.rocks);

    // 2) Dedicated River Boulders & Rapids Standing Stones:
    // Fast mountain river (4-6 m/s) scours all soil to bedrock and is armored
    // with heavy rounded boulders, standing rocks poking out of the rapids, and boulder-lined banks!
    const rPts = this.terrain.riverPts;
    const rBoulders: Array<{ x: number; y: number; z: number; scX: number; scY: number; scZ: number; yaw: number; col: THREE.Color }> = [];
    const sMax = rPts.length ? rPts[rPts.length - 1].s : 1;

    for (let si = 1; si < rPts.length - 1; si++) {
      const pt = rPts[si];
      const f = pt.s / sMax;
      if (f > 0.78) continue; // Upper gorge and middle reaches
      
      const prevPt = rPts[si - 1], nextPt = rPts[si + 1];
      let tx = nextPt.x - prevPt.x, tz = nextPt.y - prevPt.y;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const halfW = pt.w * 0.90;

      // 1 to 2 in-stream boulders partially submerged in the torrent
      const inCount = rrnd() < 0.75 ? 2 : 1;
      for (let b = 0; b < inCount; b++) {
        const off = (rrnd() * 1.3 - 0.65) * halfW;
        const bx = pt.x + nx * off - HALF, bz = pt.y + nz * off - HALF;
        const by = sampleHeight(this.terrain, bx + HALF, bz + HALF);
        const sc = 0.75 + rrnd() * 1.6;
        const yaw = rrnd() * Math.PI * 2;
        const c = new THREE.Color(0x282b30).lerp(new THREE.Color(0x3e4248), rrnd() * 0.7);
        rBoulders.push({
          x: bx,
          y: by + sc * 0.22,
          z: bz,
          scX: sc * (0.8 + rrnd() * 0.4),
          scY: sc * (0.5 + rrnd() * 0.4),
          scZ: sc * (0.8 + rrnd() * 0.4),
          yaw,
          col: c
        });
      }

      // 2 to 3 bank & rim boulders armoring the channel edges
      const bankCount = 2 + (rrnd() < 0.5 ? 1 : 0);
      for (let b = 0; b < bankCount; b++) {
        const side = (b % 2 === 0 ? 1 : -1) * (0.80 + rrnd() * 0.75);
        const off = side * halfW;
        const bx = pt.x + nx * off - HALF, bz = pt.y + nz * off - HALF;
        const by = sampleHeight(this.terrain, bx + HALF, bz + HALF);
        const sc = 0.9 + rrnd() * 2.0;
        const yaw = rrnd() * Math.PI * 2;
        const c = new THREE.Color(0x2e3136).lerp(new THREE.Color(0x4a4d53), rrnd() * 0.6);
        rBoulders.push({
          x: bx,
          y: by - sc * 0.12,
          z: bz,
          scX: sc * (0.8 + rrnd() * 0.5),
          scY: sc * (0.6 + rrnd() * 0.5),
          scZ: sc * (0.8 + rrnd() * 0.5),
          yaw,
          col: c
        });
      }
    }

    const rGeo = new THREE.DodecahedronGeometry(0.85, 1);
    const rMat = new THREE.MeshStandardMaterial({
      color: 0x35383d,
      roughness: 0.38, // Wet river stone sheen
      metalness: 0.10,
      flatShading: true,
    });
    this.riverRocks = new THREE.InstancedMesh(rGeo, rMat, rBoulders.length);
    rBoulders.forEach((rb, idx) => {
      p.set(rb.x, rb.y, rb.z);
      q.setFromEuler(new THREE.Euler((rrnd() - 0.5) * 0.35, rb.yaw, (rrnd() - 0.5) * 0.35));
      scl.set(rb.scX, rb.scY, rb.scZ);
      m.compose(p, q, scl);
      this.riverRocks.setMatrixAt(idx, m);
      this.riverRocks.setColorAt(idx, rb.col);
    });
    this.riverRocks.castShadow = true;
    this.riverRocks.receiveShadow = true;
    this.scene.add(this.riverRocks);
  }

  // -------------------------------------------------------------------- wagon
  private buildWagon() {
    this.wagon = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 0.85 });
    const woodDark = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.9 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 1.3), wood);
    bed.position.y = 0.95;
    bed.castShadow = true;
    this.wagon.add(bed);
    const railL = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 0.08), woodDark);
    railL.position.set(0, 1.4, 0.62); railL.castShadow = true;
    const railR = railL.clone(); railR.position.z = -0.62;
    this.wagon.add(railL, railR);
    const wheelGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.12, 14);
    wheelGeo.rotateX(Math.PI / 2);
    for (const [wx, wz] of [[-0.95, 0.75], [-0.95, -0.75], [0.95, 0.75], [0.95, -0.75]]) {
      const w = new THREE.Mesh(wheelGeo, wood);
      w.position.set(wx, 0.62, wz);
      w.castShadow = true;
      this.wagon.add(w);
    }
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.1), wood);
    shaft.position.set(2.0, 0.62, 0.3);
    const shaft2 = shaft.clone(); shaft2.position.z = -0.3;
    this.wagon.add(shaft, shaft2);
    // park it on the road in the valley (roadCenterY is the terrain's own
    // road definition — wx/wz are already in the 0..WORLD_SIZE frame that
    // sampleHeight expects)
    const wx = 40;
    const wz = roadCenterY(wx);
    const wy = sampleHeight(this.terrain, wx, wz);
    this.wagon.position.set(wx - HALF, wy - 0.06, wz - HALF);
    this.wagon.rotation.y = 0.35;
    this.scene.add(this.wagon);
  }

  // ------------------------------------------------------------------- update
  update(dt: number, elapsed: number, cloudiness: number, windMs: number, windDirRad: number,
    camPos: THREE.Vector3, playerPos: THREE.Vector3, flash: number) {
    const u = this.uniforms;
    u.time.value = elapsed;
    u.windStrength.value = Math.min(windMs / 14, 1.6);
    u.windDir.value.set(Math.cos(windDirRad), Math.sin(windDirRad));
    u.camPos.value.copy(camPos);
    u.cloudiness.value = cloudiness;

    // sun drifts along a low golden arc, dims under storm
    const az = 2.2 + Math.sin(elapsed * 0.004) * 0.1;
    const el = 0.30 + 0.06 * Math.sin(elapsed * 0.003 + 1.0);
    u.sunDir.value.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
    const dim = 1 - 0.93 * cloudiness;
    u.sunIntensity.value = dim;
    u.skySheen.value.setRGB(
      0.62 - 0.42 * cloudiness, 0.72 - 0.38 * cloudiness, 0.82 - 0.33 * cloudiness);
    u.sheenSun.value.setRGB(1.0, 0.85 + 0.1 * dim, 0.66 + 0.2 * dim).multiplyScalar(Math.max(dim, 0.15));
    this.sun.intensity = 2.4 * dim * dim + 0.08 + flash * 5.0;
    this.sun.color.setRGB(1.0, 0.85 + 0.1 * (1 - cloudiness), 0.66 + 0.2 * (1 - cloudiness));
    this.hemi.intensity = 0.55 * (1 - 0.4 * cloudiness) + 0.12;
    // sky follows the player dome-style
    this.sky.position.copy(camPos);
    this.sky.scale.setScalar(1);

    // shadow frustum tracks the player, snapped to texels to avoid shimmer
    const sd = u.sunDir.value;
    const texel = 180 / 2048;
    const px = Math.round(playerPos.x / texel) * texel;
    const pz = Math.round(playerPos.z / texel) * texel;
    this.sun.position.set(px + sd.x * 220, sd.y * 220 + 40, pz + sd.z * 220);
    this.sun.target.position.set(px, 0, pz);

    // fog & sky tint respond to cloudiness (clear sky stays THIN now — see
    // the constructor note — so the mountain biomes read from the valley)
    const fog = this.scene.fog as THREE.FogExp2;
    const clearC = new THREE.Color(0xe6d2ac), stormC = new THREE.Color(0x5c646e);
    fog.color.copy(clearC).lerp(stormC, cloudiness);
    fog.density = 0.0011 + cloudiness * 0.0055;
    const gm = this.grass.material as THREE.ShaderMaterial;
    gm.uniforms.uFogColor.value.copy(fog.color);
    gm.uniforms.uFogDensity.value = fog.density;

    // clouds drift with wind, darken with cloudiness
    const cloudCol = new THREE.Color(1, 1, 1).lerp(new THREE.Color(0.28, 0.30, 0.34), cloudiness);
    for (const mat of this.cloudMats) {
      mat.color.copy(cloudCol);
      mat.opacity = 0.22 + cloudiness * 0.66;
    }
    const cdx = Math.cos(windDirRad), cdz = Math.sin(windDirRad);
    const speed = (2 + windMs * 0.7);
    for (const sp of this.clouds.children) {
      sp.position.x += cdx * speed * dt * sp.userData.drift;
      sp.position.z += cdz * speed * dt * sp.userData.drift;
      if (sp.position.x > 1350) sp.position.x -= 2700;
      if (sp.position.x < -1350) sp.position.x += 2700;
      if (sp.position.z > 1350) sp.position.z -= 2700;
      if (sp.position.z < -1350) sp.position.z += 2700;
    }

    // vegetation darkens when wet (global approximation via cloudiness)
    const wetG = cloudiness * 0.55;
    this.canopyMat.color.setRGB(0.33 + 0.05 * (1 - wetG), 0.38 - 0.06 * wetG, 0.23 - 0.05 * wetG);
  }

  /** ground texture refresh after physics tick */
  refreshGroundTexture() {
    this.groundTex.needsUpdate = true;
    this.refreshLiftTexture();
    // mud material view (gel/crust/stick/soil) refreshes with the physics
    this.groundTex2.needsUpdate = true;
  }

  /** re-encode the fine-tier lift field (erosion / deposition / consolidation)
   *  into the world lift texture — dirtied only when the field actually moved
   *  (µm-level drift is quantisation, not topography) */
  private refreshLiftTexture() {
    const ero = this.ground.eroM, set = this.ground.settleM;
    const t = this.liftTexData, prev = this.liftTexPrev;
    let changed = false;
    for (let k = 0; k < GRID * GRID; k++) {
      const lift = ero[k] - set[k];
      if (Math.abs(lift - prev[k]) > 5e-4) {
        prev[k] = lift;
        const enc = Math.max(0, Math.min(255, Math.round(128 + lift / LIFT_ENCODE * 127)));
        t[k] = enc;
        changed = true;
      }
    }
    if (changed) this.liftTex.needsUpdate = true;
  }

  dispose() {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
      else if (mat) mat.dispose();
    });
  }
}
