import * as THREE from "three";

export interface WaterMaterialOptions {
  size: number;
  res: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
}

export function createWaterMaterial(opts: WaterMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uState: { value: null },
      uAux: { value: null },
      uTerrain: { value: null },
      uScreenTex: { value: null },
      uEnvMap: { value: null },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uSize: { value: opts.size },
      uRes: { value: opts.res },
      uDx: { value: opts.size / opts.res },
      uSunDir: { value: opts.sunDir },
      uSunColor: { value: opts.sunColor },
      uTime: { value: 0.0 },
      uRefraction: { value: 0.90 },
      uAbsorbScale: { value: 3.5 },
      uRoughness: { value: 0.10 },
      uGlintBoost: { value: 0.70 },
      uScatterStrength: { value: 0.35 },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: `
      precision highp float;
      uniform sampler2D uState;
      uniform sampler2D uTerrain;
      uniform float uSize;
      uniform float uRes;
      uniform float uDx;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec4 vScreenPos;
      varying float vDepth;

      void main() {
        vUv = uv;
        vec2 texel = 1.0 / vec2(uRes);

        vec4 state = texture2D(uState, uv);
        float h = state.r;
        float eta = state.a;
        vDepth = h;

        // Displace vertex along Y to water surface elevation eta
        vec3 displaced = position;
        displaced.y = eta;

        vec4 worldP = modelMatrix * vec4(displaced, 1.0);
        vWorldPos = worldP.xyz;

        // Evaluate normal from surrounding eta heights
        vec4 stateR = texture2D(uState, uv + vec2(texel.x, 0.0));
        vec4 stateL = texture2D(uState, uv - vec2(texel.x, 0.0));
        vec4 stateT = texture2D(uState, uv + vec2(0.0, texel.y));
        vec4 stateB = texture2D(uState, uv - vec2(0.0, texel.y));

        float deta_dx = (stateR.a - stateL.a) / (2.0 * uDx);
        float deta_dz = (stateT.a - stateB.a) / (2.0 * uDx);
        vNormal = normalize(vec3(-deta_dx, 1.0, -deta_dz));

        vec4 clipPos = projectionMatrix * viewMatrix * worldP;
        vScreenPos = clipPos;
        gl_Position = clipPos;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uState;
      uniform sampler2D uAux;
      uniform sampler2D uScreenTex;
      uniform sampler2D uEnvMap;
      uniform vec2 uResolution;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uTime;
      uniform float uRefraction;
      uniform float uAbsorbScale;
      uniform float uRoughness;
      uniform float uGlintBoost;
      uniform float uScatterStrength;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec4 vScreenPos;
      varying float vDepth;

      // Fast hash noise for procedural micro-ripples
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      void main() {
        if (vDepth < 0.001) discard;

        vec4 state = texture2D(uState, vUv);
        vec4 aux = texture2D(uAux, vUv);
        float foam = aux.r;

        // Dual-Phase Flow-Mapped Surface Ripples
        vec2 vel = vec2(state.g, state.b);
        float speed = length(vel);
        float tau = 0.8;
        float t0 = mod(uTime, tau);
        float t1 = mod(uTime + tau * 0.5, tau);
        float w0 = sin((t0 / tau) * 3.14159265);
        float w1 = sin((t1 / tau) * 3.14159265);

        vec2 uv0 = vWorldPos.xz * 12.0 - vel * t0 * 0.6;
        vec2 uv1 = vWorldPos.xz * 12.0 - vel * t1 * 0.6;

        vec2 rippleGrad0 = vec2(
          noise(uv0 + vec2(0.05, 0.0)) - noise(uv0 - vec2(0.05, 0.0)),
          noise(uv0 + vec2(0.0, 0.05)) - noise(uv0 - vec2(0.0, 0.05))
        );
        vec2 rippleGrad1 = vec2(
          noise(uv1 + vec2(0.05, 0.0)) - noise(uv1 - vec2(0.05, 0.0)),
          noise(uv1 + vec2(0.0, 0.05)) - noise(uv1 - vec2(0.0, 0.05))
        );
        vec2 ripple = (rippleGrad0 * w0 + rippleGrad1 * w1) * 0.04 * (1.0 - foam * 0.5);

        // Combined Surface Normal
        vec3 N = normalize(vec3(vNormal.x + ripple.x, vNormal.y, vNormal.z + ripple.y));
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);
        vec3 H = normalize(L + V);

        // Screen UV for background refraction
        vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
        // Perturb screen UV along surface normal
        vec2 refrOffset = N.xz * uRefraction * 0.035 * min(vDepth, 0.20) * (1.0 - foam);
        vec2 finalScreenUv = clamp(screenUv + refrOffset, 0.001, 0.999);

        vec3 bedColor = texture2D(uScreenTex, finalScreenUv).rgb;

        // Spectral Beer-Lambert Absorption
        // Red absorbs rapidly (1.40), green moderately (0.55), blue slowly (0.28)
        vec3 alpha = vec3(1.40, 0.55, 0.28) * uAbsorbScale;
        vec3 transmittance = exp(-alpha * (vDepth + 0.015));

        // Subsurface scattering tint
        vec3 sssColor = vec3(0.02, 0.10, 0.16) * uScatterStrength;
        vec3 waterBody = bedColor * transmittance + sssColor * (vec3(1.0) - transmittance);

        // Specular Reflection (Sun + Sky)
        float NdotV = max(dot(N, V), 0.0);
        float NdotL = max(dot(N, L), 0.0);
        float NdotH = max(dot(N, H), 0.0);

        // Schlick Fresnel
        float F0 = 0.02;
        float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);

        // Blinn-Phong specular glint
        float specPower = 120.0;
        float spec = pow(NdotH, specPower) * uGlintBoost;
        vec3 sunHighlight = uSunColor * spec * NdotL;

        // Sky reflection
        vec3 R = reflect(-V, N);
        vec3 skyRefl = mix(vec3(0.18, 0.28, 0.38), vec3(0.70, 0.82, 0.95), smoothstep(-0.2, 0.8, R.y));

        vec3 waterColor = mix(waterBody, skyRefl, fresnel) + sunHighlight;

        // Aerated foam overlay
        if (foam > 0.02) {
          float foamNoise = noise(vWorldPos.xz * 45.0 + uTime * 0.5);
          float foamMask = smoothstep(0.15, 0.65, foam + foamNoise * 0.3);
          vec3 foamColor = vec3(0.96, 0.98, 1.0) * (0.8 + 0.2 * NdotL);
          waterColor = mix(waterColor, foamColor, foamMask * 0.88);
        }

        // Shoreline fade
        float shoreAlpha = smoothstep(0.001, 0.008, vDepth);
        gl_FragColor = vec4(waterColor, shoreAlpha);
      }
    `,
  });
}

