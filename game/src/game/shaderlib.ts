/**
 * Shared GLSL fragments — the ONE place the ground-surface look is defined.
 *
 * Both the static terrain mesh (world.ts) and the contact-tier overlay
 * (contact.ts) inject these so a hole, a churned trail or a field of mud
 * shades EXACTLY the same on either surface: no visible seam where the
 * deformable window hands back to the world mesh.
 *
 * Nothing here knows about physics — wet/mud/churn values arrive as plain
 * 0..1 floats from the ground DataTexture; this is pure surface look.
 */
import { WORLD_SIZE } from "./terrain";

/** cheap deterministic value noise + 2-octave fbm on world-metre coords */
export const NOISE_GLSL = /* glsl */ `
float shHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 shHash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
// cellular noise: x = distance to nearest feature point, y = second nearest,
// z = per-cell random id. (y - x) ~ 0 on cell borders -> crack networks;
// x alone -> rounded aggregates (crumb).
vec3 shWorley(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(j));
      vec2 o = shHash22(i + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = o.x + o.y * 1.7; }
      else if (d < d2) { d2 = d; }
    }
  }
  return vec3(sqrt(d1), sqrt(d2), fract(id));
}
float shNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(shHash(i), shHash(i + vec2(1.0, 0.0)), u.x),
             mix(shHash(i + vec2(0.0, 1.0)), shHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float shFbm(vec2 p) { return 0.55 * shNoise(p) + 0.30 * shNoise(p * 2.7) + 0.15 * shNoise(p * 6.3); }
`;
/**
 * Desiccation-crack mask for a dried mud crust: ~55 cm plates with
 * per-plate seam-width jitter (real mudcracks vary plate to plate).
 * Sin-free hash — this runs per-fragment over whole dry scenes.
 */
const CRACK_SEAM_GLSL = /* glsl */ `
float crackSeam(vec2 wuv, float plateM, float worldSizeM) {
  // Voronoi plates: irregular polygons with 5-7 sides and tapering seams,
  // like real mudcracks (a warped square lattice always reads as paving)
  vec3 w = shWorley(wuv * worldSizeM / plateM);
  float e = w.y - w.x;               // ~0 on a plate border
  float jit = fract(w.z * 7.31);     // each plate its own seam width
  return 1.0 - smoothstep(0.03 + 0.04 * jit, 0.09 + 0.07 * jit, e);
}
`;

/**
 * The mud / wet-soil surface. CALLER CONTRACT (all must be in scope):
 *   vec2  vGroundUv  — 0..1 across the world
 *   float uWorldSizeM — world extent in metres (uniform or constant)
 *   vec4  g2 — the mud-MATERIAL state sampled from uGroundTex2:
 *              R gel (thixotropic structure 0..1), G crust (desiccation),
 *              B stick (adhesion), A soilId (sandy loam→loam→silty clay→
 *              dune sand→muck, quantised)
 * and afterwards USES: none (works on col/rough in place).
 *
 * Look, layer by layer:
 *   wet   — ONE monotone perceptual ramp: dry 1.0 -> OMC 0.85 -> FC 0.59 ->
 *           plastic 0.49 -> saturated 0.40. (The old mix(col, col*0.4, wet)
 *           collapsed to col*(1-0.6*wet^2): flat through the whole field
 *           range — OMC read bone-dry and the mid states shared one color.)
 *   mud   — PATCHY coverage (1.8 m noise fields break the 4 m physics-cell
 *           blobs into dry islands and wet hollows); the BODY is the soil's
 *           own bare fines SATURATED past the liquid limit — an absolute
 *           dark body ~15% darker than the same soil merely saturated,
 *           mottled ±13% for wet sheen streaks. It must sit BELOW every
 *           wet-soil state in the ramp, always. (The old body mixed toward
 *           base*1.85+0.03 — speckle brighter than dry grass: mud read
 *           LIGHTER than the wet soil around it, and after drying +
 *           crusting the mud field became the palest wet patch of ground.)
 *           Freshly REMOLDED mud (gel broken by wheel/spade) reads darker;
 *           drying mud pales a touch before the crust takes over.
 *   dry   — the REAL crust field (grows while drying, slakes away in rain)
 *           pales the surface into ~55 cm cracked plates; the surface skin
 *           dries long before the column, so plates show while still moist
 * rough — wet sheen 0.20 → glisten by remould state (fresh churn 0.13,
 *           re-gelled 0.32) → crusted matte 0.86
 */
