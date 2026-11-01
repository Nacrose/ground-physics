/**
 * World visuals: terrain mesh with live wetness/mud/road shading driven by the
 * ground-physics DataTexture, RDR2-flavoured golden-hour sky dome, drifting
 * cloud sprites, 48k instanced wind-swayed grass blades, trees, rocks and the
 * valley wagon (the trafficability stage).
 */
import * as THREE from "three";
import { GRID, MESH_SEG, WORLD_SIZE, TerrainData, sampleHeight } from "./terrain";
import { Ground } from "./ground";
import { MicroTerrain, MICRO_SIZE, MICRO_HALF, DELTA_ENCODE } from "./contact";

const HALF = WORLD_SIZE / 2;
const GRASS_BUCKET = 4; // m — spatial hash cell for trample queries

export interface WorldUniforms {
  time: { value: number };
  windStrength: { value: number };
  windDir: { value: THREE.Vector2 };
  camPos: { value: THREE.Vector3 };
  sunDir: { value: THREE.Vector3 };
  sunColor: { value: THREE.Color };
  sunIntensity: { value: number };
  cloudiness: { value: number };
}

export class World {
  scene: THREE.Scene;
  terrain: TerrainData;
  ground: Ground;
  uniforms: WorldUniforms;
  groundTex: THREE.DataTexture;
  groundTex2: THREE.DataTexture;

  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  clouds: THREE.Group;
  grass: THREE.InstancedMesh;
  treesTrunk: THREE.InstancedMesh;
  treesCanopy: THREE.InstancedMesh;
  rocks: THREE.InstancedMesh;
  wagon: THREE.Group;
  terrainMesh: THREE.Mesh;

  private cloudMats: THREE.SpriteMaterial[] = [];
  private canopyMat: THREE.MeshStandardMaterial;
  private grassCount: number;
  private baseGrassCount: number;
  private micro: MicroTerrain | null;
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
    };

    // ---- ground data texture (R wetness, G pond, B mud, A road) ----------
    this.groundTex = new THREE.DataTexture(ground.texData, GRID, GRID, THREE.RGBAFormat);
    this.groundTex.minFilter = THREE.LinearFilter;
    this.groundTex.magFilter = THREE.LinearFilter;
    this.groundTex.needsUpdate = true;
    // ---- ground texture #2 (R gel, G crust, B stick, A soil idx) — the mud
    // material view: thixotropic structure, desiccation, adhesion, texture ----
    this.groundTex2 = new THREE.DataTexture(ground.texData2, GRID, GRID, THREE.RGBAFormat);
    this.groundTex2.minFilter = THREE.LinearFilter;
    this.groundTex2.magFilter = THREE.LinearFilter;
    this.groundTex2.needsUpdate = true;
    if (this.micro) {
      this.micro.setGroundTexture(this.groundTex);
      this.micro.setGroundTexture2(this.groundTex2);
    }

    this.buildTerrainMesh();
    this.buildSky();
    this.buildLights();
    this.buildClouds();
    this.buildGrass();
    this.buildTrees();
    this.buildRocks();
    this.buildWagon();

    scene.fog = new THREE.FogExp2(0xe6d2ac, 0.0026);
  }

  // ------------------------------------------------------------------ terrain
  private buildTerrainMesh() {
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, MESH_SEG, MESH_SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = sampleHeight(this.terrain, x + HALF, z + HALF);
      pos.setY(i, h);
      // painterly vertex tint: dry golden uplands, greener lows, rock high
      const hn = Math.min(Math.max(h / 18, 0), 1);
      const dry = new THREE.Color(0xb9985a); // dry golden grass
      const lush = new THREE.Color(0x7d8a4e); // greener lowland
      c.copy(dry).lerp(lush, 1 - hn);
      if (h > 14.5) c.lerp(new THREE.Color(0x8d8478), Math.min((h - 14.5) / 5, 0.6)); // rocky ridge
      // subtle mottling
      const m = 0.92 + 0.16 * Math.sin(x * 0.171 + z * 0.137) * Math.sin(x * 0.043 - z * 0.061);
      colors[i * 3] = c.r * m; colors[i * 3 + 1] = c.g * m; colors[i * 3 + 2] = c.b * m;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0.0,
    });
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGroundTex = { value: this.groundTex };
      shader.uniforms.uGroundTex2 = { value: this.groundTex2 };
      shader.uniforms.uWorldSize = { value: WORLD_SIZE };
      shader.uniforms.uDigBox = { value: new THREE.Vector4(0, 0, 0, 0) }; // xy centre, z half, w sink
      // tunnel portal cut: vec4(x, z, halfAlong, halfAcross), separate push
      shader.uniforms.uPortal = { value: new THREE.Vector4(0, 0, 0, 0) };
      shader.uniforms.uPortalDir = { value: new THREE.Vector2(0, 1) };
      shader.uniforms.uPortalPush = { value: 0 };
      this.terrainShader = shader;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
