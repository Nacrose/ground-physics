/**
 * Mid ring — a VIEW-ONLY, sharper copy of the ground you have already
 * reshaped, drawn out to the "EDIT VIEW DISTANCE" setting (0 = off).
 *
 * Why it exists: beyond the 16 m contact window the world only keeps a
 * coarse far-field cache (0.75 m texels shown through a 1.5 m terrain
 * lattice). A 0.3 m ditch or a 10 cm spoil heap is narrower than that
 * lattice, so it blurs into a dish or vanishes. The ring is a second,
 * denser terrain patch that follows the player:
 *
 *   - mesh:    MID_SEG × MID_SEG quads (384² → ~147k vertices) over a square
 *              of side 2R. R = 96 m gives 0.5 m quads; R = 200 m gives ~1 m.
 *   - texture: MID_TEX² RGBA8 (1 MB) in the same encoding as the far-field
 *              cache (R delta, G churn, B spoil), but PEAK-dominant and not
 *              dilated, filled from the exact sparse store (6.25 cm truth).
 *   - it never simulates anything: the 16 m window stays the only thing
 *     that deforms. The ring just re-reads the record of what was dug.
 *
 * The static terrain mesh discards its fragments under the ring (the same
 * trick it already uses under the contact window), the ring's outer band is
 * blended into the coarse cache so the two surfaces meet without a step,
 * and the overlay's rim / the grass read the ring's texture while it is on.
 */
import * as THREE from "three";
import { WORLD_SIZE, TerrainData, sampleHeight } from "./terrain";
import { MicroTerrain } from "./contact";

const HALF = WORLD_SIZE / 2;
/** texture texels per side — 512² matches the far-field vertex mirror, a
 *  size known to fetch reliably in the vertex stage on every GL stack */
export const MID_TEX = 512;
/** mesh quads per side */
const MID_SEG = 384;
/** smallest radius that is allowed on (below this the ring is simply off) */
export const MID_MIN_RADIUS = 32;
export const MID_MAX_RADIUS = 256;
/** recentre when the player drifts this fraction of R from the ring centre */
const RECENTRE_FRAC = 0.25;

export class MidRing {
  readonly mesh: THREE.Mesh;
  /** textures share one byte array: F is read by the fragment stage, V by
   *  the vertex stage (a sampler used by both never binds in the vertex
   *  stage in this three build — see contact.ts) */
  readonly texF: THREE.DataTexture;
  readonly texV: THREE.DataTexture;
  /** world-uv rect of the texture: xy = origin, zw = size */
  readonly rect = new THREE.Vector4(0, 0, 1, 1);
  /** uniforms the ring's terrain material binds (shared objects, so
   *  updating .value here is seen by the shader immediately) */
  readonly uniforms: Record<string, { value: unknown }>;
  /** static terrain: "discard under the ring" box — xy centre, z half-extent */
  readonly boxUniform = { value: new THREE.Vector4(0, 0, 0, 0) };

  radius = 0;
  texel = 1;
  private built = false;
  private dirty = true;
  private cx = 0;
  private cz = 0;
  private x0 = 0;
  private z0 = 0;
  private readonly data = new Uint8Array(MID_TEX * MID_TEX * 4);
  private readonly geo: THREE.PlaneGeometry;
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  // painterly tint — identical recipe to World.buildTerrainMesh (non-allocating)
  private readonly cDry = new THREE.Color(0xb9985a);
  private readonly cLush = new THREE.Color(0x7d8a4e);
  private readonly cRock = new THREE.Color(0x8d8478);
  private readonly cTmp = new THREE.Color();

  constructor(private terrain: TerrainData, private micro: MicroTerrain) {
    const mk = () => {
      const t = new THREE.DataTexture(this.data, MID_TEX, MID_TEX, THREE.RGBAFormat);
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    };
    this.data.fill(0);
    for (let k = 0; k < MID_TEX * MID_TEX; k++) { this.data[k * 4] = 128; this.data[k * 4 + 3] = 255; }
    this.texF = mk();
    this.texV = mk();
    this.uniforms = {
      uWorldEditTex: { value: this.texF },
      uWorldEditV: { value: this.texV },
      uEditRect: { value: this.rect },
      uEditTexelUv: { value: 1 / MID_TEX },
      uEditTexelM: { value: 1 },
      uIsMid: { value: 1 },
    };

    const geo = new THREE.PlaneGeometry(1, 1, MID_SEG, MID_SEG);
    geo.rotateX(-Math.PI / 2);
    this.geo = geo;
    this.pos = geo.attributes.position as THREE.BufferAttribute;
    this.col = new THREE.BufferAttribute(new Float32Array(this.pos.count * 3), 3);
    geo.setAttribute("color", this.col);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial()); // material swapped in by World
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // vertices are rewritten on recentre
    this.mesh.visible = false;

