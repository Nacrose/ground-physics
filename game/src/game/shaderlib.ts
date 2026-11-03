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
  // ---- the current: RG = direction*speed, B = vigour 0..1. Ponds, the tarn
  // and dry ground carry (0,0) and keep the wind-ripple look; on the river
  // the current owns the surface
  vec4 flS = texture2D(uFlowTex, (p + vec2(${(WORLD_SIZE / 2).toFixed(1)})) / ${WORLD_SIZE.toFixed(1)});
  vec2 fDir = flS.rg * 2.0 - 1.0;
  float spd = flS.b;
  float riverOn = smoothstep(0.04, 0.30, spd);
  // depth-normalised body fraction: a river runs CLEAR (a pond's extinction
  // would saturate the channel to an opaque plate and bury the bed fining)
  float dN = 1.0 - exp(-depth * mix(6.0, 1.5, riverOn));
  vec2 fd = normalize(fDir + uWindDir * 1e-4); // degenerate -> wind dir (riverOn ~ 0 anyway)
  float alongC = dot(p, fd);
  float acrossC = dot(p, vec2(-fd.y, fd.x));
  float drift = uTime * (0.40 + 2.0 * spd); // downstream pattern advection [m]
  // sky luminance — the water BODY must ride the scene light like every
  // other surface (a storm-dim world with a bright cyan plate reads as a
  // glowing decal dropped on the ground)
  float skyL = clamp(dot(uSky, vec3(0.333)), 0.0, 1.0);
  // flow-texture LOD: the streak field reads as DIRECTION at gameplay
  // distance, but at your boots it collapses into brushed-metal noise — so
  // it (and its foam) fades out over the last few metres to the camera and
  // close water keeps the calm wind look instead
  float far = smoothstep(3.0, 16.0, distance(uCamPos, wpos));
  // wind capillary trains (a pond's look) + rain prickle
  float w1 = sin(dot(p, uWindDir) * 2.4 + uTime * 2.0) * cos(p.x * 1.7 - uTime * 1.4);
  float w2 = sin((p.x + p.y) * 3.1 + uTime * 2.8) * 0.5;
  float prickle = uRain * (sin(p.x * 21.0 + uTime * 11.0) * sin(p.y * 17.0 - uTime * 9.0));
  // the current's trains: crest lines ACROSS the channel, phase travelling
  // DOWNSTREAM (phase rides 'alongC'), a slow meander warp bending them,
  // plus rapids chop — this advection is what makes the water FLOW
  float warp = sin(acrossC * 0.21) * 1.6;
  float c1 = sin(alongC * 2.05 + warp - drift * 0.85);
  float c2 = sin(alongC * 4.6 - drift * 1.4 + acrossC * 0.6);
  float c3 = sin(alongC * 3.1 - drift * 2.1) * sin(acrossC * 2.3 + drift * 0.9); // rapids chop
  float c4 = sin(alongC * 7.3 - drift * 1.9 + acrossC * 1.2) * sin(acrossC * 5.1 + drift * 1.1); // short chop
  float flowR = (0.55 * c1 + 0.32 * c2 + 0.55 * c3 * spd + 0.45 * c4 * spd) * riverOn;
  float ripple = (w1 + w2) * (1.0 - 0.6 * riverOn) + flowR;
  // anisotropic streaks: noise stretched ALONG the current and advected with
  // it — the drifting flow-lines field real rivers show even without foam.
  // Dense across, long along: the anisotropy is what makes a STILL frame
  // read as flowing — direction is texture, motion is time
  float streak = wFbm(vec2(alongC * 0.45 - drift * 0.85, acrossC * 4.4));
  float streak2 = wFbm(vec2(alongC * 0.9 - drift * 1.2 + 37.2, acrossC * 5.2 + 11.7));
  // surface normal — CALM and coherent. The old normal rode high-frequency
  // noise under a broad glint lobe: scintillating white speckle patches that
  // followed the player (the 'white reflections around user near water')
  vec3 n = normalize(vec3(ripple * 0.14 + prickle * 0.03, 1.0,
                          (w2 - w1 * 0.7 - flowR * 0.7) * 0.14 + prickle * 0.025));
  vec3 v = normalize(uCamPos - wpos);
  float ndv = max(dot(v, n), 0.0);
  float fres = pow(1.0 - ndv, 2.6);
  // sun: ONE tight warm streak on the wave crests — capped, never a white
  // plate however the camera swings. A rain FILM carries no glitter (a 2 mm
  // sheet on the ground is not open water — glittering films around the
  // player were half of the 'white reflections' report)
  vec3 sd = normalize(uSunDir);
  float sp = max(dot(reflect(-v, n), sd), 0.0);
  float glint = pow(sp, 80.0) * 0.16 * smoothstep(0.01, 0.06, depth);
  // body: teal graded by depth — MULTIPLIED by the scene's sky luminance so
  // it dims with the weather exactly like the ground around it, with a warm
  // sun kiss on the shallows so it sits in the golden-hour light
  vec3 shal = mix(vec3(0.235, 0.42, 0.40), uSky * vec3(0.40, 0.52, 0.50), 0.30);
  vec3 deep = vec3(0.052, 0.175, 0.19);
  vec3 body = mix(shal, deep, dN);
  body += uSun * 0.05 * (1.0 - dN) * (1.0 - riverOn * 0.5);
  // moving crest/trough shading — the surface LIVES even looking straight down
  body *= 0.89 + 0.22 * ripple * (0.25 + dN);
  body *= 1.0 - 0.34 * riverOn * abs(flowR) * (0.3 + 0.7 * dN);
  body *= 1.0 + (0.18 + 0.26 * far) * riverOn * (streak - 0.5);
  // grazing sky mirror, CAPPED well under sky brightness
  body = mix(body, uSky * 0.55, fres * (0.34 - 0.20 * riverOn));
  body += uSun * glint * (0.4 + 0.6 * dN);
  body *= 0.26 + 0.78 * skyL;
  // ---- thin films (<4 cm) are WET GROUND: a dark translucent veil over the
  // bed's own wet shading, not teal paint. The volume opens with depth, and
  // the shallow margin (4..9 cm) keeps a LOW alpha so the bed owns most of
  // the pixel — that is where the rocky/gravel/sand fining reads
  float filmy = 1.0 - smoothstep(0.004, 0.05, depth);
  body = mix(body, vec3(0.145, 0.16, 0.145), filmy);
  // ---- foam: a SCALLOPED shoreline band (broken by the streak noise so it
  // never draws one solid white line along the polygonal waterline) + rapids
  // streaks and crest breaks, patchy (dark water with white streaks)
  float scallop = smoothstep(0.28, 0.62, streak2 + 0.18 * wNoise(p * 3.1));
  // Timberborn waterline: a SOLID bright edge over the first ~10 cm of
  // depth (reads as a line from any distance), breaking into scalloped
  // patches on the fringe out to ~30 cm
  float edge = (1.0 - smoothstep(0.012, 0.10, depth)) * smoothstep(0.0008, 0.005, depth);
  float fringe = (1.0 - smoothstep(0.10, 0.30, depth)) * scallop;
  float band = edge * 0.85 + fringe * 0.55;
  float rap = riverOn * smoothstep(0.35, 0.70, spd) * mix(0.45, 1.0, far);
  float foam = band;
  foam += rap * (0.55 * smoothstep(0.55, 0.85, streak) + 0.45 * smoothstep(0.62, 0.95, c3));
  foam += riverOn * (1.0 - dN) * 0.25 * smoothstep(0.45, 0.85, streak2); // scum lines
  foam = clamp(foam, 0.0, 0.88);
  vec3 foamC = mix(vec3(0.86, 0.90, 0.91), uSky, 0.25) * (0.72 + 0.28 * dN);
  // grain the foam — aerated water is speckled, not a flat paint fill
  foamC *= 0.82 + 0.30 * wNoise(p * 14.0 + vec2(uTime * 0.7, 0.0));
  foamC *= 0.55 + 0.50 * skyL;
  col = mix(body, foamC, foam);
  // meniscus waterline: thin, tinted, and noise-broken — a hint of the
  // pinch where the film dies into ground, never a solid line
  float men = smoothstep(0.0006, 0.0016, depth) * (1.0 - smoothstep(0.003, 0.008, depth));
  col += uSky * 0.18 * men * (0.45 + 0.55 * wNoise(p * 5.3));
  // opacity: OPEN WATER CLAIMS ITS PIXEL (the Timberborn read). The river
  // and any pond past ~8 cm render as one opaque body whose DEPTH reads as
  // colour — translucent sheets stacked over wet-shaded terrain read as
  // paint. The downstream bed fining now reads through the bright shallow
  // gradient and the exposed gravel banks instead of through the water.
  // Only genuine thin films (<4 cm sheet flow, no current) stay a wet veil.
  float openVol = max(riverOn, smoothstep(0.045, 0.11, depth));
  alpha = mix(0.22, 0.94, openVol);
  alpha = min(alpha + foam * 0.30, 0.96);
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
 * CALLER CONTRACT: uniform float uTime; uniform vec2 uWindDir; and the
 * VERTEX-STAGE TWIN sampler uFlowTexV — in this three build a sampler uniform
 * shared by both stages never gets its texture bound for the vertex stage
 * (see worldD's twin in world.ts), so the ribbon declares uFlowTexV and
 * points it at the same DataTexture as the fragment's uFlowTex.
 */
export const WATER_WAVE_GLSL = /* glsl */ `
uniform sampler2D uFlowTexV;
float waterWaveY(vec2 p, float shoreFade) {
  vec4 flS = texture2D(uFlowTexV, (p + vec2(${(WORLD_SIZE / 2).toFixed(1)})) / ${WORLD_SIZE.toFixed(1)});
  vec2 fDir = flS.rg * 2.0 - 1.0;
  float spd = flS.b;
  vec2 fd = normalize(fDir + vec2(1e-4, 0.0));
  float alongC = dot(p, fd);
  float acrossC = dot(p, vec2(-fd.y, fd.x));
  float drift = uTime * (0.40 + 2.0 * spd);
  float warp = sin(acrossC * 0.21) * 1.6;
  float y = 0.0;
  y += 0.085 * spd * sin(alongC * 2.05 + warp - drift * 0.85);
  y += 0.054 * spd * sin(alongC * 4.6 - drift * 1.4 + acrossC * 0.6);
  y += 0.032 * spd * sin(alongC * 7.3 - drift * 1.9 + acrossC * 1.2);
  y += 0.016 * sin(dot(p, uWindDir) * 2.4 + uTime * 2.0) * cos(p.x * 1.7 - uTime * 1.4);
  return y * shoreFade;
}
`;
