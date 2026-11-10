import * as THREE from "three";

export class StreamCaustics {
  readonly renderer: THREE.WebGLRenderer;
  readonly target: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private causticsMat: THREE.ShaderMaterial;

  intensity = 3.0;

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  constructor(renderer: THREE.WebGLRenderer, size = 3.0, res = 512) {
    this.renderer = renderer;

    this.target = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });

    this.causticsMat = new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: null },
        uTerrain: { value: null },
        uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        uSize: { value: size },
        uIntensity: { value: this.intensity },
        uDx: { value: size / res },
        uRes: { value: res },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uState;
        uniform sampler2D uTerrain;
        uniform vec3 uSunDir;
        uniform float uSize;
        uniform float uIntensity;
        uniform float uDx;
        uniform float uRes;
        varying vec2 vUv;

        void main() {
          vec2 texel = 1.0 / vec2(uRes);
          vec4 stateC = texture2D(uState, vUv);
          vec4 stateR = texture2D(uState, vUv + vec2(texel.x, 0.0));
          vec4 stateL = texture2D(uState, vUv - vec2(texel.x, 0.0));
          vec4 stateT = texture2D(uState, vUv + vec2(0.0, texel.y));
          vec4 stateB = texture2D(uState, vUv - vec2(0.0, texel.y));

          float h = stateC.r;
          if (h < 0.003) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          // Water surface normals from eta gradients
          float deta_dx = (stateR.a - stateL.a) / (2.0 * uDx);
          float deta_dz = (stateT.a - stateB.a) / (2.0 * uDx);
          vec3 n = normalize(vec3(-deta_dx, 1.0, -deta_dz));

          // Snell refraction of incident sunlight ray
          // Water IOR = 1.333 -> eta = 1.0 / 1.333 = 0.75
          vec3 lightRay = -normalize(uSunDir);
          vec3 refrRay = refract(lightRay, n, 0.75);

          // Ray displacement onto riverbed
          float depth = h;
          vec2 bedOffset = (refrRay.xz / max(-refrRay.y, 0.05)) * depth;
          vec2 refractedUv = vUv + bedOffset / uSize;

          // Curvature / convergence (Jacobian determinant approximation)
          float laplacian = (stateR.a + stateL.a + stateT.a + stateB.a - 4.0 * stateC.a) / (uDx * uDx);
          // Converging rays (positive laplacian) focus light into bright bands
          float caustic = max(1.0 + laplacian * depth * 2.5, 0.0);
          caustic = pow(caustic, 2.0) * uIntensity;

          // Fade out near dry shores
          caustic *= smoothstep(0.003, 0.02, h);

          gl_FragColor = vec4(vec3(caustic), 1.0);
        }
      `,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.causticsMat);
    this.quadScene.add(quad);
  }

  update(stateTex: THREE.Texture, terrainTex: THREE.Texture, sunDir: THREE.Vector3) {
    this.causticsMat.uniforms.uState.value = stateTex;
    this.causticsMat.uniforms.uTerrain.value = terrainTex;
    this.causticsMat.uniforms.uSunDir.value.copy(sunDir);
    this.causticsMat.uniforms.uIntensity.value = this.intensity;

    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.setRenderTarget(null);
  }
}