varying vec2 vGroundUv;
uniform vec4 uDigBox;
uniform vec4 uPortal;
uniform vec2 uPortalDir;
uniform float uPortalPush;`)
        .replace("#include <begin_vertex>",
          `#include <begin_vertex>
           vGroundUv = vec2(position.x / ${WORLD_SIZE.toFixed(1)} + 0.5, position.z / ${WORLD_SIZE.toFixed(1)} + 0.5);
           // the micro window owns geometry here: push the static mesh 2.5 m down
           vec2 dwb = abs(position.xz - uDigBox.xy);
           float inDig = 1.0 - smoothstep(uDigBox.z - 0.6, uDigBox.z, max(dwb.x, dwb.y));
           transformed.y -= uDigBox.w * inDig;
           // tunnel portal cut — rotated anisotropic box (along × across), 0.6 m edge
           vec2 prel = position.xz - uPortal.xy;
           vec2 prot = vec2(prel.x * uPortalDir.x + prel.y * uPortalDir.y,
                            -prel.x * uPortalDir.y + prel.y * uPortalDir.x);
           vec2 dpo = vec2(abs(prot.x) - uPortal.z, abs(prot.y) - uPortal.w);
           float inPortal = 1.0 - smoothstep(0.0, 0.6, max(dpo.x, dpo.y));
           transformed.y -= uPortalPush * inPortal;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform sampler2D uGroundTex;
          uniform sampler2D uGroundTex2;
          varying vec2 vGroundUv;
          vec3 lerp3(vec3 a, vec3 b, float t){ return a + (b-a)*t; }
          // desiccation-crack mask for a dried mud crust: ~55 cm plates with
          // per-plate seam-width jitter (real mudcracks vary plate to plate);
          // sin-free hash — this runs per-fragment over whole dry scenes
          float crackSeam(vec2 uvw, float plateM){
            vec2 wpM = uvw * ${WORLD_SIZE.toFixed(1)};
            vec2 cp = wpM / plateM;
            vec2 cid = floor(cp);
            vec3 p3s = fract(vec3(cid.xyx) * 0.1031);
            p3s += dot(p3s, p3s.yzx + 33.33);
            float hsh = fract((p3s.x + p3s.y) * p3s.z);
            vec2 f = fract(cp);
            float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
            return 1.0 - smoothstep(0.015 + 0.05 * hsh, 0.06 + 0.06 * hsh, edge);
          }`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec4 gcell = texture2D(uGroundTex, vGroundUv);
          vec4 g2 = texture2D(uGroundTex2, vGroundUv);
          float wet = gcell.r; float pond = gcell.g; float mud = gcell.b; float road = gcell.a;
          float gelF = g2.r; float crust = g2.g; float soilId = g2.a;
          // rain darkening (freshly wetted ground goes 2-3 stops darker)
          diffuseColor.rgb *= mix(1.0, 0.46, wet);
          // mud color follows the soil's own fines: sand mud is tan, loam mud
          // mid brown, silty-clay mud the dark grey-brown glossy stuff;
          // remolded (freshly trafficked) mud reads a shade darker
          vec3 mudSand = vec3(0.20, 0.165, 0.12);
          vec3 mudLoam = vec3(0.15, 0.11, 0.08);
          vec3 mudClay = vec3(0.105, 0.088, 0.072);
          vec3 mudCol = soilId > 0.75 ? mudClay : (soilId > 0.4 ? mudLoam : mudSand);
          mudCol *= 1.0 - 0.18 * (1.0 - gelF);
          diffuseColor.rgb = lerp3(diffuseColor.rgb, mudCol, mud * 0.65);
          // dirt road: dusty brown track
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.42, 0.335, 0.24) * mix(1.0, 0.5, wet), road * 0.75);
          // water-tinted where ponded
          diffuseColor.rgb = lerp3(diffuseColor.rgb, vec3(0.19, 0.22, 0.20), clamp(pond * 1.4, 0.0, 0.55));
          // desiccation: drying mud pales into cracked plates with dark seams
          // (rain re-slakes the crust and the pattern fades away again).
          // The SURFACE skin dries long before the column does, so the crust
          // shows while the soil is still moist — only fresh saturation hides it
          float crustVis = crust * (1.0 - pond) * (1.0 - 0.55 * clamp(wet - 0.35, 0.0, 1.0));
          if (crustVis > 0.015) {
            float seam = crackSeam(vGroundUv, 0.55);
            diffuseColor.rgb = lerp3(diffuseColor.rgb, diffuseColor.rgb * 1.26 + vec3(0.05), crustVis * 0.5);
            diffuseColor.rgb *= 1.0 - seam * crustVis * 0.55;
          }`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.20, wet * 0.85);
          // glisten: liquid mud carries a water film — fresh remolded churn
          // glistens hardest; the drying crust kills the sheen (matte dust)
          float crustV = crust * (1.0 - 0.55 * clamp(wet - 0.35, 0.0, 1.0));
          roughnessFactor = mix(roughnessFactor, 0.13, mud * (1.0 - crustV) * (0.55 + 0.45 * (1.0 - gelF)));
          roughnessFactor = mix(roughnessFactor, 0.86, mud * crustV);`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrainMesh = mesh;
    this.scene.add(mesh);
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
        uMicroOrigin: { value: new THREE.Vector2(0, 0) },
        uFogColor: { value: new THREE.Color(0xe6d2ac) },
        uFogDensity: { value: 0.0026 },
        uFadeR: { value: 118.0 },
      },
      vertexShader: `
        attribute float aRand;
        uniform float uTime, uWind, uWorldSize, uFadeR;
        uniform vec2 uWindDir, uMicroOrigin;
        uniform vec3 uCamPos;
        uniform sampler2D uGroundTex, uMicroTex;
        varying vec2 vUv;
        varying float vRand;
        varying float vWet;
        varying float vWind;
        varying float vViewDist;
        void main(){
          vUv = uv; vRand = aRand;
          vec4 ipos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec2 guv = vec2(ipos.x / uWorldSize + 0.5, ipos.z / uWorldSize + 0.5);
          vec4 g = texture2D(uGroundTex, guv);
          vWet = max(g.r, g.b * 0.7);
          // sink with dig holes in the micro window (quadratic decode, ±DELTA_ENCODE)
          vec2 muv = (ipos.xz - uMicroOrigin + vec2(${MICRO_HALF.toFixed(1)})) / ${MICRO_SIZE.toFixed(1)};
          float mb = texture2D(uMicroTex, clamp(muv, 0.0, 1.0)).r;
          float mdlt = sign(mb - 0.5) * ${DELTA_ENCODE.toFixed(1)} * pow(abs(mb - 0.5) * 2.0, 2.0);
          // wind sway grows with height above blade base
          float ph = uTime * (1.1 + aRand * 0.7) + ipos.x * 0.13 + ipos.z * 0.11;
          float sway = (sin(ph) + 0.5 * sin(ph * 2.3 + aRand * 6.0)) * 0.5;
          vWind = uWind;
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          float bend = pow(uv.y, 1.6) * (0.06 + 0.30 * uWind) * sway;
          wp.x += uWindDir.x * bend; wp.z += uWindDir.y * bend;
          // rain flattens grass
          float flatF = 1.0 - vWet * 0.30;
          wp.y = ipos.y + (wp.y - ipos.y) * flatF;
          wp.y += min(mdlt + 0.03, 0.0);
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
        varying float vRand, vWet, vWind, vViewDist;
        void main(){
          // golden dry grass with per-blade variation; greener when wet
          vec3 dry = vec3(0.82, 0.64, 0.30);
          vec3 lush = vec3(0.42, 0.48, 0.24);
          vec3 col = mix(dry, lush, vRand * 0.35 + vWet * 0.40);
          col *= 0.8 + 0.45 * vUv.y; // dark base → lit tip
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
    let seed = 99;
    const rnd = () => { seed = (seed * 69621) % 2147483647; return seed / 2147483647; };
    let placed = 0;
    const cell = WORLD_SIZE / GRID;
    this.grassX = new Float32Array(this.grassCount);
    this.grassZ = new Float32Array(this.grassCount);
    while (placed < this.grassCount) {
      const i = Math.floor(rnd() * GRID), j = Math.floor(rnd() * GRID);
      const k = j * GRID + i;
      const soilId = this.terrain.soil[k];
      const road = this.terrain.road[k];
      // grass favours upland/slopes, avoids road & heavy clay valley
      const p = soilId === 0 ? 0.95 : soilId === 1 ? 0.72 : 0.16;
      if (rnd() > p * (1 - road * 0.92)) continue;
      const x = (i + rnd()) * cell - HALF;
      const z = (j + rnd()) * cell - HALF;
      const y = sampleHeight(this.terrain, x + HALF, z + HALF) - 0.03;
      const s = 0.55 + rnd() * 0.9;
      posv.set(x, y, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      scl.set(s, s * (0.7 + rnd() * 0.75), s);
      m.compose(posv, q, scl);
      this.grass.setMatrixAt(placed, m);
      rands[placed] = rnd();
      this.grassX[placed] = x;
      this.grassZ[placed] = z;
      const bk = Math.floor(x / GRASS_BUCKET) * 4096 + Math.floor(z / GRASS_BUCKET);
      const arr = this.grassBuckets.get(bk);
      if (arr) arr.push(placed); else this.grassBuckets.set(bk, [placed]);
      placed++;
    }
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rands, 1));
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
    if (this.terrainShader) {
      (this.terrainShader.uniforms.uDigBox.value as THREE.Vector4).set(box.cx, box.cz, box.half, 2.5);
    }
    const gm = this.grass.material as THREE.ShaderMaterial;
    (gm.uniforms.uMicroOrigin.value as THREE.Vector2).set(micro.ox, micro.oz);
  }

  /** tunnel portal cut: push the static terrain down inside the adit box */
  setPortalBox(cx: number, cz: number, halfAlong: number, halfAcross: number, push: number, dirX: number, dirZ: number) {
    if (!this.terrainShader) return;
    (this.terrainShader.uniforms.uPortal.value as THREE.Vector4).set(cx, cz, halfAlong, halfAcross);
    (this.terrainShader.uniforms.uPortalDir.value as THREE.Vector2).set(dirX, dirZ);
    this.terrainShader.uniforms.uPortalPush.value = push;
  }

  // -------------------------------------------------------------------- trees
  private scatterOnUplands(count: number, minH: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    let seed = 1234;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    const cell = WORLD_SIZE / GRID;
    let guard = 0;
    while (out.length < count && guard < count * 60) {
      guard++;
      const i = Math.floor(rnd() * GRID), j = Math.floor(rnd() * GRID);
      const k = j * GRID + i;
      if (this.terrain.soil[k] === 2) continue; // no trees in clay valley
      if (this.terrain.road[k] > 0.25) continue;
      const x = (i + rnd()) * cell - HALF, z = (j + rnd()) * cell - HALF;
      const h = sampleHeight(this.terrain, x + HALF, z + HALF);
      if (h < minH) continue;
      out.push([x, h, z]);
    }
    return out;
  }

  private buildTrees() {
    const spots = this.scatterOnUplands(90, 4.5);
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
    spots.forEach(([x, y, z], idx) => {
      const s = 0.75 + rnd() * 0.85;
      p.set(x, y - 0.1, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      scl.set(s, s * (0.9 + rnd() * 0.5), s);
      m.compose(p, q, scl);
      this.treesTrunk.setMatrixAt(idx, m);
      this.treesCanopy.setMatrixAt(idx, m);
    });
    this.treesTrunk.castShadow = true;
    this.treesCanopy.castShadow = true;
    this.scene.add(this.treesTrunk, this.treesCanopy);
  }

  // -------------------------------------------------------------------- rocks
  private buildRocks() {
    const spots = this.scatterOnUplands(130, 6.5);
    const geo = new THREE.DodecahedronGeometry(0.55, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8177, roughness: 0.95, flatShading: true });
    this.rocks = new THREE.InstancedMesh(geo, mat, spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), scl = new THREE.Vector3(), p = new THREE.Vector3();
    let seed = 313;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    spots.forEach(([x, y, z], idx) => {
      const s = 0.4 + rnd() * 1.5;
      p.set(x, y - 0.15 * s, z);
      q.setFromEuler(new THREE.Euler(rnd() * 0.6, rnd() * Math.PI * 2, rnd() * 0.6));
      scl.set(s, s * (0.5 + rnd() * 0.5), s);
      m.compose(p, q, scl);
      this.rocks.setMatrixAt(idx, m);
    });
    this.rocks.castShadow = true;
    this.scene.add(this.rocks);
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
    // park it on the road in the clay valley
    // (wx/wz are already in the 0..WORLD_SIZE frame that sampleHeight expects)
    const roadY = (x: number) => 0.30 + 0.08 * Math.sin((x / WORLD_SIZE) * Math.PI * 1.7 + 0.4);
    const wx = 40;
    const wz = roadY(wx) * WORLD_SIZE;
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

    // fog & sky tint respond to cloudiness
    const fog = this.scene.fog as THREE.FogExp2;
    const clearC = new THREE.Color(0xe6d2ac), stormC = new THREE.Color(0x5c646e);
    fog.color.copy(clearC).lerp(stormC, cloudiness);
    fog.density = 0.0026 + cloudiness * 0.0055;
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
    this.groundTex2.needsUpdate = true;
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
