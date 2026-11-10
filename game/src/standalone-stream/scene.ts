import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { StreamSimulation, SimParams } from "./simulation";
import { StreamCaustics } from "./caustics";
import { SimplexNoise } from "./simplexNoise";
import {
  createWaterMaterial,
  createBedMaterial,
  createTriplanarRockMaterial,
} from "./waterMaterial";

export type ViewMode = "realistic" | "caustics" | "velocity" | "height" | "froude" | "foam";

const CB = [
  [ 0.05,  0.05, 0.40, 0.45, 0.24, 0.28], // Centerpiece boulder
  [ 0.35,  0.62, 0.28, 0.33, 0.18, 0.21],
  [ 0.58, -0.62, 0.25, 0.30, 0.16, 0.19],
  [ 0.78,  0.18, 0.17, 0.22, 0.04, 0.07],
  [ 0.25, -0.22, 0.15, 0.19, 0.03, 0.06],
  [-0.55, -0.40, 0.20, 0.25, 0.04, 0.07],
  [ 1.05, -0.20, 0.15, 0.20, 0.03, 0.06],
];

export class StandaloneStreamLab {
  readonly container: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  simulation: StreamSimulation;
  caustics: StreamCaustics;
  noise = new SimplexNoise(7);

  waterMesh: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;

  bedMesh: THREE.Mesh;
  bedMat: THREE.ShaderMaterial;

  bouldersGroup: THREE.Group;
  pebblesMesh!: THREE.InstancedMesh;

  sunLight: THREE.DirectionalLight;
  sunDir = new THREE.Vector3(0.55, 0.75, 0.35).normalize();
  sunColor = new THREE.Color(0xffd080);

  screenTarget: THREE.WebGLRenderTarget;

  viewMode: ViewMode = "realistic";
  isPaused = false;

  private animId = 0;
  private lastTime = 0;
  private simTime = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // 1. High Performance WebGL2 Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2a2420);

