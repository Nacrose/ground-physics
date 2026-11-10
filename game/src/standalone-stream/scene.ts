import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { StreamSimulation, SimParams } from "./simulation";
import { StreamCaustics } from "./caustics";
import { createWaterMaterial, createBedMaterial } from "./waterMaterial";

export type ViewMode = "realistic" | "caustics" | "velocity" | "height" | "froude" | "foam";

export class StandaloneStreamLab {
  readonly container: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  simulation: StreamSimulation;
  caustics: StreamCaustics;

  waterMesh: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;

  bedMesh: THREE.Mesh;
  bedMat: THREE.ShaderMaterial;

  bouldersGroup: THREE.Group;

  sunDir = new THREE.Vector3(0.55, 0.75, 0.35).normalize();
  sunColor = new THREE.Color(0xfff1dc);
  skyColor = new THREE.Color(0x8faecc);

  viewMode: ViewMode = "realistic";
  private isInteracting = false;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  private animId = 0;
  private lastTime = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // WebGL2 Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x13171c);

    // Perspective Camera
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.camera.position.set(7.0, 7.5, 9.5);

    // Orbit Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(7.0, 0.2, 0.0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04; // Don't go below ground

    // Lighting
    const hemiLight = new THREE.HemisphereLight(0x8faecc, 0x22262a, 0.65);
    this.scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfff1dc, 1.4);
    dirLight.position.copy(this.sunDir).multiplyScalar(20);
    this.scene.add(dirLight);

    const size = 14.0;
    const gridRes = 160;

    // 1. Initialize Shallow Water Simulation Engine
    this.simulation = new StreamSimulation(this.renderer, { size, res: gridRes });

    // 2. Initialize Real-Time Ray-Refracted Caustics Generator
    this.caustics = new StreamCaustics(this.renderer, size, gridRes);

    // 3. Create Riverbed Geometry & Material
    const bedGeo = new THREE.PlaneGeometry(size, size, gridRes, gridRes);
    bedGeo.rotateX(-Math.PI / 2);
    bedGeo.translate(size / 2, 0, 0); // Center at (7, 0, 0)
    bedGeo.computeVertexNormals();

    this.bedMat = createBedMaterial({
      size,
      sunDir: this.sunDir,
      sunColor: this.sunColor,
      skyColor: this.skyColor,
    });
    this.bedMat.uniforms.uBedTex.value = this.simulation.bedTexture;
    this.bedMesh = new THREE.Mesh(bedGeo, this.bedMat);
    this.scene.add(this.bedMesh);

    // 4. Create Dynamic Water Surface Mesh & Optical Shader
    const waterGeo = new THREE.PlaneGeometry(size, size, gridRes, gridRes);
    waterGeo.rotateX(-Math.PI / 2);
    waterGeo.translate(size / 2, 0, 0);

    this.waterMat = createWaterMaterial({
      size,
      gridRes,
      sunDir: this.sunDir,
      sunColor: this.sunColor,
      skyColor: this.skyColor,
    });
    this.waterMesh = new THREE.Mesh(waterGeo, this.waterMat);
    this.waterMesh.renderOrder = 2;
    this.scene.add(this.waterMesh);

    // 5. Standing Boulders (Cast shadows, disturb water)
    this.bouldersGroup = new THREE.Group();
    this.buildStandingBoulders();
    this.scene.add(this.bouldersGroup);

    // Event listeners
    this.setupEvents();

    // Start animation loop
    this.lastTime = performance.now();
    this.animate(this.lastTime);
  }

  private buildStandingBoulders() {
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x36393e,
      roughness: 0.40,
      metalness: 0.08,
      flatShading: true,
    });

    const boulders = [
      { x: 3.8, z: -0.9, y: 0.65, r: 0.95 },
      { x: 7.5, z: 1.1, y: 0.48, r: 1.15 },
      { x: 10.6, z: -0.4, y: 0.28, r: 1.05 },
    ];

    boulders.forEach(b => {
      const geo = new THREE.DodecahedronGeometry(b.r, 1);
      const mesh = new THREE.Mesh(geo, rockMat);
      mesh.position.set(b.x, b.y, b.z);
      mesh.scale.set(1.0, 0.72, 1.1);
      mesh.rotation.set(0.3, Math.random() * Math.PI, 0.2);
      this.bouldersGroup.add(mesh);
    });
  }

  private setupEvents() {
    const el = this.renderer.domElement;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.shiftKey) return; // Left click without shift disturbs water
      this.isInteracting = true;
      this.handleInteraction(e);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (this.isInteracting) {
        this.handleInteraction(e);
      }
    };

    const onPointerUp = () => {
      this.isInteracting = false;
    };

    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("resize", this.onResize);
  }

  private handleInteraction(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.waterMesh);
    if (intersects.length > 0) {
      const p = intersects[0].point;
      // Convert world (X: 0..14, Z: -7..+7) to normalized UV (0..1, 0..1)
      const uvX = p.x / this.simulation.size;
      const uvY = p.z / this.simulation.size + 0.5;
      if (uvX >= 0 && uvX <= 1 && uvY >= 0 && uvY <= 1) {
        this.simulation.addDisturbance(uvX, uvY, 0.05, 0.22);
      }
    }
  }

  private onResize = () => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  setViewMode(mode: ViewMode) {
    this.viewMode = mode;
    // In realistic mode, water is visible; in debug modes we can display corresponding textures
    if (mode === "realistic") {
      this.waterMesh.visible = true;
      this.bedMat.uniforms.uCausticStrength.value = 2.8;
    } else if (mode === "caustics") {
      this.waterMesh.visible = false;
      this.bedMat.uniforms.uCausticStrength.value = 6.0;
    }
  }

  animate = (now: number) => {
    this.animId = requestAnimationFrame(this.animate);

    const dt = Math.min((now - this.lastTime) * 0.001, 0.05);
    this.lastTime = now;

    // 1. Advance Shallow Water Equations simulation
    this.simulation.step(dt);

    const stateTex = this.simulation.currentStateTexture;
    const auxTex = this.simulation.currentAuxTexture;

    // 2. Compute Real-Time Refracted Caustics
    this.caustics.update(stateTex, this.simulation.bedTexture, this.sunDir);

    // 3. Update Water & Riverbed Shaders
    this.waterMat.uniforms.uStateTex.value = stateTex;
    this.waterMat.uniforms.uAuxTex.value = auxTex;
    this.waterMat.uniforms.uCausticTex.value = this.caustics.texture;
    this.waterMat.uniforms.uTime.value = now * 0.001;
    this.waterMat.uniforms.uCamPos.value.copy(this.camera.position);

    this.bedMat.uniforms.uStateTex.value = stateTex;
    this.bedMat.uniforms.uCausticTex.value = this.caustics.texture;

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.animId);
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.simulation.dispose();
    this.caustics.dispose();
    this.waterMesh.geometry.dispose();
    this.waterMat.dispose();
    this.bedMesh.geometry.dispose();
    this.bedMat.dispose();
    this.renderer.dispose();
  }
}
