/**
 * Skin: the human model draped over the Skeleton. Every visual piece is a
 * child of its bone, so when animator.ts rotates a bone the limb follows —
 * no per-mesh posing anywhere. Geometry uses tapered capsules (lathe-free,
 * cheap) for limbs and torso so joints stay covered through the full range
 * of motion; the head gets a jaw bone for breathing/talking hints, plus the
 * original frontier-rider identity: hat, scarf, coat, jeans, boots, lantern.
 */
import * as THREE from "three";
import { Skeleton, BoneName } from "./skeleton";

const mat = (color: number, roughness = 0.9) =>
  new THREE.MeshStandardMaterial({ color, roughness });

/** capsule segment along -Y from the bone pivot down length L */
function limb(bone: THREE.Object3D, topR: number, botR: number, len: number,
  m: THREE.Material, offset: [number, number, number] = [0, 0, 0]) {
  const g = new THREE.CapsuleGeometry((topR + botR) / 2, len, 4, 8);
  // taper illusion: scale bottom via two stacked segments is overkill for
  // this art style — a single slightly squashed capsule reads fine
  g.scale(topR / ((topR + botR) / 2), 1, topR / ((topR + botR) / 2));
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  mesh.position.set(offset[0], -len / 2 - topR * 0.2, offset[2]);
  mesh.scale.y = len / (len + topR);
  bone.add(mesh);
  return mesh;
}

function attach(name: BoneName, obj: THREE.Object3D, skel: Skeleton) {
  skel.get(name).add(obj);
}

export interface Skin {
  group: THREE.Group;
  /** chest mesh kept for breathing scaling */
  chestMesh: THREE.Mesh;
  headMesh: THREE.Mesh;
}