export function createBedMaterial(sunDir: THREE.Vector3, sunColor: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uNor: { value: null },
      uArm: { value: null },
      uState: { value: null },
      uAux: { value: null },
      uCaustics: { value: null },
      uSunDir: { value: sunDir },
      uSunColor: { value: sunColor },
      uSize: { value: 3.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uMap;
      uniform sampler2D uNor;
      uniform sampler2D uArm;
      uniform sampler2D uState;
      uniform sampler2D uAux;
      uniform sampler2D uCaustics;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSize;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      void main() {
        // Ganges pebbles texture tiling (5x across the 3m domain)
        vec2 tiledUv = (vWorldPos.xz / uSize + 0.5) * 5.0;
        vec3 albedo = texture2D(uMap, tiledUv).rgb;
        vec3 arm = texture2D(uArm, tiledUv).rgb; // r: AO, g: roughness, b: metalness

        // Simulation coordinates: map world xz [-1.5, 1.5] -> [0, 1]
        vec2 simUv = vWorldPos.xz / uSize + 0.5;
        vec4 state = texture2D(uState, simUv);
        vec4 aux = texture2D(uAux, simUv);

        float h = state.r;
        float wet = aux.g;

        // Dynamic wetness darkening (water drops albedo by 50% and reduces roughness)
        float isWet = clamp(wet, 0.0, 1.0);
        albedo *= mix(1.0, 0.50, isWet);
        float roughness = mix(arm.g, 0.10, isWet);

        // Lighting
        vec3 L = normalize(uSunDir);
        vec3 N = normalize(vNormal);
        float NdotL = max(dot(N, L), 0.0);

        // Caustics on riverbed
        vec3 caustic = texture2D(uCaustics, simUv).rgb;
        float causticIntensity = caustic.r * smoothstep(0.005, 0.03, h);

        vec3 direct = uSunColor * (NdotL + causticIntensity * 1.5);
        vec3 ambient = vec3(0.20, 0.22, 0.25) * arm.r; // AO

        vec3 finalColor = albedo * (ambient + direct);
        gl_FragColor = vec4(finalColor, 1.0);
      }
    `,
  });
}

export function createTriplanarRockMaterial(sunDir: THREE.Vector3, sunColor: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uNor: { value: null },
      uArm: { value: null },
      uState: { value: null },
      uAux: { value: null },
      uCaustics: { value: null },
      uSunDir: { value: sunDir },
      uSunColor: { value: sunColor },
      uSize: { value: 3.0 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uMap;
      uniform sampler2D uNor;
      uniform sampler2D uArm;
      uniform sampler2D uState;
      uniform sampler2D uAux;
      uniform sampler2D uCaustics;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSize;

      varying vec3 vWorldPos;
      varying vec3 vNormal;

      void main() {
        // Triplanar weights
        vec3 N = normalize(vNormal);
        vec3 weights = pow(abs(N), vec3(4.0));
        weights /= (weights.x + weights.y + weights.z);

        // Triplanar projection (scale 1.6)
        vec3 p = vWorldPos * 1.6;
        vec3 colYZ = texture2D(uMap, p.yz).rgb;
        vec3 colZX = texture2D(uMap, p.zx).rgb;
        vec3 colXY = texture2D(uMap, p.xy).rgb;
        vec3 albedo = colYZ * weights.x + colZX * weights.y + colXY * weights.z;

        vec3 armYZ = texture2D(uArm, p.yz).rgb;
        vec3 armZX = texture2D(uArm, p.zx).rgb;
        vec3 armXY = texture2D(uArm, p.xy).rgb;
        vec3 arm = armYZ * weights.x + armZX * weights.y + armXY * weights.z;

        // Simulation coordinates
        vec2 simUv = vWorldPos.xz / uSize + 0.5;
        vec4 state = texture2D(uState, simUv);
        vec4 aux = texture2D(uAux, simUv);

        float waterEta = state.a;
        float h = state.r;

        // Waterline wetness: rock underwater or in splash zone darkens significantly (70%)
        float submerged = smoothstep(waterEta + 0.04, waterEta - 0.01, vWorldPos.y) * clamp(aux.g, 0.0, 1.0);
        albedo *= mix(1.0, 0.32, submerged);

        // Lighting
        vec3 L = normalize(uSunDir);
        float NdotL = max(dot(N, L), 0.0);

        // Caustics on submerged boulder surfaces
        vec3 caustic = texture2D(uCaustics, simUv).rgb;
        float causticIntensity = caustic.r * submerged;

        vec3 direct = uSunColor * (NdotL + causticIntensity * 1.2);
        vec3 ambient = vec3(0.22, 0.24, 0.26) * arm.r;

        vec3 finalColor = albedo * (ambient + direct);
        gl_FragColor = vec4(finalColor, 1.0);
      }
    `,
  });
}