export const MUD_SURFACE_GLSL = /* glsl */ `
${CRACK_SEAM_GLSL}
void mudSurface(inout vec3 col, inout float rough, vec2 wuv, float wet, float mud, float worldSizeM, vec4 g2) {
  vec2 mp = wuv * worldSizeM;
  float nP = shNoise(mp * 0.55);            // ~1.8 m coverage patches
  float nM = shNoise(mp * 2.9);             // ~34 cm mottle
  float nG = shNoise(mp * 11.0);            // ~9 cm grain
  // patchy coverage: mud never covers a cell uniformly
  float cov = clamp(mud * (0.55 + 0.60 * nP) * (0.82 + 0.18 * nM), 0.0, 1.0);
  // moisture ramp: one monotone curve with a visible step between every
  // state (OMC is damp, saturated is 2.4 stops down — never the same color)
  col *= 1.0 - 0.60 * pow(clamp(wet, 0.0, 1.0), 0.62);
  // ---- moisture-regime STRUCTURE (cm-scale), faded out with eye distance so it
  // never shimmers and costs nothing past ~40 m. The ramp above sets the
  // colour of each state; this gives each state its TEXTURE:
  //   very dry  pale, dusty grain; clayey ground cracks into curled plates
  //   OMC       friable crumb — rounded aggregates, dark crevices, matte
  //   saturated slumped smooth (structure fades out)
  float wetC = clamp(wet, 0.0, 1.0);
  float dryW = 1.0 - smoothstep(0.04, 0.34, wetC);
  float omcW = smoothstep(0.14, 0.42, wetC) * (1.0 - smoothstep(0.62, 0.90, wetC));
  float satW = smoothstep(0.66, 0.96, wetC);
  float eyeD = length(mp - 0.5 * worldSizeM - cameraPosition.xz) + 0.5 * abs(cameraPosition.y);
  float lodNear = 1.0 - smoothstep(9.0, 40.0, eyeD);
  float lodGrain = 1.0 - smoothstep(4.0, 20.0, eyeD);
  float grainN = (shNoise(mp * 65.0) - 0.5) * 0.17 + (shNoise(mp * 19.0) - 0.5) * 0.11;
  col *= 1.0 + grainN * lodGrain * (0.45 + 0.85 * dryW) * (1.0 - 0.7 * satW);
  float lumS = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lumS), 0.18 * dryW) * (1.0 + 0.08 * dryW);   // dry soil: paler, greyer
  // which ground cracks: soil id byte 0/.2/.4/.6/.8/1 = sandy loam / loam /
  // silty clay loam / dune sand / muck / gravel — clay shrinks, sand does not
  float sId = g2.a;
  float clayS = sId < 0.1 ? 0.15 : (sId < 0.3 ? 0.55 : (sId < 0.5 ? 1.0 : (sId < 0.7 ? 0.0 : (sId < 0.9 ? 0.2 : 0.0))));
  float kC = dryW * lodNear * clayS * smoothstep(0.20, 0.55, shNoise(mp * 0.21));
  if (kC > 0.01) {
    vec3 w1 = shWorley(mp * 2.6);                       // ~38 cm plates
    float e1 = w1.y - w1.x;
    float crack1 = 1.0 - smoothstep(0.035, 0.105, e1);  // 1.5-4 cm wide
    vec3 w2 = shWorley(mp * 9.0 + 17.0);                // ~11 cm secondary net
    float crack2 = (1.0 - smoothstep(0.030, 0.075, w2.y - w2.x)) * smoothstep(0.30, 0.70, w1.x);
    float plate = 0.90 + 0.20 * w1.z;                   // each plate its own tone
    float lip = smoothstep(0.10, 0.30, e1);             // curled edges catch light
    col *= mix(1.0, plate * (0.86 + 0.18 * lip), kC);
    col *= 1.0 - clamp(crack1 + 0.6 * crack2, 0.0, 1.0) * kC * 0.64;
  }
  float kO = omcW * lodNear * (1.0 - 0.6 * satW);
  if (kO > 0.01) {
    vec3 c1 = shWorley(mp * 11.0 + 5.0);                // ~9 cm crumbs
    // gentle: tilth is texture, not spots — crevices darken ~20%, aggregates lift ~8%
    float shade = mix(1.08, 0.80, smoothstep(0.0, 0.62, c1.x)) * (0.95 + 0.10 * c1.z);
    vec3 c2 = shWorley(mp * 2.6 + 41.0);                // ~38 cm clods
    shade *= mix(1.0, 0.90 + 0.16 * smoothstep(0.0, 0.6, c2.x), 0.6);
    col *= mix(1.0, shade, kO * (0.55 + 0.45 * lodNear));
  }
  // mud body: the soil's own bare FINES, saturated past the liquid limit —
  // darker than the same soil in any wet state (a mud pool also buries the
  // vegetation tint, so this is absolute, not col-relative). Mottle is ±13%
  // wet-sheen streaking, not brightness speckle. Remoulded churn darkens;
  // drying mud pales slightly ahead of the crust.
  float gelF = g2.r, crust = g2.g, soilId = g2.a;
  // six soils now: byte 0/51/102/153/204/255 → sandy loam / loam / silty
  // clay loam / dune sand / muck / gravel. Every body stays below its own
  // saturated tint (the darkest-state rule) — muck is the darkest mud in
  // the world, gravel mud the palest gray-brown.
  vec3 mudBase = soilId > 0.9 ? vec3(0.30, 0.27, 0.23)          // gravel (bars/gorge)
               : soilId > 0.7 ? vec3(0.055, 0.048, 0.040)        // muck (swamp)
               : soilId > 0.5 ? vec3(0.22, 0.175, 0.125)         // dune sand
               : (soilId > 0.3 ? vec3(0.096, 0.082, 0.068)       // silty clay loam
                               : (soilId > 0.1 ? vec3(0.138, 0.103, 0.072)
                                               : vec3(0.192, 0.152, 0.104))); // sandy loam
  vec3 mudCol = mudBase * (0.87 + 0.26 * nM) * (0.92 + 0.16 * nG);
  mudCol *= 1.0 - 0.18 * (1.0 - gelF);
  mudCol *= mix(0.88, 1.0, clamp(wet, 0.0, 1.0));
  col = mix(col, mudCol, cov * 0.9);
  // desiccation: the crust field pales into cracked plates with dark seams
  // (rain re-slakes the crust and the pattern fades away again). Fresh
  // saturation hides it FULLY — a crust is a desiccation feature and cannot
  // exist under water or at saturation (the river bed used to keep 45% of
  // its crust under 20 cm of running water — pale plates shining through the
  // veil, the channel read as a dry mud flat)
  float crustV = crust * (1.0 - clamp((wet - 0.45) / 0.25, 0.0, 1.0));
  if (crustV > 0.015) {
    float seam = crackSeam(wuv, 0.55, worldSizeM);
    // plates pale strongly off the DARK mud body (crusted dried mud is the
    // one pale state — still never lighter than dry virgin ground)
    col = mix(col, col * 1.38 + vec3(0.055), crustV * 0.5);
    col *= 1.0 - seam * crustV * 0.55;
  }
  // roughness: wet sheen -> remould-state glisten -> crusted matte.
  // Liquid mud carries a water film: FRESH churn (gel broken) glistens
  // hardest at 0.13, re-gelled structure recovers to 0.32, and the drying
  // crust kills the sheen entirely (matte dust, 0.86)
  float glR = mix(mix(0.32, 0.13, 1.0 - gelF), 0.86, crustV);
  rough = mix(rough, 0.20, clamp(wet, 0.0, 1.0) * 0.9);
  rough = mix(rough, glR * (0.82 + 0.18 * nG), cov);
}
`;

