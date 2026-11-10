import * as THREE from "three";
import { RiverTerrain, PUDDLE_BASINS } from "./riverTerrain";
import { RiverHydraulics } from "./riverHydraulics";

function generateRaindropTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const center = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = Math.abs((x + 0.5 - center) / center); // 0 at center -> 1 at edges
      const dy = (y + 0.5) / size; // 0 at top -> 1 at bottom

      // Elongated falling rain streak (needle aspect ratio)
      const xShape = Math.exp(-dx * dx * 18.0);
      const yShape = Math.sin(dy * Math.PI);
      const alpha = Math.min(1.0, xShape * yShape * 1.4);

      data[idx] = 220;
      data[idx + 1] = 235;
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

export class RiverRunoff {
  rainIntensity = 0.0; // [0, 80] mm/h
  currentRainQ = 0.0;  // [0, 30] m³/s added to river discharge

  readonly group: THREE.Group;
  private terrain: RiverTerrain;
  private hydraulics: RiverHydraulics;
  private sunDir: THREE.Vector3;
  private sunColor: THREE.Color;

  // 3D Atmospheric Rain
  readonly maxRainDrops = 2400;
  private rainMesh: THREE.Points;
  private rainGeo: THREE.BufferGeometry;
  private rainMat: THREE.ShaderMaterial;
  private rainPos: Float32Array;
  private rainVel: Float32Array;

  // Puddles (Depression Basins on Gravel Bars)
  puddleFills: number[] = [0.0, 0.0, 0.0, 0.0]; // 0.0 = dry, 1.0 = brim-full & spilling
  private puddleMeshes: THREE.Mesh[] = [];
  private puddleMats: THREE.ShaderMaterial[] = [];
  private puddleBaseY: number[] = [];
  private puddleRimY: number[] = [];

  // Spillway Runoff Rivulets (connecting overflowing puddles to the river)
  private spillwayMeshes: THREE.Mesh[] = [];
  private spillwayMats: THREE.ShaderMaterial[] = [];

