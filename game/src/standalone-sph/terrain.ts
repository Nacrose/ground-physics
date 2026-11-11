import * as THREE from "three";

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
 * SphTerrain: Crater Basin with 3D Signed Distance Field (SDF) Boulder Obstacles
 *
 * Implements continuous 3D SDF collision inspired by deni10000/Godot-3D-SPH-Fluid-Simulation:
 * - Distance field: phi(x) <= 0 indicates solid penetration
 * - 3D continuous normal: n = grad(phi) / |grad(phi)|
 * - Full 3D lateral and vertical rebound against spherical boulder overhangs
 */
export class SphTerrain {
  readonly size: number;
  readonly halfSize: number;
  readonly craterRadius: number;
  readonly craterDepth: number;

  holeEnabled = false;
  holeRadius = 2.2;
  holePos = new THREE.Vector2(0, 0);

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

  // Analytical crater height field
  getHeight(x: number, z: number): number {
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

    // High launch slope on the negative X side for wave/dam-break
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
    // 1. Check drain hole
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

    // 2. 3D SDF check against mid-basin boulders
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
