import * as THREE from "three";
import { RiverTerrain, PUDDLE_BASINS } from "./riverTerrain";
import { RiverHydraulics } from "./riverHydraulics";

function generateRaindropTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = Math.abs((x + 0.5 - center) / center);
      const dy = (y + 0.5) / size;

      const xShape = Math.exp(-dx * dx * 18.0);
      const yShape = Math.sin(dy * Math.PI);
      const alpha = Math.min(1.0, xShape * yShape * 1.5);

      data[idx] = 230;
      data[idx + 1] = 242;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// 12 Ridge release stations for numerical gradient-descent runoff tracing:
const RIDGE_RELEASE_Z = [-32.0, -20.0, -8.0, 4.0, 16.0, 28.0];

interface StreamPoint {
  x: number;
  y: number;
  z: number;
  slope: number;
  velocity: number; // Manning speed [m/s]
  width: number;    // Channel width [m]
  dist: number;     // Cumulative downhill distance [m]
}

export class RiverRunoff {
  rainIntensity = 0.0; // [0, 80] mm/h
  currentRainQ = 0.0;  // [0, 30] m³/s added to river discharge

  readonly group: THREE.Group;
  private terrain: RiverTerrain;
  private hydraulics: RiverHydraulics;
  private sunDir: THREE.Vector3;
  private sunColor: THREE.Color;

  // 1. 3D Atmospheric Falling Rain
  readonly maxRainDrops = 2400;
  private rainMesh: THREE.Points;
  private rainGeo: THREE.BufferGeometry;
  private rainMat: THREE.ShaderMaterial;
  private rainPos: Float32Array;
  private rainVel: Float32Array;

  // 2. Physical Gradient-Traced Runoff Streams (Manning Hydrodynamics)
  private streamMeshes: THREE.Mesh[] = [];
  private streamMats: THREE.ShaderMaterial[] = [];

  // 3. Permanent Puddles (Depression Basins on Gravel Bars)
  puddleFills: number[] = [0.35, 0.40, 0.35, 0.40];
  private puddleMeshes: THREE.Mesh[] = [];
  private puddleMats: THREE.ShaderMaterial[] = [];
  private puddleBaseY: number[] = [];
  private puddleRimY: number[] = [];

  // 4. Overflow Spillway Chutes
  private spillwayMeshes: THREE.Mesh[] = [];
  private spillwayMats: THREE.ShaderMaterial[] = [];

  constructor(
    terrain: RiverTerrain,
    hydraulics: RiverHydraulics,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    waterNormalMap?: THREE.Texture,
    foamTex?: THREE.Texture
  ) {
    this.terrain = terrain;
    this.hydraulics = hydraulics;
    this.sunDir = sunDir;
    this.sunColor = sunColor;

    this.group = new THREE.Group();
    this.group.name = "RiverRunoff";

    const dummyNorm = waterNormalMap || new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
    const dummyFoam = foamTex || new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);

    // =========================================================================
    // PART 1: 3D ATMOSPHERIC FALLING RAIN SYSTEM
    // =========================================================================
    this.rainPos = new Float32Array(this.maxRainDrops * 3);
    this.rainVel = new Float32Array(this.maxRainDrops * 3);

