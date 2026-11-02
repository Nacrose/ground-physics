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
float shHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
  vec2 wpM = wuv * worldSizeM;
  // organic plate warp: real desiccation cracks form IRREGULAR polygons,
  // never a square lattice. The warp frequency must be at PLATE scale
  // (~1 m features) so neighbouring plates get different offsets — a
  // low-frequency warp just shifts the whole grid rigidly and it still
  // reads as perfect squares (needs shNoise from NOISE_GLSL, included
  // before MUD_SURFACE_GLSL by both callers)
  vec2 warp = vec2(shNoise(wpM * 0.85) - 0.5, shNoise(wpM * 0.85 + 31.7) - 0.5)
            + 0.5 * vec2(shNoise(wpM * 2.3 + 11.3) - 0.5, shNoise(wpM * 2.3 + 47.9) - 0.5);
  vec2 cp = (wpM + warp * plateM * 0.6) / plateM;
  vec2 cid = floor(cp);
  vec3 p3s = fract(vec3(cid.xyx) * 0.1031);
  p3s += dot(p3s, p3s.yzx + 33.33);
  float hsh = fract((p3s.x + p3s.y) * p3s.z);
  vec2 f = fract(cp);
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  return 1.0 - smoothstep(0.015 + 0.05 * hsh, 0.06 + 0.06 * hsh, edge);
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
  float amp = 0.030 * mud + 0.018 * wet;
  if (amp < 1e-4) return;
  vec2 mp = wuv * worldSizeM;
  float e = 0.05;
  float c0 = shFbm(mp * 6.0);
  float cx = shFbm((mp + vec2(e, 0.0)) * 6.0);
  float cz = shFbm((mp + vec2(0.0, e)) * 6.0);
  nrm = normalize(nrm + vec3(-(cx - c0) / e * amp, 0.0, -(cz - c0) / e * amp));
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
 * The water surface — ONE look shared by BOTH water renderers (the contact
 * film sheet at 6.25 cm and the fine-tier puddle sheet at 4 m), so water
 * reads the same on either side of the contact-window edge.
 *
 * CALLER CONTRACT (all in scope before including):
 *   uniform float uTime, uRain;
 *   uniform vec2  uWindDir;
 *   uniform vec3  uSky, uSun, uSunDir, uCamPos;
 *   uniform sampler2D uFlowTex;   // world flow field: RG dir·speed, B vigour
 * and afterwards USES: writes col (rgb, fog NOT applied) + alpha [0..1]; the
 * caller still owns the depth<0.6mm discard, its window/edge alpha fade and
 * the fog mix.
 *
 * Look, layer by layer:
 *   body  — CLEAR shallow water: a translucent olive-tea tint the BED shows
 *           through (the terrain's own wet shading owns the darkening), then
 *           Beer-Lambert depth toward the sky-reflecting slate of deep water;
 *           a river runs slightly turbid-milky where the current is strong
 *   waves — where a CURRENT is present (riverOn) the wind capillary trains
 *           fade back and the river's OWN trains take over: crests ACROSS
 *           the channel with phase travelling DOWNSTREAM (a slow meander
 *           warp so the lines aren't ruler-straight) plus a rapids chop that
 *           scales with vigour. THIS is what makes the water read as flowing
 *           instead of rippling in place: the pattern moves along the channel
 *   streak— anisotropic noise stretched ALONG the current and advected with
 *           it (low frequency downstream, high across): the drifting streak
 *           field real rivers show even before any foam
 *   foam  — white water where the current works: streak foam drawn out along
 *           the flow, breaking-crest foam in the rapids (vigour-gated), and
 *           drifting scum lines hugging the thin banks. Ponds/tarns (no flow
 *           field entry) keep the wind look with zero foam
 *   glint — two-lobe sun specular: a tight sparkle riding the waves plus a
 *           broad soft sheen, so the surface catches the sun like a real one
 *   rim   — a meniscus: thin bright waterline where the film pinches out,
 *           instead of a decal edge cut into the ground
 *   veil  — alpha opens with ACCUMULATED depth only: a sub-cm film is wet
 *           ground (near-invisible sheet), and even deep water keeps a
 *           quarter of the bed readable through it — clarity, not paint
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
  // ---- the current: RG = direction*speed, B = vigour 0..1. Ponds, the tarn
  // and dry ground carry (0,0) and keep the wind-ripple look; on the river
  // the current owns the surface
  vec4 flS = texture2D(uFlowTex, (p + vec2(${(WORLD_SIZE / 2).toFixed(1)})) / ${WORLD_SIZE.toFixed(1)});
  vec2 fDir = flS.rg * 2.0 - 1.0;
  float spd = flS.b;
  float riverOn = smoothstep(0.04, 0.30, spd);
  // depth-normalised ramp (Beer-Lambert-ish): 0 = film, 1 = deep — but a
  // RIVER runs CLEAR: its extinction is half a pond's (tea-stained still
  // water vs. actively flushed current), so a 20 cm channel still shows its
  // bed through. With the pond's 7.0 the whole channel saturated to full
  // sky-slate — an opaque plate that read as a snowfield, and the
  // gravel→sand bed fining was invisible under it
  float dN = 1.0 - exp(-depth * mix(7.0, 3.0, riverOn));
  vec2 fd = normalize(fDir + uWindDir * 1e-4); // degenerate -> wind dir (riverOn ~ 0 anyway)
  float alongC = dot(p, fd);
  float acrossC = dot(p, vec2(-fd.y, fd.x));
  float drift = uTime * (0.40 + 2.2 * spd); // downstream pattern advection [m]
  // wind capillary trains (a pond's look) + rain prickle
  float w1 = sin(dot(p, uWindDir) * 2.6 + uTime * 2.2) * cos(p.x * 1.9 - uTime * 1.5);
  float w2 = sin((p.x + p.y) * 3.4 + uTime * 3.0) * 0.5;
  float w3 = sin(dot(p, vec2(-uWindDir.y, uWindDir.x)) * 4.1 - uTime * 2.6) * 0.35;
  float w4 = sin(dot(p, uWindDir) * 9.0 + uTime * 3.4) * sin(dot(p, vec2(-uWindDir.y, uWindDir.x)) * 7.5 - uTime * 2.9) * 0.30;
  float prickle = uRain * (sin(p.x * 21.0 + uTime * 11.0) * sin(p.y * 17.0 - uTime * 9.0));
  // the current's trains: crest lines ACROSS the channel, phase travelling
  // DOWNSTREAM (phase rides 'alongC'), a slow meander warp bending them,
  // plus a short ~0.9 m chop — close-range liveliness; without it the
  // surface at your boots is two slow swells and reads glassy
  float warp = sin(acrossC * 0.21) * 1.6;
  float c1 = sin(alongC * 2.05 + warp - drift * 0.85);
  float c2 = sin(alongC * 4.6 - drift * 1.4 + acrossC * 0.6);
  float c3 = sin(alongC * 3.1 - drift * 2.1) * sin(acrossC * 2.3 + drift * 0.9); // rapids chop
  float c4 = sin(alongC * 7.3 - drift * 1.9 + acrossC * 1.2) * sin(acrossC * 5.1 + drift * 1.1); // short chop
  float flowR = (0.55 * c1 + 0.32 * c2 + 0.55 * c3 * spd + 0.45 * c4 * spd) * riverOn;
  float ripple = (w1 + w2 + w3 + w4) * (1.0 - 0.6 * riverOn) + flowR;
  float amp = mix(0.030 + 0.055 * dN, 0.030 + 0.16 * spd, riverOn);
  // anisotropic streaks: noise stretched ALONG the current and advected with
  // it — the drifting streak field real rivers show even without foam.
  // Dense across (1.8 m), long along (18 m): this anisotropy is what makes a
  // STILL frame read as flowing — direction is texture, motion is time
  float streak = wFbm(vec2(alongC * 0.5 - drift * 0.8, acrossC * 3.4));
  float streak2 = wFbm(vec2(alongC * 0.9 - drift * 1.15 + 37.2, acrossC * 4.6 + 11.7));
  vec3 n = normalize(vec3(ripple * amp + prickle * 0.10, 1.0,
                          (w2 - w1 * 0.8 - w3 * 0.6 - flowR * 0.8) * amp + prickle * 0.09));
  vec3 v = normalize(uCamPos - wpos);
  float ndv = max(dot(v, n), 0.0);
  float fres = pow(1.0 - ndv, 2.4);
  // sun specular, two lobes: a broad sheen that catches whole wave faces
  // (reads at any camera angle) + a tight sparkle riding the crests
  vec3 sd = normalize(uSunDir);
  float sp = max(dot(reflect(-v, n), sd), 0.0);
  float glint = pow(sp, 48.0) * 0.5 + pow(sp, 10.0) * 0.07;
  // body: clear tea over the (wet-shaded, matte) bed -> sky slate with depth;
  // the shallow tint leans on uSky so it dims under storm light like everything
  // deepT is CAPPED at ~1.0 x sky (was 0.70 + 0.85*fres = 1.55x at grazing —
  // every distant pond clipped to a white plate at grazing camera angles);
  // grazing water still brightens toward the sky, it just can't blow past it
  vec3 shallowT = mix(vec3(0.30, 0.345, 0.29), uSky * 0.42, 0.35);
  // a river runs green-teal and CLEAR, not pale ice-blue — the grazing sky
  // mirror is capped too (deepT below), or the whole channel reads as a
  // white plate at gameplay camera angles
  shallowT = mix(shallowT, vec3(0.24, 0.335, 0.30), riverOn * 0.55);
  vec3 deepT = uSky * (0.52 + 0.45 * fres * (1.0 - 0.45 * riverOn));
  col = mix(shallowT, deepT, dN);
  // moving ripple shading on the body itself — the surface visibly LIVES
  // even looking straight down (fresnel alone cannot do that). On the river
  // the current's trains shade at nearly DOUBLE contrast: crest-bright /
  // trough-dark banding along the channel is what reads as 'flowing' at
  // gameplay distance, and the drifting streak field dapples it as it goes
  col *= 0.91 + 0.16 * ripple * (0.25 + dN);
  col *= 1.0 - 0.40 * riverOn * abs(flowR) * (0.30 + 0.70 * dN);
  col *= 1.0 + 0.38 * riverOn * (streak - 0.5);
  col += uSun * glint * (0.55 + 0.75 * dN + 0.35 * riverOn);
  // ---- foam: white water where the current works — but PATCHY, a rapid
  // is dark green water with white STREAKS and crest lines, not a snowfield:
  // the thresholds ride high enough that only the strong quarter of the
  // streak field and the breaking crests whiten (snowfield regression)
  float foam = 0.0;
  foam += smoothstep(0.58 - 0.25 * spd, 0.85, streak) * 0.95 * riverOn;
  foam += smoothstep(0.62, 0.95, c3) * 1.1 * pow(spd, 1.4);
  foam += riverOn * (1.0 - dN) * (0.15 + 0.50 * smoothstep(0.45, 0.85, streak2));
  foam *= 0.35 + 0.65 * dN;
  foam = clamp(foam, 0.0, 0.8);
  vec3 foamC = mix(vec3(0.84, 0.88, 0.91), uSky, 0.30) * (0.58 + 0.42 * dN);
  // grain the foam — aerated water is speckled, not a flat paint fill
  foamC *= 0.88 + 0.24 * wNoise(p * 14.0 + vec2(uTime * 0.7, 0.0));
  col = mix(col, foamC, foam);
  // meniscus waterline: bright pinch where the film dies into the ground
  float men = smoothstep(0.0006, 0.0014, depth) * (1.0 - smoothstep(0.0022, 0.0050, depth));
  col += uSky * (fres * 0.55 + 0.22) * men;
  // clarity: veil opens with accumulated depth, deep water keeps 22% bed;
  // foam is solid white — it buys its own opacity. A RUNNING river claims
  // more of its pixel than a puddle film (0.43 average veil over the bed
  // let the bright crusted mud underneath own the look — the channel read
  // as a pale dry plate, not water)
  float veil = smoothstep(0.0009, 0.010, depth);
  alpha = veil * (0.22 + 0.58 * dN + 0.26 * riverOn);
  alpha = min(alpha + foam * 0.30, 0.85);
}
`;