/**
 * Micro-relief normal perturbation for glisten: soft fbm undulation whose
 * amplitude grows with mud (ripple creep) and wetness (rain-pocked sheen).
 * CALLER CONTRACT: nrm is the WORLD-space surface normal (before
 * viewMatrix transforms it into three's shading `normal`), vGroundUv +
 * uWorldSizeM as above, wet + mud floats in scope. Appends to nrm — call
 * AFTER the base+delta gradient is already folded in; the view-space
 * shading normal must be derived FROM the result so the lighting and the
 * sheen ride the same perturbed surface.
 */
export const MUD_NORMAL_GLSL = /* glsl */ `
void mudNormal(inout vec3 nrm, vec2 wuv, float wet, float mud, float worldSizeM) {
  vec2 mp = wuv * worldSizeM;
  float eyeD = length(mp - 0.5 * worldSizeM - cameraPosition.xz) + 0.5 * abs(cameraPosition.y);
  float lodGrain = 1.0 - smoothstep(4.0, 22.0, eyeD);
  float wetC = clamp(wet, 0.0, 1.0);
  // dry + moist soil is rough at the cm scale (grit, crumbs); saturated smooths out
  float roughSoil = (1.0 - smoothstep(0.55, 0.95, wetC)) * lodGrain;
  float amp = 0.030 * mud + 0.018 * wet;
  if (amp < 1e-4 && roughSoil < 1e-3) return;
  float e = 0.05;
  vec3 d = vec3(0.0);
  if (amp >= 1e-4) {
    float c0 = shFbm(mp * 6.0);
    float cx = shFbm((mp + vec2(e, 0.0)) * 6.0);
    float cz = shFbm((mp + vec2(0.0, e)) * 6.0);
    d += vec3(-(cx - c0) / e * amp, 0.0, -(cz - c0) / e * amp);
  }
  if (roughSoil > 1e-3) {
    float g = 0.02;
    float h0 = shNoise(mp * 38.0) + 0.6 * shNoise(mp * 14.0);
    float hx = shNoise((mp + vec2(g, 0.0)) * 38.0) + 0.6 * shNoise((mp + vec2(g, 0.0)) * 14.0);
    float hz = shNoise((mp + vec2(0.0, g)) * 38.0) + 0.6 * shNoise((mp + vec2(0.0, g)) * 14.0);
    d += vec3(-(hx - h0) / g, 0.0, -(hz - h0) / g) * 0.011 * roughSoil;
  }
  nrm = normalize(nrm + d);
}
`;

