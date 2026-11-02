import * as THREE from "three";
export interface WaterSamplers {
  groundHeight: (x: number, z: number) => number;
  pondDepth: (x: number, z: number) => number;
  mud?: (x: number, z: number) => number;
}
const CELLS = 96; const SPAN = 160; const STEP = SPAN / CELLS;
export class WaterSurface {
  mesh: THREE.Mesh; private geo: THREE.BufferGeometry; private mat: THREE.ShaderMaterial;
  private level = new Float32Array((CELLS + 1) * (CELLS + 1));
  private cx = 0; private cz = 0; private tick = 0; updateEvery = 1;
  constructor(scene: THREE.Scene, private s: WaterSamplers) {
    const n = (CELLS + 1) * (CELLS + 1);
    const pos = new Float32Array(n * 3); const aDepth = new Float32Array(n);
    const aFlow = new Float32Array(n * 2); const aMud = new Float32Array(n);
    const idx: number[] = [];
    for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
      const a = j * (CELLS + 1) + i;
      idx.push(a, a + 1, a + CELLS + 1, a + 1, a + CELLS + 2, a + CELLS + 1);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute("aDepth", new THREE.BufferAttribute(aDepth, 1));
    this.geo.setAttribute("aFlow", new THREE.BufferAttribute(aFlow, 2));
    this.geo.setAttribute("aMud", new THREE.BufferAttribute(aMud, 1));
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uRain: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        uCamPos: { value: new THREE.Vector3() },
        uShallow: { value: new THREE.Color(0x7fb6b0) }, uDeep: { value: new THREE.Color(0x123a44) },
        uMudCol: { value: new THREE.Color(0x4a3524) }, uSky: { value: new THREE.Color(0xbfd4de) },
        uFoam: { value: new THREE.Color(0xe8f2f2) },
      },
      vertexShader: `attribute float aDepth; attribute vec2 aFlow; attribute float aMud; uniform float uTime;
        varying float vDepth; varying vec2 vFlow; varying float vMud; varying vec3 vWorld;
        void main() { vDepth = aDepth; vFlow = aFlow; vMud = aMud; vec3 p = position;
        // Timberborn-scale relief: calm water breathes ~1.5cm, rapids chop to
        // ~7cm; a long swell underneath keeps the silhouette alive at distance
        float fs = length(aFlow);
        float amp = (0.014 + 0.030 * clamp(fs * 0.7, 0.0, 1.0)) * smoothstep(0.0, 0.06, aDepth);
        float w = sin(p.x * 3.1 + uTime * 2.2) * 0.5 + sin(p.z * 2.7 - uTime * 1.7) * 0.5;
        float swell = sin(p.x * 1.3 + p.z * 1.7 + uTime * 1.1) * 0.6;
        p.y += (w + swell) * amp; vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `precision highp float; uniform float uTime, uRain;
        uniform vec3 uSunDir, uCamPos, uShallow, uDeep, uMudCol, uSky, uFoam;
        varying float vDepth; varying vec2 vFlow; varying float vMud; varying vec3 vWorld;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
        void main() { float d = vDepth; if (d <= 0.004) discard; vec2 flow = vFlow; float fspeed = length(flow);
        vec2 uv = vWorld.xz; float t = uTime;
        vec2 adv = uv * 2.0 + flow * t * 2.6 + vec2(t * 0.35, t * 0.22);
        float n1 = vnoise(adv); float n2 = vnoise(uv * 5.3 - flow * t * 2.0 - vec2(t * 0.5, -t * 0.4));
        // current streaks: noise stretched ALONG the flow direction and
        // advected downstream, so a moving river reads as moving
        vec2 fdir = fspeed > 1e-3 ? flow / fspeed : vec2(1.0, 0.0);
        vec2 str = vec2(dot(uv, fdir), dot(uv, vec2(-fdir.y, fdir.x)));
        float streak = vnoise(str * vec2(1.2, 6.5) + vec2(-t * 1.6 * clamp(fspeed, 0.0, 2.0), 0.0));
        float drops = step(0.985 - uRain * 0.01, hash(floor(uv * 6.0) + floor(t * 8.0))) * uRain * 0.02;
        vec3 N = normalize(vec3((n1 - 0.5) * 0.35 + (n2 - 0.5) * 0.18 + (streak - 0.5) * 0.10 * clamp(fspeed, 0.0, 1.0), 1.0,
          (n2 - 0.5) * 0.35 + (n1 - 0.5) * 0.18 + (streak - 0.5) * 0.10 * clamp(fspeed, 0.0, 1.0)));
        N = normalize(mix(vec3(0.0, 1.0, 0.0), N, smoothstep(0.0, 0.05, d)));
        float storm = clamp(uRain / 135.0, 0.0, 1.0);
        vec3 V = normalize(uCamPos - vWorld); float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        vec3 body = mix(uShallow, uDeep, 1.0 - exp(-d * 3.2));
        body = mix(body, uMudCol, clamp(vMud * 0.6, 0.0, 0.6));
        // stormy skies stop mirroring so hard: the body colour stays readable
        vec3 col = mix(body, uSky, fres * (0.78 - 0.30 * storm));
        // sun glint: tightened and damped in rain so a hotspot can never
        // blow out to a white blob near the viewer under a storm
        vec3 R = reflect(-uSunDir, N);
        col += vec3(1.0, 0.95, 0.8) * pow(max(dot(R, V), 0.0), 90.0) * (1.15 - 0.85 * storm);
        col += uFoam * (streak - 0.5) * 0.10 * clamp(fspeed, 0.0, 1.5);
        float shore = 1.0 - smoothstep(0.015, 0.28, d); float flowFoam = smoothstep(0.45, 1.6, fspeed) * 0.55;
        float foam = clamp(shore * 0.85 + flowFoam + drops, 0.0, 1.0);
        col = mix(col, uFoam, foam * 0.8); float alpha = smoothstep(0.004, 0.05, d) * 0.88 + foam * 0.15;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0)); }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat); this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5; scene.add(this.mesh);
  }
  setRain(mmH: number) { this.mat.uniforms.uRain.value = mmH; }
  setSun(dir: THREE.Vector3) { (this.mat.uniforms.uSunDir.value as THREE.Vector3).copy(dir).normalize(); }
  setCam(p: THREE.Vector3) { (this.mat.uniforms.uCamPos.value as THREE.Vector3).copy(p); }
  update(center: THREE.Vector3, dt: number, elapsed: number) {
    this.mat.uniforms.uTime.value = elapsed; this.tick++;
    if (this.tick % this.updateEvery !== 0) return;
    this.cx = Math.round(center.x / STEP) * STEP; this.cz = Math.round(center.z / STEP) * STEP;
    const W = CELLS + 1;
    const pos = this.geo.getAttribute("position") as THREE.BufferAttribute;
    const aDepth = this.geo.getAttribute("aDepth") as THREE.BufferAttribute;
    const aFlow = this.geo.getAttribute("aFlow") as THREE.BufferAttribute;
    const aMud = this.geo.getAttribute("aMud") as THREE.BufferAttribute;
    for (let j = 0; j <= CELLS; j++) for (let i = 0; i <= CELLS; i++) {
      const x = this.cx + (i - CELLS / 2) * STEP; const z = this.cz + (j - CELLS / 2) * STEP;
      const bed = this.s.groundHeight(x, z); const d = this.s.pondDepth(x, z);
      this.level[j * W + i] = d > 0.01 ? bed + d : -1e9;
    }
    for (let pass = 0; pass < 2; pass++) { const src = this.level.slice();
      for (let j = 1; j < CELLS; j++) for (let i = 1; i < CELLS; i++) { const k = j * W + i;
        if (src[k] < -1e8) continue; let sum = 0, cnt = 0; const nb = [k - 1, k + 1, k - W, k + W];
        for (const q of nb) if (src[q] > -1e8) { sum += src[q]; cnt++; }
        if (cnt > 0) this.level[k] = src[k] * 0.35 + (sum / cnt) * 0.65; } }
    for (let j = 0; j <= CELLS; j++) for (let i = 0; i <= CELLS; i++) { const k = j * W + i;
      const x = this.cx + (i - CELLS / 2) * STEP; const z = this.cz + (j - CELLS / 2) * STEP;
      const bed = this.s.groundHeight(x, z); const lv = this.level[k];
      const d = lv > -1e8 ? Math.max(0, lv - bed) : 0;
      pos.setXYZ(k, x, d > 0.004 ? lv : bed - 0.05, z); aDepth.setX(k, d);
      const l = this.level[k - 1] ?? lv, r = this.level[k + 1] ?? lv;
      const u = this.level[k - W] ?? lv, dn = this.level[k + W] ?? lv;
      let fx = (l - r), fz = (u - dn); const fl = Math.hypot(fx, fz);
      if (fl > 1e-6) { fx /= fl; fz /= fl; } else { fx = 0; fz = 0; }
      aFlow.setXY(k, fx * Math.min(fl * 40, 2.5), fz * Math.min(fl * 40, 2.5));
      aMud.setX(k, this.s.mud ? this.s.mud(x, z) : 0); }
    pos.needsUpdate = true; aDepth.needsUpdate = true; aFlow.needsUpdate = true; aMud.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}
