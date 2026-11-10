import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";
import { RiverHydraulics } from "./riverHydraulics";
import { RiverRocks } from "./riverRocks";

function generateWaterNormalMap(size = 512): THREE.DataTexture {
  let seed = 23;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const waves: [number, number, number, number][] = [];
  while (waves.length < 16) {
    const freq = 1.5 + 5.5 * Math.pow(rand(), 1.3);
    const angle = rand() * Math.PI * 2.0;
    const kx = Math.round(freq * Math.cos(angle) * 0.6);
    const kz = Math.round(freq * Math.sin(angle));
    if (kx === 0 && kz === 0) continue;
    const mag = Math.hypot(kx, kz);
    const amp = Math.pow(mag, -2.0) * (0.6 + 0.8 * rand());
    const phase = rand() * Math.PI * 2.0;
    waves.push([kx, kz, amp, phase]);
  }

  const numPixels = size * size;
  const dX = new Float32Array(numPixels);
  const dZ = new Float32Array(numPixels);

  let varSum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const idx = y * size + x;
      for (const [kx, kz, amp, phase] of waves) {
        const theta = 2.0 * Math.PI * (kx * u + kz * v) + phase;
        const dH = Math.cos(theta) * amp * 2.0 * Math.PI;
        dX[idx] += dH * kx;
        dZ[idx] += dH * kz;
      }
      varSum += dX[idx] * dX[idx] + dZ[idx] * dZ[idx];
    }
  }

  const normFactor = 1.0 / Math.sqrt(varSum / numPixels / 2.0);
  const data = new Uint8Array(numPixels * 4);
  for (let i = 0; i < numPixels; i++) {
    const nx = Math.max(-1.0, Math.min(1.0, dX[i] * normFactor * 0.45));
    const nz = Math.max(-1.0, Math.min(1.0, dZ[i] * normFactor * 0.45));
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

          // Surging hydraulic standing waves (scales aggressively with velocity head Hv = v^2 / 2g):
          // At 45-55 m³/s, waves heave up to 0.55m tall, rushing downstream
          float waveAmp = clamp(hyd.a * 0.28, 0.03, 0.55) * smoothstep(0.05, 0.40, depth);
          float streamDist = uv.y * 80.0;
          float wave = sin(streamDist * 0.75 - uTime * hyd.r * 2.0) * waveAmp;
          wave += sin(streamDist * 1.7 - uTime * hyd.r * 3.2) * (waveAmp * 0.5);

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
          vec2 wakeDrift = vec2(0.0);
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
              if (downstreamDist > 0.0 && downstreamDist < bR * 3.8 && crossDist < bR * 1.15) {
                float zFactor = 1.0 - downstreamDist / (bR * 3.8);
                float xFactor = 1.0 - crossDist / (bR * 1.15);
                float wakeIntensity = zFactor * xFactor;

                boulderShear = mix(boulderShear, 0.15, wakeIntensity);
                wakeDrift += vec2(-sign(dXZ.x) * 0.25, -0.30) * wakeIntensity;
                wakeFoam += wakeIntensity * 0.75;
              }
            }
          }

          float effectiveSpeed = localVelocity * wallShear * boulderShear;

          // CURVILINEAR CONTINUOUS DOWNSTREAM FLOW FIELD:
          // Streamwise distance along the serpentine river curve in meters [0, 80]
          float streamDist = vRiverUv.y * 80.0;
          float xc = getRiverCenter(vWorldPos.z);
          float crossDist = vWorldPos.x - xc;

          // Continuous advection coordinate in meters (traveling downstream at physical speed v)
          float flowMeters = streamDist - uTime * effectiveSpeed * 1.35;

          // Multi-Scale Curvilinear Wave Layers:
          // Layer 1: Macro Torrent Swells (4.5m wavelength, scrolling continuously downstream)
          vec2 uvSwell = vec2(crossDist * 0.35, flowMeters * 0.22);
          vec3 nSwell = texture2D(uWaterNormalMap, uvSwell).rgb * 2.0 - 1.0;

          // Layer 2: Fast Rapid Ripples (1.8m wavelength)
          vec2 uvRipple = vec2(crossDist * 0.85, flowMeters * 0.55);
          vec3 nRipple = texture2D(uWaterNormalMap, uvRipple).rgb * 2.0 - 1.0;

          // Layer 3: High-Frequency Water Glints (0.8m wavelength)
          vec2 uvGlint = vec2(crossDist * 1.8, flowMeters * 1.25);
          vec3 nGlint = texture2D(uWaterNormalMap, uvGlint).rgb * 2.0 - 1.0;

          vec3 normalPerturb = nSwell.xzy * 0.50 + nRipple.xzy * 0.35 + nGlint.xzy * 0.15;
          vec3 N = normalize(vec3(vNormal.x + normalPerturb.x * 0.09, 1.0, vNormal.z + normalPerturb.z * 0.09));

          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uSunDir);
          vec3 H = normalize(L + V);
          vec3 R = reflect(-V, N);

          // Screen-space normal refraction
          vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
          float refrDistort = 0.038 * min(depth, 0.35);
          vec2 refrUv = clamp(screenUv + N.xz * refrDistort, 0.001, 0.999);

          vec3 bedCol;
          bedCol.r = texture2D(uScreenTex, clamp(refrUv + N.xz * 0.0025, 0.001, 0.999)).r;
          bedCol.g = texture2D(uScreenTex, refrUv).g;
          bedCol.b = texture2D(uScreenTex, clamp(refrUv - N.xz * 0.0025, 0.001, 0.999)).b;

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

          // Specular Sun Glints
          float NdotH = max(dot(N, H), 0.0);
          float NdotL = max(dot(N, L), 0.0);
          float sunGlint = pow(NdotH, 180.0) * 3.5 * fresnel * NdotL;
          finalColor += uSunColor * sunGlint;

          // VIOLENT WHITE-WATER TORRENT FOAM (Racing downstream at physical velocity):
          // High-speed foam streaks along the current
          float streak1 = sin(flowMeters * 2.5) * cos(crossDist * 3.5);
          float streak2 = sin(flowMeters * 5.8 + 1.2) * cos(crossDist * 7.0);
          float streak3 = sin(flowMeters * 12.0 - 0.7) * cos(crossDist * 14.0);
          float foamStreaks = smoothstep(0.12, 0.70, streak1 * 0.5 + streak2 * 0.35 + streak3 * 0.25);

          // Cellular bubbly froth
          vec2 fUv = vec2(crossDist * 1.8, flowMeters * 1.1);
          float fbm = sin(fUv.x * 3.5 + fUv.y * 3.0) * 0.5 +
                      sin(fUv.x * 7.5 - fUv.y * 7.0) * 0.3 +
                      sin(fUv.x * 15.0 + fUv.y * 14.0) * 0.2;
          float foamCell = smoothstep(-0.25, 0.45, fbm);

          // Rapid foam triggers in fast chutes and high Froude supercritical zones
          float cascade = smoothstep(0.35, 0.05, depth) * 1.1;
          float froudeFoam = smoothstep(0.75, 1.25, localFroude) * 1.3;
          float speedFoam = smoothstep(3.0, 7.0, effectiveSpeed) * 0.95;

          float dynamicFoam = max(cascade, max(froudeFoam, speedFoam)) * max(foamCell, foamStreaks * 1.4);
          float totalFoam = clamp(max(dynamicFoam, wakeFoam * foamCell), 0.0, 1.0);

          if (totalFoam > 0.03) {
            vec3 foamCol = vec3(0.97, 0.99, 1.0) * (0.85 + 0.15 * NdotL);
            finalColor = mix(finalColor, foamCol, totalFoam * 0.94);
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

  update(time: number) {
    this.material.uniforms.uTime.value = time;
  }
}