/**
 * The wet/mud SHEEN — the piece MeshStandardMaterial can't give without an
 * environment map: a fresnel reflection of the sky hemisphere (reads even
 * under a black storm sky, grows at grazing angles like real wet ground)
 * plus a tight sun glint off the perturbed normal (sparkles when the sun
 * is out). CALLER CONTRACT: nrm must be the WORLD-space surface normal
 * (the same vector viewMatrix turns into the shading normal — NOT the
 * view-space `normal` three.js builds: the fresnel dot below mixes nrm
 * with the world-space view ray, and a view-space normal there reads
 * ndv≈0 at every camera angle — the reflectance pinned at its GRAZING
 * maximum, a ~20% sky glow over the whole wet window that shaded the
 * overlay apart from the static mesh = the "square box" report). Call
 * AFTER mudNormal so the glint rides the micro-relief; needs vWpos (world
 * position varying), cameraPosition (three.js built-in), sky/sun colours
 * + sun direction as uniforms.
 *
 * Reflectance is PHYSICALLY CAPPED: real wet soil is a rough dielectric —
 * ~4% at nadir rising to at most ~a quarter at grazing (smooth silt
 * glistening). The earlier pow(1-ndv, 2.2) * 1.15 added up to 90% of a
 * BRIGHT sky over whole hillsides on soaked worlds — the "white layer over
 * the terrain" that read as a floating sheet above the ground and filled
 * ditches with snow. Now: Schlick-ish 4%->26%, sky dimmed to water-sky
 * brightness × 0.55, glint at the same budget — a sheen you have to squint
 * for at nadir and can still catch at grazing, never a wash.
 */