    for (let i = 0; i < this.maxRainDrops; i++) {
      const i3 = i * 3;
      this.rainPos[i3] = (Math.random() - 0.5) * 60.0;
      this.rainPos[i3 + 1] = Math.random() * 28.0;
      this.rainPos[i3 + 2] = (Math.random() - 0.5) * 85.0;

      this.rainVel[i3] = 2.4 + (Math.random() - 0.5) * 0.8;
      this.rainVel[i3 + 1] = -(20.0 + Math.random() * 4.0);
      this.rainVel[i3 + 2] = 3.6 + (Math.random() - 0.5) * 1.0;
    }

    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute("position", new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));

    const rainStreakTex = generateRaindropTexture(64);

    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uStreakTex: { value: rainStreakTex },
        uRainAlpha: { value: 0.0 },
      },
      vertexShader: `
        void main() {
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(26.0 * (480.0 / -mvPos.z), 4.0, 52.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uStreakTex;
        uniform float uRainAlpha;

        void main() {
          vec4 tex = texture2D(uStreakTex, gl_PointCoord);
          float a = tex.a * uRainAlpha * 0.65;
          if (a < 0.015) discard;
          gl_FragColor = vec4(0.88, 0.94, 1.0, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.rainMesh = new THREE.Points(this.rainGeo, this.rainMat);
    this.rainMesh.renderOrder = 25;
    this.rainMesh.frustumCulled = false;
    this.group.add(this.rainMesh);

    // =========================================================================
    // PART 2: 12 PHYSICAL GRADIENT-TRACED RUNOFF STREAMS (MANNING EQUATION)
    // =========================================================================
    const releaseConfigs: { startX: number; startZ: number; side: number }[] = [];
    RIDGE_RELEASE_Z.forEach((z) => {
      const xc = this.terrain.getRiverCenter(z);
      // West Ridge Release Point (mountain summit)
      releaseConfigs.push({ startX: xc - 14.2, startZ: z, side: -1 });
      // East Ridge Release Point (mountain summit)
      releaseConfigs.push({ startX: xc + 14.2, startZ: z, side: 1 });
    });

    releaseConfigs.forEach((cfg) => {
      // 1. Numerically trace the physical steepest descent path down the terrain:
      const path = this.traceStreamline(cfg.startX, cfg.startZ);
      if (path.length < 4) return;

      // 2. Build 3D continuous fluid ribbon from traced physical points:
      const segs = path.length - 1;
      const ptsLeft: number[] = [];
      const ptsRight: number[] = [];
      const uvs: number[] = [];
      const vels: number[] = [];
      const slopes: number[] = [];
      const indices: number[] = [];

      const totalDist = path[segs].dist || 1.0;

      for (let s = 0; s <= segs; s++) {
        const pt = path[s];
        const vNorm = pt.dist / totalDist;

        // Tangent & cross-normal vector in XZ plane:
        let dir: THREE.Vector2;
        if (s < segs) {
          dir = new THREE.Vector2(path[s + 1].x - pt.x, path[s + 1].z - pt.z).normalize();
        } else {
          dir = new THREE.Vector2(pt.x - path[s - 1].x, pt.z - path[s - 1].z).normalize();
        }
        const cross = new THREE.Vector2(-dir.y, dir.x);

        const halfW = pt.width * 0.5;
        const xL = pt.x - cross.x * halfW;
        const zL = pt.z - cross.y * halfW;
        const xR = pt.x + cross.x * halfW;
        const zR = pt.z + cross.y * halfW;

        // Elevation strictly conforms to bed height + physical depth layer
        const yL = this.terrain.getBedHeight(xL, zL) + 0.038;
        const yR = this.terrain.getBedHeight(xR, zR) + 0.038;

        const baseIdx = s * 2;
        ptsLeft.push(xL, yL, zL);
        ptsRight.push(xR, yR, zR);
        uvs.push(0.0, vNorm, 1.0, vNorm);
        vels.push(pt.velocity, pt.velocity);
        slopes.push(pt.slope, pt.slope);

        if (s < segs) {
          indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
          indices.push(baseIdx + 1, baseIdx + 3, baseIdx + 2);
        }
      }

      const streamGeo = new THREE.BufferGeometry();
      const allVerts = new Float32Array((segs + 1) * 6);
      for (let s = 0; s <= segs; s++) {
        allVerts[s * 6] = ptsLeft[s * 3];
        allVerts[s * 6 + 1] = ptsLeft[s * 3 + 1];
        allVerts[s * 6 + 2] = ptsLeft[s * 3 + 2];
        allVerts[s * 6 + 3] = ptsRight[s * 3];
        allVerts[s * 6 + 4] = ptsRight[s * 3 + 1];
        allVerts[s * 6 + 5] = ptsRight[s * 3 + 2];
      }
      streamGeo.setAttribute("position", new THREE.BufferAttribute(allVerts, 3));
      streamGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      streamGeo.setAttribute("aVelocity", new THREE.Float32BufferAttribute(vels, 1));
      streamGeo.setAttribute("aSlope", new THREE.Float32BufferAttribute(slopes, 1));
      streamGeo.setIndex(indices);
      streamGeo.computeVertexNormals();

      const streamMat = new THREE.ShaderMaterial({
        uniforms: {
          uWaterNormal: { value: dummyNorm },
          uFoamTex: { value: dummyFoam },
          uSunDir: { value: sunDir },
          uSunColor: { value: sunColor },
          uTime: { value: 0.0 },
          uRainIntensity: { value: 0.0 },
        },
        vertexShader: `
          attribute float aVelocity;
          attribute float aSlope;

          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;
          varying float vVelocity;
          varying float vSlope;

          void main() {
            vUv = uv;
            vVelocity = aVelocity;
            vSlope = aSlope;

            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          precision highp float;
          uniform sampler2D uWaterNormal;
          uniform sampler2D uFoamTex;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform float uTime;
          uniform float uRainIntensity;

          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;
          varying float vVelocity;
          varying float vSlope;

          void main() {
            float rainNorm = clamp(uRainIntensity / 50.0, 0.0, 1.0);
            // In dry weather, a clear mountain brook; in rain, a roaring torrent!
            float streamIntensity = mix(0.40, 1.0, rainNorm);

            // Flow advection is DRIVEN DIRECTLY by the physical Manning velocity vVelocity:
            float localSpeed = vVelocity * (0.85 + rainNorm * 0.45);
            vec2 uvFlow1 = vec2(vUv.x * 1.6, vUv.y * 4.2 - uTime * localSpeed);
            vec2 uvFlow2 = vec2(vUv.x * 2.4 + 0.35, vUv.y * 7.5 - uTime * (localSpeed * 1.35));

            vec3 n1 = texture2D(uWaterNormal, uvFlow1).rgb * 2.0 - 1.0;
            vec3 n2 = texture2D(uWaterNormal, uvFlow2).rgb * 2.0 - 1.0;
            vec3 nWave = normalize(n1 * 0.6 + n2 * 0.4);

            vec3 N = normalize(vNormal + vec3(nWave.x * 0.28, 0.0, nWave.z * 0.28));
            vec3 V = normalize(cameraPosition - vWorldPos);
            vec3 L = normalize(uSunDir);
            vec3 H = normalize(L + V);
            vec3 R = reflect(-V, N);

            // Optical Fresnel sky reflection
            float NdotV = clamp(dot(N, V), 0.0, 1.0);
            float fresnel = 0.06 + 0.94 * pow(1.0 - NdotV, 3.5);
            vec3 skyRefl = mix(vec3(0.35, 0.50, 0.65), vec3(0.80, 0.90, 1.0), max(R.y, 0.0));

            // Shallow turquoise liquid body
            vec3 waterBody = vec3(0.12, 0.32, 0.40);
            vec3 waterColor = mix(waterBody, skyRefl, fresnel);

            // Dancing sun specular glints on racing waves
            float NdotH = max(dot(N, H), 0.0);
            float NdotL = max(dot(N, L), 0.0);
            float spec = pow(NdotH, 36.0) * 3.5 * fresnel * NdotL;
            waterColor += uSunColor * spec;

            // Physical Supercritical Froth:
            // Where bed slope is steep (vSlope > 0.22), Froude number Fr > 1.0, generating whitecaps!
            float foamNoise = texture2D(uFoamTex, vec2(vUv.x * 2.0, vUv.y * 5.0 - uTime * localSpeed)).r;
            float steepDropFoam = smoothstep(0.18, 0.35, vSlope) * smoothstep(0.35, 0.75, foamNoise) * (0.45 + 0.55 * rainNorm);

            // Boiling white water splash plume at river entry confluence (vUv.y > 0.82)
            float riverPlunge = smoothstep(0.80, 0.98, vUv.y) * 0.85;
            float totalFoam = clamp(steepDropFoam + riverPlunge, 0.0, 1.0);
            waterColor = mix(waterColor, vec3(0.95, 0.98, 1.0) * (0.85 + 0.35 * NdotL), totalFoam * 0.90);

            // Cross-stream natural parabolic profile (thick at center, soft shore)
            float crossProfile = sin(vUv.x * 3.14159);
            float alpha = pow(crossProfile, 0.55) * streamIntensity * 0.92;

            gl_FragColor = vec4(waterColor, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
      });

      const streamMesh = new THREE.Mesh(streamGeo, streamMat);
      streamMesh.renderOrder = 14;
      this.streamMeshes.push(streamMesh);
      this.streamMats.push(streamMat);
      this.group.add(streamMesh);
    });

    // =========================================================================
    // PART 3: 4 PERMANENT NATURAL POOLS (GRAVEL BAR DEPRESSIONS)
    // =========================================================================
    PUDDLE_BASINS.forEach((basin) => {
      const xc = this.terrain.getRiverCenter(basin.z);
      const bx = xc + basin.xOffset;
      const bz = basin.z;

      const bedY = this.terrain.getBedHeight(bx, bz);
      const rimY = bedY + basin.depth;
      this.puddleBaseY.push(bedY);
      this.puddleRimY.push(rimY);

      const discGeo = new THREE.CircleGeometry(basin.radius * 0.98, 40);
      discGeo.rotateX(-Math.PI / 2);

      const pMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0.0 },
          uSunDir: { value: sunDir },
          uSunColor: { value: sunColor },
          uFill: { value: 0.35 },
          uRainIntensity: { value: 0.0 },
        },
        vertexShader: `
          varying vec3 vWorldPos;
          varying vec2 vUv;
          varying vec3 vNormal;

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
          uniform float uTime;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform float uFill;
          uniform float uRainIntensity;

          varying vec3 vWorldPos;
          varying vec2 vUv;
          varying vec3 vNormal;

          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float rDist = length(p);
            if (rDist > 1.0) discard;

            // Concentric raindrop ripples on puddle mirror surface:
            float ripple = 0.0;
            if (uRainIntensity > 0.5) {
              for (int k = 0; k < 4; k++) {
                float kF = float(k);
                float tOff = kF * 0.285;
                float cycle = fract(uTime * 1.8 + tOff);
                vec2 center = vec2(sin(kF * 4.3 + floor(uTime * 1.8 + tOff)), cos(kF * 6.7 + floor(uTime * 1.8 + tOff))) * 0.45;
                float d = length(p - center);
                float wave = sin(d * 42.0 - cycle * 20.0) * exp(-d * 5.0) * (1.0 - cycle);
                ripple += wave;
              }
            }

            vec3 N = normalize(vec3(ripple * 0.15, 1.0, ripple * 0.15));
            vec3 V = normalize(cameraPosition - vWorldPos);
            vec3 L = normalize(uSunDir);
            vec3 H = normalize(L + V);
            vec3 R = reflect(-V, N);

            // High-contrast mirror sky reflection
            float NdotV = clamp(dot(N, V), 0.0, 1.0);
            float fresnel = 0.05 + 0.95 * pow(1.0 - NdotV, 3.5);
            vec3 skyRefl = mix(vec3(0.28, 0.42, 0.56), vec3(0.82, 0.92, 1.0), max(R.y, 0.0));

            // Translucent clear puddle shallows
            vec3 shallowCol = vec3(0.16, 0.30, 0.36);
            vec3 finalColor = mix(shallowCol, skyRefl, fresnel);

            // Sun glints on ripple crests
            float NdotH = max(dot(N, H), 0.0);
            float glint = pow(NdotH, 64.0) * 3.5 * fresnel;
            finalColor += uSunColor * glint;

            float edgeAlpha = smoothstep(1.0, 0.75, rDist) * 0.92;
            gl_FragColor = vec4(finalColor, edgeAlpha);
          }
        `,
        transparent: true,
        depthWrite: false,
      });

      const puddleMesh = new THREE.Mesh(discGeo, pMat);
      puddleMesh.position.set(bx, bedY + 0.04, bz);
      puddleMesh.renderOrder = 12;
      this.puddleMeshes.push(puddleMesh);
      this.puddleMats.push(pMat);
      this.group.add(puddleMesh);

      // =======================================================================
      // PART 4: OVERFLOW SPILLWAY CHUTE (CONNECTS PUDDLE TO MAIN RIVER)
      // =======================================================================
      const riverBankX = xc + (basin.xOffset < 0 ? -3.85 : 3.85);
      const riverZ = bz + 1.8;
      const waterY = this.hydraulics.getWaterHeightAt(riverZ);

      const spStart = new THREE.Vector3(bx + (basin.xOffset < 0 ? basin.radius * 0.80 : -basin.radius * 0.80), rimY + 0.02, bz + 0.2);
      const spEnd = new THREE.Vector3(riverBankX, waterY + 0.02, riverZ);
      const spMid = new THREE.Vector3((spStart.x + spEnd.x) * 0.5, (spStart.y + spEnd.y) * 0.5 + 0.03, (spStart.z + spEnd.z) * 0.5);

      const spWidth = 0.85;
      const spGeo = new THREE.BufferGeometry();
      const spPts = [
        spStart.x - spWidth * 0.5, spStart.y, spStart.z,
        spStart.x + spWidth * 0.5, spStart.y, spStart.z,
        spMid.x - spWidth * 0.5, spMid.y, spMid.z,
        spMid.x + spWidth * 0.5, spMid.y, spMid.z,
        spEnd.x - spWidth * 0.5, spEnd.y, spEnd.z,
        spEnd.x + spWidth * 0.5, spEnd.y, spEnd.z,
      ];
      const spIndices = [0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5];
      const spUvs = [0, 0, 1, 0, 0, 0.5, 1, 0.5, 0, 1, 1, 1];

      spGeo.setAttribute("position", new THREE.Float32BufferAttribute(spPts, 3));
      spGeo.setAttribute("uv", new THREE.Float32BufferAttribute(spUvs, 2));
      spGeo.setIndex(spIndices);
      spGeo.computeVertexNormals();

      const spMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0.0 },
          uSunDir: { value: sunDir },
          uSunColor: { value: sunColor },
          uRainIntensity: { value: 0.0 },
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;

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
          uniform float uTime;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform float uRainIntensity;

          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;

          void main() {
            float rainNorm = clamp(uRainIntensity / 50.0, 0.0, 1.0);
            float spillActive = mix(0.25, 0.95, rainNorm);

            float flow = sin(vUv.y * 28.0 - uTime * 6.5) * 0.5 + 0.5;
            float crossShape = sin(vUv.x * 3.14159);
            float rillAlpha = pow(crossShape, 0.6) * spillActive * (0.60 + 0.35 * flow);

            vec3 V = normalize(cameraPosition - vWorldPos);
            vec3 L = normalize(uSunDir);
            vec3 H = normalize(L + V);
            float spec = pow(max(dot(vNormal, H), 0.0), 32.0) * 2.2;

            vec3 waterCol = mix(vec3(0.35, 0.50, 0.65), vec3(0.88, 0.96, 1.0), flow * 0.5);
            gl_FragColor = vec4(waterCol + uSunColor * spec, rillAlpha);
          }
        `,
        transparent: true,
        depthWrite: false,
      });

      const spMesh = new THREE.Mesh(spGeo, spMat);
      spMesh.renderOrder = 13;
      this.spillwayMeshes.push(spMesh);
      this.spillwayMats.push(spMat);
      this.group.add(spMesh);
    });
  }

  /**
   * Numerically integrates the steepest descent streamline along -∇z_bed(x, z).
   * Computes physical Manning velocity, slope, and drainage accumulation width.
   */
  private traceStreamline(startX: number, startZ: number, dtStep = 0.35, maxSteps = 55): StreamPoint[] {
    let curX = startX;
    let curZ = startZ;
    const path: StreamPoint[] = [];

    const g0 = this.terrain.getBedGradient(curX, curZ);
    let cumDist = 0.0;

    path.push({
      x: curX,
      y: this.terrain.getBedHeight(curX, curZ),
      z: curZ,
      slope: g0.slope,
      velocity: 2.0,
      width: 0.65,
      dist: 0.0,
    });

    for (let s = 0; s < maxSteps; s++) {
      const g = this.terrain.getBedGradient(curX, curZ);
      if (g.slope < 0.005) break;

      // Follow the negative gradient of the terrain: -∇z / |∇z|
      const dirX = -g.dx / g.slope;
      const dirZ = -g.dz / g.slope;

      const nextX = curX + dirX * dtStep;
      const nextZ = curZ + dirZ * dtStep;
      const stepDist = Math.hypot(nextX - curX, nextZ - curZ);
      cumDist += stepDist;

      curX = nextX;
      curZ = nextZ;
      const curY = this.terrain.getBedHeight(curX, curZ);

      // Manning-Strickler equation for open sheet/rill flow:
      // v = (1 / n) * R^(2/3) * sqrt(S)
      // with roughness n = 0.038, hydraulic radius R ≈ 0.045m
      const manningV = Math.min(6.5, Math.max(0.7, (1.0 / 0.038) * 0.126 * Math.sqrt(g.slope)));

      // Continuity equation: stream widens as it drains downslope accumulation area:
      const streamWidth = Math.min(1.55, 0.65 + (cumDist / 12.0) * 0.75);

      path.push({
        x: curX,
        y: curY,
        z: curZ,
        slope: g.slope,
        velocity: manningV,
        width: streamWidth,
        dist: cumDist,
      });

      // Stop when entering main river channel edge
      const xc = this.terrain.getRiverCenter(curZ);
      if (Math.abs(curX - xc) <= 3.85) break;
    }

    return path;
  }

  setRainIntensity(intensity: number) {
    this.rainIntensity = Math.max(0, Math.min(80, intensity));
    this.terrain.material.uniforms.uRainIntensity.value = this.rainIntensity;

    this.streamMats.forEach((mat) => {
      mat.uniforms.uRainIntensity.value = this.rainIntensity;
    });
    this.puddleMats.forEach((mat) => {
      mat.uniforms.uRainIntensity.value = this.rainIntensity;
    });
    this.spillwayMats.forEach((mat) => {
      mat.uniforms.uRainIntensity.value = this.rainIntensity;
    });
  }

  update(dt: number, cameraPos: THREE.Vector3, simTime: number) {
    const clampedDt = Math.min(dt, 0.033);

    // 1. Advance Rain Streaks
    const rainNormalized = this.rainIntensity / 65.0;
    this.rainMat.uniforms.uRainAlpha.value = Math.min(1.0, rainNormalized);

    if (this.rainIntensity > 0.01) {
      this.rainMesh.visible = true;
      const pos = this.rainPos;
      const vel = this.rainVel;

      for (let i = 0; i < this.maxRainDrops; i++) {
        const i3 = i * 3;
        pos[i3] += vel[i3] * clampedDt;
        pos[i3 + 1] += vel[i3 + 1] * clampedDt;
        pos[i3 + 2] += vel[i3 + 2] * clampedDt;

        if (pos[i3 + 1] < -2.0) {
          pos[i3] = cameraPos.x + (Math.random() - 0.5) * 55.0;
          pos[i3 + 1] = cameraPos.y + 16.0 + Math.random() * 12.0;
          pos[i3 + 2] = cameraPos.z + (Math.random() - 0.5) * 65.0;
        }
      }
      (this.rainGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    } else {
      this.rainMesh.visible = false;
    }

    // 2. Advance 3D Runoff Streams (physical Manning velocity driven)
    this.streamMats.forEach((mat) => {
      mat.uniforms.uTime.value = simTime;
      mat.uniforms.uRainIntensity.value = this.rainIntensity;
    });

    // 3. Hydrological Infiltration & Puddle Elevation
    const fillRate = (this.rainIntensity / 50.0) * 0.22;
    const drainRate = 0.04;

    PUDDLE_BASINS.forEach((basin, idx) => {
      if (this.rainIntensity > 0.5) {
        this.puddleFills[idx] = Math.min(1.0, this.puddleFills[idx] + fillRate * clampedDt);
      } else {
        this.puddleFills[idx] = Math.max(0.35, this.puddleFills[idx] - drainRate * clampedDt);
      }

      const fill = this.puddleFills[idx];
      const pMat = this.puddleMats[idx];
      pMat.uniforms.uTime.value = simTime;
      pMat.uniforms.uFill.value = fill;
      pMat.uniforms.uRainIntensity.value = this.rainIntensity;

      const baseY = this.puddleBaseY[idx];
      const currentWaterY = baseY + 0.02 + fill * (basin.depth - 0.02);
      this.puddleMeshes[idx].position.y = currentWaterY;

      const spMat = this.spillwayMats[idx];
      spMat.uniforms.uTime.value = simTime;
      spMat.uniforms.uRainIntensity.value = this.rainIntensity;
    });

    // 4. Catchment Runoff River Swell
    const targetRainQ = (this.rainIntensity / 65.0) * 28.0;
    this.currentRainQ += (targetRainQ - this.currentRainQ) * Math.min(clampedDt * 0.35, 0.08);
  }
}
