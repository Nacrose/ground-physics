import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SphTerrain } from "./terrain";
import { SphPhysics, SimPreset, InteractionMode } from "./sphPhysics";
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

  // Interactive 3D Cursor Forces (deni10000/Godot-3D-SPH-Fluid-Simulation)
  interactionMode: InteractionMode = "vortex";
  interactionRadius = 4.2;
  interactionStrength = 55.0;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private isPointerDown = false;
  private hitPoint = new THREE.Vector3(0, -2.5, 0);

  // Dynamic 3D Interaction Gizmo Reticle
  private gizmoGroup = new THREE.Group();
  private gizmoOuterRing: THREE.LineLoop;
  private gizmoInnerRing: THREE.LineLoop;
  private gizmoArrows: THREE.Group;
  private gizmoMat: THREE.LineBasicMaterial;
  private gizmoArrowMat: THREE.MeshBasicMaterial;

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
    this.scene.background = new THREE.Color(0x111827);

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

    // 4. Terrain & 3D SDF Boulder Geometry
    this.terrain = new SphTerrain(28.0, 8.5, 4.5);
    this.scene.add(this.terrain.mesh);
    for (const bMesh of this.terrain.boulderMeshes) {
      this.scene.add(bMesh);
    }

    // 5. 3D SPH Physics Engine
    this.physics = new SphPhysics(this.terrain, 12000);

    // 6. Fluid Renderer
    this.fluidRenderer = new SphRenderer(this.scene, this.renderer, this.physics);

    // 7. Dynamic 3D Interaction Reticle Gizmo
    this.gizmoMat = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.85, linewidth: 2 });
    this.gizmoArrowMat = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.85 });

    const ringSegments = 48;
    const ringGeo = new THREE.BufferGeometry();
    const ringPts: number[] = [];
    for (let i = 0; i < ringSegments; i++) {
      const a = (i / ringSegments) * Math.PI * 2;
      ringPts.push(Math.cos(a) * this.interactionRadius, 0.05, Math.sin(a) * this.interactionRadius);
    }
    ringGeo.setAttribute("position", new THREE.Float32BufferAttribute(ringPts, 3));
    this.gizmoOuterRing = new THREE.LineLoop(ringGeo, this.gizmoMat);
    this.gizmoGroup.add(this.gizmoOuterRing);

    const innerGeo = new THREE.BufferGeometry();
    const innerPts: number[] = [];
    for (let i = 0; i < ringSegments; i++) {
      const a = (i / ringSegments) * Math.PI * 2;
      innerPts.push(Math.cos(a) * (this.interactionRadius * 0.4), 0.05, Math.sin(a) * (this.interactionRadius * 0.4));
    }
    innerGeo.setAttribute("position", new THREE.Float32BufferAttribute(innerPts, 3));
    this.gizmoInnerRing = new THREE.LineLoop(innerGeo, this.gizmoMat);
    this.gizmoGroup.add(this.gizmoInnerRing);

    this.gizmoArrows = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.6, 6), this.gizmoArrowMat);
      cone.rotateX(Math.PI / 2);
      this.gizmoArrows.add(cone);
    }
    this.gizmoGroup.add(this.gizmoArrows);
    this.gizmoGroup.visible = false;
    this.scene.add(this.gizmoGroup);

    // 8. Setup Interactive Pointer Events
    this.setupPointerEvents();

    // Window resize
    window.addEventListener("resize", this.onResize);

    // Animation loop
    this.lastTime = performance.now();
    this.animate(this.lastTime);
  }

  private setupPointerEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  private updatePointerCoord(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.updatePointerCoord(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObject(this.terrain.mesh);
    if (hits.length > 0 && (this.interactionMode !== "orbit" || e.shiftKey)) {
      this.isPointerDown = true;
      this.controls.enabled = false;
      this.hitPoint.copy(hits[0].point);
      this.physics.setInteraction(true, this.interactionMode, this.hitPoint, this.interactionRadius, this.interactionStrength);
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    this.updatePointerCoord(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain.mesh);

    if (hits.length > 0) {
      this.hitPoint.copy(hits[0].point);
      this.gizmoGroup.position.copy(this.hitPoint);

      if (this.interactionMode !== "orbit") {
        this.gizmoGroup.visible = true;
        this.renderer.domElement.style.cursor = "crosshair";
      } else {
        this.gizmoGroup.visible = false;
        this.renderer.domElement.style.cursor = "default";
      }

      if (this.isPointerDown && (this.interactionMode !== "orbit" || e.shiftKey)) {
        this.physics.setInteraction(true, this.interactionMode, this.hitPoint, this.interactionRadius, this.interactionStrength);
      }
    } else {
      if (!this.isPointerDown) {
        this.gizmoGroup.visible = false;
        this.renderer.domElement.style.cursor = "default";
      }
    }
  };

  private onPointerUp = () => {
    this.isPointerDown = false;
    this.controls.enabled = true;
    this.physics.setInteraction(false, this.interactionMode, this.hitPoint);
  };

  setInteractionMode(mode: InteractionMode) {
    this.interactionMode = mode;
    this.controls.enabled = true;
    this.physics.interactionMode = mode;

    // Dynamically re-theme 3D Gizmo visuals based on mode
    if (mode === "vortex") {
      this.gizmoMat.color.setHex(0x10b981); // Emerald Green
      this.gizmoArrowMat.color.setHex(0x10b981);
      this.gizmoArrows.visible = true;
    } else if (mode === "attract") {
      this.gizmoMat.color.setHex(0x06b6d4); // Radiant Cyan
      this.gizmoArrowMat.color.setHex(0x06b6d4);
      this.gizmoArrows.visible = true;
    } else if (mode === "repel") {
      this.gizmoMat.color.setHex(0xf97316); // Blazing Orange
      this.gizmoArrowMat.color.setHex(0xf97316);
      this.gizmoArrows.visible = true;
    } else if (mode === "emit") {
      this.gizmoMat.color.setHex(0x3b82f6); // Royal Blue
      this.gizmoArrowMat.color.setHex(0x3b82f6);
      this.gizmoArrows.visible = false;
    } else {
      this.gizmoGroup.visible = false;
    }
  }

  setInteractionRadius(r: number) {
    this.interactionRadius = r;
    this.gizmoOuterRing.scale.set(r / 4.2, 1, r / 4.2);
    this.gizmoInnerRing.scale.set(r / 4.2, 1, r / 4.2);
  }

  setInteractionStrength(s: number) {
    this.interactionStrength = s;
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

      // Animate 3D Gizmo Reticle
      if (this.gizmoGroup.visible) {
        if (this.interactionMode === "vortex") {
          this.gizmoArrows.rotation.y += delta * 4.5;
          const r = this.interactionRadius * 0.7;
          for (let k = 0; k < 4; k++) {
            const a = this.gizmoArrows.rotation.y + (k / 4) * Math.PI * 2;
            const cone = this.gizmoArrows.children[k] as THREE.Mesh;
            cone.position.set(Math.cos(a) * r, 0.1, Math.sin(a) * r);
            cone.rotation.y = -a;
          }
        } else if (this.interactionMode === "attract") {
          const pulse = (Math.sin(now * 0.008) * 0.5 + 0.5);
          this.gizmoInnerRing.scale.setScalar(0.2 + pulse * 0.5);
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI * 2;
            const dist = 1.2 + (1.0 - pulse) * (this.interactionRadius - 1.2);
            const cone = this.gizmoArrows.children[k] as THREE.Mesh;
            cone.position.set(Math.cos(a) * dist, 0.1, Math.sin(a) * dist);
            cone.rotation.y = -a + Math.PI / 2; // Point inward
          }
        } else if (this.interactionMode === "repel") {
          const pulse = (Math.sin(now * 0.009) * 0.5 + 0.5);
          this.gizmoInnerRing.scale.setScalar(0.4 + pulse * 0.6);
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI * 2;
            const dist = 0.8 + pulse * (this.interactionRadius - 1.0);
            const cone = this.gizmoArrows.children[k] as THREE.Mesh;
            cone.position.set(Math.cos(a) * dist, 0.1, Math.sin(a) * dist);
            cone.rotation.y = -a - Math.PI / 2; // Point outward
          }
        }
      }
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

    const dom = this.renderer.domElement;
    dom.removeEventListener("pointerdown", this.onPointerDown);
    dom.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);

    this.renderer.dispose();
    this.container.innerHTML = "";
  }
}