export const MUD_SHEEN_GLSL = /* glsl */ `
void mudSheen(inout vec3 col, vec3 nrm, vec3 wpos, float wet, float mud,
              vec3 skyCol, vec3 sunDir, vec3 sunCol) {
  float sheen = clamp(wet * 0.75 + mud * 0.55, 0.0, 1.0);
  if (sheen < 0.01) return;
  vec3 vDir = normalize(wpos - cameraPosition);
  float ndv = max(dot(nrm, -vDir), 0.0);
  // wet-earth reflectance curve: 4% looking straight down -> 26% at grazing
  // (a rough dielectric, not a mirror — hard ceiling, no blowout)
  float refl = 0.04 + 0.22 * pow(1.0 - ndv, 3.0);
  // sky sheen: the sky env is tuned BRIGHT for the water surface (0.62-0.82
  // in clear sky) — wet soil only returns a fraction of it
  col += skyCol * refl * sheen * 0.55;
  // sun glint: tight lobe, perturbed normal gives it sparkle
  float glint = pow(max(dot(reflect(vDir, nrm), normalize(sunDir)), 0.0), 60.0);
  col += sunCol * glint * sheen * 0.55;
}
`;

/**
 * The water surface — ONE look shared by ALL THREE water renderers (the river
 * ribbon mesh, the fine-tier pond sheet and the contact film sheet), so water
 * reads the same everywhere a handoff happens.
 *
 * CALLER CONTRACT (all in scope before including):
 *   uniform float uTime, uRain;
 *   uniform vec2  uWindDir;
 *   uniform vec3  uSky, uSun, uSunDir, uCamPos;
 *   uniform sampler2D uFlowTex;   // world flow field: RG dir·speed, B vigour
 * and afterwards USES: writes col (rgb, fog NOT applied) + alpha [0..1]; the
 * caller still owns the depth<0.6mm discard, its window/edge fades and the
 * fog mix.
 *
 * The look is a stylised WATER VOLUME (the Timberborn read), layer by layer:
 *   body  — a teal graded by depth: clear aqua shallows the BED reads through
 *           (the rocky->gravel->sand fining must be visible) into deep teal;
 *           a river runs at half a pond's extinction so its bed always shows
 *   waves — where a CURRENT is present (riverOn) crest lines ACROSS the
 *           channel with phase travelling DOWNSTREAM, plus rapids chop that
 *           scales with vigour; still water keeps gentle wind trains
 *   streak— anisotropic noise stretched ALONG the current and advected with
 *           it: the drifting flow-lines field that makes even a STILL frame
 *           read as moving water
 *   foam  — a scalloped shoreline band where the water pinches out, streak
 *           foam and breaking crests in the rapids (vigour-gated), and thin
 *           scum lines on the shallows; patchy and grained, never a snowfield
 *   glint — ONE tight warm sun streak riding the wave crests, hard-capped.
 *           (The old two-lobe glint at up to +0.9 white on noise-riding
 *           normals was the 'strange white reflections near the player'.)
 *   film  — under 4 cm of water this is WET GROUND, not paint: a dark
 *           translucent veil; the teal volume opens with the smoothstep into
 *           real depth
 *   rim   — a thin waterline where the sheet dies into the ground, tinted,
 *           subtle
 */
