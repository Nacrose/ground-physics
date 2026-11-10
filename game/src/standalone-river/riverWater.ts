import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";

export class RiverWater {
  readonly terrain: RiverTerrain;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  flowSpeed = 3.2; // m/s downstream

  constructor(
    terrain: RiverTerrain,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    screenTarget: THREE.WebGLRenderTarget
  ) {
    this.terrain = terrain;

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
      const waterY = terrain.getWaterHeight(xc + uX, z);

      pos.setX(i, xc + uX);
      pos.setY(i, waterY);
    }
    geo.computeVertexNormals();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScreenTex: { value: screenTarget.texture },
        uSunDir: { value: sunDir },
        uSunColor: { value: sunColor },
        uTime: { value: 0.0 },
        uFlowSpeed: { value: this.flowSpeed },
        uAbsorbScale: { value: 3.5 },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec4 vScreenPos;
        varying float vDepth;
        varying vec2 vFlowDir;

        uniform float uTime;
        uniform float uFlowSpeed;

        float getRiverCenter(float z) {
          return 4.0 * sin(z * 0.07) + 1.8 * cos(z * 0.15);
        }

        float getRiverSlope(float z) {
          return (1.0 - (z + 40.0) / 80.0) * 6.5 + 0.35;
        }

        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);

          // Flow tangent along curve
          float eps = 0.5;
          float x0 = getRiverCenter(wp.z - eps);
          float x1 = getRiverCenter(wp.z + eps);
          vec2 flowDir = normalize(vec2((x1 - x0) / (2.0 * eps), 1.0));
          vFlowDir = flowDir;

          // Standing waves / river rapids displacement
          float wave = sin(wp.z * 1.8 - uTime * uFlowSpeed * 1.5) * cos(wp.x * 2.2) * 0.06;
          wave += sin(wp.z * 4.0 - uTime * uFlowSpeed * 2.8) * 0.03;
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
        uniform sampler2D uScreenTex;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uTime;
        uniform float uFlowSpeed;
        uniform float uAbsorbScale;

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec4 vScreenPos;
        varying vec2 vFlowDir;

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
          // River depth at this position
          float bedY = getBedHeight(vWorldPos.x, vWorldPos.z);
          float depth = max(vWorldPos.y - bedY, 0.02);

          // Dual-Phase Flow-Mapped Ripples along river channel
          float tau = 0.8;
          float t0 = mod(uTime * 0.9, tau);
          float t1 = mod(uTime * 0.9 + tau * 0.5, tau);
          float w0 = sin((t0 / tau) * 3.14159265);
          float w1 = sin((t1 / tau) * 3.14159265);

          vec2 uv0 = vWorldPos.xz * 4.5 + vFlowDir * (t0 * uFlowSpeed * 0.6);
          vec2 uv1 = vWorldPos.xz * 4.5 + vFlowDir * (t1 * uFlowSpeed * 0.6);

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

          // Aerated foam in shallow cascades and rapid crests
          float cascade = smoothstep(0.35, 0.08, depth);
          float foamWave = sin(vWorldPos.z * 3.5 - uTime * uFlowSpeed * 2.0);
          float foam = cascade * smoothstep(0.4, 0.8, foamWave + rip0 * 0.4);

          if (foam > 0.05) {
            vec3 foamCol = vec3(0.95, 0.98, 1.0) * (0.8 + 0.2 * NdotL);
            finalColor = mix(finalColor, foamCol, foam * 0.85);
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
    this.material.uniforms.uFlowSpeed.value = this.flowSpeed;
  }
}
