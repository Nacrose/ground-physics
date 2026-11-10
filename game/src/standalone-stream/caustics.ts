import * as THREE from "three";

/**
 * ☀️ Real-Time Ray-Refracted Caustics Generator
 * Recreates Evan Wallace & stream.mulualem.com's GPU Jacobian Caustics:
 *
 * 1. A mesh grid of light rays projects downward from the sun direction.
 * 2. Rays refract through the dynamic water surface normal (Snell's Law: IOR = 1.333).
 * 3. The ray intersection with the riverbed is calculated.
 * 4. Additive blending accumulates concentrated light rays into brilliant caustic webs.
 */

export interface CausticParams {
  strength: number;      // Caustic brightness multiplier (default 2.8)
  resolution: number;    // Caustic texture resolution (default 512 or 1024)
}

export class StreamCaustics {
  readonly resolution: number;
  params: CausticParams;

  private renderer: THREE.WebGLRenderer;
  private target: THREE.WebGLRenderTarget;
  private causticScene: THREE.Scene;
  private causticCamera: THREE.OrthographicCamera;
  private rayMesh: THREE.Mesh;
  private causticMat: THREE.ShaderMaterial;

  constructor(renderer: THREE.WebGLRenderer, size: number, gridRes: number, params?: Partial<CausticParams>) {
    this.renderer = renderer;
    this.resolution = params?.resolution ?? 512;
    this.params = {
      strength: params?.strength ?? 2.8,
      resolution: this.resolution,
    };

    // Render target for caustic intensity map
    this.target = new THREE.WebGLRenderTarget(this.resolution, this.resolution, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    this.causticScene = new THREE.Scene();
    this.causticCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Grid mesh: each vertex is a refracted light ray
    const rayGeo = new THREE.PlaneGeometry(size, size, gridRes, gridRes);
    rayGeo.rotateX(-Math.PI / 2);

    this.causticMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform sampler2D uStateTex;
        uniform sampler2D uBedTex;
        uniform vec3 uSunDir;
        uniform float uSize;
        varying float vOldArea;
        varying float vNewArea;

        const float IOR_AIR = 1.0;
        const float IOR_WATER = 1.333;

        void main() {
          vec2 uv = position.xz / uSize + 0.5;
          vec4 state = texture2D(uStateTex, uv);
          float h = state.r;
          float bed = state.a - h;
          float eta = state.a;

          // Standard flat sun ray direction
          vec3 sunRay = normalize(-uSunDir);
          
          // Reconstruct water surface normal from neighbor heights
          float delta = 1.0 / float(${gridRes.toFixed(1)});
          float hE = texture2D(uStateTex, uv + vec2(delta, 0.0)).a;
          float hW = texture2D(uStateTex, uv - vec2(delta, 0.0)).a;
          float hN = texture2D(uStateTex, uv + vec2(0.0, delta)).a;
          float hS = texture2D(uStateTex, uv - vec2(0.0, delta)).a;
          
          vec3 norm = normalize(vec3(-(hE - hW), 2.0 * (uSize * delta), -(hN - hS)));
          if (h < 0.005) norm = vec3(0.0, 1.0, 0.0);

          // Refracted ray vector (Snell's Law)
          vec3 refr = refract(sunRay, norm, IOR_AIR / IOR_WATER);
          if (length(refr) < 0.1) refr = sunRay;

          // Ray intersect bed plane
          float t = (bed - eta) / refr.y;
          vec3 hit = vec3(position.x, eta, position.z) + refr * t;

          // Clip space projection for caustic accumulation
          vec2 hitUv = hit.xz / uSize;
          gl_Position = vec4(hitUv * 2.0, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        void main() {
          // Additive focused light intensity
          gl_FragColor = vec4(vec3(0.25 * uStrength), 1.0);
        }
      `,
      uniforms: {
        uStateTex: { value: null },
        uBedTex: { value: null },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        uSize: { value: size },
        uStrength: { value: this.params.strength },
      },
    });

    this.rayMesh = new THREE.Mesh(rayGeo, this.causticMat);
    this.rayMesh.frustumCulled = false;
    this.causticScene.add(this.rayMesh);
  }

  update(stateTex: THREE.Texture, bedTex: THREE.Texture, sunDir: THREE.Vector3) {
    this.causticMat.uniforms.uStateTex.value = stateTex;
    this.causticMat.uniforms.uBedTex.value = bedTex;
    this.causticMat.uniforms.uSunDir.value.copy(sunDir);
    this.causticMat.uniforms.uStrength.value = this.params.strength;

    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.clearColor();
    this.renderer.render(this.causticScene, this.causticCamera);
    this.renderer.setRenderTarget(prevTarget);
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  dispose() {
    this.target.dispose();
    this.rayMesh.geometry.dispose();
    this.causticMat.dispose();
  }
}