    micro.onWorldSplat = () => this.refreshWindow();
  }

  /** true while the ring is drawn and its texture is valid */
  get active(): boolean { return this.radius > 0 && this.built; }

  /** metres; values below MID_MIN_RADIUS turn the ring off */
  setRadius(r: number) {
    const v = r < MID_MIN_RADIUS ? 0 : Math.min(r, MID_MAX_RADIUS);
    if (v === this.radius) return;
    this.radius = v;
    this.dirty = true;
    if (v === 0) {
      this.mesh.visible = false;
      this.boxUniform.value.set(0, 0, 0, 0);
      this.built = false;
    }
  }

  /** per frame: (re)centre on the actor when needed */
  update(px: number, pz: number) {
    if (this.radius === 0) return;
    const R = this.radius;
    if (!this.dirty && Math.abs(px - this.cx) < R * RECENTRE_FRAC && Math.abs(pz - this.cz) < R * RECENTRE_FRAC) return;
    this.recentre(px, pz);
  }

  /** the live window changed: refresh just the texels it touches */
  refreshWindow() {
    if (!this.active || this.dirty) return;
    this.micro.midRefreshWindow(this.data, MID_TEX, this.x0, this.z0, this.texel);
    this.texF.needsUpdate = true;
    this.texV.needsUpdate = true;
  }

  private recentre(px: number, pz: number) {
    const R = this.radius;
    const texel = (2 * R) / MID_TEX;
    this.texel = texel;
    // snap to the texel grid so the texture lattice is stable while walking
    this.cx = Math.round(px / texel) * texel;
    this.cz = Math.round(pz / texel) * texel;
    this.x0 = this.cx - R;
    this.z0 = this.cz - R;

    // ---- geometry: world-space vertices on the terrain surface -----------
    const step = (2 * R) / MID_SEG;
    const pos = this.pos, col = this.col;
    const c = this.cTmp;
    for (let j = 0; j <= MID_SEG; j++) {
      const z = Math.max(-HALF, Math.min(HALF, this.z0 + j * step));
      for (let i = 0; i <= MID_SEG; i++) {
        const x = Math.max(-HALF, Math.min(HALF, this.x0 + i * step));
        const h = sampleHeight(this.terrain, x + HALF, z + HALF);
        const k = j * (MID_SEG + 1) + i;
        pos.setXYZ(k, x, h, z);
        const hn = Math.min(Math.max(h / 18, 0), 1);
        c.copy(this.cDry).lerp(this.cLush, 1 - hn);
        if (h > 14.5) c.lerp(this.cRock, Math.min((h - 14.5) / 5, 0.6));
        const m = 0.92 + 0.16 * Math.sin(x * 0.171 + z * 0.137) * Math.sin(x * 0.043 - z * 0.061);
        col.setXYZ(k, c.r * m, c.g * m, c.b * m);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;

    // ---- texture ----------------------------------------------------------
    this.micro.midFill(this.data, MID_TEX, this.x0, this.z0, texel);
    this.texF.needsUpdate = true;
    this.texV.needsUpdate = true;

    // ---- uniforms -----------------------------------------------------------
    this.rect.set(this.x0 / WORLD_SIZE + 0.5, this.z0 / WORLD_SIZE + 0.5, (2 * R) / WORLD_SIZE, (2 * R) / WORLD_SIZE);
    this.uniforms.uEditTexelUv.value = texel / WORLD_SIZE;
    this.uniforms.uEditTexelM.value = texel;
    this.boxUniform.value.set(this.cx, this.cz, R, 0);
    this.mesh.visible = true;
    this.built = true;
    this.dirty = false;
  }
}
