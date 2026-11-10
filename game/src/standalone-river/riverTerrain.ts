import * as THREE from "three";

export class RiverTerrain {
  readonly length = 80.0; // Z from -40 to +40
  readonly width = 32.0;  // X from -16 to +16
  readonly channelHalfWidth = 4.5;
  readonly baseDrop = 6.5; // descends 6.5m over 80m

  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;

  constructor(texLoader: THREE.TextureLoader, sunDir: THREE.Vector3, sunColor: THREE.Color) {
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
        uPebbleMap: { value: pebbleDiffuse },
        uPebbleNor: { value: pebbleNor },
        uPebbleArm: { value: pebbleArm },
        uBankMap: { value: bankDiffuse },
        uBankNor: { value: bankNor },
        uBankArm: { value: bankArm },
        uSunDir: { value: sunDir },
        uSunColor: { value: sunColor },
        uTime: { value: 0.0 },
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
        uniform sampler2D uPebbleMap;
        uniform sampler2D uPebbleNor;
        uniform sampler2D uPebbleArm;
        uniform sampler2D uBankMap;
        uniform sampler2D uBankNor;
        uniform sampler2D uBankArm;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uTime;

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec2 vUv;

        // River centerline function
        float getRiverCenter(float z) {
          return 4.0 * sin(z * 0.07) + 1.8 * cos(z * 0.15);
        }

        // River water surface elevation
        float getWaterHeight(float x, float z) {
          float slope = (1.0 - (z + 40.0) / 80.0) * 6.5;
          return slope + 0.35;
        }

        void main() {
          float xCenter = getRiverCenter(vWorldPos.z);
          float distToCenter = abs(vWorldPos.x - xCenter);
          float waterY = getWaterHeight(vWorldPos.x, vWorldPos.z);

          // Riverbed vs Bank blending
          float channelMask = smoothstep(4.8, 3.2, distToCenter);

          // UV mapping
          vec2 pebbleUv = vWorldPos.xz * 1.5;
          vec2 bankUv = vWorldPos.xz * 0.6;

          vec3 pebbleCol = texture2D(uPebbleMap, pebbleUv).rgb;
          vec3 pebbleArm = texture2D(uPebbleArm, pebbleUv).rgb;

          vec3 bankCol = texture2D(uBankMap, bankUv).rgb;
          vec3 bankArm = texture2D(uBankArm, bankUv).rgb;

          vec3 albedo = mix(bankCol, pebbleCol, channelMask);
          vec3 arm = mix(bankArm, pebbleArm, channelMask);

          // Dynamic wetness darkening where under water or near shoreline
          float submerged = smoothstep(waterY + 0.15, waterY - 0.05, vWorldPos.y);
          albedo *= mix(1.0, 0.48, submerged * channelMask);
          float roughness = mix(arm.g, 0.10, submerged * channelMask);

          // Lighting
          vec3 L = normalize(uSunDir);
          vec3 N = normalize(vNormal);
          float NdotL = max(dot(N, L), 0.0);

          // Ambient & direct
          vec3 ambient = vec3(0.18, 0.22, 0.26) * arm.r;
          vec3 direct = uSunColor * NdotL;

          // Simulated caustics dancing on the submerged bed
          if (submerged > 0.1 && channelMask > 0.2) {
            float c1 = sin(vWorldPos.x * 6.0 + uTime * 3.5) * cos(vWorldPos.z * 6.0 - uTime * 4.0);
            float c2 = sin(vWorldPos.x * 12.0 - uTime * 5.0) * cos(vWorldPos.z * 12.0 + uTime * 4.5);
            float caust = pow(max(c1 + c2, 0.0), 3.0) * 1.8;
            direct += uSunColor * caust * submerged;
          }

          vec3 finalColor = albedo * (ambient + direct);
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

  // Bed height calculation
  getBedHeight(x: number, z: number): number {
    // Longitudinal elevation slope: from y=6.5 at z=-40 to y=0 at z=+40
    const slope = (1.0 - (z + 40.0) / this.length) * this.baseDrop;

    // Distance from river centerline
    const xc = this.getRiverCenter(z);
    const d = Math.abs(x - xc);
    const w = this.channelHalfWidth;

    let bedDepth = 0;
    if (d < w) {
      // Parabolic carved riverbed channel
      const t = d / w;
      bedDepth = -1.45 * (1.0 - t * t);
    } else {
      // Sloping valley banks
      bedDepth = 0.5 * Math.log(1.0 + (d - w) * 1.2);
    }

    // Micro-rock roughness along channel
    const rockNoise = Math.sin(x * 1.5) * Math.cos(z * 1.5) * 0.12;

    return slope + bedDepth + rockNoise;
  }

  // Water surface elevation at (x, z)
  getWaterHeight(x: number, z: number): number {
    const slope = (1.0 - (z + 40.0) / this.length) * this.baseDrop;
    return slope + 0.35;
  }
}
