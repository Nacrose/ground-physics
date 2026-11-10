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

    // Curved ribbon geometry following river path
    const segsZ = 320;
    const segsX = 40;
    const channelW = 8.5;

    const geo = new THREE.PlaneGeometry(channelW, terrain.length, segsX, segsZ);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const uX = pos.getX(i); // [-4.25, +4.25]
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

        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);

          // Sample real-time Saint-Venant hydraulic state
          // Texture RGBA: r = velocity, g = waterY, b = froude, a = head
          float uStation = clamp((wp.z + 40.0) / 80.0, 0.0, 1.0);
          vec4 hyd = texture2D(uHydraulicsTex, vec2(uStation, 0.5));
          vHydraulics = hyd;

          // Adjust base water surface elevation according to physical depth & discharge
          wp.y = hyd.g;

          // Flow tangent along curve
          float eps = 0.5;
          float x0 = getRiverCenter(wp.z - eps);
          float x1 = getRiverCenter(wp.z + eps);
          vec2 flowDir = normalize(vec2((x1 - x0) / (2.0 * eps), 1.0));
          vFlowDir = flowDir;

          // Physical standing waves & hydraulic jump displacement
          // Amplitude scales with dynamic velocity head Hv = v^2 / (2g)
          float waveAmp = clamp(hyd.a * 0.10, 0.02, 0.22);
          float wave = sin(wp.z * 1.8 - uTime * hyd.r * 1.2) * cos(wp.x * 2.2) * waveAmp;
          wave += sin(wp.z * 3.6 - uTime * hyd.r * 2.2) * (waveAmp * 0.5);
          wp.y += wave;

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

        float getBedHeight(float x, float z) {
          float slope = (1.0 - (z + 40.0) / 80.0) * 6.5;
          float xc = getRiverCenter(z);
          float d = abs(x - xc);
          float w = 4.5;
          float bedDepth = 0.0;
          if (d < w) {
            float t = d / w;
            bedDepth = -1.45 * (1.0 - t * t);
          }
          return slope + bedDepth;
        }

        void main() {
          float localVelocity = vHydraulics.r;
          float localFroude = vHydraulics.b;
          float localHead = vHydraulics.a;

          // River depth at this position
          float bedY = getBedHeight(vWorldPos.x, vWorldPos.z);
          float depth = max(vWorldPos.y - bedY, 0.02);

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
          vec3 transmittance = exp(-alpha * (depth + 0.02));

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
          float cascade = smoothstep(0.35, 0.08, depth);
          float froudeFoam = smoothstep(0.85, 1.35, localFroude);
          float foamWave = sin(vWorldPos.z * 3.5 - uTime * localVelocity * 1.8);
          float foam = max(cascade * 0.5, froudeFoam * 0.85) * smoothstep(0.25, 0.8, foamWave + rip0 * 0.5 + localHead * 0.3);

          if (foam > 0.04) {
            vec3 foamCol = vec3(0.95, 0.98, 1.0) * (0.8 + 0.2 * NdotL);
            finalColor = mix(finalColor, foamCol, foam * 0.90);
          }

          // Shoreline alpha fade
          float xc = getRiverCenter(vWorldPos.z);
          float distToCenter = abs(vWorldPos.x - xc);
          float shoreAlpha = smoothstep(4.2, 3.6, distToCenter);

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
