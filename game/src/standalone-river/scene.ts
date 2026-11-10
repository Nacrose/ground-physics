import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { RiverHydraulics } from "./riverHydraulics";
import { RiverTerrain } from "./riverTerrain";
import { RiverRocks } from "./riverRocks";
import { RiverWater } from "./riverWater";
import { RiverSpray } from "./riverSpray";

export class StandaloneRiverLab {
  readonly container: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  hydraulics: RiverHydraulics;
  terrain: RiverTerrain;
  rocks: RiverRocks;
  water: RiverWater;
  spray: RiverSpray;

  sunLight: THREE.DirectionalLight;
  sunDir = new THREE.Vector3(0.55, 0.75, 0.35).normalize();
  sunColor = new THREE.Color(0xffd080);

  screenTarget: THREE.WebGLRenderTarget;

  isPaused = false;
  cameraFollowRiver = false;
  private cameraProgress = 0.15; // [0, 1] along river

  private animId = 0;
  private lastTime = 0;
  private simTime = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // 1. Renderer Setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1816);

    // 2. Camera & OrbitControls
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 200);
    this.camera.position.set(12.0, 9.0, -18.0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 3.0, -12.0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    // 3. Screen Refraction Target
    this.screenTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    // 4. Lighting & Environment
    const hemiLight = new THREE.HemisphereLight(0xffeedd, 0x332a22, 0.45);
    this.scene.add(hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xffd080, 5.0);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(40.0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 5.0;
    this.sunLight.shadow.camera.far = 100.0;
    this.sunLight.shadow.camera.left = -25;
    this.sunLight.shadow.camera.right = 25;
    this.sunLight.shadow.camera.top = 25;
    this.sunLight.shadow.camera.bottom = -25;
    this.sunLight.shadow.bias = -0.0003;
    this.scene.add(this.sunLight);

    new RGBELoader().load("/assets-1k/hdri/autumn_field_puresky_1k.hdr", (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = hdr;
      this.scene.environmentIntensity = 0.45;
    });

    const texLoader = new THREE.TextureLoader();

    // 5. Open-Channel Saint-Venant Hydraulics Solver
    this.hydraulics = new RiverHydraulics();

    // 6. River Terrain Valley
    this.terrain = new RiverTerrain(texLoader, this.sunDir, this.sunColor, this.hydraulics);
    this.scene.add(this.terrain.mesh);

    // 7. Mid-Stream Boulders & Instanced River Pebbles
    this.rocks = new RiverRocks(this.terrain, texLoader, this.sunDir, this.sunColor, this.hydraulics);
    this.scene.add(this.rocks.group);

    // 8. Dynamic Flowing Water Ribbon
    this.water = new RiverWater(this.terrain, this.sunDir, this.sunColor, this.screenTarget, this.hydraulics);
    this.scene.add(this.water.mesh);

    // 9. 3D Spray Particle System
    this.spray = new RiverSpray(this.rocks, this.hydraulics);
    this.scene.add(this.spray.mesh);

    window.addEventListener("resize", this.onResize);

    this.lastTime = performance.now();
    this.animate(this.lastTime);
  }

  private onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.screenTarget.setSize(w, h);
  };

  private animate = (now: number) => {
    this.animId = requestAnimationFrame(this.animate);

    const delta = Math.min((now - this.lastTime) * 0.001, 0.033);
    this.lastTime = now;

    if (!this.isPaused) {
      this.simTime += delta;
      this.terrain.material.uniforms.uTime.value = this.simTime;
      this.water.update(this.simTime);
      this.spray.update(delta);

      if (this.cameraFollowRiver) {
        this.cameraProgress = (this.cameraProgress + delta * 0.022) % 1.0;
        const z = -35.0 + this.cameraProgress * 70.0;
        const xc = this.terrain.getRiverCenter(z);
        const wy = this.hydraulics.getWaterHeightAt(z);

        this.controls.target.set(xc, wy, z + 6.0);
        this.camera.position.set(xc + 5.5, wy + 4.0, z - 7.0);
      }
    }

    this.controls.update();

    // Two-pass rendering for screen refraction:
    // Pass 1: Render terrain, rocks, and spray into screenTarget
    this.water.mesh.visible = false;
    this.renderer.setRenderTarget(this.screenTarget);
    this.renderer.render(this.scene, this.camera);

    // Pass 2: Show water mesh and render complete scene to canvas
    this.water.mesh.visible = true;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  };

  setDischarge(q: number) {
    this.hydraulics.setDischarge(q);
  }

  setClarity(clarity: number) {
    this.water.material.uniforms.uAbsorbScale.value = clarity;
  }

  setSpray(enabled: boolean) {
    this.spray.mesh.visible = enabled;
  }

  setPebbles(enabled: boolean) {
    this.rocks.pebblesMesh.visible = enabled;
  }

  setFollowRiver(follow: boolean) {
    this.cameraFollowRiver = follow;
    if (!follow) {
      this.controls.target.set(0, 3.0, -12.0);
      this.camera.position.set(12.0, 9.0, -18.0);
      this.controls.update();
    }
  }

  setViewPreset(preset: "rapids" | "island" | "canyon" | "overview") {
    this.cameraFollowRiver = false;
    if (preset === "rapids") {
      this.controls.target.set(1.2, 4.8, -18.0);
      this.camera.position.set(5.5, 6.8, -24.0);
    } else if (preset === "island") {
      this.controls.target.set(0.4, 2.3, 15.0);
      this.camera.position.set(-4.5, 4.5, 9.0);
    } else if (preset === "canyon") {
      this.controls.target.set(0.0, 1.0, 20.0);
      this.camera.position.set(3.0, 4.0, 38.0);
    } else if (preset === "overview") {
      this.controls.target.set(0, 2.0, 0);
      this.camera.position.set(24.0, 28.0, -15.0);
    }
    this.controls.update();
  }

  dispose() {
    cancelAnimationFrame(this.animId);
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.screenTarget.dispose();
    this.container.innerHTML = "";
  }
}
