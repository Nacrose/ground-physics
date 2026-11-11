import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";
import { RiverHydraulics } from "./riverHydraulics";

export interface RiverBoulderData {
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  radius: number;
}

export class RiverRocks {
  readonly group = new THREE.Group();
  readonly boulders: RiverBoulderData[] = [];
  pebblesMesh!: THREE.InstancedMesh;
  readonly pebbleCount: number = 1200;
  private pPos!: Float32Array;
  private pRot!: Float32Array;
  private pScale!: Float32Array;
  private pVelZ!: Float32Array;
  private rockMats: THREE.ShaderMaterial[] = [];

  constructor(
    terrain: RiverTerrain,
    texLoader: THREE.TextureLoader,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    hydraulics: RiverHydraulics
  ) {
    const rock05Diffuse = texLoader.load("/assets-1k/rock_05/Diffuse.jpg");
    const rock05Nor = texLoader.load("/assets-1k/rock_05/nor_gl.jpg");
    const rock05Arm = texLoader.load("/assets-1k/rock_05/arm.jpg");
    rock05Diffuse.wrapS = rock05Diffuse.wrapT = THREE.RepeatWrapping;

    const rock08Diffuse = texLoader.load("/assets-1k/rock_08/Diffuse.jpg");
    const rock08Nor = texLoader.load("/assets-1k/rock_08/nor_gl.jpg");
    const rock08Arm = texLoader.load("/assets-1k/rock_08/arm.jpg");
    rock08Diffuse.wrapS = rock08Diffuse.wrapT = THREE.RepeatWrapping;

    const createRockMat = (map: THREE.Texture, nor: THREE.Texture, arm: THREE.Texture) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uHydraulicsTex: { value: hydraulics.texture },
          uMap: { value: map },
          uNor: { value: nor },
          uArm: { value: arm },
          uSunDir: { value: sunDir },
          uSunColor: { value: sunColor },
          uTime: { value: 0.0 },
        },
        vertexShader: `
          varying vec3 vWorldPos;
          varying vec3 vNormal;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          precision highp float;
          uniform sampler2D uHydraulicsTex;
          uniform sampler2D uMap;
          uniform sampler2D uNor;
          uniform sampler2D uArm;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform float uTime;
          varying vec3 vWorldPos;
          varying vec3 vNormal;

          void main() {
            vec3 N = normalize(vNormal);
            vec3 weights = pow(abs(N), vec3(4.0));
            weights /= (weights.x + weights.y + weights.z);

            vec3 p = vWorldPos * 1.5;
            vec3 col = texture2D(uMap, p.yz).rgb * weights.x +
                       texture2D(uMap, p.zx).rgb * weights.y +
                       texture2D(uMap, p.xy).rgb * weights.z;

            vec3 arm = texture2D(uArm, p.yz).rgb * weights.x +
                       texture2D(uArm, p.zx).rgb * weights.y +
                       texture2D(uArm, p.xy).rgb * weights.z;

            // Waterline wetness darkening using real-time hydraulic height
            float uStation = clamp((vWorldPos.z + 40.0) / 80.0, 0.0, 1.0);
            vec4 hyd = texture2D(uHydraulicsTex, vec2(uStation, 0.5));
            float waterY = hyd.g;
            float submerged = smoothstep(waterY + 0.18, waterY - 0.05, vWorldPos.y);
            col *= mix(1.0, 0.42, submerged);

            vec3 L = normalize(uSunDir);
            float NdotL = max(dot(N, L), 0.0);
            vec3 direct = uSunColor * NdotL;

            // Dancing light caustics on submerged boulder flanks
            if (submerged > 0.05) {
              float depth = max(0.0, waterY - vWorldPos.y);
              vec2 cUv1 = vWorldPos.xz * 2.8 - vec2(0.0, uTime * 2.2);
              vec2 cUv2 = vWorldPos.xz * 5.6 + vec2(uTime * 0.45, -uTime * 3.2);
              float c1 = texture2D(uNor, cUv1).r * 0.5 + 0.5;
              float c2 = texture2D(uNor, cUv2).g * 0.5 + 0.5;
              float caust = pow(c1 * c2, 2.6) * 5.5 * exp(-depth * 0.85);
              direct += uSunColor * caust * submerged;
            }

            // Glistening wetness specular on rock surface
            vec3 V = normalize(cameraPosition - vWorldPos);
            vec3 H = normalize(L + V);
            float NdotH = max(dot(N, H), 0.0);
            float wetGlint = pow(NdotH, 64.0) * 1.6 * submerged * NdotL;
            direct += uSunColor * wetGlint;

            vec3 ambient = vec3(0.20, 0.22, 0.25) * arm.r;
            gl_FragColor = vec4(col * (ambient + direct), 1.0);
          }
        `,
      });
      this.rockMats.push(mat);
      return mat;
    };

    const mats = [
      createRockMat(rock05Diffuse, rock05Nor, rock05Arm),
      createRockMat(rock08Diffuse, rock08Nor, rock08Arm),
    ];

    // 1. Procedural Mid-Stream & Bank Boulders
    const boulderConfigs = [
      { z: -32.0, xOffset: 0.5, r: 1.4, h: 1.2 },
      { z: -25.0, xOffset: -1.8, r: 1.8, h: 1.5 },
      { z: -18.0, xOffset: 1.2, r: 2.1, h: 1.8 }, // Major rapid boulder
      { z: -10.0, xOffset: -0.6, r: 1.5, h: 1.3 },
      { z: -2.0,  xOffset: 1.6, r: 1.9, h: 1.6 },
      { z: 6.0,   xOffset: -1.2, r: 1.6, h: 1.4 },
      { z: 15.0,  xOffset: 0.4, r: 2.3, h: 1.9 }, // Big island rock
      { z: 22.0,  xOffset: -2.0, r: 1.4, h: 1.2 },
      { z: 30.0,  xOffset: 1.1, r: 1.7, h: 1.4 },
      { z: 36.0,  xOffset: -0.5, r: 1.3, h: 1.1 },
    ];

    boulderConfigs.forEach((cfg, idx) => {
      const xc = terrain.getRiverCenter(cfg.z) + cfg.xOffset;
      const bedY = terrain.getBedHeight(xc, cfg.z);

      const geo = new THREE.IcosahedronGeometry(cfg.r, 24);
      const pos = geo.attributes.position;
      const v = new THREE.Vector3();

      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        // Simple noise perturbation
        const n =
          0.35 * Math.sin(v.x * 2.5 + idx) * Math.cos(v.z * 2.5) +
          0.15 * Math.sin(v.y * 5.0);
        v.multiplyScalar(1.0 + n);
        v.y *= 0.70; // squish vertically
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mats[idx % 2]);
      mesh.position.set(xc, bedY + cfg.h * 0.45, cfg.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);

      this.boulders.push({
        mesh,
        center: mesh.position.clone(),
        radius: cfg.r,
      });
    });

    // 2. Instanced River Pebbles (REEF3D Dynamic Bedload Scour & Mobilization)
    const pebbleCount = 1200;
    this.pebbleCount = pebbleCount;
    this.pPos = new Float32Array(pebbleCount * 3);
    this.pRot = new Float32Array(pebbleCount * 3);
    this.pScale = new Float32Array(pebbleCount * 3);
    this.pVelZ = new Float32Array(pebbleCount);

    const pebbleBaseGeo = new THREE.IcosahedronGeometry(0.12, 1);
    const pebbleMat = mats[0];

    this.pebblesMesh = new THREE.InstancedMesh(pebbleBaseGeo, pebbleMat, pebbleCount);
    this.pebblesMesh.castShadow = true;
    this.pebblesMesh.receiveShadow = true;
    this.pebblesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dummy = new THREE.Object3D();

    for (let i = 0; i < pebbleCount; i++) {
      const z = (Math.random() - 0.5) * 76.0;
      const xc = terrain.getRiverCenter(z);
      const x = xc + (Math.random() - 0.5) * 7.5;
      const y = terrain.getBedHeight(x, z);

      const i3 = i * 3;
      this.pPos[i3] = x;
      this.pPos[i3 + 1] = y + 0.04;
      this.pPos[i3 + 2] = z;

      const rx = Math.random() * 0.3;
      const ry = Math.random() * Math.PI;
      const rz = Math.random() * 0.3;
      this.pRot[i3] = rx;
      this.pRot[i3 + 1] = ry;
      this.pRot[i3 + 2] = rz;

      const scale = 0.5 + Math.random() * 0.9;
      const sx = scale * (0.8 + Math.random() * 0.4);
      const sy = scale * 0.55;
      const sz = scale;
      this.pScale[i3] = sx;
      this.pScale[i3 + 1] = sy;
      this.pScale[i3 + 2] = sz;
      this.pVelZ[i] = 0;

      dummy.position.set(x, y + 0.04, z);
      dummy.scale.set(sx, sy, sz);
      dummy.rotation.set(rx, ry, rz);
      dummy.updateMatrix();

      this.pebblesMesh.setMatrixAt(i, dummy.matrix);
    }

    this.pebblesMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.pebblesMesh);
  }

  // REEF3D Sediment Transport: Pebbles mobilize, roll, saltate, and deposit based on Shields parameter θ
  update(dt: number, hydraulics: RiverHydraulics, terrain: RiverTerrain, time = 0) {
    const clampedDt = Math.min(dt, 0.033);
    const dummy = new THREE.Object3D();

    for (const mat of this.rockMats) {
      if (mat.uniforms.uTime) {
        mat.uniforms.uTime.value = time;
      }
    }

    for (let i = 0; i < this.pebbleCount; i++) {
      const i3 = i * 3;
      let x = this.pPos[i3];
      let y = this.pPos[i3 + 1];
      let z = this.pPos[i3 + 2];
      let rx = this.pRot[i3];
      const ry = this.pRot[i3 + 1];
      const rz = this.pRot[i3 + 2];
      const sx = this.pScale[i3];
      const sy = this.pScale[i3 + 1];
      const sz = this.pScale[i3 + 2];

      const st = hydraulics.getStationAtZ(z);
      const xc = terrain.getRiverCenter(z);
      const distFromCenter = Math.abs(x - xc);

      // Only mobilize pebbles inside the active channel where Shields parameter exceeds critical threshold:
      if (st.isScouring && distFromCenter < 3.8) {
        // Meyer-Peter & Müller active bedload transport:
        const excess = Math.max(0, st.shieldsParam - 0.047);
        const targetVz = st.velocity * Math.min(0.65, 0.08 + excess * 1.8);
        this.pVelZ[i] += (targetVz - this.pVelZ[i]) * Math.min(clampedDt * 4.0, 1.0);

        // Advance streamwise:
        z += this.pVelZ[i] * clampedDt;

        // Saltation & angular rolling tumble:
        rx += this.pVelZ[i] * 6.0 * clampedDt;
        const hop = Math.abs(Math.sin(rx * 2.5)) * Math.min(0.04, this.pVelZ[i] * 0.03);
        const bedY = terrain.getBedHeight(x, z);
        y = bedY + 0.04 + hop;

        // Recycle if swept out of domain:
        if (z > 38.5) {
          z = -38.0 + (Math.random() - 0.5) * 4.0;
          x = terrain.getRiverCenter(z) + (Math.random() - 0.5) * 5.0;
          y = terrain.getBedHeight(x, z) + 0.04;
          this.pVelZ[i] = 0;
        }
      } else {
        // Settled into stable armored bed / quiet gravel bar:
        this.pVelZ[i] *= Math.max(0.0, 1.0 - clampedDt * 5.0);
        const bedY = terrain.getBedHeight(x, z);
        y = bedY + 0.04;
      }

      this.pPos[i3] = x;
      this.pPos[i3 + 1] = y;
      this.pPos[i3 + 2] = z;
      this.pRot[i3] = rx;

      dummy.position.set(x, y, z);
      dummy.rotation.set(rx, ry, rz);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();

      this.pebblesMesh.setMatrixAt(i, dummy.matrix);
    }

    this.pebblesMesh.instanceMatrix.needsUpdate = true;
  }
}

