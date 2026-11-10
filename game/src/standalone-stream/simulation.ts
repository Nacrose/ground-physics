import * as THREE from "three";

/**
 * 🌊 2D Shallow Water Equations (SWE) GPU Simulation Engine
 * Recreates the hydrodynamic solver architecture from stream.mulualem.com:
 *
 * State Texture (RGBA Float):
 *   R: Water depth h [m]
 *   G: Velocity u (X axis) [m/s]
 *   B: Velocity v (Z axis) [m/s]
 *   A: Surface elevation eta = h + bed [m]
 *
 * Aux Texture (RGBA Float):
 *   R: Foam intensity [0..1]
 *   G: Obstacle / wetness mask [0 = obstacle, 1 = water channel]
 *   B: Flow speed ||u|| [m/s]
 *   A: Bed elevation bed [m]
 *
 * UV Texture (RGBA Float):
 *   RG: Flow-advected UV Phase 1
 *   BA: Flow-advected UV Phase 2
 */

export interface SimParams {
  res: number;            // Grid resolution (default 160)
  size: number;           // World domain size in meters (default 14m)
  inflowSpeed: number;    // Upstream river inflow speed (default 2.4 m/s)
  inflowDepth: number;    // Upstream water depth (default 0.35m)
  gravity: number;        // Gravitational acceleration (default 9.81 m/s^2)
  drag: number;           // Manning/bed quadratic drag (default 0.045)
  foamGen: number;        // Foam generation rate from compression (default 1.8)
  foamDecay: number;      // Foam exponential decay rate (default 0.85)
}

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class StreamSimulation {
  readonly res: number;
  readonly size: number;
  readonly dx: number;
  params: SimParams;

  private renderer: THREE.WebGLRenderer;
  private quadGeo: THREE.PlaneGeometry;
  private camera: THREE.OrthographicCamera;
  private scene: THREE.Scene;
  private quadMesh: THREE.Mesh;

  // Ping-pong render targets for state (h, u, v, eta)
  private stateTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private stateIdx = 0;

  // Ping-pong render targets for aux (foam, mask, speed, bed)
  private auxTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private auxIdx = 0;

  // Ping-pong render targets for flow-advected UVs
  private uvTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private uvIdx = 0;

  // Static bed height texture
  bedTexture: THREE.DataTexture;

  // Shader materials for compute passes
  private initMat: THREE.ShaderMaterial;
  private advectMat: THREE.ShaderMaterial;
  private heightMat: THREE.ShaderMaterial;
  private velocityMat: THREE.ShaderMaterial;
  private auxMat: THREE.ShaderMaterial;
  private obstacleMat: THREE.ShaderMaterial;

  // Animation & time tracking
  private simTime = 0;
  private uvTimer = 0;
  private resetPhase1 = 0;
  private resetPhase2 = 0;

  constructor(renderer: THREE.WebGLRenderer, params?: Partial<SimParams>) {
    this.renderer = renderer;
    this.res = params?.res ?? 160;
    this.size = params?.size ?? 14.0;
    this.dx = this.size / this.res;

    this.params = {
      res: this.res,
      size: this.size,
      inflowSpeed: params?.inflowSpeed ?? 2.4,
      inflowDepth: params?.inflowDepth ?? 0.38,
      gravity: params?.gravity ?? 9.81,
      drag: params?.drag ?? 0.042,
      foamGen: params?.foamGen ?? 2.2,
      foamDecay: params?.foamDecay ?? 0.82,
    };

    // Full-screen quad setup
    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quadMesh = new THREE.Mesh(this.quadGeo);
    this.scene.add(this.quadMesh);

    // Create 32-bit float render targets
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };

    this.stateTargets = [
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
    ];
    this.auxTargets = [
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
    ];
    this.uvTargets = [
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
      new THREE.WebGLRenderTarget(this.res, this.res, rtOpts),
    ];

    // Build initial rocky riverbed heightfield
    this.bedTexture = this.buildRiverbedTexture();

    // Compile simulation shader passes
    this.initMat = this.createInitShader();
    this.advectMat = this.createAdvectShader();
    this.heightMat = this.createHeightShader();
    this.velocityMat = this.createVelocityShader();
    this.auxMat = this.createAuxShader();
    this.obstacleMat = this.createObstacleShader();

    // Initialize state
    this.reset();
  }

  // -------------------------------------------------------------------------
  // RIVERBED GEOLOGY (Central scoured canyon, banks, and embedded boulders)
  // -------------------------------------------------------------------------
  private buildRiverbedTexture(): THREE.DataTexture {
    const data = new Float32Array(this.res * this.res * 4);
    for (let j = 0; j < this.res; j++) {
      const zNorm = j / (this.res - 1) - 0.5; // -0.5 .. +0.5 across channel
      const z = zNorm * this.size;
      for (let i = 0; i < this.res; i++) {
        const xNorm = i / (this.res - 1); // 0.0 upstream .. 1.0 downstream
        const x = xNorm * this.size;
        const k = (j * this.res + i) * 4;

        // Downhill slope (river flows from X=0 down to X=size)
        let bed = 0.85 * (1.0 - xNorm);

        // U-shaped canyon cross section: deeper in center, rising steep banks
        const chDist = Math.abs(z);
        const chHalfW = 3.8;
        const bankU = Math.min(chDist / chHalfW, 1.0);
        bed += Math.pow(bankU, 2.4) * 1.4;

        // Subtle rocky undulations and bedrock shelves
        bed += Math.sin(x * 1.8 + z * 0.9) * 0.08;
        bed += Math.sin(x * 3.4 - z * 2.1) * 0.04;

        // Add 3 prominent standing boulders in the stream
        // Boulder 1: Upstream center-left
        const d1 = Math.hypot(x - 3.8, z + 0.9);
        if (d1 < 1.1) bed += Math.cos(d1 * (Math.PI / 2 / 1.1)) * 0.52;

        // Boulder 2: Mid-stream center-right
        const d2 = Math.hypot(x - 7.5, z - 1.1);
        if (d2 < 1.3) bed += Math.cos(d2 * (Math.PI / 2 / 1.3)) * 0.65;

        // Boulder 3: Downstream rapids constriction
        const d3 = Math.hypot(x - 10.6, z + 0.4);
        if (d3 < 1.2) bed += Math.cos(d3 * (Math.PI / 2 / 1.2)) * 0.58;

        data[k] = bed;      // R: bed elevation
        data[k + 1] = 0;    // G: rockiness / hardness
        data[k + 2] = 0;    // B: reserved
        data[k + 3] = 1;    // A: 1.0
      }
    }

    const tex = new THREE.DataTexture(data, this.res, this.res, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  // -------------------------------------------------------------------------
  // SHADER COMPILATION
  // -------------------------------------------------------------------------
  private createInitShader(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uBedTex;
        uniform float uInflowDepth;
        uniform float uInflowSpeed;
        varying vec2 vUv;
        void main() {
          float bed = texture2D(uBedTex, vUv).r;
          float h = max(uInflowDepth - max(bed - 0.4, 0.0), 0.0);
          float u = h > 0.01 ? uInflowSpeed : 0.0;
          float v = 0.0;
          float eta = bed + h;
          gl_FragColor = vec4(h, u, v, eta);
        }
      `,
      uniforms: {
        uBedTex: { value: this.bedTexture },
        uInflowDepth: { value: this.params.inflowDepth },
        uInflowSpeed: { value: this.params.inflowSpeed },
      },
    });
  }

  private createAdvectShader(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uStateTex;
        uniform sampler2D uBedTex;
        uniform float uDt;
        uniform float uDx;
        varying vec2 vUv;

        void main() {
          vec4 cur = texture2D(uStateTex, vUv);
          float h = cur.r;
          vec2 vel = cur.gb;
          float bed = texture2D(uBedTex, vUv).r;

          // Semi-Lagrangian upstream backtrace in normalized UV space
          vec2 backUv = vUv - (vel * uDt) / (uDx * float(${this.res.toFixed(1)}));
          backUv = clamp(backUv, vec2(0.5 / float(${this.res.toFixed(1)})), vec2(1.0 - 0.5 / float(${this.res.toFixed(1)})));

          // Bilinear advection of velocity components
          vec2 advectVel = texture2D(uStateTex, backUv).gb;

          // Mask dry ground
          if (h < 0.005) {
            advectVel = vec2(0.0);
          }

          gl_FragColor = vec4(h, advectVel.x, advectVel.y, bed + h);
        }
      `,
      uniforms: {
        uStateTex: { value: null },
        uBedTex: { value: this.bedTexture },
        uDt: { value: 0.016 },
        uDx: { value: this.dx },
      },
    });
  }

  private createHeightShader(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uStateTex;
        uniform sampler2D uBedTex;
        uniform float uDt;
        uniform float uDx;
        uniform float uInflowDepth;
        varying vec2 vUv;

        void main() {
          float invRes = 1.0 / float(${this.res.toFixed(1)});
          vec4 c = texture2D(uStateTex, vUv);
          vec4 e = texture2D(uStateTex, vUv + vec2(invRes, 0.0));
          vec4 w = texture2D(uStateTex, vUv - vec2(invRes, 0.0));
          vec4 n = texture2D(uStateTex, vUv + vec2(0.0, invRes));
          vec4 s = texture2D(uStateTex, vUv - vec2(0.0, invRes));

          // Upwind conservative flux calculation
          float fluxE = (e.g > 0.0 ? c.r : e.r) * e.g;
          float fluxW = (c.g > 0.0 ? w.r : c.r) * c.g;
          float fluxN = (n.b > 0.0 ? c.r : n.r) * n.b;
          float fluxS = (c.b > 0.0 ? s.r : c.r) * c.b;

          float divFlux = (fluxE - fluxW + fluxN - fluxS) / uDx;
          float newH = max(c.r - uDt * divFlux, 0.0);

          float bed = texture2D(uBedTex, vUv).r;

          // Upstream inflow boundary at X = 0 (left column)
          if (vUv.x < invRes * 2.5) {
            float bankCut = smoothstep(0.48, 0.28, abs(vUv.y - 0.5));
            newH = max(uInflowDepth * bankCut - max(bed - 0.35, 0.0), 0.0);
          }

          // Downstream absorption sponge boundary at X = 1 (right edge)
          if (vUv.x > 1.0 - invRes * 4.0) {
            newH = mix(newH, 0.25, 0.08);
          }

          gl_FragColor = vec4(newH, c.g, c.b, bed + newH);
        }
      `,
      uniforms: {
        uStateTex: { value: null },
        uBedTex: { value: this.bedTexture },
        uDt: { value: 0.016 },
        uDx: { value: this.dx },
        uInflowDepth: { value: this.params.inflowDepth },
      },
    });
  }

  private createVelocityShader(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uStateTex;
        uniform sampler2D uBedTex;
        uniform float uDt;
        uniform float uDx;
        uniform float uGravity;
        uniform float uDrag;
        uniform float uInflowSpeed;
        varying vec2 vUv;

        void main() {
          float invRes = 1.0 / float(${this.res.toFixed(1)});
          vec4 c = texture2D(uStateTex, vUv);
          float h = c.r;
          float bed = texture2D(uBedTex, vUv).r;

          if (h < 0.003) {
            gl_FragColor = vec4(h, 0.0, 0.0, bed + h);
            return;
          }

          vec4 e = texture2D(uStateTex, vUv + vec2(invRes, 0.0));
          vec4 w = texture2D(uStateTex, vUv - vec2(invRes, 0.0));
          vec4 n = texture2D(uStateTex, vUv + vec2(0.0, invRes));
          vec4 s = texture2D(uStateTex, vUv - vec2(0.0, invRes));

          // Free-surface elevation gradient dEta/dx, dEta/dz
          float dEtaDx = (e.a - w.a) / (2.0 * uDx);
          float dEtaDz = (n.a - s.a) / (2.0 * uDx);

          // Gravitational acceleration down surface gradient
          float uNew = c.g - uGravity * uDt * dEtaDx;
          float vNew = c.b - uGravity * uDt * dEtaDz;

          // Bed friction / Manning quadratic drag
          float speed = length(vec2(uNew, vNew));
          float dragFactor = 1.0 + (uDrag * uDt * speed) / max(h, 0.02);
          uNew /= dragFactor;
          vNew /= dragFactor;

          // Upstream inflow boundary enforcement
          if (vUv.x < invRes * 2.5) {
            uNew = uInflowSpeed;
            vNew = 0.0;
          }

          // Dry bank boundary enforcement (kill velocity pointing into dry terrain)
          if (e.r < 0.004 && uNew > 0.0) uNew = 0.0;
          if (w.r < 0.004 && uNew < 0.0) uNew = 0.0;
          if (n.r < 0.004 && vNew > 0.0) vNew = 0.0;
          if (s.r < 0.004 && vNew < 0.0) vNew = 0.0;

          gl_FragColor = vec4(h, uNew, vNew, bed + h);
        }
      `,
      uniforms: {
        uStateTex: { value: null },
        uBedTex: { value: this.bedTexture },
        uDt: { value: 0.016 },
        uDx: { value: this.dx },
        uGravity: { value: this.params.gravity },
        uDrag: { value: this.params.drag },
        uInflowSpeed: { value: this.params.inflowSpeed },
      },
    });
  }

  private createAuxShader(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uStateTex;
        uniform sampler2D uAuxTex;
        uniform sampler2D uUVTex;
        uniform sampler2D uBedTex;
        uniform float uDt;
        uniform float uDx;
        uniform float uFoamGen;
        uniform float uFoamDecay;
        uniform float uResetPhase1;
        uniform float uResetPhase2;
        varying vec2 vUv;

        void main() {
          float invRes = 1.0 / float(${this.res.toFixed(1)});
          vec4 cur = texture2D(uStateTex, vUv);
          vec4 prevAux = texture2D(uAuxTex, vUv);
          vec4 prevUV = texture2D(uUVTex, vUv);

          float h = cur.r;
          vec2 vel = cur.gb;
          float speed = length(vel);
          float bed = texture2D(uBedTex, vUv).r;

          // Velocity divergence: negative divergence indicates compression / hydraulic jump
          vec4 e = texture2D(uStateTex, vUv + vec2(invRes, 0.0));
          vec4 w = texture2D(uStateTex, vUv - vec2(invRes, 0.0));
          vec4 n = texture2D(uStateTex, vUv + vec2(0.0, invRes));
          vec4 s = texture2D(uStateTex, vUv - vec2(0.0, invRes));
          float divVel = (e.g - w.g + n.b - s.b) / (2.0 * uDx);

          // Froude number Fr = v / sqrt(g * h)
          float froude = speed / sqrt(max(9.81 * h, 0.001));

          // Physical foam generation in hydraulic jumps, rapids, and obstacle wake
          float jumpFoam = max(-divVel * 1.8, 0.0);
          float rapidFoam = max(froude - 1.0, 0.0) * 0.75;
          float gen = (jumpFoam + rapidFoam) * uFoamGen * smoothstep(0.02, 0.12, h);

          // Foam exponential dissipation
          float foam = (prevAux.r + gen * uDt) * exp(-uFoamDecay * uDt);
          foam = clamp(foam, 0.0, 1.0);

          float wetMask = smoothstep(0.005, 0.025, h);

          // Output Aux: R=foam, G=wetMask, B=speed, A=bed
          gl_FragColor = vec4(foam, wetMask, speed, bed);
        }
      `,
      uniforms: {
        uStateTex: { value: null },
        uAuxTex: { value: null },
        uUVTex: { value: null },
        uBedTex: { value: this.bedTexture },
        uDt: { value: 0.016 },
        uDx: { value: this.dx },
        uFoamGen: { value: this.params.foamGen },
        uFoamDecay: { value: this.params.foamDecay },
        uResetPhase1: { value: 0 },
        uResetPhase2: { value: 0 },
      },
    });
  }

  private createObstacleShader(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uBedTex;
        uniform vec2 uPos;
        uniform float uRadius;
        uniform float uHeight;
        varying vec2 vUv;
        void main() {
          vec4 cur = texture2D(uBedTex, vUv);
          float d = distance(vUv, uPos);
          if (d < uRadius) {
            float falloff = cos(d / uRadius * (3.14159265 / 2.0));
            cur.r += uHeight * falloff;
          }
          gl_FragColor = cur;
        }
      `,
      uniforms: {
        uBedTex: { value: null },
        uPos: { value: new THREE.Vector2(0.5, 0.5) },
        uRadius: { value: 0.05 },
        uHeight: { value: 0.4 },
      },
    });
  }

  // -------------------------------------------------------------------------
  // SIMULATION CYCLE
  // -------------------------------------------------------------------------
  reset() {
    this.initMat.uniforms.uInflowDepth.value = this.params.inflowDepth;
    this.initMat.uniforms.uInflowSpeed.value = this.params.inflowSpeed;
    this.runPass(this.initMat, this.stateTargets[0]);
    this.runPass(this.initMat, this.stateTargets[1]);
    this.stateIdx = 0;
  }

  step(dt: number) {
    // Sub-step for numerical stability (CFL condition)
    const substeps = 2;
    const subDt = Math.min(dt, 0.033) / substeps;

    for (let s = 0; s < substeps; s++) {
      this.simTime += subDt;

      // 1. Advection Pass (Backtrace velocities)
      const readState = this.stateTargets[this.stateIdx];
      const writeState1 = this.stateTargets[1 - this.stateIdx];
      this.advectMat.uniforms.uStateTex.value = readState.texture;
      this.advectMat.uniforms.uDt.value = subDt;
      this.runPass(this.advectMat, writeState1);
      this.stateIdx = 1 - this.stateIdx;

      // 2. Height Pass (Continuity & Mass conservation)
      const stateAfterAdv = this.stateTargets[this.stateIdx];
      const writeState2 = this.stateTargets[1 - this.stateIdx];
      this.heightMat.uniforms.uStateTex.value = stateAfterAdv.texture;
      this.heightMat.uniforms.uDt.value = subDt;
      this.heightMat.uniforms.uInflowDepth.value = this.params.inflowDepth;
      this.runPass(this.heightMat, writeState2);
      this.stateIdx = 1 - this.stateIdx;

      // 3. Velocity Pass (Pressure gradient acceleration & bottom drag)
      const stateAfterH = this.stateTargets[this.stateIdx];
      const writeState3 = this.stateTargets[1 - this.stateIdx];
      this.velocityMat.uniforms.uStateTex.value = stateAfterH.texture;
      this.velocityMat.uniforms.uDt.value = subDt;
      this.velocityMat.uniforms.uGravity.value = this.params.gravity;
      this.velocityMat.uniforms.uDrag.value = this.params.drag;
      this.velocityMat.uniforms.uInflowSpeed.value = this.params.inflowSpeed;
      this.runPass(this.velocityMat, writeState3);
      this.stateIdx = 1 - this.stateIdx;

      // 4. Aux Pass (Foam generation & decay)
      const finalState = this.stateTargets[this.stateIdx];
      const readAux = this.auxTargets[this.auxIdx];
      const writeAux = this.auxTargets[1 - this.auxIdx];
      this.auxMat.uniforms.uStateTex.value = finalState.texture;
      this.auxMat.uniforms.uAuxTex.value = readAux.texture;
      this.auxMat.uniforms.uDt.value = subDt;
      this.auxMat.uniforms.uFoamGen.value = this.params.foamGen;
      this.auxMat.uniforms.uFoamDecay.value = this.params.foamDecay;
      this.runPass(this.auxMat, writeAux);
      this.auxIdx = 1 - this.auxIdx;
    }
  }

  // Interactively add a disturbance or splash ripple at (uvX, uvY)
  addDisturbance(uvX: number, uvY: number, radius = 0.04, amount = 0.18) {
    const read = this.stateTargets[this.stateIdx];
    const write = this.stateTargets[1 - this.stateIdx];

    const mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        uniform vec2 uPos;
        uniform float uRad;
        uniform float uAmt;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uTex, vUv);
          float d = distance(vUv, uPos);
          if (d < uRad) {
            float w = cos(d / uRad * 3.14159265 * 0.5);
            c.r = max(c.r + uAmt * w, 0.0);
            c.a += uAmt * w;
          }
          gl_FragColor = c;
        }
      `,
      uniforms: {
        uTex: { value: read.texture },
        uPos: { value: new THREE.Vector2(uvX, uvY) },
        uRad: { value: radius },
        uAmt: { value: amount },
      },
    });

    this.runPass(mat, write);
    this.stateIdx = 1 - this.stateIdx;
    mat.dispose();
  }

  get currentStateTexture(): THREE.Texture {
    return this.stateTargets[this.stateIdx].texture;
  }

  get currentAuxTexture(): THREE.Texture {
    return this.auxTargets[this.auxIdx].texture;
  }

  private runPass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quadMesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
  }

  dispose() {
    this.quadGeo.dispose();
    this.stateTargets.forEach(t => t.dispose());
    this.auxTargets.forEach(t => t.dispose());
    this.uvTargets.forEach(t => t.dispose());
    this.bedTexture.dispose();
  }
}