export function buildSkin(skel: Skeleton): Skin {
  const coat = mat(0x4a3a30, 0.92);
  const jeans = mat(0x35404d, 0.95);
  const skinM = mat(0xc9a184, 0.8);
  const hatM = mat(0x5d4630, 0.95);
  const bootM = mat(0x2a211c, 0.9);
  const scarfM = mat(0x8c2f2f, 0.9);
  const gloveM = mat(0x3b2d22, 0.95);

  // ---- torso: hips block + belly + chest (each rides its spine bone) ------
  const hipsMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.155, 0.12, 4, 10), jeans);
  hipsMesh.castShadow = true;
  hipsMesh.scale.set(1.25, 1, 0.8);
  hipsMesh.position.y = -0.02;
  attach("hips", hipsMesh, skel);

  const belly = new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.10, 4, 10), coat);
  belly.castShadow = true;
  belly.scale.set(1.15, 1, 0.75);
  belly.position.y = 0.05;
  attach("spine", belly, skel);

  const chestMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.165, 0.16, 4, 10), coat);
  chestMesh.castShadow = true;
  chestMesh.scale.set(1.2, 1, 0.72);
  chestMesh.position.y = 0.06;
  attach("chest", chestMesh, skel);
  // coat collar hint
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.14, 0.07, 10), coat);
  collar.position.y = 0.21;
  attach("chest", collar, skel);

  // ---- neck + head + face parts --------------------------------------------
  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.10, 8), skinM);
  neckMesh.position.y = 0.04;
  attach("neck", neckMesh, skel);

  const scarf = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.10, 0.09, 10), scarfM);
  scarf.position.y = 0.02;
  attach("neck", scarf, skel);

  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12), skinM);
  headMesh.castShadow = true;
  headMesh.scale.set(0.92, 1.08, 0.95);
  headMesh.position.y = 0.09;
  attach("head", headMesh, skel);

  // hair back-cap + ears
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.118, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(0x2e2018));
  hair.position.y = 0.105;
  hair.rotation.x = -0.35;
  attach("head", hair, skel);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), skinM);
    ear.position.set(0.105 * s, 0.085, 0);
    ear.scale.set(0.5, 1, 0.8);
    attach("head", ear, skel);
  }
  // nose + brows (tiny anchors for the face reading at third-person distance)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.045, 6), skinM);
  nose.position.set(0, 0.075, 0.108);
  nose.rotation.x = Math.PI / 2;
  attach("head", nose, skel);
  const browMat = mat(0x241a12);
  for (const s of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.008, 0.012), browMat);
    brow.position.set(0.042 * s, 0.115, 0.102);
    attach("head", brow, skel);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), mat(0x1a1410, 0.4));
    eye.position.set(0.042 * s, 0.098, 0.101);
    attach("head", eye, skel);
  }

  // jaw rides its own bone so yawning/breathing/talking have a handle
  const jawMesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55), skinM);
  jawMesh.scale.set(1.05, 0.8, 1.05);
  jawMesh.position.set(0, 0.02, 0.02);
  attach("jaw", jawMesh, skel);

  // ---- hat (rides head, tips with it) ---------------------------------------
  const hatTop = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.115, 0.14, 12), hatM);
  hatTop.position.y = 0.21;
  hatTop.castShadow = true;
  attach("head", hatTop, skel);
  const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.25, 0.02, 16), hatM);
  hatBrim.position.y = 0.155;
  hatBrim.rotation.x = 0.06; // worn slightly tilted forward
  hatBrim.castShadow = true;
  attach("head", hatBrim, skel);

  // ---- arms -----------------------------------------------------------------
  // shoulder pads smooth the deltoideus junction
  for (const side of ["L", "R"] as const) {
    const pad = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), coat);
    pad.castShadow = true;
    attach(`shoulder${side}` as BoneName, pad, skel);

    limb(skel.get(`upperArm${side}` as BoneName), 0.058, 0.05, 0.28, coat);
    // elbow cap
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.052, 8, 8), coat);
    attach(`foreArm${side}` as BoneName, elbow, skel);
    limb(skel.get(`foreArm${side}` as BoneName), 0.05, 0.042, 0.24, coat);
    // rolled-up cuff hint
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.04, 8), mat(0x6b5545));
    cuff.position.y = -0.20;
    attach(`foreArm${side}` as BoneName, cuff, skel);
    // hand + fingers
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.085, 0.045), gloveM);
    hand.castShadow = true;
    hand.position.y = -0.045;
    attach(`hand${side}` as BoneName, hand, skel);
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 7), gloveM);
    attach(`fist${side}` as BoneName, fist, skel);
  }

  // ---- legs -----------------------------------------------------------------
  for (const side of ["L", "R"] as const) {
    // hip roundness
    const hipCap = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), jeans);
    attach(`thigh${side}` as BoneName, hipCap, skel);
    limb(skel.get(`thigh${side}` as BoneName), 0.082, 0.062, 0.38, jeans);
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), jeans);
    attach(`shin${side}` as BoneName, knee, skel);
    limb(skel.get(`shin${side}` as BoneName), 0.06, 0.05, 0.34, jeans);
    // boot shaft
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.12, 8), bootM);
    shaft.position.y = -0.05;
    shaft.castShadow = true;
    attach(`foot${side}` as BoneName, shaft, skel);
    // foot
    const footMesh = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.055, 0.24), bootM);
    footMesh.castShadow = true;
    footMesh.position.set(0, -0.09, 0.055);
    attach(`foot${side}` as BoneName, footMesh, skel);
    // toe box rides the toe bone (foot-roll looks alive)
    const toeBox = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), bootM);
    toeBox.scale.set(1, 0.6, 1.2);
    attach(`toe${side}` as BoneName, toeBox, skel);
  }

  // ---- belt + buckle ----------------------------------------------------------
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.05, 12), mat(0x2f2620));
  belt.scale.set(1.15, 1, 0.8);
  belt.position.y = 0.10;
  attach("hips", belt, skel);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.015), mat(0xb8a04a, 0.4));
  buckle.position.set(0, 0.10, 0.135);
  attach("hips", buckle, skel);

  // backpack rides the chest bone so it sways with upper-body rotation
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.36, 0.14), mat(0x3d3226));
  pack.castShadow = true;
  pack.position.set(0, 0.05, -0.16);
  attach("chest", pack, skel);
  const bedroll = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), mat(0x556055));
  bedroll.rotation.z = Math.PI / 2;
  bedroll.position.set(0, 0.22, -0.17);
  attach("chest", bedroll, skel);

  return { group: skel.group, chestMesh, headMesh };
}

/** spade held in the right hand — parented to handR so it swings with the dig anim */
export function buildSpade(skel: Skeleton): THREE.Group {
  const spade = new THREE.Group();
  const wood = mat(0x6e5230);
  const steel = mat(0x9aa2ab, 0.35);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.05, 6), wood);
  shaft.castShadow = true;
  shaft.position.y = -0.35;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.12, 6), wood);
  grip.position.y = 0.18;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 0.02), steel);
  blade.castShadow = true;
  blade.position.y = -0.95;
  blade.rotation.x = 0.12;
  spade.add(shaft, grip, blade);
  // rest orientation: blade pointing back-down along the arm
  spade.rotation.x = 0.35;
  skel.get("handR").add(spade);
  return spade;
}

/** miner's lantern hung from the left-hand bone */
export function buildLantern(skel: Skeleton): { body: THREE.Mesh; light: THREE.PointLight } {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.11, 8),
    new THREE.MeshStandardMaterial({ color: 0xffcf7a, emissive: 0xff9a30, emissiveIntensity: 0.0, roughness: 0.4 }));
  body.position.y = -0.12;
  const light = new THREE.PointLight(0xffb066, 0, 9, 1.8);
  light.visible = false;
  body.add(light);
  skel.get("handL").add(body);
  return { body, light };
}
