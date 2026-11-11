import * as THREE from "three";
import { SphPhysics } from "./sphPhysics";
import { generateWaterNormalMap, generateFoamTexture } from "../standalone-river/riverWater";

export type RenderMode = "fluid" | "particles";

/**
 * 🌊 High-Fidelity Continuous Screen Space Fluid Renderer (SSFR)
 *
 * Replaces discrete balloon-like spheres with a truly continuous,
 * glass-smooth liquid volume featuring:
 *  - C1 Wendland polynomial metaballs (zero boundary slope)
 *  - 6-pass multi-scale hierarchical bilateral blur (75+ pixel coverage)
 *  - Screen-space normal reconstruction with Kolmogorov wave micro-ripples
 *  - Beer-Lambert physical light absorption & optical refraction
 *  - Shoreline bedrock contact foam (zero per-particle rim outlines)
 *  - Feathered depth-weighted isosurface blending
 */
export class SphRenderer {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly physics: SphPhysics;

  mode: RenderMode = "fluid";

  // Particle Point Cloud Mode (Debug/Analytical)
  private pointsGeo: THREE.BufferGeometry;
  private pointsMat: THREE.ShaderMaterial;
  private pointsMesh: THREE.Points;

  // --- SSFR Render Targets ---
  private sceneTarget: THREE.WebGLRenderTarget;
  private fluidDepthTarget: THREE.WebGLRenderTarget;
  private fluidThicknessTarget: THREE.WebGLRenderTarget;
  private tempBlur1: THREE.WebGLRenderTarget;
  private tempBlur2: THREE.WebGLRenderTarget;
  private smoothedDepthTarget: THREE.WebGLRenderTarget;

  // --- Textures ---
  private waterNormalMap: THREE.DataTexture;
  private foamTex: THREE.DataTexture;

  // --- Particle Instanced Quads ---
  private particleGeo: THREE.InstancedBufferGeometry;
  private posAttr: THREE.InstancedBufferAttribute;
  private velAttr: THREE.InstancedBufferAttribute;
  private densityAttr: THREE.InstancedBufferAttribute;

  private particleDepthMat: THREE.ShaderMaterial;
  private particleThicknessMat: THREE.ShaderMaterial;
  private particleQuadMesh: THREE.Mesh;
  private fluidScene: THREE.Scene;

  // --- Fullscreen Post-Processing Passes ---
  private postCam: THREE.OrthographicCamera;
  private blurMat: THREE.ShaderMaterial;
  private blurScene: THREE.Scene;

  private compositeMat: THREE.ShaderMaterial;
  private compositeScene: THREE.Scene;

