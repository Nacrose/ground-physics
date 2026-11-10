import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SphTerrain } from "./terrain";
import { SphPhysics, SimPreset } from "./sphPhysics";
import { SphRenderer, RenderMode } from "./sphRenderer";

export class StandaloneSphLab {
  readonly container: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  terrain: SphTerrain;
  physics: SphPhysics;
  fluidRenderer: SphRenderer;

  sunLight: THREE.DirectionalLight;

  isPaused = false;
  private animId = 0;
  private lastTime = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // 1. Renderer Setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x182028);

    // 2. Camera & OrbitControls overlooking the crater basin
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 150);
    this.camera.position.set(16.0, 14.0, 18.0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, -1.0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    // 3. Environment & Lighting
    const hemiLight = new THREE.HemisphereLight(0x8faecc, 0x1f2429, 0.55);
    this.scene.add(hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xffeedd, 3.5);
    this.sunLight.position.set(12, 22, 10);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1.0;
    this.sunLight.shadow.camera.far = 60.0;
    this.sunLight.shadow.camera.left = -16;
    this.sunLight.shadow.camera.right = 16;
    this.sunLight.shadow.camera.top = 16;
    this.sunLight.shadow.camera.bottom = -16;
    this.sunLight.shadow.bias = -0.0003;
    this.scene.add(this.sunLight);

    // 4. Terrain & Crater Geometry
    this.terrain = new SphTerrain(28.0, 8.5, 4.5);
    this.scene.add(this.terrain.mesh);

    // 5. 3D SPH Physics Engine
    this.physics = new SphPhysics(this.terrain, 12000);

    // 6. Fluid Renderer
    this.fluidRenderer = new SphRenderer(this.scene, this.renderer, this.physics);

    // Window resize
    window.addEventListener("resize", this.onResize);

    // Animation loop
    this.lastTime = performance.now();
    this.animate(this.lastTime);
  }

  private onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private animate = (now: number) => {
    this.animId = requestAnimationFrame(this.animate);

    const delta = Math.min((now - this.lastTime) * 0.001, 0.033);
    this.lastTime = now;

    if (!this.isPaused) {
      this.physics.step(delta);
      this.fluidRenderer.update();
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  setPreset(preset: SimPreset) {
    this.physics.applyPreset(preset);
    this.fluidRenderer.update();
  }

  setRenderMode(mode: RenderMode) {
    this.fluidRenderer.setMode(mode);
  }

  toggleHole(enabled: boolean) {
    this.terrain.holeEnabled = enabled;
  }

  dispose() {
    cancelAnimationFrame(this.animId);
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    this.container.innerHTML = "";
  }
}
