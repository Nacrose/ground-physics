import * as THREE from "three";
import { RiverHydraulics } from "./riverHydraulics";

export interface PuddleBasin {
  xOffset: number; // offset from river center xc(z)
  z: number;
  radius: number;
  depth: number;
  name: string;
}

export const PUDDLE_BASINS: PuddleBasin[] = [
  { xOffset: -5.6, z: -16.0, radius: 2.2, depth: 0.15, name: "West Terrace Basin" },
  { xOffset: 5.4,  z: -4.0,  radius: 2.5, depth: 0.18, name: "East Gravel Bar Pool" },
  { xOffset: -5.8, z: 12.0,  radius: 2.4, depth: 0.16, name: "West Floodplain Hollow" },
  { xOffset: 5.2,  z: 26.0,  radius: 2.5, depth: 0.17, name: "East Lower Gravel Bar" },
];

export class RiverTerrain {
  readonly length = 80.0; // Z from -40 to +40
  readonly width = 32.0;  // X from -16 to +16
  readonly channelHalfWidth = 4.0;
  readonly baseDrop = 6.5; // descends 6.5m over 80m

  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(
    texLoader: THREE.TextureLoader,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    hydraulics: RiverHydraulics
  ) {
    const resX = 160;
    const resZ = 240;

    const geo = new THREE.PlaneGeometry(this.width, this.length, resX, resZ);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, this.getBedHeight(x, z));
    }
    geo.computeVertexNormals();

    // PBR Textures
    const pebbleDiffuse = texLoader.load("/assets-1k/ganges_river_pebbles/Diffuse.jpg");
    const pebbleNor = texLoader.load("/assets-1k/ganges_river_pebbles/nor_gl.jpg");
    const pebbleArm = texLoader.load("/assets-1k/ganges_river_pebbles/arm.jpg");
    pebbleDiffuse.wrapS = pebbleDiffuse.wrapT = THREE.RepeatWrapping;
    pebbleNor.wrapS = pebbleNor.wrapT = THREE.RepeatWrapping;
    pebbleArm.wrapS = pebbleArm.wrapT = THREE.RepeatWrapping;

    const bankDiffuse = texLoader.load("/assets-1k/rock_08/Diffuse.jpg");
    const bankNor = texLoader.load("/assets-1k/rock_08/nor_gl.jpg");
    const bankArm = texLoader.load("/assets-1k/rock_08/arm.jpg");
    bankDiffuse.wrapS = bankDiffuse.wrapT = THREE.RepeatWrapping;
    bankNor.wrapS = bankNor.wrapT = THREE.RepeatWrapping;
    bankArm.wrapS = bankArm.wrapT = THREE.RepeatWrapping;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHydraulicsTex: { value: hydraulics.texture },
        uPebbleMap: { value: pebbleDiffuse },
        uPebbleNor: { value: pebbleNor },
        uPebbleArm: { value: pebbleArm },
        uBankMap: { value: bankDiffuse },
        uBankNor: { value: bankNor },
        uBankArm: { value: bankArm },
        uSunDir: { value: sunDir },
        uSunColor: { value: sunColor },
        uTime: { value: 0.0 },
        uRainIntensity: { value: 0.0 },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec2 vUv;

        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uHydraulicsTex;
        uniform sampler2D uPebbleMap;
        uniform sampler2D uPebbleNor;
        uniform sampler2D uPebbleArm;
        uniform sampler2D uBankMap;
        uniform sampler2D uBankNor;
        uniform sampler2D uBankArm;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uTime;
        uniform float uRainIntensity;

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec2 vUv;

        // River centerline function
        float getRiverCenter(float z) {
          return 4.0 * sin(z * 0.07) + 1.8 * cos(z * 0.15);
        }

        void main() {
          float xCenter = getRiverCenter(vWorldPos.z);
          float distToCenter = abs(vWorldPos.x - xCenter);

          // Real-time hydraulic water surface elevation
          float uStation = clamp((vWorldPos.z + 40.0) / 80.0, 0.0, 1.0);
          vec4 hyd = texture2D(uHydraulicsTex, vec2(uStation, 0.5));
          float waterY = hyd.g;

          // Riverbed vs Bank blending (gravel bar extends across wide flood corridor)
          float channelMask = smoothstep(7.2, 4.2, distToCenter);

          // UV mapping
          vec2 pebbleUv = vWorldPos.xz * 1.5;
          vec2 bankUv = vWorldPos.xz * 0.6;

          vec3 pebbleCol = texture2D(uPebbleMap, pebbleUv).rgb;
          vec3 pebbleArm = texture2D(uPebbleArm, pebbleUv).rgb;

          vec3 bankCol = texture2D(uBankMap, bankUv).rgb;
          vec3 bankArm = texture2D(uBankArm, bankUv).rgb;

          vec3 albedo = mix(bankCol, pebbleCol, channelMask);
          vec3 arm = mix(bankArm, pebbleArm, channelMask);

          // Dynamic wetness darkening where under water or near surging swash shoreline
          float submerged = smoothstep(waterY + 0.16, waterY - 0.04, vWorldPos.y);
          albedo *= mix(1.0, 0.45, submerged);
          float roughness = mix(arm.g, 0.08, submerged);

          // Dynamic Rain Wetness (terrain absorbs water, turns dark & glossy)
          float rainWetness = clamp(uRainIntensity / 50.0, 0.0, 1.0);
          if (rainWetness > 0.005) {
            albedo *= mix(1.0, 0.64, rainWetness * 0.85);
            roughness = mix(roughness, 0.06, rainWetness * 0.72);
          }

          // Lighting
          vec3 L = normalize(uSunDir);
          vec3 N = normalize(vNormal);
          float NdotL = max(dot(N, L), 0.0);

          // Ambient & direct
          vec3 ambient = vec3(0.18, 0.22, 0.26) * arm.r;
          vec3 direct = uSunColor * NdotL;

          // Dynamic sunlight caustics dancing on submerged riverbed (moving downstream +z)
          if (submerged > 0.1 && channelMask > 0.2) {
            float sDist = (vWorldPos.z + 40.0);
            float c1 = sin(vWorldPos.x * 5.0 + sin(sDist * 0.4) * 1.5) * cos(sDist * 4.5 - uTime * 4.2);
            float c2 = sin(vWorldPos.x * 9.0 - sin(sDist * 0.8) * 1.2) * cos(sDist * 8.5 - uTime * 5.8);
            float caust = pow(max(c1 + c2, 0.0), 2.5) * 1.5;
            direct += uSunColor * caust * submerged;
          }

          vec3 finalColor = albedo * (ambient + direct);

          // Visible Hillslope Runoff Sheet & Glistening Sheen:
          // Water sheets down the valley banks (distToCenter > 4.1) towards the river
          if (rainWetness > 0.01 && distToCenter > 4.0) {
            vec2 runoffDir = normalize(vec2(-sign(vWorldPos.x - xCenter) * 1.8, 0.65));
            float flowSpeed = 3.2 + rainWetness * 1.8;
            vec2 rUv1 = vWorldPos.xz * 2.2 + runoffDir * (uTime * flowSpeed);
            vec2 rUv2 = vWorldPos.xz * 4.4 + runoffDir * (uTime * flowSpeed * 1.35);

            vec3 rNor1 = texture2D(uPebbleNor, rUv1).rgb * 2.0 - 1.0;
            vec3 rNor2 = texture2D(uBankNor, rUv2).rgb * 2.0 - 1.0;
            vec3 rWave = normalize(rNor1 * 0.55 + rNor2 * 0.45);

            // Perturb surface normal so water film reflects sunlight dynamically:
            vec3 wetN = normalize(N + vec3(rWave.x * 0.35, 0.0, rWave.z * 0.35) * rainWetness);
            vec3 V = normalize(cameraPosition - vWorldPos);
            vec3 H = normalize(L + V);
            vec3 R = reflect(-V, wetN);

            float NdotV = clamp(dot(wetN, V), 0.0, 1.0);
            float fresnel = 0.05 + 0.95 * pow(1.0 - NdotV, 3.5);
            vec3 skyRefl = mix(vec3(0.35, 0.48, 0.62), vec3(0.78, 0.88, 1.0), max(R.y, 0.0));

            float wetSpec = pow(max(dot(wetN, H), 0.0), 32.0) * 2.8 * rainWetness * fresnel;
            float sheetAmount = clamp(rainWetness * 0.65, 0.0, 0.75);

            finalColor = mix(finalColor, skyRefl * (ambient + direct) + uSunColor * wetSpec, sheetAmount);
          }

          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
  }

  getRiverCenter(z: number): number {
    return 4.0 * Math.sin(z * 0.07) + 1.8 * Math.cos(z * 0.15);
  }

  getBedElevation(z: number): number {
    const t = (z + 40.0) / 80.0;
    const base = (1.0 - t) * 6.5;

    const pool1 = Math.exp(-Math.pow((z + 16.0) / 6.5, 2.0)) * 0.45;
    const pool2 = Math.exp(-Math.pow((z - 14.0) / 7.5, 2.0)) * 0.50;
    const pool3 = Math.exp(-Math.pow((z - 32.0) / 6.0, 2.0)) * 0.35;

    return base - (pool1 + pool2 + pool3);
  }

  // Bed height calculation
  getBedHeight(x: number, z: number): number {
    const slope = this.getBedElevation(z);

    // Distance from river centerline
    const xc = this.getRiverCenter(z);
    const d = Math.abs(x - xc);
    const w = this.channelHalfWidth;
    const dMax = 0.85;

    let bedDepth = 0;
    if (d < w) {
      // Parabolic carved low-flow channel
      const t = d / w;
      bedDepth = -dMax * (1.0 - t * t);
    } else {
      // Gently sloping gravel bars & valley sides
      bedDepth = 0.22 * (d - w) + 0.12 * Math.log(1.0 + 1.2 * (d - w));
    }

    // Carve natural gravel bar depression bowls for puddles
    for (const b of PUDDLE_BASINS) {
      const bx = xc + b.xOffset;
      const dx = x - bx;
      const dz = z - b.z;
      const distSq = dx * dx + dz * dz;
      const rSq = b.radius * b.radius;
      if (distSq < rSq) {
        const t = Math.sqrt(distSq) / b.radius;
        const dip = b.depth * Math.pow(1.0 - t * t, 2.0);
        bedDepth -= dip;
      }
    }

    // Micro-rock roughness along channel
    const rockNoise = Math.sin(x * 1.5) * Math.cos(z * 1.5) * 0.08;

    return slope + bedDepth + rockNoise;
  }

  // Physical 2D terrain gradient vector ∇z = (∂z/∂x, ∂z/∂z) and bed slope S = |∇z|
  getBedGradient(x: number, z: number, eps = 0.05): { dx: number; dz: number; slope: number } {
    const hL = this.getBedHeight(x - eps, z);
    const hR = this.getBedHeight(x + eps, z);
    const hD = this.getBedHeight(x, z - eps);
    const hU = this.getBedHeight(x, z + eps);
    const dhdx = (hR - hL) / (2.0 * eps);
    const dhdz = (hU - hD) / (2.0 * eps);
    const slope = Math.hypot(dhdx, dhdz);
    return { dx: dhdx, dz: dhdz, slope };
  }

  // Water surface elevation at (x, z)
  getWaterHeight(x: number, z: number): number {
    const slope = (1.0 - (z + 40.0) / this.length) * this.baseDrop;
    return slope + 0.35;
  }
}

