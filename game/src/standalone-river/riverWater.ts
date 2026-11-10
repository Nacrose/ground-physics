import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";
import { RiverHydraulics } from "./riverHydraulics";

export class RiverWater {
  readonly terrain: RiverTerrain;
  readonly hydraulics: RiverHydraulics;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(
    terrain: RiverTerrain,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    screenTarget: THREE.WebGLRenderTarget,
    hydraulics: RiverHydraulics
  ) {
    this.terrain = terrain;
    this.hydraulics = hydraulics;

    // Curved ribbon geometry following river path - wide enough to span across the bank slopes
    const segsZ = 320;
    const segsX = 48;
    const channelW = 14.0; // 14m wide spans beyond the 4.5m half-width banks

    const geo = new THREE.PlaneGeometry(channelW, terrain.length, segsX, segsZ);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const uX = pos.getX(i); // [-7.0, +7.0]
      const z = pos.getZ(i);  // [-40, +40]
      const xc = terrain.getRiverCenter(z);
      const waterY = hydraulics.getWaterHeightAt(z);

      pos.setX(i, xc + uX);
      pos.setY(i, waterY);
    }
    geo.computeVertexNormals();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHydraulicsTex: { value: hydraulics.texture },
        uScreenTex: { value: screenTarget.texture },
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
          vec4 wp = modelMatrix * vec4(position, 1.0);

          // Sample real-time Saint-Venant hydraulic state
          // Texture RGBA: r = velocity, g = waterY, b = froude, a = head
          float uStation = clamp((wp.z + 40.0) / 80.0, 0.0, 1.0);
          vec4 hyd = texture2D(uHydraulicsTex, vec2(uStation, 0.5));
          vHydraulics = hyd;

          // Water seeks its own level: perfectly horizontal plane across X at height hyd.g
          float bedY = getBedHeight(wp.x, wp.z);
          float depth = max(0.0, hyd.g - bedY);

          // Standing waves along flow direction (z), damped to ZERO at shorelines so edges remain perfectly level
          float waveAmp = clamp(hyd.a * 0.08, 0.01, 0.16) * smoothstep(0.05, 0.40, depth);
          float wave = sin(wp.z * 1.8 - uTime * hyd.r * 1.2) * waveAmp;
          wave += sin(wp.z * 3.6 - uTime * hyd.r * 2.2) * (waveAmp * 0.4);

          wp.y = hyd.g + wave;

          // Flow tangent along curve
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
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uTime;
        uniform float uAbsorbScale;

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec4 vScreenPos;
        varying vec2 vFlowDir;
        varying vec4 vHydraulics;

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

          // True physical water depth relative to 3D valley terrain
          float bedY = getBedHeight(vWorldPos.x, vWorldPos.z);
          float depth = vWorldPos.y - bedY;

          // Hydrostatic cutoff: if terrain is above water surface, that is dry ground!
          if (depth <= 0.001) {
            discard;
          }

          // Dual-Phase Flow-Mapped Ripples driven by local physical velocity
          float tau = 0.8;
          float t0 = mod(uTime * 0.9, tau);
          float t1 = mod(uTime * 0.9 + tau * 0.5, tau);
          float w0 = sin((t0 / tau) * 3.14159265);
          float w1 = sin((t1 / tau) * 3.14159265);

          vec2 uv0 = vWorldPos.xz * 4.5 + vFlowDir * (t0 * localVelocity * 0.6);
          vec2 uv1 = vWorldPos.xz * 4.5 + vFlowDir * (t1 * localVelocity * 0.6);

          float rip0 = sin(uv0.x * 6.0 + uv0.y * 8.0) * cos(uv0.x * 4.0);
          float rip1 = sin(uv1.x * 6.0 + uv1.y * 8.0) * cos(uv1.x * 4.0);
          vec2 ripGrad = vec2(rip0 * w0 + rip1 * w1, rip1 * w0 + rip0 * w1) * 0.04;

          vec3 N = normalize(vec3(vNormal.x + ripGrad.x, 1.0, vNormal.z + ripGrad.y));
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 L = normalize(uSunDir);
          vec3 H = normalize(L + V);

          // Screen-space normal refraction
          vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
          vec2 refrUv = clamp(screenUv + N.xz * 0.035 * min(depth, 0.3), 0.001, 0.999);
          vec3 bedCol = texture2D(uScreenTex, refrUv).rgb;

          // Spectral Beer-Lambert Absorption
          vec3 alpha = vec3(1.40, 0.55, 0.28) * uAbsorbScale;
          vec3 transmittance = exp(-alpha * (depth + 0.01));

          // Subsurface scattering in wave crests
          vec3 sss = vec3(0.02, 0.12, 0.18) * 0.45 * (vec3(1.0) - transmittance);
          vec3 waterBody = bedCol * transmittance + sss;

          // Fresnel & Specular Sunlight Reflection
          float NdotV = max(dot(N, V), 0.0);
          float NdotL = max(dot(N, L), 0.0);
          float NdotH = max(dot(N, H), 0.0);

          float F0 = 0.02;
          float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
          float spec = pow(NdotH, 90.0) * 0.85;

          vec3 skyRefl = mix(vec3(0.20, 0.32, 0.42), vec3(0.75, 0.85, 0.98), NdotV);
          vec3 finalColor = mix(waterBody, skyRefl, fresnel) + uSunColor * spec * NdotL;

          // Aerated foam in shallow cascades, high Froude supercritical rapids & wave crests
          float cascade = smoothstep(0.30, 0.06, depth);
          float froudeFoam = smoothstep(0.85, 1.35, localFroude);
          float foamWave = sin(vWorldPos.z * 3.5 - uTime * localVelocity * 1.8);
          float foam = max(cascade * 0.5, froudeFoam * 0.85) * smoothstep(0.25, 0.8, foamWave + rip0 * 0.5 + localHead * 0.3);

          if (foam > 0.04) {
            vec3 foamCol = vec3(0.95, 0.98, 1.0) * (0.8 + 0.2 * NdotL);
            finalColor = mix(finalColor, foamCol, foam * 0.90);
          }

          // Hydrostatic sub-millimeter waterline fade:
          // Translucent meniscus where water meets gravel, completely vanishing at depth 0
          float shoreAlpha = smoothstep(0.001, 0.035, depth);

          gl_FragColor = vec4(finalColor, shoreAlpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 10;
  }

  update(time: number) {
    this.material.uniforms.uTime.value = time;
  }
}
