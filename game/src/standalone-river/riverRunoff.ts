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

  // 2. True 3D Volumetric Runoff Flumes (7-point cross section, parabolic camber, rock-sealing skirts)
  private streamMeshes: THREE.Mesh[] = [];
  private streamMats: THREE.ShaderMaterial[] = [];

  // 3. 3D Kinetic Confluence Splash Droplet System (1,200 physical droplets)
  readonly maxConfluenceParticles = 1200;
  private confluenceMesh: THREE.InstancedMesh;
  private confPos: Float32Array;
  private confVel: Float32Array;
  private confLife: Float32Array;
  private confMaxLife: Float32Array;
  private confOriginIdx: Int32Array;
  private confluencePoints: { pos: THREE.Vector3; dir: THREE.Vector3; speed: number }[] = [];

  // 4. 3D Rain Ground Impact Splashes (Directive: Rainfall becomes 3D water upon ground impact)
  readonly maxGroundSplashes = 600;
  private groundSplashMesh: THREE.InstancedMesh;
  private gPos: Float32Array;
  private gVel: Float32Array;
  private gLife: Float32Array;
  private gMaxLife: Float32Array;
  private nextGroundSplashIdx = 0;

  // 5. Permanent Puddles (Depression Basins on Gravel Bars)
  puddleFills: number[] = [0.35, 0.40, 0.35, 0.40];
  private puddleMeshes: THREE.Mesh[] = [];
  private puddleMats: THREE.ShaderMaterial[] = [];
  private puddleBaseY: number[] = [];
  private puddleRimY: number[] = [];

  // 6. Overflow Spillway Chutes
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
          vec4 c = texture2D(uStreakTex, gl_PointCoord);
          float alpha = c.a * uRainAlpha * 0.70;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(c.rgb, alpha);
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
    // PART 2: 12 TRUE 3D VOLUMETRIC RUNOFF FLUMES (PARABOLIC MENISCUS & SKIRTS)
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
      // 1. Numerically trace physical steepest descent down the carved mountain gully:
      const path = this.traceStreamline(cfg.startX, cfg.startZ);
      if (path.length < 4) return;

      // Record confluence point for 3D kinetic plunge splash system:
      const endPt = path[path.length - 1];
      const prevPt = path[path.length - 2];
      const plungeDir = new THREE.Vector3(endPt.x - prevPt.x, endPt.y - prevPt.y, endPt.z - prevPt.z).normalize();
      this.confluencePoints.push({
        pos: new THREE.Vector3(endPt.x, endPt.y, endPt.z),
        dir: plungeDir,
        speed: endPt.velocity,
      });

      // 2. Build 3D Volumetric Flume (7 lateral vertices per cross-section):
      // j=0: Left bedrock anchor skirt
      // j=1: Left waterline
      // j=2: Quarter bank
      // j=3: Center crest (8.5cm deep parabolic camber)
      // j=4: Three-quarter bank
      // j=5: Right waterline
      // j=6: Right bedrock anchor skirt
      const segs = path.length - 1;
      const numLateral = 7;
      const totalVerts = (segs + 1) * numLateral;

      const positions = new Float32Array(totalVerts * 3);
      const uvs = new Float32Array(totalVerts * 2);
      const vels = new Float32Array(totalVerts);
      const slopes = new Float32Array(totalVerts);
      const crests = new Float32Array(totalVerts);
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

        // Lateral points across width:
        // Column 0: Left anchor (embedded into bedrock)
        // Column 1: Left bank waterline
        // Column 2: Mid-left (parabolic rise)
        // Column 3: Center crest (maximum depth)
        // Column 4: Mid-right (parabolic rise)
        // Column 5: Right bank waterline
        // Column 6: Right anchor (embedded into bedrock)
        const latCols: { x: number; y: number; z: number; u: number; crest: number }[] = [];

        // Left coordinates
        const xL = pt.x - cross.x * halfW;
        const zL = pt.z - cross.y * halfW;
        const yBedL = this.terrain.getBedHeight(xL, zL);

        // Right coordinates
        const xR = pt.x + cross.x * halfW;
        const zR = pt.z + cross.y * halfW;
        const yBedR = this.terrain.getBedHeight(xR, zR);

        // Center coordinates
        const xC = pt.x;
        const zC = pt.z;
        const yBedC = this.terrain.getBedHeight(xC, zC);

        // Mid-left & mid-right coordinates
        const xML = pt.x - cross.x * (halfW * 0.5);
        const zML = pt.z - cross.y * (halfW * 0.5);
        const yBedML = this.terrain.getBedHeight(xML, zML);

        const xMR = pt.x + cross.x * (halfW * 0.5);
        const zMR = pt.z + cross.y * (halfW * 0.5);
        const yBedMR = this.terrain.getBedHeight(xMR, zMR);

        // 0: Left skirt anchor
        latCols.push({ x: xL, y: yBedL - 0.05, z: zL, u: 0.0, crest: 0.0 });
        // 1: Left waterline
        latCols.push({ x: xL, y: yBedL + 0.022, z: zL, u: 0.0, crest: 0.0 });
        // 2: Mid-left surface
        latCols.push({ x: xML, y: yBedML + 0.060, z: zML, u: 0.25, crest: 0.75 });
        // 3: Center crest (8.5cm deep parabolic camber)
        latCols.push({ x: xC, y: yBedC + 0.085, z: zC, u: 0.5, crest: 1.0 });
        // 4: Mid-right surface
        latCols.push({ x: xMR, y: yBedMR + 0.060, z: zMR, u: 0.75, crest: 0.75 });
        // 5: Right waterline
        latCols.push({ x: xR, y: yBedR + 0.022, z: zR, u: 1.0, crest: 0.0 });
        // 6: Right skirt anchor
        latCols.push({ x: xR, y: yBedR - 0.05, z: zR, u: 1.0, crest: 0.0 });

        for (let j = 0; j < numLateral; j++) {
          const vIdx = s * numLateral + j;
          const col = latCols[j];
          positions[vIdx * 3] = col.x;
          positions[vIdx * 3 + 1] = col.y;
          positions[vIdx * 3 + 2] = col.z;

          uvs[vIdx * 2] = col.u;
          uvs[vIdx * 2 + 1] = vNorm;

          vels[vIdx] = pt.velocity;
          slopes[vIdx] = pt.slope;
          crests[vIdx] = col.crest;
        }

        // Indices connecting row s to row s+1:
        if (s < segs) {
          for (let j = 0; j < numLateral - 1; j++) {
            const v0 = s * numLateral + j;
            const v1 = s * numLateral + j + 1;
            const v2 = (s + 1) * numLateral + j;
            const v3 = (s + 1) * numLateral + j + 1;

            indices.push(v0, v2, v1);
            indices.push(v1, v2, v3);
          }
        }
      }

      const streamGeo = new THREE.BufferGeometry();
      streamGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      streamGeo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      streamGeo.setAttribute("aVelocity", new THREE.BufferAttribute(vels, 1));
      streamGeo.setAttribute("aSlope", new THREE.BufferAttribute(slopes, 1));
      streamGeo.setAttribute("aCrest", new THREE.BufferAttribute(crests, 1));
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
        side: THREE.DoubleSide,
        vertexShader: `
          attribute float aVelocity;
          attribute float aSlope;
          attribute float aCrest;

          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;
          varying float vVelocity;
          varying float vSlope;
          varying float vCrest;

          uniform float uTime;
          uniform float uRainIntensity;

          void main() {
            vUv = uv;
            vVelocity = aVelocity;
            vSlope = aSlope;
            vCrest = aCrest;

            vec3 pos = position;

            // Real 3D Physical Vertex Wave Displacement:
            // High velocity water on steep slopes physically churns and heaves in 3D:
            float rainNorm = clamp(uRainIntensity / 50.0, 0.0, 1.0);
            float localSpeed = aVelocity * (0.85 + rainNorm * 0.45);

            float surgePhase = uv.y * 36.0 - uTime * (localSpeed * 1.6);
            float waveAmp = clamp(aSlope * 0.08, 0.012, 0.055) * aCrest * (0.7 + rainNorm * 0.6);
            float surge = sin(surgePhase) * waveAmp;
            float chop = cos(uv.y * 72.0 - uTime * (localSpeed * 2.8)) * (waveAmp * 0.35);

            pos.y += (surge + chop);

            vec4 wp = modelMatrix * vec4(pos, 1.0);
            vWorldPos = wp.xyz;

            vec3 norm = normal;
            norm.y += cos(surgePhase) * waveAmp * 3.5;
            vNormal = normalize(mat3(modelMatrix) * norm);

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
          varying float vCrest;

          void main() {
            float rainNorm = clamp(uRainIntensity / 50.0, 0.0, 1.0);
            float streamIntensity = mix(0.40, 1.0, rainNorm);

            // Physical Manning wave advection:
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

            // Optical Fresnel reflection:
            float NdotV = clamp(dot(N, V), 0.0, 1.0);
            float fresnel = 0.06 + 0.94 * pow(1.0 - NdotV, 3.5);
            vec3 skyRefl = mix(vec3(0.35, 0.50, 0.65), vec3(0.80, 0.90, 1.0), max(R.y, 0.0));

            // Deep turquoise liquid core + translucent banks:
            vec3 waterBody = mix(vec3(0.18, 0.38, 0.46), vec3(0.10, 0.26, 0.34), vCrest);
            vec3 waterColor = mix(waterBody, skyRefl, fresnel);

            // Dancing specular glints:
            float NdotH = max(dot(N, H), 0.0);
            float NdotL = max(dot(N, L), 0.0);
            float spec = pow(NdotH, 36.0) * 3.5 * fresnel * NdotL;
            waterColor += uSunColor * spec;

            // Physical Supercritical Aeration (whitecap foam on steep drops Fr > 1):
            float foamNoise = texture2D(uFoamTex, vec2(vUv.x * 2.0, vUv.y * 5.0 - uTime * localSpeed)).r;
            float steepDropFoam = smoothstep(0.18, 0.35, vSlope) * smoothstep(0.35, 0.75, foamNoise) * (0.45 + 0.55 * rainNorm);
            float riverPlunge = smoothstep(0.80, 0.98, vUv.y) * 0.85;
            float totalFoam = clamp(steepDropFoam + riverPlunge, 0.0, 1.0);
            waterColor = mix(waterColor, vec3(0.95, 0.98, 1.0) * (0.85 + 0.35 * NdotL), totalFoam * 0.90);

            // Alpha transparency: solid 3D water core (92%), smooth translucent banks (72%)
            float alpha = mix(0.72, 0.94, vCrest) * streamIntensity;

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
    // PART 3: 3D KINETIC CONFLUENCE SPLASH PARTICLES (1,200 PHYSICAL DROPLETS)
    // =========================================================================
    const dropGeo = new THREE.DodecahedronGeometry(0.042, 1);
    const dropMat = new THREE.MeshStandardMaterial({
      color: 0xbae6fd,
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      opacity: 0.88,
    });

    this.confluenceMesh = new THREE.InstancedMesh(dropGeo, dropMat, this.maxConfluenceParticles);
    this.confluenceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.confluenceMesh.renderOrder = 22;
    this.group.add(this.confluenceMesh);

    this.confPos = new Float32Array(this.maxConfluenceParticles * 3);
    this.confVel = new Float32Array(this.maxConfluenceParticles * 3);
    this.confLife = new Float32Array(this.maxConfluenceParticles);
    this.confMaxLife = new Float32Array(this.maxConfluenceParticles);
    this.confOriginIdx = new Int32Array(this.maxConfluenceParticles);

    for (let i = 0; i < this.maxConfluenceParticles; i++) {
      this.confOriginIdx[i] = i % Math.max(1, this.confluencePoints.length);
      this.resetConfluenceParticle(i);
      this.confLife[i] = Math.random() * this.confMaxLife[i];
    }

    // =========================================================================
    // PART 4: 3D RAIN GROUND IMPACT SPLASHES (600 PHYSICAL DROPLETS)
    // =========================================================================
    const gDropGeo = new THREE.DodecahedronGeometry(0.035, 1);
    const gDropMat = new THREE.MeshStandardMaterial({
      color: 0xdbeafe,
      roughness: 0.15,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
    });

    this.groundSplashMesh = new THREE.InstancedMesh(gDropGeo, gDropMat, this.maxGroundSplashes);
    this.groundSplashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.groundSplashMesh.renderOrder = 23;
    this.group.add(this.groundSplashMesh);

    this.gPos = new Float32Array(this.maxGroundSplashes * 3);
    this.gVel = new Float32Array(this.maxGroundSplashes * 3);
    this.gLife = new Float32Array(this.maxGroundSplashes);
    this.gMaxLife = new Float32Array(this.maxGroundSplashes);

    for (let i = 0; i < this.maxGroundSplashes; i++) {
      this.gLife[i] = -1.0; // Inactive until ground collision
    }

    // =========================================================================
    // PART 5: 4 PERMANENT NATURAL POOLS (GRAVEL BAR DEPRESSIONS)
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
          uniform float uFill;
          uniform float uRainIntensity;

          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;

          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float rDist = length(p);

            float ripple = 0.0;
            if (uRainIntensity > 0.05) {
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
      // PART 6: OVERFLOW SPILLWAY CHUTE (CONNECTS PUDDLE TO MAIN RIVER)
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

  private resetConfluenceParticle(i: number) {
    if (this.confluencePoints.length === 0) return;
    const oIdx = this.confOriginIdx[i] % this.confluencePoints.length;
    const cPt = this.confluencePoints[oIdx];
    const i3 = i * 3;

    // Plunge point at river bank
    this.confPos[i3] = cPt.pos.x + (Math.random() - 0.5) * 0.40;
    this.confPos[i3 + 1] = cPt.pos.y + 0.04 + Math.random() * 0.08;
    this.confPos[i3 + 2] = cPt.pos.z + (Math.random() - 0.5) * 0.40;

    // Ballistic initial velocity: forward into river + upward explosion
    const fwdSpeed = cPt.speed * (0.45 + Math.random() * 0.55);
    this.confVel[i3] = cPt.dir.x * fwdSpeed + (Math.random() - 0.5) * 1.4;
    this.confVel[i3 + 1] = 1.6 + Math.random() * 2.8; // Upward fountain arc
    this.confVel[i3 + 2] = cPt.dir.z * fwdSpeed + (Math.random() - 0.5) * 1.4;

    this.confMaxLife[i] = 0.28 + Math.random() * 0.42;
    this.confLife[i] = this.confMaxLife[i];
  }

  private triggerGroundSplash(x: number, y: number, z: number) {
    const i = this.nextGroundSplashIdx;
    this.nextGroundSplashIdx = (this.nextGroundSplashIdx + 1) % this.maxGroundSplashes;
    const i3 = i * 3;

    this.gPos[i3] = x;
    this.gPos[i3 + 1] = y + 0.03;
    this.gPos[i3 + 2] = z;

    // Kinetic 3D splatter arc upon ground impact
    this.gVel[i3] = (Math.random() - 0.5) * 1.6;
    this.gVel[i3 + 1] = 1.2 + Math.random() * 1.8;
    this.gVel[i3 + 2] = (Math.random() - 0.5) * 1.6;

    this.gMaxLife[i] = 0.16 + Math.random() * 0.18;
    this.gLife[i] = this.gMaxLife[i];
  }

  // Numerical gradient-descent solver along negative terrain gradient -∇z / |∇z|
  private traceStreamline(startX: number, startZ: number, maxSteps = 45, dtStep = 0.35): StreamPoint[] {
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
    const rainNormalized = Math.min(1.0, this.rainIntensity / 65.0);

    // 1. Advance Falling Rain & Detect Ground Impact Collisions (Directive)
    this.rainMat.uniforms.uRainAlpha.value = rainNormalized;

    if (this.rainIntensity > 0.01) {
      this.rainMesh.visible = true;
      const pos = this.rainPos;
      const vel = this.rainVel;

      for (let i = 0; i < this.maxRainDrops; i++) {
        const i3 = i * 3;
        pos[i3] += vel[i3] * clampedDt;
        pos[i3 + 1] += vel[i3 + 1] * clampedDt;
        pos[i3 + 2] += vel[i3 + 2] * clampedDt;

        // Ground Collision: Rainfall transitions into 3D ground water!
        const groundY = this.terrain.getBedHeight(pos[i3], pos[i3 + 2]);
        if (pos[i3 + 1] <= groundY) {
          // Trigger kinetic 3D ground splatter burst
          this.triggerGroundSplash(pos[i3], groundY, pos[i3 + 2]);

          // Reset droplet back to cloud altitude
          pos[i3] = cameraPos.x + (Math.random() - 0.5) * 55.0;
          pos[i3 + 1] = cameraPos.y + 16.0 + Math.random() * 12.0;
          pos[i3 + 2] = cameraPos.z + (Math.random() - 0.5) * 65.0;
        }
      }
      (this.rainGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    } else {
      this.rainMesh.visible = false;
    }

    // 2. Advance 3D Kinetic Confluence Splashes (Ballistic Gravity g = -9.81 m/s²)
    const dummyMat = new THREE.Matrix4();
    const dummyPos = new THREE.Vector3();
    const dummyScale = new THREE.Vector3();
    const splashScaleFactor = 0.65 + rainNormalized * 0.75;

    for (let i = 0; i < this.maxConfluenceParticles; i++) {
      this.confLife[i] -= clampedDt;
      const i3 = i * 3;

      if (this.confLife[i] <= 0) {
        this.resetConfluenceParticle(i);
      } else {
        // Real gravity:
        this.confVel[i3 + 1] -= 9.81 * clampedDt;
        this.confPos[i3] += this.confVel[i3] * clampedDt;
        this.confPos[i3 + 1] += this.confVel[i3 + 1] * clampedDt;
        this.confPos[i3 + 2] += this.confVel[i3 + 2] * clampedDt;

        // Reset if submerged into river surface
        const riverWaterY = this.hydraulics.getWaterHeightAt(this.confPos[i3 + 2]);
        if (this.confPos[i3 + 1] <= riverWaterY) {
          this.resetConfluenceParticle(i);
        }
      }

      const lifeFrac = Math.max(0.0, this.confLife[i] / this.confMaxLife[i]);
      const s = Math.sin(lifeFrac * Math.PI) * splashScaleFactor;
      dummyPos.set(this.confPos[i3], this.confPos[i3 + 1], this.confPos[i3 + 2]);
      dummyScale.set(s, s, s);
      dummyMat.makeScale(s, s, s).setPosition(dummyPos);
      this.confluenceMesh.setMatrixAt(i, dummyMat);
    }
    this.confluenceMesh.instanceMatrix.needsUpdate = true;

    // 3. Advance 3D Ground Impact Splashes
    for (let i = 0; i < this.maxGroundSplashes; i++) {
      if (this.gLife[i] > 0) {
        this.gLife[i] -= clampedDt;
        const i3 = i * 3;

        this.gVel[i3 + 1] -= 9.81 * clampedDt;
        this.gPos[i3] += this.gVel[i3] * clampedDt;
        this.gPos[i3 + 1] += this.gVel[i3 + 1] * clampedDt;
        this.gPos[i3 + 2] += this.gVel[i3 + 2] * clampedDt;

        const lifeFrac = Math.max(0.0, this.gLife[i] / this.gMaxLife[i]);
        const s = Math.sin(lifeFrac * Math.PI) * (0.75 + rainNormalized * 0.70);
        dummyPos.set(this.gPos[i3], this.gPos[i3 + 1], this.gPos[i3 + 2]);
        dummyScale.set(s, s, s);
        dummyMat.makeScale(s, s, s).setPosition(dummyPos);
      } else {
        dummyMat.makeScale(0, 0, 0);
      }
      this.groundSplashMesh.setMatrixAt(i, dummyMat);
    }
    this.groundSplashMesh.instanceMatrix.needsUpdate = true;

    // 4. Advance 3D Volumetric Runoff Flumes (vertex wave displacement + Manning flow)
    this.streamMats.forEach((mat) => {
      mat.uniforms.uTime.value = simTime;
      mat.uniforms.uRainIntensity.value = this.rainIntensity;
    });

    // 5. Hydrological Infiltration & Puddle Elevation
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

    // 6. Catchment Runoff River Swell
    const targetRainQ = (this.rainIntensity / 65.0) * 28.0;
    this.currentRainQ += (targetRainQ - this.currentRainQ) * Math.min(clampedDt * 0.35, 0.08);
  }

  // Exact stored puddle water volume in Liters across all 4 depression basins
  getPuddleStorageVolume(): number {
    let totalLiters = 0;
    PUDDLE_BASINS.forEach((basin, idx) => {
      const fill = this.puddleFills[idx] || 0;
      const m3 = (Math.PI / 2.0) * basin.radius * basin.radius * (fill * basin.depth);
      totalLiters += m3 * 1000.0;
    });
    return totalLiters;
  }

  // Real physical rainfall mass influx across the 4,800 m² catchment basin [kg/s]
  getRainfallMassFlux(): number {
    return (4800.0 * this.rainIntensity) / 3600.0;
  }
}
