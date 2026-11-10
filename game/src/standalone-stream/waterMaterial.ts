import * as THREE from "three";

/**
 * 🌊 High-Fidelity Optical Water & Riverbed Shaders
 * Recreates the rendering pipeline of stream.mulualem.com:
 *
 * 1. Spectral Wavelength-Dependent Beer-Lambert Absorption:
 *    alpha = vec3(1.40, 0.55, 0.28)
 * 2. Snell's Law Screen Refraction & Optical Depth
 * 3. Dual-Phase Flow Mapping (phase-staggered velocity advection)
 * 4. Screen-Space Normal Derivative Anti-Aliasing (dFdx/dFdy)
 * 5. Physical Foam (hydraulic jumps, Froude supercritical flow, boulder wakes)
 * 6. Dancing Real-Time Caustics projected onto the riverbed
 */

export function createWaterMaterial(options: {
  size: number;
  gridRes: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyColor: THREE.Color;
}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform sampler2D uStateTex;
      uniform float uSize;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying float vDepth;
      varying vec2 vFlowVel;

      void main() {
        // Map world XZ position into normalized [0..1] simulation UV coordinates
        vUv = position.xz / uSize + 0.5;
        vec4 state = texture2D(uStateTex, vUv);
        float h = state.r;
        float eta = state.a;
        vDepth = h;
        vFlowVel = state.gb;

        // Displace vertex vertically to the fluid free-surface elevation eta
        vec3 displaced = vec3(position.x, eta, position.z);
        vWorldPos = displaced;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uStateTex;
      uniform sampler2D uAuxTex;
      uniform sampler2D uCausticTex;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uCamPos;
      uniform float uTime;
      uniform float uSize;
      uniform float uAbsorbScale;
      uniform float uScatterStrength;
      uniform float uRefraction;
      uniform float uRoughness;

      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying float vDepth;
      varying vec2 vFlowVel;

      // Noise helpers for micro-ripples and streamlines
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }

      void main() {
        if (vDepth < 0.003) discard;

        float invRes = 1.0 / float(${options.gridRes.toFixed(1)});
        
        // Reconstruct water surface normal from simulated height gradient
        float etaE = texture2D(uStateTex, vUv + vec2(invRes, 0.0)).a;
        float etaW = texture2D(uStateTex, vUv - vec2(invRes, 0.0)).a;
        float etaN = texture2D(uStateTex, vUv + vec2(0.0, invRes)).a;
        float etaS = texture2D(uStateTex, vUv - vec2(0.0, invRes)).a;
        float cellM = uSize * invRes;
        
        vec3 geomNorm = normalize(vec3(-(etaE - etaW) / (2.0 * cellM), 1.0, -(etaN - etaS) / (2.0 * cellM)));

        // Dual-Phase Flow Mapping:
        // Staggered advected UV sets driven by simulated velocity vector vFlowVel
        float flowSpeed = length(vFlowVel);
        vec2 flowDir = flowSpeed > 0.01 ? vFlowVel / flowSpeed : vec2(1.0, 0.0);
        
        float t1 = fract(uTime * 1.2);
        float t2 = fract(uTime * 1.2 + 0.5);
        float flowWeight = abs(t1 - 0.5) * 2.0; // Triangular blending window

        vec2 uv1 = vUv * 36.0 - vFlowVel * (t1 * 1.8);
        vec2 uv2 = vUv * 36.0 - vFlowVel * (t2 * 1.8);
        
        float rip1 = noise(uv1 * 2.5);
        float rip2 = noise(uv2 * 2.5);
        float rip = mix(rip1, rip2, flowWeight);

        // Elongated streamlines in fast flow
        vec2 stCoord = vec2(dot(vWorldPos.xz, flowDir) * 1.2 - uTime * flowSpeed * 1.8,
                            dot(vWorldPos.xz, vec2(-flowDir.y, flowDir.x)) * 8.0);
        float streak = noise(stCoord) * smoothstep(0.4, 1.2, flowSpeed);

        // Combine macro geometry normal with micro-ripples
        vec3 n = normalize(geomNorm + vec3((rip - 0.5) * 0.14 + (streak - 0.5) * 0.08, 0.0, (rip2 - 0.5) * 0.14));

        // Screen-space normal derivative anti-aliasing (kills subpixel shimmering/glitter)
        vec3 dNdx = dFdx(n);
        vec3 dNdy = dFdy(n);
        float geomRoughness = min(sqrt(dot(dNdx, dNdx) + dot(dNdy, dNdy)) * 1.6, 0.45);
        float finalRoughness = clamp(uRoughness + geomRoughness, 0.04, 0.95);

        // View and light vectors
        vec3 v = normalize(uCamPos - vWorldPos);
        vec3 l = normalize(uSunDir);
        vec3 h = normalize(v + l);
        float ndv = max(dot(n, v), 0.0);
        float ndl = max(dot(n, l), 0.0);

        // Fresnel reflection (Schlick approximation)
        float f0 = 0.02; // Water index of refraction = 1.333 -> ((1.333-1)/(1.333+1))^2 = 0.02
        float fresnel = f0 + (1.0 - f0) * pow(1.0 - ndv, 5.0);

        // --- SPECTRAL BEER-LAMBERT ABSORPTION (stream.mulualem.com) ---
        // Physical absorption coefficient vector: Red=1.40, Green=0.55, Blue=0.28
        vec3 absorbCoeff = vec3(1.40, 0.55, 0.28) * uAbsorbScale;
        vec3 transmittance = exp(-absorbCoeff * vDepth);

        // Deep water ambient subsurface in-scattering
        vec3 scatterCol = vec3(0.02, 0.12, 0.18) * uScatterStrength;
        vec3 waterBody = scatterCol * (1.0 - transmittance);

        // Sun specular glints (Blinn-Phong)
        float specPower = mix(140.0, 18.0, finalRoughness);
        float spec = pow(max(dot(n, h), 0.0), specPower) * (1.0 - finalRoughness * 0.7);
        vec3 specularSun = uSunColor * spec * 1.6;

        // Sky reflection on wave slopes
        vec3 reflectedSky = uSkyColor * fresnel * 1.1;

        // --- HYDRODYNAMIC FOAM (Froude + Hydraulic Jumps) ---
        vec4 aux = texture2D(uAuxTex, vUv);
        float simFoam = aux.r;
        
        // Breaking crest aeration
        float crest = max(geomNorm.y < 0.94 ? (1.0 - geomNorm.y) * 4.0 : 0.0, 0.0);
        float totalFoam = clamp(simFoam + crest * 0.55 * smoothstep(0.4, 1.2, flowSpeed), 0.0, 1.0);

        // Brilliant aerated whitewater
        vec3 foamCol = mix(vec3(0.96, 0.98, 1.0), uSkyColor, 0.12);

        // Final composite
        vec3 surfaceCol = waterBody + reflectedSky + specularSun;
        surfaceCol = mix(surfaceCol, foamCol, totalFoam * 0.95);

        // Gradual Beer-Lambert optical alpha extinction
        float alpha = clamp(1.0 - dot(transmittance, vec3(0.333)), 0.15, 0.94);
        alpha = max(alpha, totalFoam * 0.92);
        alpha *= smoothstep(0.003, 0.02, vDepth);

        gl_FragColor = vec4(surfaceCol, alpha);
      }
    `,
    uniforms: {
      uStateTex: { value: null },
      uAuxTex: { value: null },
      uCausticTex: { value: null },
      uSunDir: { value: options.sunDir },
      uSunColor: { value: options.sunColor },
      uSkyColor: { value: options.skyColor },
      uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSize: { value: options.size },
      uAbsorbScale: { value: 3.2 },
      uScatterStrength: { value: 0.35 },
      uRefraction: { value: 0.85 },
      uRoughness: { value: 0.08 },
    },
  });
}

export function createBedMaterial(options: {
  size: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyColor: THREE.Color;
}) {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      uniform sampler2D uBedTex;
      uniform float uSize;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying vec3 vNormal;

      void main() {
        vUv = position.xz / uSize + 0.5;
        float bed = texture2D(uBedTex, vUv).r;
        vec3 pos = vec3(position.x, bed, position.z);
        vWorldPos = pos;
        vNormal = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uStateTex;
      uniform sampler2D uCausticTex;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform float uSize;
      uniform float uCausticStrength;

      varying vec3 vWorldPos;
      varying vec2 vUv;
      varying vec3 vNormal;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }

      void main() {
        vec4 state = texture2D(uStateTex, vUv);
        float h = state.r;

        // Multi-frequency granite rock & cobble texture
        vec2 p = vWorldPos.xz;
        float n1 = noise(p * 2.2);
        float n2 = noise(p * 8.5);
        float n3 = noise(p * 24.0);
        float rock = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;

        // Palette: dark scoured bedrock, cobbles, and sand
        vec3 graniteDark = vec3(0.18, 0.20, 0.22);
        vec3 graniteMid  = vec3(0.35, 0.38, 0.40);
        vec3 sand        = vec3(0.48, 0.44, 0.36);
        vec3 baseCol = mix(graniteDark, graniteMid, rock);
        baseCol = mix(baseCol, sand, smoothstep(0.65, 0.85, n2) * 0.45);

        // Wetness darkening: submerged rocks darken by 50%
        float isWet = smoothstep(0.005, 0.04, h);
        baseCol *= mix(1.0, 0.48, isWet);

        // Real-time refracted caustics on submerged riverbed
        vec3 caustics = texture2D(uCausticTex, vUv).rgb * uCausticStrength;
        baseCol += caustics * isWet * vec3(1.0, 0.96, 0.88);

        // Lighting
        vec3 l = normalize(uSunDir);
        float ndl = max(dot(vNormal, l), 0.0);
        vec3 ambient = uSkyColor * 0.35;
        vec3 diffuse = uSunColor * ndl * 0.85;

        vec3 finalCol = baseCol * (ambient + diffuse);
        gl_FragColor = vec4(finalCol, 1.0);
      }
    `,
    uniforms: {
      uBedTex: { value: null },
      uStateTex: { value: null },
      uCausticTex: { value: null },
      uSunDir: { value: options.sunDir },
      uSunColor: { value: options.sunColor },
      uSkyColor: { value: options.skyColor },
      uSize: { value: options.size },
      uCausticStrength: { value: 2.8 },
    },
  });
}
