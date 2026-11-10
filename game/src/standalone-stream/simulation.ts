import * as THREE from "three";

export interface SimParams {
  size: number;
  res: number;
  inflowSpeed: number;
  inflowDepth: number;
  drag: number;
  gravity: number;
  foamGen: number;
  foamDiv: number;
  foamDecay: number;
  rippleTau: number;
}

const DEFAULT_PARAMS: SimParams = {
  size: 3.0,
  res: 256,
  inflowSpeed: 0.60,
  inflowDepth: 0.10,
  drag: 0.05,
  gravity: 9.81,
  foamGen: 2.0,
  foamDiv: 15.0,
  foamDecay: 1.0,
  rippleTau: 0.8,
};

// Fullscreen quad utility for GPGPU passes
class FullscreenPass {
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private scene = new THREE.Scene();
  private mesh: THREE.Mesh;

  constructor(material: THREE.ShaderMaterial) {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, material);
    this.scene.add(this.mesh);
  }

  setMaterial(mat: THREE.ShaderMaterial) {
    this.mesh.material = mat;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
}

export class StreamSimulation {
  readonly renderer: THREE.WebGLRenderer;
  readonly params: SimParams;
  readonly res: number;
  readonly size: number;
  readonly dx: number;
  readonly min: number;

  private readStateIdx = 0;
  private stateTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private auxTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readAuxIdx = 0;
  private uvTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readUVIdx = 0;

  readonly terrainTarget: THREE.WebGLRenderTarget;

  private advectMat: THREE.ShaderMaterial;
  private heightMat: THREE.ShaderMaterial;
  private velocityMat: THREE.ShaderMaterial;
  private auxMat: THREE.ShaderMaterial;
  private pass: FullscreenPass;

  private simTime = 0;

  get texState(): THREE.Texture {
    return this.stateTargets[this.readStateIdx].texture;
  }

  get texAux(): THREE.Texture {
    return this.auxTargets[this.readAuxIdx].texture;
  }

  get texUV(): THREE.Texture {
    return this.uvTargets[this.readUVIdx].texture;
  }

  get terrainTexture(): THREE.Texture {
    return this.terrainTarget.texture;
  }

  constructor(renderer: THREE.WebGLRenderer, options: Partial<SimParams> = {}) {
    this.renderer = renderer;
    this.params = { ...DEFAULT_PARAMS, ...options };
    this.res = this.params.res;
    this.size = this.params.size;
    this.dx = this.size / this.res;
    this.min = -this.size / 2;

    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    };

    // Ping-pong targets for State: (r: height, g: u_vel, b: v_vel, a: eta = h + bed)
    this.stateTargets = [
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
    ];

    // Ping-pong targets for Aux: (r: foam, g: wetness, b: rippleStrength, a: restBed)
    this.auxTargets = [
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
    ];

    // Ping-pong targets for Flow UVs: (xy: uv0, zw: uv1)
    this.uvTargets = [
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
    ];

    // Terrain target: (r: bed height, g: normal.x, b: normal.z, a: obstacle)
    this.terrainTarget = new THREE.WebGLRenderTarget(this.res, this.res, {
      ...rtOpts,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    // Setup GPGPU Shaders
    this.advectMat = this.createAdvectMaterial();
    this.heightMat = this.createHeightMaterial();
    this.velocityMat = this.createVelocityMaterial();
    this.auxMat = this.createAuxMaterial();

    this.pass = new FullscreenPass(this.advectMat);

    this.reset();
  }

  private createAdvectMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: null },
        uTerrain: { value: null },
        uDt: { value: 0.002 },
        uDx: { value: this.dx },
        uRes: { value: this.res },
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
        uniform float uDt;
        uniform float uDx;
        uniform float uRes;
        varying vec2 vUv;

