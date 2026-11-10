import * as THREE from "three";
import { RiverTerrain } from "./riverTerrain";

export interface RiverBoulderData {
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  radius: number;
}

export class RiverRocks {
  readonly group = new THREE.Group();
  readonly boulders: RiverBoulderData[] = [];
  pebblesMesh!: THREE.InstancedMesh;

  constructor(
    terrain: RiverTerrain,
    texLoader: THREE.TextureLoader,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color
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
      return new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: map },
          uNor: { value: nor },
          uArm: { value: arm },
          uSunDir: { value: sunDir },
          uSunColor: { value: sunColor },
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
          uniform sampler2D uMap;
          uniform sampler2D uNor;
          uniform sampler2D uArm;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          varying vec3 vWorldPos;
          varying vec3 vNormal;

          float getWaterHeight(float z) {
            float slope = (1.0 - (z + 40.0) / 80.0) * 6.5;
            return slope + 0.35;
          }

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

            // Waterline wetness darkening
            float waterY = getWaterHeight(vWorldPos.z);
            float submerged = smoothstep(waterY + 0.15, waterY - 0.05, vWorldPos.y);
            col *= mix(1.0, 0.32, submerged);

            vec3 L = normalize(uSunDir);
            float NdotL = max(dot(N, L), 0.0);
            vec3 direct = uSunColor * NdotL;
            vec3 ambient = vec3(0.20, 0.22, 0.25) * arm.r;

            gl_FragColor = vec4(col * (ambient + direct), 1.0);
          }
        `,
      });
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

    // 2. Instanced River Pebbles
    const pebbleCount = 1200;
    const pebbleBaseGeo = new THREE.IcosahedronGeometry(0.12, 1);
    const pebbleMat = mats[0];

    this.pebblesMesh = new THREE.InstancedMesh(pebbleBaseGeo, pebbleMat, pebbleCount);
    this.pebblesMesh.castShadow = true;
    this.pebblesMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0;

    for (let i = 0; i < pebbleCount; i++) {
      const z = (Math.random() - 0.5) * 76.0;
      const xc = terrain.getRiverCenter(z);
      const x = xc + (Math.random() - 0.5) * 7.5;
      const y = terrain.getBedHeight(x, z);

      dummy.position.set(x, y + 0.05, z);
      const scale = 0.5 + Math.random() * 0.9;
      dummy.scale.set(scale * (0.8 + Math.random() * 0.4), scale * 0.55, scale);
      dummy.rotation.set(Math.random() * 0.3, Math.random() * Math.PI, Math.random() * 0.3);
      dummy.updateMatrix();

      this.pebblesMesh.setMatrixAt(placed, dummy.matrix);
      placed++;
    }

    this.pebblesMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.pebblesMesh);
  }
}