  constructor(
    terrain: RiverTerrain,
    hydraulics: RiverHydraulics,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color
  ) {
    this.terrain = terrain;
    this.hydraulics = hydraulics;
    this.sunDir = sunDir;
    this.sunColor = sunColor;

    this.group = new THREE.Group();
    this.group.name = "RiverRunoff";

    // 1. Setup 3D Atmospheric Falling Rain System
    this.rainPos = new Float32Array(this.maxRainDrops * 3);
    this.rainVel = new Float32Array(this.maxRainDrops * 3);

    for (let i = 0; i < this.maxRainDrops; i++) {
      const i3 = i * 3;
      this.rainPos[i3] = (Math.random() - 0.5) * 60.0;
      this.rainPos[i3 + 1] = Math.random() * 28.0;
      this.rainPos[i3 + 2] = (Math.random() - 0.5) * 80.0;

      // Realistic terminal velocity with wind tilt
      this.rainVel[i3] = 2.2 + (Math.random() - 0.5) * 0.8;
      this.rainVel[i3 + 1] = -(18.0 + Math.random() * 4.0);
      this.rainVel[i3 + 2] = 3.5 + (Math.random() - 0.5) * 1.0;
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
          gl_PointSize = clamp(24.0 * (450.0 / -mvPos.z), 4.0, 48.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uStreakTex;
        uniform float uRainAlpha;

        void main() {
          vec4 tex = texture2D(uStreakTex, gl_PointCoord);
          float a = tex.a * uRainAlpha * 0.55;
          if (a < 0.015) discard;
          gl_FragColor = vec4(0.88, 0.94, 1.0, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.rainMesh = new THREE.Points(this.rainGeo, this.rainMat);
    this.rainMesh.renderOrder = 20;
    this.rainMesh.frustumCulled = false;
    this.group.add(this.rainMesh);

    // 2. Setup Depression Puddles on Gravel Terraces
    PUDDLE_BASINS.forEach((basin, idx) => {
      const xc = this.terrain.getRiverCenter(basin.z);
      const bx = xc + basin.xOffset;
      const bz = basin.z;

      // Calculate bed height at basin center and rim lip
      const bedY = this.terrain.getBedHeight(bx, bz);
      const rimY = bedY + basin.depth;
      this.puddleBaseY.push(bedY);
      this.puddleRimY.push(rimY);

      // Puddle water disc geometry
      const discGeo = new THREE.CircleGeometry(basin.radius * 0.96, 36);
      discGeo.rotateX(-Math.PI / 2);

      const pMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0.0 },
          uSunDir: { value: sunDir },
          uSunColor: { value: sunColor },
          uFill: { value: 0.0 }, // 0 = empty, 1 = full
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
            if (uFill < 0.02) discard;

            vec2 p = vUv * 2.0 - 1.0;
            float rDist = length(p);
            if (rDist > 1.0) discard;

            // Concentric raindrop ripples on puddle mirror surface:
            float ripple = 0.0;
            if (uRainIntensity > 0.5) {
              for (int k = 0; k < 3; k++) {
                float kF = float(k);
                float tOff = kF * 0.382;
                float cycle = fract(uTime * 1.6 + tOff);
                vec2 center = vec2(sin(kF * 4.3 + floor(uTime * 1.6 + tOff)), cos(kF * 6.7 + floor(uTime * 1.6 + tOff))) * 0.40;
                float d = length(p - center);
                float wave = sin(d * 38.0 - cycle * 18.0) * exp(-d * 5.0) * (1.0 - cycle);
                ripple += wave;
              }
            }

            vec3 N = normalize(vec3(ripple * 0.12, 1.0, ripple * 0.12));
            vec3 V = normalize(cameraPosition - vWorldPos);
            vec3 L = normalize(uSunDir);
            vec3 H = normalize(L + V);
            vec3 R = reflect(-V, N);

            // Optical sky reflection
            float NdotV = clamp(dot(N, V), 0.0, 1.0);
            float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 4.0);
            vec3 skyRefl = mix(vec3(0.40, 0.52, 0.65), vec3(0.75, 0.86, 0.98), max(R.y, 0.0));

            // Shallow liquid body (translucent clear puddle water)
            vec3 shallowCol = vec3(0.20, 0.28, 0.32);
            vec3 finalColor = mix(shallowCol, skyRefl, fresnel);

            // Sun glints on raindrop ripple crests
            float NdotH = max(dot(N, H), 0.0);
            float glint = pow(NdotH, 64.0) * 2.2 * fresnel;
            finalColor += uSunColor * glint;

            // Soft shoreline edge falloff:
            float edgeAlpha = smoothstep(1.0, 0.75, rDist) * smoothstep(0.0, 0.20, uFill) * 0.88;
            gl_FragColor = vec4(finalColor, edgeAlpha);
          }
        `,
        transparent: true,
        depthWrite: false,
      });

      const puddleMesh = new THREE.Mesh(discGeo, pMat);
      puddleMesh.position.set(bx, bedY + 0.01, bz);
      puddleMesh.renderOrder = 12;
      this.puddleMeshes.push(puddleMesh);
      this.puddleMats.push(pMat);
      this.group.add(puddleMesh);

      // 3. Setup Overflow Spillway Rivulet (carries runoff from puddle to river edge)
      const riverBankX = xc + (basin.xOffset < 0 ? -3.85 : 3.85);
      const riverZ = bz + 1.8;
      const waterY = this.hydraulics.getWaterHeightAt(riverZ);

      // Create a 2-segment ribbon connecting puddle lip to river edge
      const spStart = new THREE.Vector3(bx + (basin.xOffset < 0 ? basin.radius * 0.75 : -basin.radius * 0.75), rimY, bz + 0.2);
      const spEnd = new THREE.Vector3(riverBankX, waterY + 0.02, riverZ);
      const spMid = new THREE.Vector3((spStart.x + spEnd.x) * 0.5, (spStart.y + spEnd.y) * 0.5 + 0.03, (spStart.z + spEnd.z) * 0.5);

      const spWidth = 0.55;
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
          uFlowActive: { value: 0.0 }, // 0 = dry, 1 = active stream
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
          uniform float uFlowActive;

          varying vec2 vUv;
          varying vec3 vWorldPos;
          varying vec3 vNormal;

          void main() {
            if (uFlowActive < 0.02) discard;

            // Rushing runoff rill waves flowing towards river (vUv.y -> 1.0)
            float flow = sin(vUv.y * 24.0 - uTime * 6.5) * 0.5 + 0.5;
            float crossShape = sin(vUv.x * 3.14159);
            float rillAlpha = crossShape * uFlowActive * (0.45 + 0.35 * flow);

            vec3 V = normalize(cameraPosition - vWorldPos);
            vec3 L = normalize(uSunDir);
            vec3 H = normalize(L + V);
            float spec = pow(max(dot(vNormal, H), 0.0), 32.0) * 1.8;

            vec3 waterCol = mix(vec3(0.40, 0.55, 0.70), vec3(0.85, 0.95, 1.0), flow * 0.4);
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

  setRainIntensity(intensity: number) {
    this.rainIntensity = Math.max(0, Math.min(80, intensity));
    this.terrain.material.uniforms.uRainIntensity.value = this.rainIntensity;
  }

  update(dt: number, cameraPos: THREE.Vector3, simTime: number) {
    const clampedDt = Math.min(dt, 0.033);

    // 1. Update Falling Rain Streaks
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

        // Wrap around camera bounding volume:
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

    // 2. Hydrological Infiltration & Puddle Filling
    // Filling rate depends on rain intensity; drainage depends on gravel infiltration
    const fillRate = (this.rainIntensity / 50.0) * 0.18; // fill in ~6-8 seconds in heavy downpour
    const drainRate = 0.035; // slow natural infiltration when rain stops

    PUDDLE_BASINS.forEach((basin, idx) => {
      if (this.rainIntensity > 0.5) {
        this.puddleFills[idx] = Math.min(1.0, this.puddleFills[idx] + fillRate * clampedDt);
      } else {
        this.puddleFills[idx] = Math.max(0.0, this.puddleFills[idx] - drainRate * clampedDt);
      }

      const fill = this.puddleFills[idx];
      const pMat = this.puddleMats[idx];
      pMat.uniforms.uTime.value = simTime;
      pMat.uniforms.uFill.value = fill;
      pMat.uniforms.uRainIntensity.value = this.rainIntensity;

      // Physically elevate the puddle water surface as it fills
      const baseY = this.puddleBaseY[idx];
      const rimY = this.puddleRimY[idx];
      const currentWaterY = baseY + 0.01 + fill * (basin.depth - 0.01);
      this.puddleMeshes[idx].position.y = currentWaterY;

      // Overflow Spillway Rivulet: active when puddle is > 65% full and spilling over rim
      const spMat = this.spillwayMats[idx];
      const spillFlow = Math.max(0, (fill - 0.65) / 0.35);
      spMat.uniforms.uTime.value = simTime;
      spMat.uniforms.uFlowActive.value = spillFlow;
    });

    // 3. Hillslope Catchment Runoff Swell (adds dynamic inflow to river discharge Q)
    // 0 mm/h -> 0 m³/s; 25 mm/h -> +10 m³/s; 65 mm/h -> +28 m³/s
    const targetRainQ = (this.rainIntensity / 65.0) * 28.0;
    // Catchment concentration hydrograph lag:
    this.currentRainQ += (targetRainQ - this.currentRainQ) * Math.min(clampedDt * 0.35, 0.08);
  }
}