    // 2. Camera & Orbit Controls focused on centerpiece boulder
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.05, 50);
    this.camera.position.set(1.55, 1.45, 1.75);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0.05, 0.08, 0.05);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    // 3. Screen-Space Refraction Target
    this.screenTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    // 4. Lighting & Environment
    const hemiLight = new THREE.HemisphereLight(0xffeedd, 0x332a22, 0.45);
    this.scene.add(hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xffd080, 5.5);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(6.0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1.0;
    this.sunLight.shadow.camera.far = 12.0;
    this.sunLight.shadow.camera.left = -2.3;
    this.sunLight.shadow.camera.right = 2.3;
    this.sunLight.shadow.camera.top = 2.3;
    this.sunLight.shadow.camera.bottom = -2.3;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.004;
    this.scene.add(this.sunLight);

    // Load HDRI environment map
    new RGBELoader().load("/stream-assets/hdri/autumn_field_puresky_1k.hdr", (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = hdr;
      this.scene.environmentIntensity = 0.45;
    });

    // 5. Initialize Simulation & Caustics (3m x 3m domain)
    const size = 3.0;
    const gridRes = 256;
    this.simulation = new StreamSimulation(this.renderer, { size, res: gridRes });
    this.caustics = new StreamCaustics(this.renderer, size, 512);

    // 6. Riverbed Geometry & PBR Textures
    const texLoader = new THREE.TextureLoader();
    const pebbleDiffuse = texLoader.load("/stream-assets/ganges_river_pebbles/Diffuse.jpg");
    const pebbleNor = texLoader.load("/stream-assets/ganges_river_pebbles/nor_gl.jpg");
    const pebbleArm = texLoader.load("/stream-assets/ganges_river_pebbles/arm.jpg");
    pebbleDiffuse.wrapS = pebbleDiffuse.wrapT = THREE.RepeatWrapping;
    pebbleNor.wrapS = pebbleNor.wrapT = THREE.RepeatWrapping;
    pebbleArm.wrapS = pebbleArm.wrapT = THREE.RepeatWrapping;

    const bedGeo = new THREE.PlaneGeometry(size, size, gridRes, gridRes);
    bedGeo.rotateX(-Math.PI / 2);

    const bedPositions = bedGeo.attributes.position;
    const bedFn = (x: number, z: number) => {
      return (
        -0.02 * x -
        0.028 +
        0.008 * this.noise.noise2D(x * 0.6, z * 0.6) +
        0.004 * this.noise.noise2D(x * 1.7 + 5.3, z * 1.7 - 2.1)
      );
    };

    for (let i = 0; i < bedPositions.count; i++) {
      const bx = bedPositions.getX(i);
      const bz = bedPositions.getZ(i);
      bedPositions.setY(i, bedFn(bx, bz));
    }
    bedGeo.computeVertexNormals();

    this.bedMat = createBedMaterial(this.sunDir, this.sunColor);
    this.bedMat.uniforms.uMap.value = pebbleDiffuse;
    this.bedMat.uniforms.uNor.value = pebbleNor;
    this.bedMat.uniforms.uArm.value = pebbleArm;
    this.bedMat.uniforms.uState.value = this.simulation.texState;
    this.bedMat.uniforms.uAux.value = this.simulation.texAux;
    this.bedMat.uniforms.uCaustics.value = this.caustics.texture;

    this.bedMesh = new THREE.Mesh(bedGeo, this.bedMat);
    this.bedMesh.receiveShadow = true;
    this.scene.add(this.bedMesh);

    // 7. Procedural Boulders from CB
    this.bouldersGroup = new THREE.Group();
    const boulderDataList = this.buildProceduralBoulders(texLoader);
    this.scene.add(this.bouldersGroup);

    // 8. 2,500 Instanced Riverbed Pebbles
    this.buildInstancedPebbles(pebbleDiffuse, pebbleNor, pebbleArm, boulderDataList);

    // 9. Bake Riverbed + Boulders into Simulation Terrain
    this.simulation.bakeTerrainFromBed(bedFn, boulderDataList);

    // 10. Water Surface Mesh & Shader
    const waterGeo = new THREE.PlaneGeometry(size, size, gridRes, gridRes);
    waterGeo.rotateX(-Math.PI / 2);

    this.waterMat = createWaterMaterial({
      size,
      res: gridRes,
      sunDir: this.sunDir,
      sunColor: this.sunColor,
    });
    this.waterMat.uniforms.uState.value = this.simulation.texState;
    this.waterMat.uniforms.uAux.value = this.simulation.texAux;
    this.waterMat.uniforms.uTerrain.value = this.simulation.terrainTexture;
    this.waterMat.uniforms.uScreenTex.value = this.screenTarget.texture;

    this.waterMesh = new THREE.Mesh(waterGeo, this.waterMat);
    this.waterMesh.renderOrder = 10;
    this.scene.add(this.waterMesh);

    // Resize handler
    window.addEventListener("resize", this.onResize);

    // Animation Loop
    this.lastTime = performance.now();
    this.animate(this.lastTime);
  }

  private buildProceduralBoulders(texLoader: THREE.TextureLoader) {
    const rock05Diffuse = texLoader.load("/stream-assets/rock_05/Diffuse.jpg");
    const rock05Nor = texLoader.load("/stream-assets/rock_05/nor_gl.jpg");
    const rock05Arm = texLoader.load("/stream-assets/rock_05/arm.jpg");
    rock05Diffuse.wrapS = rock05Diffuse.wrapT = THREE.RepeatWrapping;

    const rock08Diffuse = texLoader.load("/stream-assets/rock_08/Diffuse.jpg");
    const rock08Nor = texLoader.load("/stream-assets/rock_08/nor_gl.jpg");
    const rock08Arm = texLoader.load("/stream-assets/rock_08/arm.jpg");
    rock08Diffuse.wrapS = rock08Diffuse.wrapT = THREE.RepeatWrapping;

    const mats = [
      createTriplanarRockMaterial(this.sunDir, this.sunColor),
      createTriplanarRockMaterial(this.sunDir, this.sunColor),
    ];
    mats[0].uniforms.uMap.value = rock05Diffuse;
    mats[0].uniforms.uNor.value = rock05Nor;
    mats[0].uniforms.uArm.value = rock05Arm;
    mats[0].uniforms.uState.value = this.simulation.texState;
    mats[0].uniforms.uAux.value = this.simulation.texAux;
    mats[0].uniforms.uCaustics.value = this.caustics.texture;

    mats[1].uniforms.uMap.value = rock08Diffuse;
    mats[1].uniforms.uNor.value = rock08Nor;
    mats[1].uniforms.uArm.value = rock08Arm;
    mats[1].uniforms.uState.value = this.simulation.texState;
    mats[1].uniforms.uAux.value = this.simulation.texAux;
    mats[1].uniforms.uCaustics.value = this.caustics.texture;

    const boulderDataList: Array<{ x: number; z: number; r: number; h: number }> = [];

    CB.forEach((entry, idx) => {
      const [cx, cz, minR, maxR, minH, maxH] = entry;
      const r = (minR + maxR) * 0.5;
      const h = (minH + maxH) * 0.5;
      const seedOffset = idx * 13.7;

      const geo = new THREE.IcosahedronGeometry(1.0, 32);
      const pos = geo.attributes.position;
      const v = new THREE.Vector3();

      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        let n = 0;
        let amp = 0.5;
        let freq = 0.8;
        for (let o = 0; o < 4; o++) {
          n += amp * this.noise.noise3D(v.x * freq + seedOffset, v.y * freq, v.z * freq - seedOffset);
          amp *= 0.45;
          freq *= 2.2;
        }
        v.multiplyScalar(r * (1.0 + 0.3 * n));
        v.y *= 0.68; // Vertical flattening
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mats[idx % 2]);
      mesh.position.set(cx, h * 0.42, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.bouldersGroup.add(mesh);

      boulderDataList.push({ x: cx, z: cz, r, h });
    });

    return boulderDataList;
  }

  private buildInstancedPebbles(
    diffuse: THREE.Texture,
    nor: THREE.Texture,
    arm: THREE.Texture,
    boulders: Array<{ x: number; z: number; r: number }>
  ) {
    const pebbleCount = 1800;
    const baseGeo = new THREE.IcosahedronGeometry(0.025, 2);
    const pPos = baseGeo.attributes.position;
    const pv = new THREE.Vector3();
    for (let i = 0; i < pPos.count; i++) {
      pv.fromBufferAttribute(pPos, i);
      pv.multiplyScalar(1.0 + 0.15 * this.noise.noise3D(pv.x * 2.0, pv.y * 2.0, pv.z * 2.0));
      pPos.setXYZ(i, pv.x, pv.y, pv.z);
    }
    baseGeo.computeVertexNormals();

    const pebbleMat = createBedMaterial(this.sunDir, this.sunColor);
    pebbleMat.uniforms.uMap.value = diffuse;
    pebbleMat.uniforms.uNor.value = nor;
    pebbleMat.uniforms.uArm.value = arm;
    pebbleMat.uniforms.uState.value = this.simulation.texState;
    pebbleMat.uniforms.uAux.value = this.simulation.texAux;
    pebbleMat.uniforms.uCaustics.value = this.caustics.texture;

    this.pebblesMesh = new THREE.InstancedMesh(baseGeo, pebbleMat, pebbleCount);
    this.pebblesMesh.castShadow = true;
    this.pebblesMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;

    while (placed < pebbleCount && attempts < 10000) {
      attempts++;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * 1.35;
      const px = Math.cos(ang) * rad;
      const pz = Math.sin(ang) * rad;

      // Avoid boulder centers
      let nearBoulder = false;
      for (const b of boulders) {
        const d = Math.hypot(px - b.x, pz - b.z);
        if (d < b.r * 1.1) {
          nearBoulder = true;
          break;
        }
      }
      if (nearBoulder) continue;

      const py = -0.02 * px - 0.028 + 0.008 * this.noise.noise2D(px * 0.6, pz * 0.6);
      dummy.position.set(px, py + 0.008, pz);
      const scale = 0.5 + Math.random() * 0.9;
      dummy.scale.set(scale * (0.8 + Math.random() * 0.4), scale * 0.55, scale);
      dummy.rotation.set(Math.random() * 0.3, Math.random() * Math.PI, Math.random() * 0.3);
      dummy.updateMatrix();

      this.pebblesMesh.setMatrixAt(placed, dummy.matrix);
      placed++;
    }

    this.pebblesMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.pebblesMesh);
  }

  private onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.screenTarget.setSize(w, h);
    this.waterMat.uniforms.uResolution.value.set(w, h);
  };

  private animate = (now: number) => {
    this.animId = requestAnimationFrame(this.animate);

    const delta = Math.min((now - this.lastTime) * 0.001, 0.033);
    this.lastTime = now;

    if (!this.isPaused) {
      this.simTime += delta;
      // Step Shallow Water Simulation
      this.simulation.step(delta);

      // Update Caustics
      this.caustics.update(this.simulation.texState, this.simulation.terrainTexture, this.sunDir);

      // Update shader uniforms
      this.waterMat.uniforms.uTime.value = this.simTime;
      this.waterMat.uniforms.uState.value = this.simulation.texState;
      this.waterMat.uniforms.uAux.value = this.simulation.texAux;

      this.bedMat.uniforms.uState.value = this.simulation.texState;
      this.bedMat.uniforms.uAux.value = this.simulation.texAux;
      this.bedMat.uniforms.uCaustics.value = this.caustics.texture;

      this.bouldersGroup.children.forEach(c => {
        if (c instanceof THREE.Mesh && c.material instanceof THREE.ShaderMaterial) {
          c.material.uniforms.uState.value = this.simulation.texState;
          c.material.uniforms.uAux.value = this.simulation.texAux;
          c.material.uniforms.uCaustics.value = this.caustics.texture;
        }
      });
    }

    this.controls.update();

    // Two-pass rendering for screen-space refraction:
    // Pass 1: Render background (pebbles, boulders, bed with caustics and shadows) to screenTarget
    this.waterMesh.visible = false;
    this.renderer.setRenderTarget(this.screenTarget);
    this.renderer.render(this.scene, this.camera);

    // Pass 2: Show water mesh and render full scene to canvas
    this.waterMesh.visible = true;
    this.waterMat.uniforms.uScreenTex.value = this.screenTarget.texture;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  };

  reset() {
    this.simulation.reset();
  }

  dispose() {
    cancelAnimationFrame(this.animId);
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.screenTarget.dispose();
    this.container.innerHTML = "";
  }
}