        vec4 sampleBilin(sampler2D tex, vec2 uv) {
          vec2 pos = uv * uRes - 0.5;
          vec2 f = fract(pos);
          vec2 i = (floor(pos) + 0.5) / uRes;
          vec2 d = 1.0 / vec2(uRes);
          vec4 c00 = texture2D(tex, i);
          vec4 c10 = texture2D(tex, i + vec2(d.x, 0.0));
          vec4 c01 = texture2D(tex, i + vec2(0.0, d.y));
          vec4 c11 = texture2D(tex, i + d);
          return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
        }

        void main() {
          vec2 texel = 1.0 / vec2(uRes);
          vec4 center = texture2D(uState, vUv);
          vec4 right  = texture2D(uState, vUv + vec2(texel.x, 0.0));
          vec4 top    = texture2D(uState, vUv + vec2(0.0, texel.y));
          vec4 bot    = texture2D(uState, vUv - vec2(0.0, texel.y));
          vec4 left   = texture2D(uState, vUv - vec2(texel.x, 0.0));

          // Velocity at staggered face u: (u, average v)
          float u_avg_v = (center.b + right.b + bot.b + (vUv.x + texel.x < 1.0 ? texture2D(uState, vUv + vec2(texel.x, -texel.y)).b : bot.b)) * 0.25;
          vec2 vel_u = vec2(center.g, u_avg_v);
          vec2 back_u = vUv - vel_u * (uDt / (uDx * uRes));
          float adv_u = sampleBilin(uState, back_u).g;

          // Velocity at staggered face v: (average u, v)
          float v_avg_u = (center.g + left.g + top.g + (vUv.y + texel.y < 1.0 ? texture2D(uState, vUv + vec2(-texel.x, texel.y)).g : left.g)) * 0.25;
          vec2 vel_v = vec2(v_avg_u, center.b);
          vec2 back_v = vUv - vel_v * (uDt / (uDx * uRes));
          float adv_v = sampleBilin(uState, back_v).b;

          // Obstacle check: if neighbor is dry or solid wall, cancel flux
          vec4 bedC = texture2D(uTerrain, vUv);
          vec4 bedR = texture2D(uTerrain, vUv + vec2(texel.x, 0.0));
          vec4 bedT = texture2D(uTerrain, vUv + vec2(0.0, texel.y));

          float hThreshold = 1e-4 * uDx;
          if (center.r <= hThreshold && bedC.r > right.a) adv_u = 0.0;
          if (right.r <= hThreshold && bedR.r > center.a) adv_u = 0.0;
          if (center.r <= hThreshold && bedC.r > top.a)   adv_v = 0.0;
          if (top.r <= hThreshold && bedT.r > center.a)   adv_v = 0.0;

          gl_FragColor = vec4(center.r, adv_u, adv_v, center.a);
        }
      `,
    });
  }

  private createHeightMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: null },
        uTerrain: { value: null },
        uDt: { value: 0.002 },
        uDx: { value: this.dx },
        uRes: { value: this.res },
        uInflowDepth: { value: DEFAULT_PARAMS.inflowDepth },
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
        uniform float uDt;
        uniform float uDx;
        uniform float uRes;
        uniform float uInflowDepth;
        varying vec2 vUv;

        void main() {
          vec2 texel = 1.0 / vec2(uRes);
          vec4 center = texture2D(uState, vUv);
          vec4 right  = texture2D(uState, vUv + vec2(texel.x, 0.0));
          vec4 left   = texture2D(uState, vUv - vec2(texel.x, 0.0));
          vec4 top    = texture2D(uState, vUv + vec2(0.0, texel.y));
          vec4 bot    = texture2D(uState, vUv - vec2(0.0, texel.y));
          vec4 bed    = texture2D(uTerrain, vUv);

          // Upwind staggered mass fluxes
          float u_right = center.g;
          float u_left  = left.g;
          float v_top   = center.b;
          float v_bot   = bot.b;

          float h_u_right = u_right > 0.0 ? center.r : right.r;
          float h_u_left  = u_left  > 0.0 ? left.r   : center.r;
          float h_v_top   = v_top   > 0.0 ? center.r : top.r;
          float h_v_bot   = v_bot   > 0.0 ? bot.r    : center.r;

          float flux_div = ((h_u_right * u_right - h_u_left * u_left) +
                            (h_v_top * v_top - h_v_bot * v_bot)) / uDx;

          float new_h = max(center.r - flux_div * uDt, 0.0);

          // Inflow boundary condition on left (vUv.x < 3.0 / uRes)
          if (vUv.x < 3.0 / uRes) {
            new_h = uInflowDepth;
          }

          // Sponge layer damping on right boundary (vUv.x > 0.92)
          if (vUv.x > 0.92) {
            float sponge = (vUv.x - 0.92) / 0.08;
            float target_h = max(-0.02 * (vUv.x * 3.0 - 1.5) + uInflowDepth * 0.8 - bed.r, 0.0);
            new_h = mix(new_h, target_h, sponge * 0.15);
          }

          gl_FragColor = vec4(new_h, center.g, center.b, bed.r + new_h);
        }
      `,
    });
  }

  private createVelocityMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: null },
        uTerrain: { value: null },
        uDt: { value: 0.002 },
        uDx: { value: this.dx },
        uRes: { value: this.res },
        uGravity: { value: DEFAULT_PARAMS.gravity },
        uDrag: { value: DEFAULT_PARAMS.drag },
        uInflowSpeed: { value: DEFAULT_PARAMS.inflowSpeed },
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
        uniform float uDt;
        uniform float uDx;
        uniform float uRes;
        uniform float uGravity;
        uniform float uDrag;
        uniform float uInflowSpeed;
        varying vec2 vUv;

        void main() {
          vec2 texel = 1.0 / vec2(uRes);
          vec4 center = texture2D(uState, vUv);
          vec4 right  = texture2D(uState, vUv + vec2(texel.x, 0.0));
          vec4 top    = texture2D(uState, vUv + vec2(0.0, texel.y));

          // Gravity pressure gradient: g * d(eta)/dx, g * d(eta)/dy
          float deta_dx = (right.a - center.a) / uDx;
          float deta_dy = (top.a - center.a) / uDx;

          float u = center.g - uGravity * deta_dx * uDt;
          float v = center.b - uGravity * deta_dy * uDt;

          // Quadratic bottom friction / drag
          float h_u = max((center.r + right.r) * 0.5, 0.005);
          float h_v = max((center.r + top.r) * 0.5, 0.005);
          u /= (1.0 + uDrag * uDt * abs(u) / h_u);
          v /= (1.0 + uDrag * uDt * abs(v) / h_v);

          // Inflow boundary
          if (vUv.x < 3.0 / uRes) {
            u = uInflowSpeed;
            v = 0.0;
          }

          // Sponge layer on right
          if (vUv.x > 0.92) {
            float sponge = (vUv.x - 0.92) / 0.08;
            u = mix(u, uInflowSpeed * 0.8, sponge * 0.1);
            v = mix(v, 0.0, sponge * 0.1);
          }

          // Kill velocity if water is essentially dry
          if (center.r < 1e-4 * uDx) {
            u = 0.0;
            v = 0.0;
          }

          gl_FragColor = vec4(center.r, u, v, center.a);
        }
      `,
    });
  }

  private createAuxMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: null },
        uPrevAux: { value: null },
        uPrevUV: { value: null },
        uTerrain: { value: null },
        uDt: { value: 0.002 },
        uDx: { value: this.dx },
        uRes: { value: this.res },
        uFoamGen: { value: DEFAULT_PARAMS.foamGen },
        uFoamDiv: { value: DEFAULT_PARAMS.foamDiv },
        uFoamDecay: { value: DEFAULT_PARAMS.foamDecay },
        uTime: { value: 0.0 },
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
        uniform sampler2D uPrevAux;
        uniform sampler2D uPrevUV;
        uniform sampler2D uTerrain;
        uniform float uDt;
        uniform float uDx;
        uniform float uRes;
        uniform float uFoamGen;
        uniform float uFoamDiv;
        uniform float uFoamDecay;
        uniform float uTime;
        varying vec2 vUv;

        void main() {
          vec2 texel = 1.0 / vec2(uRes);
          vec4 stateC = texture2D(uState, vUv);
          vec4 stateL = texture2D(uState, vUv - vec2(texel.x, 0.0));
          vec4 stateB = texture2D(uState, vUv - vec2(0.0, texel.y));
          vec4 prevAux = texture2D(uPrevAux, vUv);

          // Divergence: du/dx + dv/dy
          float div = ((stateC.g - stateL.g) + (stateC.b - stateB.b)) / uDx;

          // Velocity magnitude & Froude number
          vec2 vel = vec2(stateC.g + stateL.g, stateC.b + stateB.b) * 0.5;
          float speed = length(vel);
          float froude = speed / sqrt(max(stateC.r * 9.81, 1e-4));

          // Aerated foam source: negative divergence (hydraulic jump / collision with boulder) + high Froude
          float foamSource = max(-div * uFoamDiv, 0.0) * smoothstep(0.05, 0.25, speed);
          if (froude > 1.0) {
            foamSource += (froude - 1.0) * uFoamGen;
          }

          // Advect existing foam backwards
          vec2 backUv = vUv - vel * (uDt / (uDx * uRes));
          float advectedFoam = texture2D(uPrevAux, backUv).r;
          float newFoam = clamp(advectedFoam * (1.0 - uFoamDecay * uDt) + foamSource * uDt, 0.0, 1.0);

          // Wetness: instant 1.0 when submerged, slow decay when dry
          float targetWet = stateC.r > 0.002 ? 1.0 : 0.0;
          float newWet = targetWet > 0.5 ? 1.0 : max(prevAux.g - 0.03 * uDt, 0.0);

          // Turbulence / ripple modulation
          float turbulence = smoothstep(0.1, 0.8, speed) * smoothstep(0.01, 0.08, stateC.r);

          gl_FragColor = vec4(newFoam, newWet, turbulence, stateC.a);
        }
      `,
    });
  }

  bakeTerrainFromBed(bedFn: (x: number, z: number) => number, boulders: Array<{ x: number; z: number; r: number; h: number }>) {
    const data = new Float32Array(this.res * this.res * 4);
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = this.min + (i + 0.5) * this.dx;
        const z = this.min + (j + 0.5) * this.dx;

        let y = bedFn(x, z);

        // Boulders collision / height
        for (const b of boulders) {
          const dx = x - b.x;
          const dz = z - b.z;
          const dist2 = dx * dx + dz * dz;
          if (dist2 < b.r * b.r) {
            const hRock = Math.sqrt(Math.max(b.r * b.r - dist2, 0.0)) * (b.h / b.r);
            y = Math.max(y, b.h * 0.4 + hRock);
          }
        }

        const idx = (j * this.res + i) * 4;
        data[idx] = y;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 1.0;
      }
    }

    const tex = new THREE.DataTexture(data, this.res, this.res, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;

    // Render into terrainTarget
    const quadMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; uniform sampler2D uTex; varying vec2 vUv; void main() { gl_FragColor = texture2D(uTex, vUv); }`,
    });
    this.pass.setMaterial(quadMat);
    this.pass.render(this.renderer, this.terrainTarget);
    quadMat.dispose();
    tex.dispose();
  }

  reset() {
    this.simTime = 0;
    const initialData = new Float32Array(this.res * this.res * 4);
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = this.min + (i + 0.5) * this.dx;
        const idx = (j * this.res + i) * 4;
        // Rest water depth
        const bedApprox = -0.02 * x - 0.028;
        const h = Math.max(this.params.inflowDepth - 0.015 * (x + 1.5), 0.01);
        initialData[idx] = h;
        initialData[idx + 1] = this.params.inflowSpeed; // initial downstream velocity
        initialData[idx + 2] = 0.0;
        initialData[idx + 3] = bedApprox + h;
      }
    }

    const initTex = new THREE.DataTexture(initialData, this.res, this.res, THREE.RGBAFormat, THREE.FloatType);
    initTex.needsUpdate = true;

    const copyMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: initTex } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; uniform sampler2D uTex; varying vec2 vUv; void main() { gl_FragColor = texture2D(uTex, vUv); }`,
    });

    this.pass.setMaterial(copyMat);
    this.pass.render(this.renderer, this.stateTargets[0]);
    this.pass.render(this.renderer, this.stateTargets[1]);

    // Clear aux
    this.renderer.setRenderTarget(this.auxTargets[0]);
    this.renderer.clearColor();
    this.renderer.setRenderTarget(this.auxTargets[1]);
    this.renderer.clearColor();

    copyMat.dispose();
    initTex.dispose();
  }

  step(dt: number) {
    const substeps = 4;
    const subDt = Math.min(dt / substeps, 0.003);

    for (let s = 0; s < substeps; s++) {
      this.simTime += subDt;

      // 1. Advection Pass: read from readStateIdx, write to 1 - readStateIdx
      const readIdx = this.readStateIdx;
      const writeIdx = 1 - readIdx;

      this.advectMat.uniforms.uState.value = this.stateTargets[readIdx].texture;
      this.advectMat.uniforms.uTerrain.value = this.terrainTarget.texture;
      this.advectMat.uniforms.uDt.value = subDt;
      this.pass.setMaterial(this.advectMat);
      this.pass.render(this.renderer, this.stateTargets[writeIdx]);

      // 2. Height Pass: read from writeIdx, write to readIdx
      this.heightMat.uniforms.uState.value = this.stateTargets[writeIdx].texture;
      this.heightMat.uniforms.uTerrain.value = this.terrainTarget.texture;
      this.heightMat.uniforms.uDt.value = subDt;
      this.heightMat.uniforms.uInflowDepth.value = this.params.inflowDepth;
      this.pass.setMaterial(this.heightMat);
      this.pass.render(this.renderer, this.stateTargets[readIdx]);

      // 3. Velocity Pass: read from readIdx, write to writeIdx
      this.velocityMat.uniforms.uState.value = this.stateTargets[readIdx].texture;
      this.velocityMat.uniforms.uTerrain.value = this.terrainTarget.texture;
      this.velocityMat.uniforms.uDt.value = subDt;
      this.velocityMat.uniforms.uGravity.value = this.params.gravity;
      this.velocityMat.uniforms.uDrag.value = this.params.drag;
      this.velocityMat.uniforms.uInflowSpeed.value = this.params.inflowSpeed;
      this.pass.setMaterial(this.velocityMat);
      this.pass.render(this.renderer, this.stateTargets[writeIdx]);

      this.readStateIdx = writeIdx;
    }

    // 4. Auxiliary Pass: Foam & Wetness
    const prevAuxIdx = this.readAuxIdx;
    const nextAuxIdx = 1 - prevAuxIdx;
    this.auxMat.uniforms.uState.value = this.texState;
    this.auxMat.uniforms.uPrevAux.value = this.auxTargets[prevAuxIdx].texture;
    this.auxMat.uniforms.uTerrain.value = this.terrainTarget.texture;
    this.auxMat.uniforms.uDt.value = dt;
    this.auxMat.uniforms.uFoamGen.value = this.params.foamGen;
    this.auxMat.uniforms.uFoamDiv.value = this.params.foamDiv;
    this.auxMat.uniforms.uFoamDecay.value = this.params.foamDecay;
    this.auxMat.uniforms.uTime.value = this.simTime;
    this.pass.setMaterial(this.auxMat);
    this.pass.render(this.renderer, this.auxTargets[nextAuxIdx]);
    this.readAuxIdx = nextAuxIdx;

    this.renderer.setRenderTarget(null);
  }
}