export const WATER_SURFACE_GLSL = /* glsl */ `
uniform sampler2D uFlowTex;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),
             mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wFbm(vec2 p) { return 0.55 * wNoise(p) + 0.30 * wNoise(p * 2.7) + 0.15 * wNoise(p * 6.1); }
void waterLook(vec3 wpos, float depth, out vec3 col, out float alpha) {
  vec2 p = wpos.xz;
  // ---- the current: RG = direction*speed, B = vigour 0..1
  vec4 flS = texture2D(uFlowTex, (p + vec2(${(WORLD_SIZE / 2).toFixed(1)})) / ${WORLD_SIZE.toFixed(1)});
  vec2 fDir = flS.rg * 2.0 - 1.0;
  float spd = flS.b;
  float riverOn = smoothstep(0.04, 0.30, spd);

  // depth-normalised body factor
  float dN = 1.0 - exp(-depth * mix(3.5, 1.6, riverOn));

  vec2 fd = normalize(fDir + uWindDir * 1e-4);
  float alongC = dot(p, fd);
  float acrossC = dot(p, vec2(-fd.y, fd.x));

  // TRUE 4-6 m/s MOUNTAIN RIVER FLOW VELOCITY:
  // In the gorge, water surges downstream at 4.2 to 5.5 m/s.
  // In flatter reaches, it cruises at 1.8 to 2.4 m/s.
  float flowSpeed = mix(1.8, 5.4, spd);
  float flowDist = uTime * flowSpeed;

  // sky luminance for lighting response
  float skyL = clamp(dot(uSky, vec3(0.333)), 0.0, 1.0);

  // distance from camera for adaptive LOD
  float far = smoothstep(3.0, 22.0, distance(uCamPos, wpos));

  // Downstream travelling wave trains racing at true flowSpeed
  float warp = sin(acrossC * 0.35) * 1.2;
  float c1 = sin(1.65 * (alongC - flowDist) + warp);
  float c2 = sin(3.30 * (alongC - flowDist * 1.06) + acrossC * 0.7);
  float c3 = sin(5.60 * (alongC - flowDist * 1.14) + acrossC * 1.4) * sin(acrossC * 2.2);
  float c0 = sin(0.75 * (alongC - flowDist * 0.92) + warp * 0.4);
  float flowR = (0.35 * c0 + 0.50 * c1 + 0.28 * c2 + 0.45 * c3 * spd) * riverOn;

  // Wind ripples on still water / ponds
  float w1 = sin(dot(p, uWindDir) * 2.4 + uTime * 2.0) * cos(p.x * 1.7 - uTime * 1.4);
  float w2 = sin((p.x + p.y) * 3.1 + uTime * 2.8) * 0.5;
  float prickle = uRain * (sin(p.x * 21.0 + uTime * 11.0) * sin(p.y * 17.0 - uTime * 9.0));
  float ripple = (w1 + w2) * (1.0 - 0.75 * riverOn) + flowR;

  // Anisotropic flow streaks: thin streamlines stretched along current and hurtling downstream at 5.5 m/s
  vec2 stCoord = vec2((alongC - flowDist * 1.08) * 0.26, acrossC * 3.4);
  float streak = wNoise(stCoord) * 0.65 + wNoise(stCoord * 2.2 + vec2(19.4, 43.1)) * 0.35;

  // Surface normal perturbed along current direction:
  // Wave slopes face downstream, catching sunlight and sky reflections dynamically
  vec2 nGrad = (fd * (flowR * 0.16) + vec2(-fd.y, fd.x) * (sin(acrossC * 2.2) * 0.06 * riverOn));
  vec3 n = normalize(vec3(nGrad.x + (w1 + prickle * 0.02) * 0.12 * (1.0 - riverOn),
                          1.0,
                          nGrad.y + (w2 + prickle * 0.02) * 0.12 * (1.0 - riverOn)));
  vec3 v = normalize(uCamPos - wpos);
  float ndv = max(dot(v, n), 0.0);
  float fres = pow(1.0 - ndv, 3.0);

  // --- CRYSTALLINE ALPINE LIQUID PALETTE ---
  // Glacier-fed crystal clarity: deep emerald turquoise and sapphire tones
  vec3 shalColor = vec3(0.05, 0.34, 0.38); // shallows: clear aquatic turquoise tint
  vec3 midColor  = vec3(0.02, 0.18, 0.28); // mid-depth: rich Caribbean emerald-blue
  vec3 deepColor = vec3(0.01, 0.07, 0.16); // deep channel: dense sapphire navy

  vec3 body = mix(shalColor, midColor, smoothstep(0.04, 0.45, depth));
  body = mix(body, deepColor, smoothstep(0.35, 1.20, depth));

  // Sun warmth in clear shallows
  body += uSun * 0.08 * (1.0 - dN);

  // Dynamic relief: wave crest highlights and trough shadows
  body *= max(0.45, 0.88 + ripple * 0.22 * (0.3 + 0.7 * dN));
  body *= 1.0 + (0.16 + 0.20 * far) * riverOn * (streak - 0.5);

  // Bank contact shadow
  float contactW = max(0.10, min(mix(0.18, 0.50, far), 0.40 * depth));
  float contact = 1.0 - smoothstep(0.0, contactW, depth);
  body = mix(body, body * 0.60, contact * 0.50);

  // Sky Fresnel reflection (reflects bright sky on wave faces)
  body = mix(body, uSky * 0.92, fres * 0.55);

  // Specular sun glint sparkling off fast crests
  vec3 sd = normalize(uSunDir);
  float sp = max(dot(reflect(-v, n), sd), 0.0);
  float glint = (pow(sp, 36.0) * 0.40 + pow(sp, 110.0) * 0.60) * smoothstep(0.01, 0.06, depth);
  body += uSun * glint * 0.70;

  // Scene ambient lighting response
  body *= 0.55 + 0.45 * skyL;

  // --- CRISP RAPIDS FOAM & STREAMLINES ---
  // Fast water (4-6 m/s) forms foam only on:
  // 1. Breaking wave crests (c1 & c2 peaks)
  float crestFoam = smoothstep(0.52, 0.88, c1 * 0.58 + c2 * 0.42) * smoothstep(0.40, 0.75, spd);
  
  // 2. High-speed flow streamline aeration
  float streakFoam = smoothstep(0.68, 0.92, streak) * smoothstep(0.48, 0.82, spd);
  
  // 3. Delicate shoreline rim along the bank margin
  float edgeW = mix(0.03, 0.10, far);
  float shoreRim = smoothstep(0.003, 0.015, depth) * (1.0 - smoothstep(0.02, edgeW, depth));
  float shoreFoam = shoreRim * smoothstep(0.04, 0.25, depth) * riverOn;

  float rapFoam = riverOn * max(crestFoam * 0.88, streakFoam * 0.65);
  float totalFoam = clamp(shoreFoam + rapFoam, 0.0, 1.0);

  // Brilliant aerated foam with subtle sky tint
  vec3 foamCol = mix(vec3(0.96, 0.98, 1.0), uSky, 0.08);
  foamCol *= 0.65 + 0.40 * skyL;

  col = mix(body, foamCol, totalFoam * 0.92);

  // Volumetric Beer-Lambert optical extinction:
  // Shallows are crystal clear (alpha 0.25 - 0.50) so dark scoured riverbed rocks and submerged boulders show through!
  // Deep channels have dense liquid body (alpha 0.82 - 0.92).
  float depthAlpha = clamp(1.0 - exp(-depth * 2.8), 0.0, 0.92);
  alpha = max(depthAlpha, totalFoam * 0.86);
  alpha *= smoothstep(0.008, 0.04, depth);
}
`;