  private targetW = 1;
  private targetH = 1;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, physics: SphPhysics) {
    this.scene = scene;
    this.renderer = renderer;
    this.physics = physics;

    const size = new THREE.Vector2();
    renderer.getSize(size);
    const dpr = Math.min(renderer.getPixelRatio(), 1.5);
    const w = Math.max(1, Math.round(size.x * dpr));
    const h = Math.max(1, Math.round(size.y * dpr));
    this.targetW = w;
    this.targetH = h;

    // Shared Unified Textures (same as River Lab)
    this.waterNormalMap = generateWaterNormalMap(512);
    this.foamTex = generateFoamTexture(256);

    // 1. Scene Target with Hardware Depth Texture
    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(w, h);
    this.sceneTarget.depthTexture.type = THREE.UnsignedIntType;

    // 2. Fluid Depth Target (Linear View-Space Z)
    this.fluidDepthTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // 3. Fluid Optical Thickness Target (Additive Blending)
    this.fluidThicknessTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // 4. Ping-Pong Targets for Multi-Pass Bilateral Depth Smoothing
    this.tempBlur1 = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    this.tempBlur2 = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    this.smoothedDepthTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // --- Instanced Billboard Particle Geometry ---
    const basePlane = new THREE.PlaneGeometry(1, 1);
    this.particleGeo = new THREE.InstancedBufferGeometry();
    this.particleGeo.index = basePlane.index;
    this.particleGeo.attributes.position = basePlane.attributes.position;
    this.particleGeo.attributes.uv = basePlane.attributes.uv;

    this.posAttr = new THREE.InstancedBufferAttribute(physics.pos, 3);
    this.velAttr = new THREE.InstancedBufferAttribute(physics.vel, 3);
    this.densityAttr = new THREE.InstancedBufferAttribute(physics.density, 1);

    this.particleGeo.setAttribute("aInstancePos", this.posAttr);
    this.particleGeo.setAttribute("aInstanceVel", this.velAttr);
    this.particleGeo.setAttribute("aDensity", this.densityAttr);

    // Particle Visual Radius (increased to span the full SPH smoothing radius H = 0.72)
    const fluidVisualRadius = physics.params.smoothingRadius * 0.95;

    // --- Particle Depth Shader (Wendland C1 Continuous Kernel) ---
    this.particleDepthMat = new THREE.ShaderMaterial({
      transparent: false,
      depthWrite: true,
      depthTest: true,
      uniforms: {
        uRadius: { value: fluidVisualRadius },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aInstancePos;
        attribute vec3 aInstanceVel;
        attribute float aDensity;
        uniform float uRadius;

        varying vec2 vUv;
        varying vec3 vViewCenter;

        void main() {
          vUv = uv;
          vec4 viewCenter = modelViewMatrix * vec4(aInstancePos, 1.0);
          vViewCenter = viewCenter.xyz;

          // Camera-facing billboard quad in view space
          vec3 viewPos = viewCenter.xyz + vec3((uv - 0.5) * (uRadius * 2.8), 0.0);
          gl_Position = projectionMatrix * vec4(viewPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uRadius;
        varying vec2 vUv;
        varying vec3 vViewCenter;

        void main() {
          vec2 n = vUv * 2.0 - 1.0;
          float r2 = dot(n, n);
          if (r2 > 1.0) discard;

          // Smooth Wendland C1 polynomial surface function:
          // w(r) = (1 - r^2)^2 * (1 + 2 * r^2). Zero slope at boundary!
          float w = 1.0 - r2;
          float zOffset = w * w * (1.0 + 1.6 * r2) * uRadius * 0.88;
          float linearZ = -(vViewCenter.z + zOffset);
          gl_FragColor = vec4(linearZ, 0.0, 0.0, 1.0);
        }
      `,
    });

    // --- Particle Thickness Shader (Additive) ---
    this.particleThicknessMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uRadius: { value: fluidVisualRadius },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aInstancePos;
        uniform float uRadius;
        varying vec2 vUv;

        void main() {
          vUv = uv;
          vec4 viewCenter = modelViewMatrix * vec4(aInstancePos, 1.0);
          vec3 viewPos = viewCenter.xyz + vec3((uv - 0.5) * (uRadius * 2.8), 0.0);
          gl_Position = projectionMatrix * vec4(viewPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uRadius;
        varying vec2 vUv;

        void main() {
          vec2 n = vUv * 2.0 - 1.0;
          float r2 = dot(n, n);
          if (r2 > 1.0) discard;

          float w = 1.0 - r2;
          float thickness = w * w * uRadius * 1.85;
          gl_FragColor = vec4(thickness, thickness, thickness, 1.0);
        }
      `,
    });

    this.particleQuadMesh = new THREE.Mesh(this.particleGeo, this.particleDepthMat);
    this.particleQuadMesh.frustumCulled = false;

    this.fluidScene = new THREE.Scene();
    this.fluidScene.add(this.particleQuadMesh);

    // --- Post-Processing Orthographic Camera & Quads ---
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const fullscreenPlane = new THREE.PlaneGeometry(2, 2);

    // --- Configurable Bilateral Blur Material ---
    this.blurMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uDepthTex: { value: this.fluidDepthTarget.texture },
        uStep: { value: new THREE.Vector2(1 / w, 0) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uDepthTex;
        uniform vec2 uStep;
        varying vec2 vUv;

        void main() {
          float centerZ = texture2D(uDepthTex, vUv).r;
          if (centerZ <= 0.001) {
            gl_FragColor = vec4(0.0);
            return;
          }

          float sum = 0.0;
          float totalW = 0.0;
          const int R = 5;

          for (int i = -R; i <= R; i++) {
            vec2 off = uStep * float(i);
            float sampleZ = texture2D(uDepthTex, vUv + off).r;
            if (sampleZ > 0.001) {
              float dist2 = float(i * i);
              float spatialW = exp(-dist2 / 12.0);
              float depthDiff = abs(sampleZ - centerZ);
              // Generous threshold to merge particles smoothly across SPH kernel width (up to 2.2m)
              float depthW = exp(-depthDiff * depthDiff / 2.8);
              float w = spatialW * depthW;
              sum += sampleZ * w;
              totalW += w;
            }
          }

          float res = totalW > 0.0 ? sum / totalW : centerZ;
          gl_FragColor = vec4(res, 0.0, 0.0, 1.0);
        }
      `,
    });

    this.blurScene = new THREE.Scene();
    this.blurScene.add(new THREE.Mesh(fullscreenPlane, this.blurMat));

    // --- Fullscreen Composite SSFR Shader ---
    this.compositeMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSceneColor: { value: this.sceneTarget.texture },
        uSceneDepth: { value: this.sceneTarget.depthTexture },
        uSmoothedDepth: { value: this.smoothedDepthTarget.texture },
        uThickness: { value: this.fluidThicknessTarget.texture },
        uWaterNormalMap: { value: this.waterNormalMap },
        uFoamTex: { value: this.foamTex },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
        uInvProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uViewMatrix: { value: new THREE.Matrix4() },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 200.0 },
        uViewSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.4) },
        uSkyColor: { value: new THREE.Color(0x38bdf8) },
        uSunColor: { value: new THREE.Color(0xfff7ed) },
        uWaterDeepColor: { value: new THREE.Color(0x023e73) },
        uWaterShallowColor: { value: new THREE.Color(0x22d3ee) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSceneColor;
        uniform sampler2D uSceneDepth;
        uniform sampler2D uSmoothedDepth;
        uniform sampler2D uThickness;
        uniform sampler2D uWaterNormalMap;
        uniform sampler2D uFoamTex;
        uniform vec2 uTexelSize;
        uniform mat4 uInvProj;
        uniform mat4 uInvView;
        uniform mat4 uViewMatrix;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform vec3 uViewSunDir;
        uniform vec3 uSkyColor;
        uniform vec3 uSunColor;
        uniform vec3 uWaterDeepColor;
        uniform vec3 uWaterShallowColor;
        uniform float uTime;

        varying vec2 vUv;

        // Linearize hardware depth buffer
        float linearizeDepth(float d) {
          float z_ndc = d * 2.0 - 1.0;
          return 2.0 * uCameraNear * uCameraFar / (uCameraFar + uCameraNear - z_ndc * (uCameraFar - uCameraNear));
        }

        // Reconstruct view position accurately from linear view-space depth
        vec3 reconstructViewPos(vec2 uv, float linearZ) {
          vec4 clip = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
          vec4 pView = uInvProj * clip;
          vec3 rayDir = pView.xyz / pView.w;
          return rayDir * (linearZ / (-rayDir.z));
        }

        void main() {
          vec4 bgCol = texture2D(uSceneColor, vUv);
          float fluidZ = texture2D(uSmoothedDepth, vUv).r;

          if (fluidZ <= 0.001) {
            gl_FragColor = bgCol;
            return;
          }

          float rawSceneD = texture2D(uSceneDepth, vUv).r;
          float sceneZ = linearizeDepth(rawSceneD);

          // Occlusion: fluid occluded by solid scene geometry (terrain ridges, boulders)
          if (fluidZ > sceneZ - 0.03) {
            gl_FragColor = bgCol;
            return;
          }

          float thickness = texture2D(uThickness, vUv).r;
          if (thickness < 0.035) {
            gl_FragColor = bgCol;
            return;
          }

          // 1. Reconstruct view position and smooth surface normal
          vec3 posC = reconstructViewPos(vUv, fluidZ);

          float zR = texture2D(uSmoothedDepth, vUv + vec2(uTexelSize.x * 2.0, 0.0)).r;
          float zL = texture2D(uSmoothedDepth, vUv - vec2(uTexelSize.x * 2.0, 0.0)).r;
          float zT = texture2D(uSmoothedDepth, vUv + vec2(0.0, uTexelSize.y * 2.0)).r;
          float zB = texture2D(uSmoothedDepth, vUv - vec2(0.0, uTexelSize.y * 2.0)).r;

          if (zR <= 0.001 || abs(zR - fluidZ) > 1.2) zR = fluidZ;
          if (zL <= 0.001 || abs(zL - fluidZ) > 1.2) zL = fluidZ;
          if (zT <= 0.001 || abs(zT - fluidZ) > 1.2) zT = fluidZ;
          if (zB <= 0.001 || abs(zB - fluidZ) > 1.2) zB = fluidZ;

          vec3 posR = reconstructViewPos(vUv + vec2(uTexelSize.x * 2.0, 0.0), zR);
          vec3 posL = reconstructViewPos(vUv - vec2(uTexelSize.x * 2.0, 0.0), zL);
          vec3 posT = reconstructViewPos(vUv + vec2(0.0, uTexelSize.y * 2.0), zT);
          vec3 posB = reconstructViewPos(vUv - vec2(0.0, uTexelSize.y * 2.0), zB);

          vec3 dX = posR - posL;
          vec3 dY = posT - posB;
          vec3 macroN = normalize(cross(dX, dY));
          if (macroN.z < 0.0) macroN = -macroN;

          // 2. Add realistic Kolmogorov surface capillary waves
          vec3 worldPos = (uInvView * vec4(posC, 1.0)).xyz;
          vec2 waveUv = worldPos.xz * 0.35;
          vec3 ripple1 = texture2D(uWaterNormalMap, waveUv + vec2(uTime * 0.07, uTime * 0.04)).rgb * 2.0 - 1.0;
          vec3 ripple2 = texture2D(uWaterNormalMap, waveUv * 1.7 - vec2(uTime * 0.05, -uTime * 0.06)).rgb * 2.0 - 1.0;
          vec3 rippleWorld = normalize(vec3(ripple1.x + ripple2.x, 3.2, ripple1.z + ripple2.z));
          vec3 rippleView = normalize((uViewMatrix * vec4(rippleWorld, 0.0)).xyz);

          // Combine macro SPH curvature + subtle micro-ripples
          vec3 N = normalize(macroN + rippleView * 0.22);
          vec3 V = normalize(-posC);

          // 3. Screen-Space Optical Refraction (distort background)
          vec2 refrOffset = N.xy * 0.035 * clamp(thickness * 1.5, 0.0, 1.0);
          vec2 refrUv = vUv + refrOffset;
          float refrSceneZ = linearizeDepth(texture2D(uSceneDepth, refrUv).r);
          if (refrSceneZ < fluidZ) refrUv = vUv; // Reject foreground occlusion bleeding

          vec3 sceneSample = texture2D(uSceneColor, refrUv).rgb;

          // 4. Physical Beer-Lambert Light Absorption Law
          // I = I0 * exp(-alpha * thickness)
          vec3 alphaAbsorb = vec3(1.35, 0.45, 0.16);
          vec3 transmission = exp(-alphaAbsorb * thickness * 1.8);
          vec3 waterCol = sceneSample * transmission;

          // Gradient tinting (turquoise Caribbean shallows -> deep navy river depths)
          vec3 waterTint = mix(uWaterShallowColor, uWaterDeepColor, smoothstep(0.1, 1.2, thickness));
          waterCol = mix(waterCol, waterTint, clamp(thickness * 0.75, 0.0, 0.85));

          // 5. Schlick's Fresnel Sky Reflection
          float R0 = 0.0204; // Refractive index of water = 1.333
          float cosTheta = max(dot(N, V), 0.0);
          float fresnel = R0 + (1.0 - R0) * pow(1.0 - cosTheta, 5.0);
          waterCol = mix(waterCol, uSkyColor * 1.15, fresnel * 0.75);

          // 6. Blinn-Phong Sun Specular Highlight
          vec3 L = normalize(uViewSunDir);
          vec3 H = normalize(L + V);
          float NdotH = max(dot(N, H), 0.0);
          float spec = pow(NdotH, 128.0);
          waterCol += uSunColor * spec * 1.1;

          // 7. Shoreline / Bedrock Contact Foam (where water meets land, zero per-particle rim foam)
          float depthToBed = max(sceneZ - fluidZ, 0.0);
          float shorelineContact = smoothstep(0.20, 0.02, depthToBed);
          vec2 foamUv = worldPos.xz * 0.5 + vec2(uTime * 0.03, uTime * 0.02);
          float foamSample = texture2D(uFoamTex, foamUv).r;
          float shoreFoam = shorelineContact * smoothstep(0.35, 0.75, foamSample);
          waterCol = mix(waterCol, vec3(0.95, 0.98, 1.0), shoreFoam * 0.65);

          // 8. Soft alpha feathering at outer boundary
          float alpha = smoothstep(0.03, 0.14, thickness);
          gl_FragColor = vec4(mix(bgCol.rgb, waterCol, alpha), 1.0);
        }
      `,
    });

    this.compositeScene = new THREE.Scene();
    this.compositeScene.add(new THREE.Mesh(fullscreenPlane, this.compositeMat));

    // --- Legacy Particle Points Mode (for raw SPH debugging) ---
    this.pointsGeo = new THREE.BufferGeometry();
    this.pointsGeo.setAttribute("position", new THREE.BufferAttribute(physics.pos, 3));
    this.pointsGeo.setAttribute("velocity", new THREE.BufferAttribute(physics.vel, 3));

    this.pointsMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x38bdf8) },
        uRadius: { value: physics.params.particleRadius * 160.0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 velocity;
        varying vec3 vVel;
        varying float vSpeed;
        uniform float uRadius;

        void main() {
          vVel = velocity;
          vSpeed = length(velocity);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uRadius / -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vVel;
        varying float vSpeed;
        uniform vec3 uColor;

        void main() {
          vec2 coord = gl_PointCoord - vec2(0.5);
          float dist2 = dot(coord, coord);
          if (dist2 > 0.25) discard;

          float normalZ = sqrt(max(0.25 - dist2, 0.0)) * 2.0;
          vec3 N = normalize(vec3(coord * 2.0, normalZ));
          vec3 L = normalize(vec3(0.5, 0.8, 0.4));
          float NdotL = max(dot(N, L), 0.0);
          float spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 32.0);

          vec3 baseColor = mix(vec3(0.05, 0.35, 0.85), vec3(0.35, 0.85, 1.0), clamp(vSpeed * 0.1, 0.0, 1.0));
          vec3 finalColor = baseColor * (0.3 + 0.7 * NdotL) + vec3(1.0) * spec;

          gl_FragColor = vec4(finalColor, 0.95);
        }
      `,
      transparent: true,
      depthWrite: true,
    });

    this.pointsMesh = new THREE.Points(this.pointsGeo, this.pointsMat);
    this.pointsMesh.visible = false;
    scene.add(this.pointsMesh);

    this.setMode(this.mode);
  }

  setMode(mode: RenderMode) {
    this.mode = mode;
    if (mode === "fluid") {
      this.pointsMesh.visible = false;
    } else {
      this.pointsMesh.visible = true;
    }
  }

  update() {
    const count = this.physics.activeParticles;

    // Fast GPU attribute update (zero matrix computation on CPU!)
    this.posAttr.needsUpdate = true;
    this.velAttr.needsUpdate = true;
    this.densityAttr.needsUpdate = true;
    this.particleGeo.instanceCount = count;

    if (this.mode === "particles") {
      const posAttr = this.pointsGeo.getAttribute("position") as THREE.BufferAttribute;
      const velAttr = this.pointsGeo.getAttribute("velocity") as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
      velAttr.needsUpdate = true;
      this.pointsGeo.setDrawRange(0, count);
    }
  }

  render(cam: THREE.PerspectiveCamera, sunWorldDir?: THREE.Vector3) {
    const count = this.physics.activeParticles;

    if (this.mode === "particles" || count <= 0) {
      // Direct pass for particle points or when empty
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, cam);
      return;
    }

    const tx = 1.0 / this.targetW;
    const ty = 1.0 / this.targetH;

    // Pass 1: Render background world into scene target with hardware depth
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(this.scene, cam);

    // Pass 2: Render fluid particle depth buffer (view-space linear Z with Wendland kernel)
    this.renderer.setRenderTarget(this.fluidDepthTarget);
    this.renderer.clear();
    this.particleQuadMesh.material = this.particleDepthMat;
    this.renderer.render(this.fluidScene, cam);

    // Pass 3: Render fluid optical thickness buffer (additive accumulation)
    this.renderer.setRenderTarget(this.fluidThicknessTarget);
    this.renderer.clear();
    this.particleQuadMesh.material = this.particleThicknessMat;
    this.renderer.render(this.fluidScene, cam);

    // Pass 4: 6-Pass Multi-Scale Hierarchical Bilateral Depth Blur (covers 75+ screen pixels)
    // Pass 4a: Horizontal Step 1.0 (from fluidDepthTarget to tempBlur1)
    this.blurMat.uniforms.uDepthTex.value = this.fluidDepthTarget.texture;
    this.blurMat.uniforms.uStep.value.set(tx * 1.0, 0);
    this.renderer.setRenderTarget(this.tempBlur1);
    this.renderer.clear();
    this.renderer.render(this.blurScene, this.postCam);

    // Pass 4b: Vertical Step 1.0 (from tempBlur1 to tempBlur2)
    this.blurMat.uniforms.uDepthTex.value = this.tempBlur1.texture;
    this.blurMat.uniforms.uStep.value.set(0, ty * 1.0);
    this.renderer.setRenderTarget(this.tempBlur2);
    this.renderer.clear();
    this.renderer.render(this.blurScene, this.postCam);

    // Pass 4c: Horizontal Step 2.5 (from tempBlur2 to tempBlur1)
    this.blurMat.uniforms.uDepthTex.value = this.tempBlur2.texture;
    this.blurMat.uniforms.uStep.value.set(tx * 2.5, 0);
    this.renderer.setRenderTarget(this.tempBlur1);
    this.renderer.clear();
    this.renderer.render(this.blurScene, this.postCam);

    // Pass 4d: Vertical Step 2.5 (from tempBlur1 to tempBlur2)
    this.blurMat.uniforms.uDepthTex.value = this.tempBlur1.texture;
    this.blurMat.uniforms.uStep.value.set(0, ty * 2.5);
    this.renderer.setRenderTarget(this.tempBlur2);
    this.renderer.clear();
    this.renderer.render(this.blurScene, this.postCam);

    // Pass 4e: Horizontal Step 5.0 (from tempBlur2 to tempBlur1)
    this.blurMat.uniforms.uDepthTex.value = this.tempBlur2.texture;
    this.blurMat.uniforms.uStep.value.set(tx * 5.0, 0);
    this.renderer.setRenderTarget(this.tempBlur1);
    this.renderer.clear();
    this.renderer.render(this.blurScene, this.postCam);

    // Pass 4f: Vertical Step 5.0 (from tempBlur1 into smoothedDepthTarget)
    this.blurMat.uniforms.uDepthTex.value = this.tempBlur1.texture;
    this.blurMat.uniforms.uStep.value.set(0, ty * 5.0);
    this.renderer.setRenderTarget(this.smoothedDepthTarget);
    this.renderer.clear();
    this.renderer.render(this.blurScene, this.postCam);

    // Pass 5: Fullscreen Composite SSFR Shading to Canvas
    this.compositeMat.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
    this.compositeMat.uniforms.uInvView.value.copy(cam.matrixWorld);
    this.compositeMat.uniforms.uViewMatrix.value.copy(cam.matrixWorldInverse);
    this.compositeMat.uniforms.uCameraNear.value = cam.near;
    this.compositeMat.uniforms.uCameraFar.value = cam.far;
    this.compositeMat.uniforms.uTime.value = performance.now() * 0.001;

    // Transform sun direction to view space
    const sunDir = sunWorldDir || new THREE.Vector3(0.5, 0.8, 0.4);
    const viewSun = sunDir.clone().transformDirection(cam.matrixWorldInverse).normalize();
    this.compositeMat.uniforms.uViewSunDir.value.copy(viewSun);

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.postCam);
  }

  resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    this.targetW = w;
    this.targetH = h;

    this.sceneTarget.setSize(w, h);
    this.fluidDepthTarget.setSize(w, h);
    this.fluidThicknessTarget.setSize(w, h);
    this.tempBlur1.setSize(w, h);
    this.tempBlur2.setSize(w, h);
    this.smoothedDepthTarget.setSize(w, h);

    const ts = new THREE.Vector2(1 / w, 1 / h);
    this.compositeMat.uniforms.uTexelSize.value.copy(ts);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.fluidDepthTarget.dispose();
    this.fluidThicknessTarget.dispose();
    this.tempBlur1.dispose();
    this.tempBlur2.dispose();
    this.smoothedDepthTarget.dispose();

    this.particleGeo.dispose();
    this.particleDepthMat.dispose();
    this.particleThicknessMat.dispose();

    this.blurMat.dispose();
    this.compositeMat.dispose();

    this.waterNormalMap.dispose();
    this.foamTex.dispose();

    this.pointsGeo.dispose();
    this.pointsMat.dispose();
  }
}
