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
    const segsX = 48;
    const channelW = 14.0;

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

    const dummyEnv = new THREE.DataTexture(new Uint8Array([120, 160, 210, 255]), 1, 1, THREE.RGBAFormat);
    dummyEnv.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHydraulicsTex: { value: hydraulics.texture },
        uScreenTex: { value: screenTarget.texture },
        uWaterNormalMap: { value: waterNormalMap },
        uEnvMap: { value: dummyEnv },
        uHasEnvMap: { value: 0 },
        uBoulders: { value: boulderUniforms },
        uSunDir: { value: sunDir },
        uSunColor: { value: sunColor },
        uTime: { value: 0.0 },
        uAbsorbScale: { value: 3.5 },
        uFoamScale: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        uniform sampler2D uHydraulicsTex;
        uniform float uTime;

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
          float w = 4.5;
          float bedDepth = 0.0;
          if (d < w) {
            float t = d / w;
            bedDepth = -1.45 * (1.0 - t * t);
          } else {
            bedDepth = 0.5 * log(1.0 + (d - w) * 1.2);
          }
          return slope + bedDepth;
        }

        void main() {
          vRiverUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);

          float uStation = clamp((wp.z + 40.0) / 80.0, 0.0, 1.0);
          vec4 hyd = texture2D(uHydraulicsTex, vec2(uStation, 0.5));
          vHydraulics = hyd;

          float bedY = getBedHeight(wp.x, wp.z);
          float depth = max(0.0, hyd.g - bedY);

          // Hydraulic standing waves (smooth, continuous C-infinity heaving):
          float waveAmp = clamp(hyd.a * 0.22, 0.02, 0.45) * smoothstep(0.05, 0.40, depth);
          float streamDist = uv.y * 80.0;
          float wave = sin(streamDist * 0.75 - uTime * hyd.r * 1.8) * waveAmp;
          wave += sin(streamDist * 1.6 - uTime * hyd.r * 2.8) * (waveAmp * 0.4);

          wp.y = hyd.g + wave;

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
        uniform sampler2D uEnvMap;
        uniform int uHasEnvMap;
        uniform vec4 uBoulders[10];
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uTime;
        uniform float uAbsorbScale;
        uniform float uFoamScale;

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
          float w = 4.5;
          float bedDepth = 0.0;
          if (d < w) {
            float t = d / w;
            bedDepth = -1.45 * (1.0 - t * t);
          } else {
            bedDepth = 0.5 * log(1.0 + (d - w) * 1.2);
          }
          return slope + bedDepth;
        }

        // Procedural Organic Foam Function (Domain-warped fluid froth with zero angularity)
        float computeOrganicFroth(vec2 p, float time) {
          // Turbulent vortex swirl warp
          vec2 warp = vec2(
            sin(p.y * 1.5 + p.x * 0.7 + time * 0.5),
            cos(p.x * 1.3 - p.y * 1.2 - time * 0.3)
          );
          vec2 wp = p + warp * 0.35;

          // Streamwise elongated foam filaments
          float f1 = sin(wp.y * 2.2) * 0.5 + 0.5;
          float f2 = sin(wp.y * 5.4 + wp.x * 1.8 + warp.x * 2.0) * 0.5 + 0.5;
          float f3 = sin(wp.y * 11.0 - wp.x * 3.5) * 0.5 + 0.5;
          float streaks = f1 * 0.35 + f2 * 0.45 + f3 * 0.20;

          // Micro bubble lace
          vec2 cp = wp * 2.8;
          float c1 = sin(cp.x * 2.8 + cp.y * 2.1);
          float c2 = cos(cp.x * 2.4 - cp.y * 3.2);
          float c3 = sin(cp.x * 5.5 + cp.y * 4.8 + time * 0.7);
          float cells = 0.5 + 0.5 * (c1 * c2 + c3 * 0.5);

          return clamp(streaks * 0.60 + cells * 0.40, 0.0, 1.0);
        }

        void main() {
          float localVelocity = vHydraulics.r;
          float localFroude = vHydraulics.b;
          float localHead = vHydraulics.a;

          float bedY = getBedHeight(vWorldPos.x, vWorldPos.z);
          float depth = vWorldPos.y - bedY;

          if (depth <= 0.001) {
            discard;
          }

          // Boundary Layer Physics:
          float delta = 0.45;
          float wallDist = clamp(depth / delta, 0.0, 1.0);
          float wallShear = pow(wallDist, 0.20);

          float boulderShear = 1.0;
          float wakeFoam = 0.0;

          for (int i = 0; i < 10; i++) {
            vec3 bPos = uBoulders[i].xyz;
            float bR = uBoulders[i].w;
            if (bR <= 0.05) continue;

            vec2 dXZ = vWorldPos.xz - bPos.xz;
            float dist = length(dXZ);

            if (dist < bR * 2.4) {
              float skinDist = clamp((dist - bR * 0.95) / (bR * 1.2), 0.0, 1.0);
              boulderShear *= pow(skinDist, 0.35);

              float downstreamDist = vWorldPos.z - bPos.z;
              float crossDist = abs(dXZ.x);
              if (downstreamDist > 0.0 && downstreamDist < bR * 4.0 && crossDist < bR * 1.25) {
                float zFactor = 1.0 - downstreamDist / (bR * 4.0);
                float xFactor = 1.0 - crossDist / (bR * 1.25);
                float wakeIntensity = zFactor * xFactor;

                boulderShear = mix(boulderShear, 0.20, wakeIntensity);
                wakeFoam += wakeIntensity * 0.85;
              }
            }
          }

          float effectiveSpeed = localVelocity * wallShear * boulderShear;

          // Continuous curvilinear coordinates (meters):
          float streamDist = vRiverUv.y * 80.0;
          float xc = getRiverCenter(vWorldPos.z);
          float crossDist = vWorldPos.x - xc;

          // Downstream advection at physical velocity
          float flowMeters = streamDist - uTime * effectiveSpeed * 1.25;

          // STRICTLY ISOTROPIC 1:1 METRIC SAMPLING:
          // No rectangular stretching! All layers maintain 1:1 circular metric scale.
          vec2 baseUv = vec2(crossDist, flowMeters);

          // Layer 1: Macro Torrents & Swells (~3.5m wavelength)
          vec2 uvSwell = baseUv * 0.28;
          vec3 nSwell = texture2D(uWaterNormalMap, uvSwell).rgb * 2.0 - 1.0;

          // Layer 2: Fast Rapid Ripples (~1.5m wavelength, rotated 8.5 deg to break symmetry)
          vec2 uvRipple = mat2(0.989, -0.148, 0.148, 0.989) * (vec2(crossDist, flowMeters * 1.12) * 0.65);
          vec3 nRipple = texture2D(uWaterNormalMap, uvRipple).rgb * 2.0 - 1.0;

          // Layer 3: Capillary Glints (~0.7m wavelength, rotated -18 deg)
          vec2 uvChop = mat2(0.951, 0.309, -0.309, 0.951) * (vec2(crossDist, flowMeters * 1.28) * 1.40);
          vec3 nChop = texture2D(uWaterNormalMap, uvChop).rgb * 2.0 - 1.0;

          // Smooth composite normal:
          vec3 normalPerturb = nSwell.xzy * 0.45 + nRipple.xzy * 0.35 + nChop.xzy * 0.20;

          // Soft normal perturbation scale (0.038) prevents any angular specular facets:
          vec3 N = normalize(vec3(vNormal.x + normalPerturb.x * 0.038, 1.0, vNormal.z + normalPerturb.z * 0.038));

          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uSunDir);
          vec3 H = normalize(L + V);
          vec3 R = reflect(-V, N);

          // Screen-space normal refraction
          vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
          float refrDistort = 0.030 * min(depth, 0.35);
          vec2 refrUv = clamp(screenUv + N.xz * refrDistort, 0.001, 0.999);

          vec3 bedCol;
          bedCol.r = texture2D(uScreenTex, clamp(refrUv + N.xz * 0.002, 0.001, 0.999)).r;
          bedCol.g = texture2D(uScreenTex, refrUv).g;
          bedCol.b = texture2D(uScreenTex, clamp(refrUv - N.xz * 0.002, 0.001, 0.999)).b;

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
          float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
          vec3 finalColor = mix(waterBody, skyRefl, fresnel);

          // Specular Sun Highlights (Smooth, natural, non-angular)
          float NdotH = max(dot(N, H), 0.0);
          float NdotL = max(dot(N, L), 0.0);
          float sunGlint = pow(NdotH, 120.0) * 2.8 * fresnel * NdotL;
          finalColor += uSunColor * sunGlint;

          // ORGANIC TRANSLUCENT WHITE-WATER RAPID FOAM:
          if (uFoamScale > 0.01) {
            // Physical hydraulic triggers:
            float froudeFoam = smoothstep(0.85, 1.30, localFroude);
            float speedFoam = smoothstep(3.2, 6.5, effectiveSpeed);
            float cascadeFoam = smoothstep(0.35, 0.06, depth) * smoothstep(1.8, 4.0, effectiveSpeed);

            float hydFoam = max(froudeFoam * 1.1, max(speedFoam * 0.85, cascadeFoam * 0.90));
            float foamTrigger = clamp(hydFoam + wakeFoam * 1.25, 0.0, 1.5);

            if (foamTrigger > 0.04) {
              vec2 foamCoord = vec2(crossDist * 1.15, flowMeters * 0.70);
              float frothPattern = computeOrganicFroth(foamCoord, uTime);

              // Soft thresholding with wide smooth transition (no sharp binary edges):
              float threshold = 1.10 - foamTrigger * 0.65;
              float foamAlpha = smoothstep(threshold, threshold + 0.45, frothPattern + foamTrigger * 0.45);
              float totalFoam = clamp(foamAlpha * min(foamTrigger, 1.0) * uFoamScale, 0.0, 1.0);

              if (totalFoam > 0.01) {
                // Froth has subtle alpine water tint and gentle sun illumination
                vec3 litFoam = vec3(0.93, 0.97, 1.0) * (0.84 + 0.16 * NdotL);
                // Translucent blending (max 0.82 opacity) lets underlying water and stones show through
                finalColor = mix(finalColor, litFoam, totalFoam * 0.82);
              }
            }
          }

          float shoreAlpha = smoothstep(0.001, 0.035, depth);
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

  update(time: number) {
    this.material.uniforms.uTime.value = time;
  }
}
