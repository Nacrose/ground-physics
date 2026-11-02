/**
 * The ONE terrain vertex-tint formula — shared by every mesh that renders
 * the ground surface: the static world mesh (world.ts), the deformable
 * contact overlay (contact.ts) and the view-only mid ring (midring.ts).
 *
 * One definition so the 16 m window and the edit-distance ring can never
 * shade apart from the world around them — a tint mismatch reads as a
 * colored square following the player across biome ground.
 */
import * as THREE from "three";
import { GRID, WORLD_SIZE, TerrainData, BIOMES, B_ICE, B_MOUNTAIN, B_RIVER } from "./terrain";

const HALF = WORLD_SIZE / 2;
const biomeCols = BIOMES.map((b) => new THREE.Color(b.color));
const rockHi = new THREE.Color(0xa8adb2);
const snow = new THREE.Color(0xf5f8fa);
// the river bed FINES downstream: stony gray bars in the mountain reach
// pale into alluvial sand by the lowlands (the water tint rides on top)
const bedStone = new THREE.Color(0x8f897d);
const bedSand = new THREE.Color(0xb8a884);

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

/** the full painterly vertex tint: biome palette + height relief + mountain
 *  rock / ice-cap palings + the shared mottling. h is the terrain height at
 *  (x, z) — callers may fold their dynamic lift in, the ~±0.5 m it adds is
 *  invisible at this tint's scale. */
export function vertexTint(t: TerrainData, x: number, z: number, h: number, out: THREE.Color): void {
  biomeColorAt(t, x, z, out);
  const hn = Math.min(Math.max(h / 60, 0), 1);
  out.multiplyScalar(0.86 + 0.30 * hn);
  const bm = biomeIdAt(t, x, z);
  if (bm === B_MOUNTAIN) out.lerp(rockHi, Math.min(Math.max((h - 60) / 55, 0), 0.6));
  if (bm === B_ICE) out.lerp(snow, Math.min(Math.max((h - 92) / 18, 0), 0.85));
  // the river bed tells the geology: fining = bed elevation 13..28 m — a
  // gray gravel-cobble gorge paling into sandy alluvium downstream (matches
  // the soil map's downstream fining so what you SEE through the water is
  // what the spade meets)
  if (bm === B_RIVER) {
    const fining = Math.min(Math.max((h - 13) / 15, 0), 1);
    out.lerp(bedStone, 0.55 * fining);
    out.lerp(bedSand, 0.45 * (1 - fining));
  }
  const m = 0.92 + 0.16 * Math.sin(x * 0.171 + z * 0.137) * Math.sin(x * 0.043 - z * 0.061);
  out.multiplyScalar(m);
}
