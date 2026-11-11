import * as THREE from "three";
import { SimPreset } from "./sphPhysics";

export interface TerrainCollisionResult {
  isColliding: boolean;
  terrainY: number;
  normal: THREE.Vector3;
  isInHole: boolean;
  isBoulder?: boolean;
  penetration?: number;
}

export interface SphBoulder {
  center: THREE.Vector3;
  radius: number;
  mesh?: THREE.Mesh;
}

/**
 * SphTerrain: Crater Basin & Stepped Ditch-Weir Terrain with 3D SDF Boulder Collisions
 *
 * Implements:
 * 1. Stepped dual-elevation Ditch & Weir Spillway terrain (rainwater pooling and threshold overflow)
 * 2. Crater basin terrain (dam-break wave, rain, high-speed jet, tanker dump)
 * 3. 3D Signed Distance Field (SDF) continuous boulder collisions
 */
export class SphTerrain {
  readonly size: number;
  readonly halfSize: number;
  readonly craterRadius: number;
  readonly craterDepth: number;

  holeEnabled = false;
  holeRadius = 2.2;
  holePos = new THREE.Vector2(0, 0);

  currentPreset: SimPreset = "wave";

  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;

  // 3D Analytical SDF Boulders in Crater Basin
  readonly boulders: SphBoulder[] = [
    { center: new THREE.Vector3(2.6, -2.4, 1.4), radius: 1.85 },
    { center: new THREE.Vector3(-3.2, -1.8, -1.6), radius: 1.50 },
  ];
  readonly boulderMeshes: THREE.Mesh[] = [];

