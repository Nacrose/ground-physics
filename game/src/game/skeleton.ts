/**
 * Skeleton: a fine-grained hierarchical bone rig for the player character.
 * 32 bones (root -> hips -> spine/chest/neck/head/jaw, two-chain arms with
 * shoulder twist and roll bones, two-chain legs with ankle twist, toes and
 * heels) built as nested THREE.Object3D pivots at true anatomical joint
 * positions. The skin is a separate module (skin.ts) that hangs geometry on
 * these bones; animation (animator.ts) only ever touches bone rotations —
 * exactly like a production skeletal system, so new actions blend over the
 * same rig instead of re-posing meshes by hand.
 */
import * as THREE from "three";

export type BoneName =
  | "root" | "hips"
  | "spine" | "chest" | "neck" | "head" | "jaw"
  | "shoulderL" | "upperArmL" | "foreArmL" | "handL"
  | "rollArmL" | "rollForeL" | "fistL"
  | "shoulderR" | "upperArmR" | "foreArmR" | "handR"
  | "rollArmR" | "rollForeR" | "fistR"
  | "thighL" | "shinL" | "footL" | "toeL" | "heelL"
  | "thighR" | "shinR" | "footR" | "toeR" | "heelR";

export interface BoneDef {
  name: BoneName;
  /** parent bone name, null for root */
  parent: BoneName | null;
  /** rest offset from parent pivot [m] */
  pos: [number, number, number];
  /** rest orientation applied after inherited rotation */
  restRot?: [number, number, number];
}

/**
 * Rest-pose metric skeleton (Y-up, facing +Z in local space). Heights match
 * the old box rider (~1.85 m with hat): hips 0.94, shoulders 1.46, head 1.72.
 */
const BONES: BoneDef[] = [
  { name: "root", parent: null, pos: [0, 0, 0] },
  { name: "hips", parent: "root", pos: [0, 0.94, 0] },

  { name: "spine", parent: "hips", pos: [0, 0.13, 0] },
  { name: "chest", parent: "spine", pos: [0, 0.18, 0] },
  { name: "neck", parent: "chest", pos: [0, 0.22, 0] },
  { name: "head", parent: "neck", pos: [0, 0.10, 0] },
  { name: "jaw", parent: "head", pos: [0, -0.05, 0.08] },

  // left arm (character's own left = +X when facing +Z)
  { name: "shoulderL", parent: "chest", pos: [0.17, 0.16, 0] },
  { name: "upperArmL", parent: "shoulderL", pos: [0.06, -0.02, 0], restRot: [0, 0, -0.10] },
  { name: "foreArmL", parent: "upperArmL", pos: [0, -0.30, 0] },
  { name: "handL", parent: "foreArmL", pos: [0, -0.26, 0] },
  { name: "rollArmL", parent: "upperArmL", pos: [0.03, -0.15, 0] },
  { name: "rollForeL", parent: "foreArmL", pos: [0.02, -0.13, 0] },
  { name: "fistL", parent: "handL", pos: [0, -0.06, 0.02] },

  // right arm
  { name: "shoulderR", parent: "chest", pos: [-0.17, 0.16, 0] },
  { name: "upperArmR", parent: "shoulderR", pos: [-0.06, -0.02, 0], restRot: [0, 0, 0.10] },
  { name: "foreArmR", parent: "upperArmR", pos: [0, -0.30, 0] },
  { name: "handR", parent: "foreArmR", pos: [0, -0.26, 0] },
  { name: "rollArmR", parent: "upperArmR", pos: [-0.03, -0.15, 0] },
  { name: "rollForeR", parent: "foreArmR", pos: [-0.02, -0.13, 0] },
  { name: "fistR", parent: "handR", pos: [0, -0.06, 0.02] },

  // legs
  { name: "thighL", parent: "hips", pos: [0.105, -0.02, 0] },
  { name: "shinL", parent: "thighL", pos: [0, -0.42, 0] },
  { name: "footL", parent: "shinL", pos: [0, -0.40, 0] },
  { name: "toeL", parent: "footL", pos: [0, -0.05, 0.11] },
  { name: "heelL", parent: "footL", pos: [0, -0.02, -0.06] },

  { name: "thighR", parent: "hips", pos: [-0.105, -0.02, 0] },
  { name: "shinR", parent: "thighR", pos: [0, -0.42, 0] },
  { name: "footR", parent: "shinR", pos: [0, -0.40, 0] },
  { name: "toeR", parent: "footR", pos: [0, -0.05, 0.11] },
  { name: "heelR", parent: "footR", pos: [0, -0.02, -0.06] },
];

export class Skeleton {
  group: THREE.Group;
  bones = new Map<BoneName, THREE.Object3D>();
  /** world-space rest positions per bone (for debug drawing / IK checks) */
  defs = new Map<BoneName, BoneDef>();

  constructor(debugVisible = false) {
    this.group = new THREE.Group();
    for (const def of BONES) {
      const b = new THREE.Object3D();
      b.name = `bone_${def.name}`;
      b.position.set(...def.pos);
      if (def.restRot) b.rotation.set(...def.restRot);
      this.bones.set(def.name, b);
      this.defs.set(def.name, def);
      if (def.parent) this.bones.get(def.parent)!.add(b);
      else this.group.add(b);
    }
    if (debugVisible) this.attachDebug();
  }

  get(name: BoneName): THREE.Object3D {
    const b = this.bones.get(name);
    if (!b) throw new Error(`no bone ${name}`);
    return b;
  }

  /** reset every bone to its rest transform (call before layering poses) */
  reset() {
    for (const def of BONES) {
      const b = this.bones.get(def.name)!;
      const r = def.restRot ?? [0, 0, 0];
      b.rotation.set(r[0], r[1], r[2]);
    }
  }

  /** small spheres + lines showing the rig (dev only) */
  private attachDebug() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
    const g = new THREE.SphereGeometry(0.02, 6, 5);
    for (const def of BONES) {
      const s = new THREE.Mesh(g, mat);
      s.position.set(0, 0, 0);
      this.bones.get(def.name)!.add(s);
    }
  }
}
