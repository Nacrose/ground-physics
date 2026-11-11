import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";
import { RiverHydraulics } from "./riverHydraulics";
import { RiverRocks } from "./riverRocks";

function generateWaterNormalMap(size = 512): THREE.DataTexture {
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const waves: [number, number, number, number][] = [];
  const used = new Set<string>();
  const goldenAngle = 2.39996323;

  // 36 smooth isotropic harmonics distributed evenly across 360 degrees using golden ratio
  for (let i = 0; i < 36; i++) {
    const octave = Math.floor(i / 6);
    const baseFreq = 2.0 * Math.pow(1.5, octave);
    const r = baseFreq * (0.9 + 0.2 * rand());
    const theta = i * goldenAngle;
    // Strictly isotropic 1:1 integer wave numbers (no axis compression or shearing)
    const kx = Math.round(r * Math.cos(theta));
    const kz = Math.round(r * Math.sin(theta));
    const key = `${kx},${kz}`;
    if ((kx === 0 && kz === 0) || used.has(key)) continue;
    used.add(key);

    const magSq = kx * kx + kz * kz;
    // Kolmogorov / Phillips hydrodynamic power spectrum E(k) ~ k^-1.7
    const amp = Math.pow(magSq, -0.85) * (0.7 + 0.6 * rand());
    const phase = rand() * Math.PI * 2.0;
    waves.push([kx, kz, amp, phase]);
  }

  const numPixels = size * size;
  const dX = new Float32Array(numPixels);
  const dZ = new Float32Array(numPixels);

  let varSum = 0;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      for (const [kx, kz, amp, phase] of waves) {
        const theta = 2.0 * Math.PI * (kx * u + kz * v) + phase;
        const dH = -Math.sin(theta) * amp * 2.0 * Math.PI;
        dX[idx] += dH * kx;
        dZ[idx] += dH * kz;
      }
      varSum += dX[idx] * dX[idx] + dZ[idx] * dZ[idx];
    }
  }

  const normFactor = 1.0 / Math.sqrt(varSum / numPixels / 2.0);
  const data = new Uint8Array(numPixels * 4);
  for (let i = 0; i < numPixels; i++) {
    // Gentle isotropic slope factor (0.28) guarantees smooth C-infinity curvature without angular facets
    const nx = Math.max(-0.95, Math.min(0.95, dX[i] * normFactor * 0.28));
    const nz = Math.max(-0.95, Math.min(0.95, dZ[i] * normFactor * 0.28));
    const ny = Math.sqrt(Math.max(0.01, 1.0 - nx * nx - nz * nz));

    data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    data[i * 4 + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function generateFoamTexture(size = 256): THREE.DataTexture {
  const perm = new Uint8Array(512);
  let seed = 424242;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = perm[i & 255];

  const gradX = new Float32Array(256);
  const gradY = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const th = (i / 256) * Math.PI * 2;
    gradX[i] = Math.cos(th);
    gradY[i] = Math.sin(th);
  }

  function perlin2D(x: number, y: number, period: number): number {
    const X0 = ((Math.floor(x) % period) + period) % period;
    const Y0 = ((Math.floor(y) % period) + period) % period;
    const X1 = (X0 + 1) % period;
    const Y1 = (Y0 + 1) % period;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6.0 - 15.0) + 10.0);
    const v = yf * yf * yf * (yf * (yf * 6.0 - 15.0) + 10.0);

    const g00 = perm[perm[X0] + Y0];
    const g10 = perm[perm[X1] + Y0];
    const g01 = perm[perm[X0] + Y1];
    const g11 = perm[perm[X1] + Y1];

    const d00 = gradX[g00] * xf + gradY[g00] * yf;
    const d10 = gradX[g10] * (xf - 1.0) + gradY[g10] * yf;
    const d01 = gradX[g01] * xf + gradY[g01] * (yf - 1.0);
    const d11 = gradX[g11] * (xf - 1.0) + gradY[g11] * (yf - 1.0);

    const x1 = d00 + u * (d10 - d00);
    const x2 = d01 + u * (d11 - d01);
    return x1 + v * (x2 - x1);
  }

  const numPixels = size * size;
  const data = new Uint8Array(numPixels * 4);

  const rawR = new Float32Array(numPixels);
  const rawG = new Float32Array(numPixels);
  const rawB = new Float32Array(numPixels);

  let minR = 1e9, maxR = -1e9;
  let minG = 1e9, maxG = -1e9;
  let minB = 1e9, maxB = -1e9;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;

      // Strictly periodic fluid domain warping (turbulent curl displacement):
      const wU = perlin2D(u * 4.0, v * 4.0, 4) * 0.14;
      const wV = perlin2D(u * 4.0 + 2.3, v * 4.0 + 1.7, 4) * 0.14;
      const uw = u + wU;
      const vw = v + wV;

      const n1 = perlin2D(uw * 4.0, vw * 4.0, 4) * 0.5 + 0.5;
      const n2 = perlin2D(uw * 8.0, vw * 8.0, 8) * 0.5 + 0.5;
      const n3 = perlin2D(uw * 16.0, vw * 16.0, 16) * 0.5 + 0.5;
      const n4 = perlin2D(u * 32.0, v * 32.0, 32) * 0.5 + 0.5;

      // Channel R: Billowy whitecap froth heads (fluffy aerated cloud billows)
      const froth = Math.pow(n1 * 0.46 + n2 * 0.34 + n3 * 0.15 + n4 * 0.05, 1.25);

      // Channel G: Lacy filamentary streamers / veins (ridge noise on warped coordinates)
      const vein = Math.pow(1.0 - Math.abs(2.0 * (n2 * 0.62 + n3 * 0.38) - 1.0), 1.5);

      // Channel B: Micro-bubble effervescence speckle
      const bubbles = Math.pow(n3 * 0.55 + n4 * 0.45, 1.4);

      rawR[idx] = froth;
      rawG[idx] = vein;
      rawB[idx] = bubbles;

      if (froth < minR) minR = froth; if (froth > maxR) maxR = froth;
      if (vein < minG) minG = vein; if (vein > maxG) maxG = vein;
      if (bubbles < minB) minB = bubbles; if (bubbles > maxB) maxB = bubbles;
    }
  }

  const rangeR = maxR - minR || 1.0;
  const rangeG = maxG - minG || 1.0;
  const rangeB = maxB - minB || 1.0;

  for (let i = 0; i < numPixels; i++) {
    const rNorm = (rawR[i] - minR) / rangeR;
    const gNorm = (rawG[i] - minG) / rangeG;
    const bNorm = (rawB[i] - minB) / rangeB;
    const aNorm = Math.min(1.0, rNorm * 0.65 + gNorm * 0.35);

    data[i * 4] = Math.round(rNorm * 255);
    data[i * 4 + 1] = Math.round(gNorm * 255);
    data[i * 4 + 2] = Math.round(bNorm * 255);
    data[i * 4 + 3] = Math.round(aNorm * 255);
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class RiverWater {
  readonly terrain: RiverTerrain;
  readonly hydraulics: RiverHydraulics;
  readonly rocks: RiverRocks;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(
    terrain: RiverTerrain,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    screenTarget: THREE.WebGLRenderTarget,
    hydraulics: RiverHydraulics,
    rocks: RiverRocks
  ) {
    this.terrain = terrain;
    this.hydraulics = hydraulics;
    this.rocks = rocks;

    const segsZ = 320;
    const segsX = 80;
    const channelW = 20.0;

    const geo = new THREE.PlaneGeometry(channelW, terrain.length, segsX, segsZ);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const uX = pos.getX(i);
      const z = pos.getZ(i);
      const xc = terrain.getRiverCenter(z);
      const waterY = hydraulics.getWaterHeightAt(z);

      pos.setX(i, xc + uX);
      pos.setY(i, waterY);
    }
    geo.computeVertexNormals();

    const boulderUniforms: THREE.Vector4[] = [];
    for (let i = 0; i < 10; i++) {
      if (rocks.boulders[i]) {
        const b = rocks.boulders[i];
        boulderUniforms.push(new THREE.Vector4(b.center.x, b.center.y, b.center.z, b.radius));
      } else {
        boulderUniforms.push(new THREE.Vector4(0, -999, 0, 0));
      }
    }

    const waterNormalMap = generateWaterNormalMap(512);
    const foamMap = generateFoamTexture(256);

    const dummyEnv = new THREE.DataTexture(new Uint8Array([120, 160, 210, 255]), 1, 1, THREE.RGBAFormat);
    dummyEnv.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHydraulicsTex: { value: hydraulics.texture },
        uScreenTex: { value: screenTarget.texture },
        uWaterNormalMap: { value: waterNormalMap },
        uFoamTex: { value: foamMap },
        uEnvMap: { value: dummyEnv },
        uHasEnvMap: { value: 0 },
        uBoulders: { value: boulderUniforms },
        uSunDir: { value: sunDir },
        uSunColor: { value: sunColor },
        uTime: { value: 0.0 },
        uAbsorbScale: { value: 3.5 },
        uFoamScale: { value: 1.0 },
        uFlowSpeed: { value: 3.8 },
        uRainIntensity: { value: 0.0 },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        uniform sampler2D uHydraulicsTex;
        uniform float uTime;
        uniform float uFlowSpeed;
        uniform vec4 uBoulders[10];

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec4 vScreenPos;
        varying vec2 vFlowDir;
        varying vec4 vHydraulics;
        varying vec2 vRiverUv;

        float getRiverCenter(float z) {
          return 4.0 * sin(z * 0.07) + 1.8 * cos(z * 0.15);
        }

        float getBedElevation(float z) {
          float t = (z + 40.0) / 80.0;
          float base = (1.0 - t) * 6.5;
          float p1 = exp(-pow((z + 16.0) / 6.5, 2.0)) * 0.45;
          float p2 = exp(-pow((z - 14.0) / 7.5, 2.0)) * 0.50;
          float p3 = exp(-pow((z - 32.0) / 6.0, 2.0)) * 0.35;
          return base - (p1 + p2 + p3);
        }

        float getBedHeight(float x, float z) {
          float slope = getBedElevation(z);
          float xc = getRiverCenter(z);
          float d = abs(x - xc);
          float w = 4.0;
          float dMax = 0.85;
          float bedDepth = 0.0;
          if (d < w) {
            float t = d / w;
            bedDepth = -dMax * (1.0 - t * t);
          } else {
            bedDepth = 0.22 * (d - w) + 0.12 * log(1.0 + 1.2 * (d - w));
          }
          float rockNoise = sin(x * 1.5) * cos(z * 1.5) * 0.08;
          return slope + bedDepth + rockNoise;
        }

        void main() {
          vRiverUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);

          float uStation = clamp((wp.z + 40.0) / 80.0, 0.0, 1.0);
          vec4 hyd = texture2D(uHydraulicsTex, vec2(uStation, 0.5));
          vHydraulics = hyd;

          float bedY = getBedHeight(wp.x, wp.z);
          float streamDist = (1.0 - uv.y) * 80.0;
          float xc = getRiverCenter(wp.z);
          float crossDist = wp.x - xc;
          float absCross = abs(crossDist);

          // Physical hydraulic wave amplitude based on velocity head (Hv = v^2 / 2g):
          float baseAmp = clamp(hyd.a * 0.22, 0.035, 0.36);

          // Multi-directional open-channel wave dynamics:
          // 1. Primary downstream standing swell
          float wDown = sin(streamDist * 0.65 - uTime * (uFlowSpeed * 0.85)) * 0.40;
          // 2. Chevron wake waves radiating diagonally outward toward banks (moves in x as flow travels in z)
          float wChevron = sin(streamDist * 1.15 - absCross * 1.10 - uTime * (uFlowSpeed * 0.95)) * 0.35;
          // 3. Cross-channel transverse surging (dynamic widthwise slosh across river corridor)
          float wCross = sin(crossDist * 0.75 + sin(streamDist * 0.30) * 1.2 - uTime * (uFlowSpeed * 0.60)) * 0.25;
          // 4. Edge lapping swash pulsing against the shoreline gravel
          float wLap = sin(streamDist * 1.95 + crossDist * 1.35 - uTime * (uFlowSpeed * 1.10)) * 0.15;

          // REEF3D Non-Hydrostatic Bow Wave & Stagnation Pressure Head over Boulders:
          float bowRooster = 0.0;
          for (int b = 0; b < 10; b++) {
            vec4 bld = uBoulders[b];
            if (bld.w > 0.1) {
              float dx = wp.x - bld.x;
              float dz = wp.z - bld.z;
              float dist = sqrt(dx * dx + dz * dz);
              float r = bld.w;
              // Upstream stagnation rooster: dynamic velocity head converts into vertical crest
              if (dist < r * 2.2 && dz < 0.2) {
                float upstreamFrac = clamp(1.0 - dist / (r * 2.0), 0.0, 1.0);
                float stagnationHead = hyd.a * 0.42;
                bowRooster += stagnationHead * pow(upstreamFrac, 1.5) * max(0.0, -dz / dist);
              }
              // Downstream wake drawdown cavity:
              if (dist < r * 2.0 && dz > 0.0) {
                float wakeFrac = clamp(1.0 - dist / (r * 1.8), 0.0, 1.0);
                bowRooster -= hyd.a * 0.22 * pow(wakeFrac, 2.0) * (dz / dist);
              }
            }
          }

          float wave = (wDown + wChevron + wCross + wLap) * baseAmp + bowRooster;

          // Instantaneous water surface elevation:
          float waterSurf = hyd.g + wave;

          // Dynamic shoreline swash: water surges freely up sloping banks during wave crests,
          // and conforms cleanly to terrain when the wave retreats (zero dipping under ground).
          wp.y = max(bedY, waterSurf);

          float eps = 0.5;
          float x0 = getRiverCenter(wp.z - eps);
          float x1 = getRiverCenter(wp.z + eps);
          vec2 flowDir = normalize(vec2((x1 - x0) / (2.0 * eps), 1.0));
          vFlowDir = flowDir;

          vWorldPos = wp.xyz;
          vNormal = normalize(mat3(modelMatrix) * normal + vec3(0.0, 1.0, 0.0));

          vec4 clip = projectionMatrix * viewMatrix * wp;
          vScreenPos = clip;
          gl_Position = clip;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uHydraulicsTex;
        uniform sampler2D uScreenTex;
        uniform sampler2D uWaterNormalMap;
        uniform sampler2D uFoamTex;
        uniform sampler2D uEnvMap;
        uniform int uHasEnvMap;
        uniform vec4 uBoulders[10];
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uTime;
        uniform float uAbsorbScale;
        uniform float uFoamScale;
        uniform float uFlowSpeed;
        uniform float uRainIntensity;

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec4 vScreenPos;
        varying vec2 vFlowDir;
        varying vec4 vHydraulics;
        varying vec2 vRiverUv;

        float getRiverCenter(float z) {
          return 4.0 * sin(z * 0.07) + 1.8 * cos(z * 0.15);
        }

        float getBedElevation(float z) {
          float t = (z + 40.0) / 80.0;
          float base = (1.0 - t) * 6.5;
          float p1 = exp(-pow((z + 16.0) / 6.5, 2.0)) * 0.45;
          float p2 = exp(-pow((z - 14.0) / 7.5, 2.0)) * 0.50;
          float p3 = exp(-pow((z - 32.0) / 6.0, 2.0)) * 0.35;
          return base - (p1 + p2 + p3);
        }

        float getBedHeight(float x, float z) {
          float slope = getBedElevation(z);
          float xc = getRiverCenter(z);
          float d = abs(x - xc);
          float w = 4.0;
          float dMax = 0.85;
          float bedDepth = 0.0;
          if (d < w) {
            float t = d / w;
            bedDepth = -dMax * (1.0 - t * t);
          } else {
            bedDepth = 0.22 * (d - w) + 0.12 * log(1.0 + 1.2 * (d - w));
          }
          float rockNoise = sin(x * 1.5) * cos(z * 1.5) * 0.08;
          return slope + bedDepth + rockNoise;
        }

        void main() {
          float localVelocity = vHydraulics.r;
          float localFroude = vHydraulics.b;
          float localHead = vHydraulics.a;

          float bedY = getBedHeight(vWorldPos.x, vWorldPos.z);
          float depth = vWorldPos.y - bedY;

          if (depth <= 0.0005) {
            discard;
          }

          // Boundary Layer Physics & Boulder Wake Tracking:
          float wakeFoam = 0.0;
          for (int i = 0; i < 10; i++) {
            vec3 bPos = uBoulders[i].xyz;
            float bR = uBoulders[i].w;
            if (bR <= 0.05) continue;

            vec2 dXZ = vWorldPos.xz - bPos.xz;
            float distToBoulder = length(dXZ);
            float downstreamDist = vWorldPos.z - bPos.z;
            float crossDist = abs(dXZ.x);

            // 1. Upstream Bow Shock (rushing water slamming into upstream face of boulder)
            if (downstreamDist <= 0.20 && distToBoulder < bR * 1.40) {
              float bowIntensity = smoothstep(bR * 1.40, bR * 0.85, distToBoulder);
              wakeFoam += bowIntensity * 1.45;
            }

            // 2. Expanding V-wake trailing behind boulder
            if (downstreamDist > 0.0 && downstreamDist < bR * 6.5) {
              float wakeSpread = bR * (0.85 + (downstreamDist / (bR * 6.5)) * 1.25);
              if (crossDist < wakeSpread) {
                float zFactor = 1.0 - (downstreamDist / (bR * 6.5));
                float xFactor = 1.0 - (crossDist / wakeSpread);
                wakeFoam += zFactor * xFactor * 1.15;
              }
            }
          }

          // Curvilinear downstream coordinate (0.0 at upstream summit z=-40 -> 80.0 at valley base z=+40):
          float streamDist = (1.0 - vRiverUv.y) * 80.0;
          float xc = getRiverCenter(vWorldPos.z);
          float crossDist = vWorldPos.x - xc;

          // UNIFORM TIME ADVECTION (Guarantees zero spatial shear, zero Nyquist aliasing, locked mipmap 0):
          float flowDist1 = streamDist - uTime * uFlowSpeed;
          float flowDist2 = streamDist - uTime * (uFlowSpeed * 1.35);
          float flowDist3 = streamDist - uTime * (uFlowSpeed * 1.70);

          // Dynamic widthwise drift & lateral expansion:
          // Ripples actively drift and expand diagonally outward toward the banks as water rushes downstream
          float latDrift1 = crossDist - sign(crossDist) * (uTime * (uFlowSpeed * 0.16));
          float latDrift2 = crossDist + sin(streamDist * 0.45 - uTime * 2.2) * 0.35;
          float latDrift3 = crossDist - sign(crossDist) * (uTime * (uFlowSpeed * 0.26));

          // Three-tier multi-scale waves (moving downstream AND widthwise):
          vec2 uvSwell = vec2(latDrift1, flowDist1) * 0.30;
          vec3 nSwell = texture2D(uWaterNormalMap, uvSwell).rgb * 2.0 - 1.0;

          vec2 uvRipple = mat2(0.978, -0.208, 0.208, 0.978) * (vec2(latDrift2, flowDist2) * 0.72);
          vec3 nRipple = texture2D(uWaterNormalMap, uvRipple).rgb * 2.0 - 1.0;

          vec2 uvChop = mat2(0.927, 0.375, -0.375, 0.927) * (vec2(latDrift3, flowDist3) * 1.50);
          vec3 nChop = texture2D(uWaterNormalMap, uvChop).rgb * 2.0 - 1.0;

          // Ripples stay alive right up to the water edge (calming only in final 2.5 mm):
          float rippleDamping = smoothstep(0.001, 0.025, depth);
          vec3 normalPerturb = (nSwell.xzy * 0.48 + nRipple.xzy * 0.36 + nChop.xzy * 0.16) * rippleDamping;

          // Dynamic Raindrop Impact Rings across the river surface:
          if (uRainIntensity > 0.5) {
            vec2 rainGrid = vWorldPos.xz * 3.6;
            vec2 rCell = floor(rainGrid);
            vec2 rFrac = fract(rainGrid) - 0.5;
            float rPhase = fract(sin(dot(rCell, vec2(127.1, 311.7))) * 43758.5453 + uTime * 4.0);
            float rDist = length(rFrac);
            float rRing = sin(rDist * 32.0 - rPhase * 22.0) * exp(-rDist * 4.5) * (1.0 - rPhase);
            float rScale = clamp(uRainIntensity / 50.0, 0.0, 1.0) * 0.22;
            normalPerturb.x += rRing * rScale;
            normalPerturb.z += rRing * rScale;
          }

          vec3 N = normalize(vec3(vNormal.x + normalPerturb.x * 0.092, 1.0, vNormal.z + normalPerturb.z * 0.092));

          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uSunDir);
          vec3 H = normalize(L + V);
          vec3 R = reflect(-V, N);

          // VISIBLE DANCING SUNLIGHT CAUSTICS ON RIVERBED:
          // Sunlight focused by racing surface waves onto pebbles
          vec2 cUv1 = vec2(crossDist * 0.90, (streamDist - uTime * uFlowSpeed * 1.08) * 0.90);
          vec2 cUv2 = vec2(crossDist * 1.35 + 0.35, (streamDist - uTime * uFlowSpeed * 1.32) * 1.35);
          float cWave1 = texture2D(uWaterNormalMap, cUv1).r;
          float cWave2 = texture2D(uWaterNormalMap, cUv2).g;
          float caustics = pow(cWave1 * cWave2, 2.2) * 4.8 * exp(-depth * 0.85) * smoothstep(0.04, 0.40, depth);

          // Screen-space refraction with visible pebble shimmer:
          vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
          // Refraction distortion softly scales down only in the final centimeter so dry banks are never distorted
          float refrDistort = 0.040 * smoothstep(0.006, 0.16, depth);
          vec2 refrUv = clamp(screenUv + normalPerturb.xz * refrDistort, 0.001, 0.999);

          vec3 bedCol;
          bedCol.r = texture2D(uScreenTex, clamp(refrUv + normalPerturb.xz * 0.003, 0.001, 0.999)).r;
          bedCol.g = texture2D(uScreenTex, refrUv).g;
          bedCol.b = texture2D(uScreenTex, clamp(refrUv - normalPerturb.xz * 0.003, 0.001, 0.999)).b;

          // Add racing golden caustics to riverbed:
          bedCol += caustics * uSunColor * 0.75;

          // Spectral Beer-Lambert Absorption
          vec3 alpha = vec3(1.40, 0.55, 0.28) * uAbsorbScale;
          vec3 transmittance = exp(-alpha * (depth + 0.005));
          vec3 scatterColor = vec3(0.015, 0.11, 0.16);
          vec3 waterBody = bedCol * transmittance + scatterColor * (vec3(1.0) - transmittance);

          // HDRI Sky Reflection
          vec3 skyRefl;
          if (uHasEnvMap == 1) {
            vec2 envUv = vec2(
              atan(R.z, R.x) / (2.0 * 3.14159265) + 0.5,
              asin(clamp(R.y, -1.0, 1.0)) / 3.14159265 + 0.5
            );
            skyRefl = texture2D(uEnvMap, envUv).rgb * 0.85;
          } else {
            skyRefl = mix(vec3(0.22, 0.35, 0.48), vec3(0.70, 0.84, 0.98), max(R.y, 0.0));
          }

          float NdotV = clamp(dot(N, V), 0.0, 1.0);
          float fresnel = 0.035 + 0.965 * pow(1.0 - NdotV, 4.0);
          vec3 finalColor = mix(waterBody, skyRefl, fresnel);

          // Specular Sun Highlights (Broad liquid sheen + sharp crest glints):
          float NdotH = max(dot(N, H), 0.0);
          float NdotL = max(dot(N, L), 0.0);
          float broadSpec = pow(NdotH, 24.0) * 0.55 * fresnel * NdotL;
          float sharpGlint = pow(NdotH, 110.0) * 3.2 * fresnel * NdotL;
          finalColor += uSunColor * (broadSpec + sharpGlint);

          // PHOTOREALISTIC CELLULAR FOAM & WHITE-WATER RAPIDS:
          if (uFoamScale > 0.01) {
            // Physical hydraulic triggers:
            float froudeFoam = smoothstep(0.78, 1.22, localFroude) * 1.35;
            float speedFoam = smoothstep(2.6, 5.2, localVelocity) * 1.05;
            float cascadeFoam = smoothstep(0.38, 0.08, depth) * smoothstep(1.4, 3.6, localVelocity) * smoothstep(0.015, 0.10, depth);
            float hydFoam = max(froudeFoam, max(speedFoam, cascadeFoam));
            float rapidTrigger = clamp(hydFoam + wakeFoam * 1.5, 0.0, 2.0);

            // Streamwise anisotropic foam UVs:
            // Cross-stream coordinates are scaled higher (0.85 and 1.60) than downstream coordinates (0.28 and 0.48)
            // This naturally stretches foam features along river streamlines into elegant, flowing streamers!
            vec2 fUv1 = vec2(latDrift1 * 0.85, flowDist1 * 0.28);
            vec2 fUv2 = vec2(latDrift2 * 1.60, flowDist2 * 0.48);

            vec4 foam1 = texture2D(uFoamTex, fUv1);
            vec4 foam2 = texture2D(uFoamTex, fUv2);

            // Active boiling whitecap aeration head (channel R):
            float frothField = foam1.r * 0.65 + foam2.r * 0.35;
            float rapidFroth = smoothstep(0.70 - rapidTrigger * 0.48, 1.08 - rapidTrigger * 0.28, frothField) * min(rapidTrigger * 1.1, 1.4);

            // Passive trailing lacy streamers & bubble rafts (channel G):
            float lacyField = foam1.g * 0.55 + foam2.g * 0.45;
            float streamerTrigger = clamp(wakeFoam * 1.25 + hydFoam * 0.55, 0.0, 1.6);
            float trailingStreamers = smoothstep(0.58 - streamerTrigger * 0.40, 1.02 - streamerTrigger * 0.20, lacyField) * smoothstep(0.04, 0.40, depth);

            // Effervescent micro-bubble flecks around edges (channel B):
            float microBubbles = (foam1.b * 0.5 + foam2.b * 0.5) * smoothstep(0.12, 0.80, rapidTrigger) * 0.40;

            float totalFoam = clamp((rapidFroth * 0.85 + trailingStreamers * 0.55 + microBubbles * 0.35) * uFoamScale, 0.0, 1.0);

            if (totalFoam > 0.008) {
              // 3D micro-relief normal perturbation
              vec3 foamN = normalize(N + vec3((foam1.a - 0.5) * 0.30, 0.0, (foam2.a - 0.5) * 0.30) * totalFoam);
              float foamNdotL = max(dot(foamN, L), 0.0);
              float foamNdotH = max(dot(foamN, H), 0.0);

              // Soft forward-scattered sunlight & ambient alpine sky fill:
              vec3 ambientSky = mix(vec3(0.50, 0.68, 0.82), vec3(0.88, 0.94, 0.99), max(foamN.y, 0.0));
              vec3 directSun = uSunColor * (0.85 + 0.30 * foamNdotL);
              vec3 litFoam = ambientSky * 0.45 + directSun * 0.65;

              // Crisp sparkling sun glints on aerated micro-bubbles:
              float foamGlint = pow(foamNdotH, 36.0) * 1.8 * fresnel * NdotL;
              litFoam += uSunColor * foamGlint;

              // Translucent subsurface blending:
              // Dense core whitecaps reach 92% opacity, while trailing streamers remain translucent (20-60%)
              // letting the luminous turquoise river body glow through!
              float foamOpacity = smoothstep(0.015, 0.80, totalFoam) * mix(0.65, 0.92, totalFoam);
              finalColor = mix(finalColor, litFoam, foamOpacity);
            }
          }

          float shoreAlpha = smoothstep(0.0005, 0.035, depth);
          gl_FragColor = vec4(finalColor, shoreAlpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 10;
  }

  setEnvMap(hdr: THREE.Texture) {
    this.material.uniforms.uEnvMap.value = hdr;
    this.material.uniforms.uHasEnvMap.value = 1;
  }

  setFoamEnabled(enabled: boolean) {
    this.material.uniforms.uFoamScale.value = enabled ? 1.0 : 0.0;
  }

  setRainIntensity(intensity: number) {
    this.material.uniforms.uRainIntensity.value = intensity;
  }

  update(time: number) {
    this.material.uniforms.uTime.value = time;
    const q = this.hydraulics.dischargeQ;
    // Dynamic physical downstream speed in m/s:
    // Q=12 -> 2.8 m/s; Q=22 -> 3.8 m/s; Q=45 -> 6.1 m/s; Q=55 -> 7.1 m/s
    this.material.uniforms.uFlowSpeed.value = 1.6 + (q / 22.0) * 2.2;
  }
}
