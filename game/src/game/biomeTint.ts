/**
 * The ONE terrain vertex-tint formula — shared by every mesh that renders
 * the ground surface: the static world mesh (world.ts), the deformable
 * contact overlay (contact.ts) and the view-only mid ring (midring.ts).
 *
 * One definition so the 16 m window and the edit-distance ring can never
 * shade apart from the world around them.
 */
import * as THREE from "three";
import { GRID, WORLD_SIZE, TerrainData, BIOMES, B_ICE, B_MOUNTAIN, B_ROCKY, B_RIVER, terrainNormal } from "./terrain";

const HALF = WORLD_SIZE / 2;
const biomeCols = BIOMES.map((b) => new THREE.Color(b.color));

// Geological mountain rock palette
const graniteDark = new THREE.Color(0x2a2c30);   // deep basalt / charcoal slate
const graniteMid = new THREE.Color(0x44474c);    // cold alpine granite cliff face
const rockOchre = new THREE.Color(0x564d3f);     // iron oxide / sedimentary bedding strata
const rockScree = new THREE.Color(0x525458);     // broken talus / loose rock debris
const alpineSnow = new THREE.Color(0xf0f3f6);    // crisp alpine snowpack on flat ledges

// River scour palette
const riverBedrock = new THREE.Color(0x24272a);  // scoured dark wet riverbed
const riverCobble = new THREE.Color(0x46494e);   // coarse river gravel / boulders
const bedSand = new THREE.Color(0xa8997a);       // lowland alluvial sand

const tempN: [number, number, number] = [0, 0, 1];

/** bilinear biome colour (x, z in the -HALF..HALF world frame) — blends the
 *  four nearest cells' biome colours so borders shade across ~4 m, not alias */
export function biomeColorAt(t: TerrainData, x: number, z: number, out: THREE.Color): THREE.Color {
  const cell = WORLD_SIZE / GRID;
  const gx = (x + HALF) / cell - 0.5;
  const gz = (z + HALF) / cell - 0.5;
  const i0 = Math.max(0, Math.min(GRID - 1, Math.floor(gx)));
  const j0 = Math.max(0, Math.min(GRID - 1, Math.floor(gz)));
  const i1 = Math.min(GRID - 1, i0 + 1);
  const j1 = Math.min(GRID - 1, j0 + 1);
  const u = Math.max(0, Math.min(1, gx - i0));
  const v = Math.max(0, Math.min(1, gz - j0));
  const b = t.biome;
  const c00 = biomeCols[b[j0 * GRID + i0]];
  const c10 = biomeCols[b[j0 * GRID + i1]];
  const c01 = biomeCols[b[j1 * GRID + i0]];
  const c11 = biomeCols[b[j1 * GRID + i1]];
  out.setRGB(
    (c00.r * (1 - u) + c10.r * u) * (1 - v) + (c01.r * (1 - u) + c11.r * u) * v,
    (c00.g * (1 - u) + c10.g * u) * (1 - v) + (c01.g * (1 - u) + c11.g * u) * v,
    (c00.b * (1 - u) + c10.b * u) * (1 - v) + (c01.b * (1 - u) + c11.b * u) * v);
  return out;
}

/** nearest-cell biome id (x, z in the -HALF..HALF world frame) */
export function biomeIdAt(t: TerrainData, x: number, z: number): number {
  const cell = WORLD_SIZE / GRID;
  const i = Math.max(0, Math.min(GRID - 1, Math.floor((x + HALF) / cell)));
  const j = Math.max(0, Math.min(GRID - 1, Math.floor((z + HALF) / cell)));
  return t.biome[j * GRID + i];
}

/** the full painterly vertex tint: geological rock strata + slope-dependent
 *  cliff exposure + mountain snow on high ledges + scoured riverbed */
export function vertexTint(t: TerrainData, x: number, z: number, h: number, out: THREE.Color): void {
  biomeColorAt(t, x, z, out);
  const bm = biomeIdAt(t, x, z);
  
  const cell = WORLD_SIZE / GRID;
  const ci = Math.max(0, Math.min(GRID - 1, Math.floor((x + HALF) / cell)));
  const cj = Math.max(0, Math.min(GRID - 1, Math.floor((z + HALF) / cell)));
  const k = cj * GRID + ci;
  const rf = t.rockFrac ? t.rockFrac[k] : 0;
  const rv = t.river ? t.river[k] : 0;

  terrainNormal(t, x + HALF, z + HALF, tempN);
  const ny = tempN[2]; // vertical component: 1 = flat, ~0.7 = 45 deg, ~0.3 = steep cliff
  const steep = Math.max(0, Math.min(1, (0.92 - ny) / 0.32)); // 0 on flat, 1 on steep cliff

  // Geological rock strata: sedimentary/metamorphic bedding planes with angle tilt
  const strata = Math.sin(h * 0.42 + (x * 0.04 - z * 0.02) * 1.6);
  const strataBand = strata * 0.5 + 0.5; // 0..1
  const rockTone = graniteDark.clone().lerp(graniteMid, strataBand);
  if (strata > 0.55) {
    rockTone.lerp(rockOchre, (strata - 0.55) * 0.75); // warm iron oxide banding
  }

  // Mountain & Rocky High Relief:
  if (bm === B_MOUNTAIN || bm === B_ROCKY || h > 42 || rf > 0.3) {
    const rockFactor = Math.max(rf, Math.min(1.0, 0.45 + steep * 0.55));
    // Blend rock tone onto surface: steep cliffs get dark granite, gentle slopes get scree
    const slopeRock = rockTone.clone().lerp(rockScree, 1.0 - steep);
    out.lerp(slopeRock, rockFactor);

    // Alpine Snow: settles ONLY on gentle high ledges and plateau passes (h > 65m, ny > 0.80)
    // Steep rock cliffs (ny < 0.78) shed snow completely!
    if (h > 65) {
      const snowProb = Math.min(Math.max((h - 65) / 28, 0), 1);
      const ledge = Math.min(Math.max((ny - 0.76) / 0.16, 0), 1);
      const snowMask = snowProb * ledge * (bm === B_ICE ? 0.96 : 0.85);
      if (snowMask > 0.01) {
        out.lerp(alpineSnow, snowMask);
      }
    }
  }

  // River Corridor Scouring (4-6 m/s torrent strips all loose loam down to bedrock):
  if (rv > 0.04) {
    if (h > 24) {
      // Mountain & gorge reach: 100% dark scoured bedrock floor and wet canyon rock
      const scour = Math.min(rv * 1.6, 1.0);
      out.lerp(riverBedrock, scour * 0.88);
    } else {
      // Middle to lowland reach: cobbles fading into alluvium
      const fining = Math.min(Math.max((h - 12) / 12, 0), 1);
      const bedCol = riverCobble.clone().lerp(bedSand, 1.0 - fining);
      out.lerp(bedCol, Math.min(rv * 1.2, 0.75));
    }
  }

  // High-frequency rock crag mottling so slopes don't look like smooth airbrush
  const crag = 0.93 + 0.14 * Math.sin(x * 0.32 + z * 0.26) * Math.sin(x * 0.17 - z * 0.39);
  out.multiplyScalar(crag);
}