  constructor(size = 28.0, craterRadius = 9.0, craterDepth = 5.0) {
    this.size = size;
    this.halfSize = size / 2;
    this.craterRadius = craterRadius;
    this.craterDepth = craterDepth;

    const res = 128;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, this.getHeight(x, z));
    }
    geo.computeVertexNormals();

    this.material = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.85,
      metalness: 0.15,
      flatShading: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;

    // Create 3D Visual Meshes matching the analytical SDF boulders
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.70,
      metalness: 0.20,
    });

    for (const b of this.boulders) {
      const bGeo = new THREE.IcosahedronGeometry(b.radius, 16);
      const bMesh = new THREE.Mesh(bGeo, rockMat);
      bMesh.position.copy(b.center);
      bMesh.castShadow = true;
      bMesh.receiveShadow = true;
      b.mesh = bMesh;
      this.boulderMeshes.push(bMesh);
    }
  }

  setPreset(preset: SimPreset) {
    this.currentPreset = preset;
    const isBottle = preset === "bottle";
    for (const bm of this.boulderMeshes) {
      bm.visible = !isBottle;
    }
    this.rebuildGeometry();
  }

  rebuildGeometry() {
    const pos = this.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, this.getHeight(x, z));
    }
    this.mesh.geometry.computeVertexNormals();
    pos.needsUpdate = true;
  }

  // Analytical height field based on active preset
  getHeight(x: number, z: number): number {
    if (this.currentPreset === "bottle") {
      // Flat pedestal floor under the bottle
      return -3.4 + Math.sin(x * 0.4) * Math.cos(z * 0.4) * 0.15;
    }

    if (this.currentPreset === "ditch") {
      // Stepped Ditch & Spillway Overflow Terrain:
      // Upper ditch bowl at x in [-7.5, -1.2], z in [-4.5, 4.5]
      // Spillway weir notch at x = -1.2, z in [-1.5, 1.5]
      // Lower terrace basin at x in [0.5, 8.0], z in [-5.5, 5.5]
      const dxUpper = (x - (-4.5)) / 3.0;
      const dzUpper = z / 3.2;
      const rUpperSq = dxUpper * dxUpper + dzUpper * dzUpper;

      let upperDitch = 0.0;
      if (rUpperSq < 1.0) {
        upperDitch = -1.85 * (1.0 - rUpperSq);
      }

      // Upper ditch surrounding rim
      const rimUpper = 0.45 * Math.exp(-Math.pow((rUpperSq - 1.0) * 2.2, 2));

      // Spillway notch at x = -1.2
      const isSpillway = Math.abs(x - (-1.2)) < 0.8 && Math.abs(z) < 1.6;
      const notchCut = isSpillway ? -0.35 * (1.0 - Math.pow(z / 1.6, 2)) : 0.0;

      // Lower cascade slope between x = -1.2 and x = 0.5
      let cascadeSlope = 0.0;
      if (x > -1.2 && x < 1.0) {
        const t = (x - (-1.2)) / 2.2;
        cascadeSlope = -t * 3.4;
      }

      // Lower terrace basin at x in [1.0, 7.5]
      const dxLower = (x - 4.5) / 3.2;
      const dzLower = z / 3.8;
      const rLowerSq = dxLower * dxLower + dzLower * dzLower;

      let lowerBasin = 0.0;
      if (x >= 1.0) {
        if (rLowerSq < 1.0) {
          lowerBasin = -3.85 - 1.2 * (1.0 - rLowerSq);
        } else {
          lowerBasin = -3.85 + 0.6 * Math.log(1.0 + (rLowerSq - 1.0));
        }
      }

      return (x < 1.0 ? (upperDitch + rimUpper + notchCut + cascadeSlope) : lowerBasin);
    }

    // Default crater basin terrain (wave, rain, crater, jet, tanker)
    const r = Math.hypot(x, z);
    const cr = this.craterRadius;

    // Rim ridge around the crater
    const rimDist = Math.abs(r - cr);
    const rimHeight = 2.0 * Math.exp(-rimDist * rimDist * 0.4);

    let baseHeight = 0;
    if (r < cr) {
      // Smooth bowl / crater basin
      const t = r / cr;
      baseHeight = -this.craterDepth * (1.0 - t * t) + rimHeight;
    } else {
      // Outer gentle slope
      baseHeight = rimHeight - 0.5 * Math.log(1.0 + (r - cr) * 0.5);
    }

    // High launch slope on the negative X side for wave/dam-break/tanker
    const slopeX = Math.max(-x - 4.0, 0.0);
    const launchRamp = slopeX * 0.65;

    // Small procedural undulation
    const ripples = Math.sin(x * 0.8) * Math.cos(z * 0.8) * 0.25;

    return baseHeight + launchRamp + ripples;
  }

  getNormal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const eps = 0.05;
    const hL = this.getHeight(x - eps, z);
    const hR = this.getHeight(x + eps, z);
    const hD = this.getHeight(x, z - eps);
    const hU = this.getHeight(x, z + eps);

    out.set(-(hR - hL) / (2 * eps), 1.0, -(hU - hD) / (2 * eps)).normalize();
    return out;
  }

  /**
   * 3D Signed Distance Field (SDF) Collision Check
   * Evaluates terrain bowl and analytical 3D boulders
   */
  checkCollision(x: number, y: number, z: number, radius = 0.25): TerrainCollisionResult {
    // 1. Check drain hole (if enabled)
    const distToHole = Math.hypot(x - this.holePos.x, z - this.holePos.y);
    const inHole = this.holeEnabled && distToHole < this.holeRadius;

    if (inHole) {
      return {
        isColliding: false,
        terrainY: -999,
        normal: new THREE.Vector3(0, 1, 0),
        isInHole: true,
      };
    }

    // 2. 3D SDF check against mid-basin boulders (only when not in bottle mode)
    if (this.currentPreset !== "bottle") {
      for (const b of this.boulders) {
        const dx = x - b.center.x;
        const dy = y - b.center.y;
        const dz = z - b.center.z;
        const dist = Math.hypot(dx, dy, dz);
        const minDist = b.radius + radius;

        if (dist < minDist) {
          const invDist = dist > 1e-4 ? 1.0 / dist : 1.0;
          const normal = new THREE.Vector3(dx * invDist, dy * invDist, dz * invDist);
          return {
            isColliding: true,
            terrainY: y,
            normal,
            isInHole: false,
            isBoulder: true,
            penetration: minDist - dist,
          };
        }
      }
    }

    // 3. Terrain bedrock collision
    const tY = this.getHeight(x, z);
    const isColliding = y - radius <= tY;
    const normal = this.getNormal(x, z);

    return {
      isColliding,
      terrainY: tY,
      normal,
      isInHole: false,
      isBoulder: false,
      penetration: isColliding ? (tY + radius - y) : 0,
    };
  }
}
