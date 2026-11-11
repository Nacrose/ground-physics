import * as THREE from "three";
import { SphPhysics } from "./sphPhysics";

export type RenderMode = "fluid" | "particles";

/**
 * 🌊 High-Fidelity Screen Space Fluid Renderer (SSFR)
 *
 * Transforms discrete 3D SPH particles into a seamless, continuous,
 * glass-like liquid surface with realistic meniscus, caustics,
 * Beer-Lambert light absorption, Fresnel reflection, and white-water foam.
 *
 * Pipeline:
 *  1. Scene Color & Depth Pre-Pass (records terrain, boulders, sky)
 *  2. Fluid Depth Rasterization (view-space billboard sphere mathematics)
 *  3. Fluid Thickness Pass (additive optical absorption volume)
 *  4. 2-Pass Separable Bilateral Depth-Aware Smoothing (melts particles together without blurring edges)
 *  5. Fullscreen Composite Shader (normal reconstruction, refraction, Beer-Lambert, Fresnel, sun glints, foam)
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
  private tempBlurTarget: THREE.WebGLRenderTarget;
  private smoothedDepthTarget: THREE.WebGLRenderTarget;

  // --- Particle Instanced Quads for Depth & Thickness ---
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
  private blurQuadMesh: THREE.Mesh;
  private blurHMat: THREE.ShaderMaterial;
  private blurVMat: THREE.ShaderMaterial;
  private blurHScene: THREE.Scene;
  private blurVScene: THREE.Scene;

  private compositeQuadMesh: THREE.Mesh;
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

    const max = physics.maxParticles;

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

    // 4. Temporary Target for Horizontal Bilateral Blur
    this.tempBlurTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
    });

    // 5. Smoothed Depth Target (Bilateral Blur Output)
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

    // Particle Visual Radius (tuned for seamless isosurface fusion)
    const fluidVisualRadius = physics.params.particleRadius * 1.85;

    // --- Particle Depth Shader ---
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
        varying vec3 vVelocity;

        void main() {
          vUv = uv;
          vVelocity = aInstanceVel;
          vec4 viewCenter = modelViewMatrix * vec4(aInstancePos, 1.0);
          vViewCenter = viewCenter.xyz;

          // Camera-facing billboard quad in view space
          vec3 viewPos = viewCenter.xyz + vec3((uv - 0.5) * (uRadius * 2.2), 0.0);
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

          // Spherical depth displacement in view space
          float zOffset = sqrt(1.0 - r2) * uRadius;
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
          vec3 viewPos = viewCenter.xyz + vec3((uv - 0.5) * (uRadius * 2.2), 0.0);
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

          // Chord thickness through particle sphere
          float thickness = sqrt(1.0 - r2) * uRadius * 1.8;
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

    // --- Bilateral Depth Smoothing Shaders (Separable 2-Pass) ---
    const blurVertexShader = /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `;

    const blurFragmentShader = (isVertical: boolean) => /* glsl */ `
      uniform sampler2D uDepthTex;
      uniform vec2 uTexelSize;
      varying vec2 vUv;

      void main() {
        float centerZ = texture2D(uDepthTex, vUv).r;
        if (centerZ <= 0.001) {
          gl_FragColor = vec4(0.0);
          return;
        }

        float sum = 0.0;
        float totalW = 0.0;
        vec2 dir = ${isVertical ? "vec2(0.0, 1.0)" : "vec2(1.0, 0.0)"};

        // 9-tap 1D bilateral kernel (R = 4)
        const int R = 4;
        for (int i = -R; i <= R; i++) {
          vec2 off = dir * float(i) * uTexelSize * 1.25;
          float sampleZ = texture2D(uDepthTex, vUv + off).r;
          if (sampleZ > 0.001) {
            float dist2 = float(i * i);
            float spatialW = exp(-dist2 / 8.0);
            float depthDiff = abs(sampleZ - centerZ);
            // Silhouette edge preservation (discontinuity threshold)
            float depthW = exp(-depthDiff * depthDiff / 0.16);
            float w = spatialW * depthW;
            sum += sampleZ * w;
            totalW += w;
          }
        }

        float res = totalW > 0.0 ? sum / totalW : centerZ;
        gl_FragColor = vec4(res, 0.0, 0.0, 1.0);
      }
    `;

    this.blurHMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uDepthTex: { value: this.fluidDepthTarget.texture },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
      },
      vertexShader: blurVertexShader,
      fragmentShader: blurFragmentShader(false),
    });

    this.blurVMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uDepthTex: { value: this.tempBlurTarget.texture },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
      },
      vertexShader: blurVertexShader,
      fragmentShader: blurFragmentShader(true),
    });

    this.blurHScene = new THREE.Scene();
    this.blurHScene.add(new THREE.Mesh(fullscreenPlane, this.blurHMat));

    this.blurVScene = new THREE.Scene();
    this.blurVScene.add(new THREE.Mesh(fullscreenPlane, this.blurVMat));

    // --- Fullscreen Composite SSFR Shader ---
    this.compositeMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSceneColor: { value: this.sceneTarget.texture },
        uSceneDepth: { value: this.sceneTarget.depthTexture },
        uSmoothedDepth: { value: this.smoothedDepthTarget.texture },
        uThickness: { value: this.fluidThicknessTarget.texture },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
        uInvProj: { value: new THREE.Matrix4() },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 200.0 },
        uViewSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.4) },
        uSkyColor: { value: new THREE.Color(0x38bdf8) },
        uSunColor: { value: new THREE.Color(0xfff7ed) },
        uWaterDeepColor: { value: new THREE.Color(0x03497d) },
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
        uniform vec2 uTexelSize;
        uniform mat4 uInvProj;
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

          // Fluid occluded by solid scene geometry (e.g. terrain ridges, boulders)
          if (fluidZ > sceneZ - 0.02) {
            gl_FragColor = bgCol;
            return;
          }

          float thickness = texture2D(uThickness, vUv).r;
          if (thickness < 0.008) {
            gl_FragColor = bgCol;
            return;
          }

          // Reconstruct view-space surface position and normal from smoothed depth
          vec3 posC = reconstructViewPos(vUv, fluidZ);

          float zR = texture2D(uSmoothedDepth, vUv + vec2(uTexelSize.x, 0.0)).r;
          float zL = texture2D(uSmoothedDepth, vUv - vec2(uTexelSize.x, 0.0)).r;
          float zT = texture2D(uSmoothedDepth, vUv + vec2(0.0, uTexelSize.y)).r;
          float zB = texture2D(uSmoothedDepth, vUv - vec2(0.0, uTexelSize.y)).r;

          if (zR <= 0.001 || abs(zR - fluidZ) > 0.4) zR = fluidZ;
          if (zL <= 0.001 || abs(zL - fluidZ) > 0.4) zL = fluidZ;
          if (zT <= 0.001 || abs(zT - fluidZ) > 0.4) zT = fluidZ;
          if (zB <= 0.001 || abs(zB - fluidZ) > 0.4) zB = fluidZ;

          vec3 posR = reconstructViewPos(vUv + vec2(uTexelSize.x, 0.0), zR);
          vec3 posL = reconstructViewPos(vUv - vec2(uTexelSize.x, 0.0), zL);
          vec3 posT = reconstructViewPos(vUv + vec2(0.0, uTexelSize.y), zT);
          vec3 posB = reconstructViewPos(vUv - vec2(0.0, uTexelSize.y), zB);

          vec3 dX = posR - posL;
          vec3 dY = posT - posB;
          vec3 N = normalize(cross(dX, dY));
          if (N.z < 0.0) N = -N;

          // View vector in view space
          vec3 V = normalize(-posC);

          // Optical Screen-Space Refraction
          vec2 refrOffset = N.xy * 0.025 * clamp(thickness * 2.0, 0.0, 1.0);
          vec2 refrUv = vUv + refrOffset;
          float refrSceneZ = linearizeDepth(texture2D(uSceneDepth, refrUv).r);
          if (refrSceneZ < fluidZ) refrUv = vUv; // Reject foreground occlusion bleeding

          vec3 sceneSample = texture2D(uSceneColor, refrUv).rgb;

          // Beer-Lambert Light Absorption Law (Red light absorbs first -> Caribbean teal)
          vec3 absorption = vec3(1.35, 0.45, 0.16);
          vec3 transmission = exp(-absorption * thickness * 2.2);
          vec3 waterCol = sceneSample * transmission;

          // Gradient color tinting (turquoise shallow -> deep oceanic navy)
          vec3 waterTint = mix(uWaterShallowColor, uWaterDeepColor, smoothstep(0.05, 0.85, thickness));
          waterCol = mix(waterCol, waterTint, clamp(thickness * 0.85, 0.0, 0.82));

          // Schlick's Fresnel Reflection
          float R0 = 0.0204; // Index of Refraction n = 1.333 for water
          float cosTheta = max(dot(N, V), 0.0);
          float fresnel = R0 + (1.0 - R0) * pow(1.0 - cosTheta, 5.0);
          waterCol = mix(waterCol, uSkyColor * 1.12, fresnel * 0.72);

          // Sun Specular Highlight (Blinn-Phong)
          vec3 L = normalize(uViewSunDir);
          vec3 H = normalize(L + V);
          float NdotH = max(dot(N, H), 0.0);
          float spec = pow(NdotH, 96.0);
          waterCol += uSunColor * spec * 0.95;

          // Stylized contact edge foam and aeration
          float edgeFoam = smoothstep(0.12, 0.02, thickness) * smoothstep(0.005, 0.02, thickness);
          vec3 foamColor = vec3(0.95, 0.98, 1.0);
          waterCol = mix(waterCol, foamColor, edgeFoam * 0.45);

          gl_FragColor = vec4(waterCol, 1.0);
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

    // Pass 1: Render background world (terrain, sky, bottles, reticles) into scene target with depth texture
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(this.scene, cam);

    // Pass 2: Render fluid particle depth buffer (view-space linear Z)
    this.renderer.setRenderTarget(this.fluidDepthTarget);
    this.renderer.clear();
    this.particleQuadMesh.material = this.particleDepthMat;
    this.renderer.render(this.fluidScene, cam);

    // Pass 3: Render fluid optical thickness buffer (additive chord accumulation)
    this.renderer.setRenderTarget(this.fluidThicknessTarget);
    this.renderer.clear();
    this.particleQuadMesh.material = this.particleThicknessMat;
    this.renderer.render(this.fluidScene, cam);

    // Pass 4a: Horizontal Bilateral Depth Blur
    this.renderer.setRenderTarget(this.tempBlurTarget);
    this.renderer.clear();
    this.renderer.render(this.blurHScene, this.postCam);

    // Pass 4b: Vertical Bilateral Depth Blur -> Smoothed Depth Target
    this.renderer.setRenderTarget(this.smoothedDepthTarget);
    this.renderer.clear();
    this.renderer.render(this.blurVScene, this.postCam);

    // Pass 5: Fullscreen Composite SSFR Shading to Canvas
    // Update camera uniforms
    this.compositeMat.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
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
    this.tempBlurTarget.setSize(w, h);
    this.smoothedDepthTarget.setSize(w, h);

    const ts = new THREE.Vector2(1 / w, 1 / h);
    this.blurHMat.uniforms.uTexelSize.value.copy(ts);
    this.blurVMat.uniforms.uTexelSize.value.copy(ts);
    this.compositeMat.uniforms.uTexelSize.value.copy(ts);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.fluidDepthTarget.dispose();
    this.fluidThicknessTarget.dispose();
    this.tempBlurTarget.dispose();
    this.smoothedDepthTarget.dispose();

    this.particleGeo.dispose();
    this.particleDepthMat.dispose();
    this.particleThicknessMat.dispose();

    this.blurHMat.dispose();
    this.blurVMat.dispose();
    this.compositeMat.dispose();

    this.pointsGeo.dispose();
    this.pointsMat.dispose();
  }
}