/**
 * The water surface's own VERTICAL motion, for the vertex stage of the river
 * ribbon: the SAME wave trains waterLook shades in the fragment, evaluated as
 * height and advected downstream with the current. Amplitude rides vigour —
 * still water carries wind chop only, the rapids get real travelling crests.
 * shoreFade (0..1) kills the waves at the banks so they never poke through
 * the terrain.
 *
 * CALLER CONTRACT: uniform float uTime; uniform vec2 uWindDir; uniform
 * vec3 uCamPos; and the VERTEX-STAGE TWIN sampler uFlowTexV.
 */
export const WATER_WAVE_GLSL = /* glsl */ `
uniform sampler2D uFlowTexV;
uniform vec3 uCamPos;
float waterWaveY(vec2 p, float shoreFade) {
  vec4 flS = texture2D(uFlowTexV, (p + vec2(${(WORLD_SIZE / 2).toFixed(1)})) / ${WORLD_SIZE.toFixed(1)});
  vec2 fDir = flS.rg * 2.0 - 1.0;
  float spd = flS.b;
  vec2 fd = normalize(fDir + vec2(1e-4, 0.0));
  float alongC = dot(p, fd);
  float acrossC = dot(p, vec2(-fd.y, fd.x));
  float flowSpeed = mix(1.8, 5.4, spd);
  float flowDist = uTime * flowSpeed;
  float warp = sin(acrossC * 0.35) * 1.2;
  float vig = 0.35 + 0.65 * clamp(spd, 0.0, 1.0);
  float y = 0.0;
  y += 0.12 * vig * sin(1.65 * (alongC - flowDist) + warp);
  y += 0.06 * vig * sin(3.30 * (alongC - flowDist * 1.06) + acrossC * 0.7);
  y += 0.03 * vig * sin(5.60 * (alongC - flowDist * 1.14) + acrossC * 1.4);
  y += 0.02 * sin(dot(p, uWindDir) * 2.4 + uTime * 2.0) * cos(p.x * 1.7 - uTime * 1.4);
  float lod = clamp(distance(uCamPos.xz, p) / 45.0, 0.0, 1.0);
  return y * shoreFade * (1.0 + 1.8 * lod);
}
`;
