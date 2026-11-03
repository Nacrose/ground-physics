import * as THREE from "three";

export type TrampleLike = (x: number, z: number, r: number, mode: "trample" | "dig") => void;

export interface InputLike {
  forward: number; right: number; sprint: boolean; jump: boolean;
  dig: boolean; yaw: number; pitch: number; zoom: number;
}

export type SteampunkDroneKind = "movement" | "inventory" | "worker";

export interface DroneInventoryItem { id: string; name: string; qty: number; }

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpAngle(a: number, b: number, t: number) {
  const two = Math.PI * 2;
  let d = (b - a) % two;
  if (d > Math.PI) d -= two;
  if (d < -Math.PI) d += two;
  return a + d * clamp(t, 0, 1);
}

function rand(seed: number) {
  const s = Math.sin(seed * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function V(x = 0, y = 0, z = 0) { return new THREE.Vector3(x, y, z); }

const MATS = {
  brass: new THREE.MeshStandardMaterial({ color: 0x9a6b28, metalness: 0.92, roughness: 0.34 }),
  copper: new THREE.MeshStandardMaterial({ color: 0x7c4a26, metalness: 0.88, roughness: 0.42 }),
  iron: new THREE.MeshStandardMaterial({ color: 0x2d2a27, metalness: 0.75, roughness: 0.58 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x6d7076, metalness: 0.9, roughness: 0.35 }),
  leather: new THREE.MeshStandardMaterial({ color: 0x4b2e1c, metalness: 0.05, roughness: 0.92 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x5b3a22, metalness: 0.02, roughness: 0.9 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x121110, metalness: 0.04, roughness: 0.96 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0xffc37a, emissive: 0xff8a2a, emissiveIntensity: 1.8, metalness: 0.1, roughness: 0.4 }),
  ember: new THREE.MeshStandardMaterial({ color: 0xff6a2a, emissive: 0xff3d00, emissiveIntensity: 2.1, metalness: 0.05, roughness: 0.55 }),
};

function tubeBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(V(0, 1, 0), dir.normalize());
  return mesh;
}

function rivet(parent: THREE.Object3D, pos: THREE.Vector3, s = 0.013) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(s, 5, 5), MATS.brass);
  m.position.copy(pos);
  parent.add(m);
}

function buildWheel(radius: number, tireR: number) {
  const wheel = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(radius, tireR, 10, 28), MATS.rubber);
  tire.rotation.y = Math.PI / 2; wheel.add(tire);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.88, tireR * 0.42, 8, 28), MATS.brass);
  rim.rotation.y = Math.PI / 2; wheel.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 10), MATS.iron);
  hub.rotation.z = Math.PI / 2; wheel.add(hub);
  for (let i = 0; i < 12; i++) {
    const holder = new THREE.Group();
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, radius * 0.86, 5), MATS.steel);
    spoke.position.y = radius * 0.43; holder.add(spoke);
    holder.rotation.x = (i / 12) * Math.PI * 2; wheel.add(holder);
  }
  return wheel;
}

function buildBike() {
  const g = new THREE.Group();
  const wheelRear = buildWheel(0.4, 0.06); wheelRear.position.set(0, 0.4, -0.72); g.add(wheelRear);
  const wheelFront = buildWheel(0.42, 0.06); wheelFront.position.set(0, 0.42, 0.76); g.add(wheelFront);
  const rearHub = V(0, 0.4, -0.72), frontHub = V(0, 0.42, 0.76), engineBase = V(0, 0.42, 0.02), steeringHead = V(0, 0.86, 0.5), seatBase = V(0, 0.84, -0.3), rackBase = V(0, 0.76, -0.62);
  const addTube = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material) => g.add(tubeBetween(a, b, r, m));
  addTube(rearHub, engineBase, 0.034, MATS.iron); addTube(engineBase, steeringHead, 0.036, MATS.iron);
  addTube(rearHub, seatBase, 0.032, MATS.iron); addTube(seatBase, steeringHead, 0.03, MATS.copper);
  addTube(rearHub.clone().add(V(0, 0.18, 0)), rackBase, 0.02, MATS.brass);
  addTube(engineBase.clone().add(V(0, 0.1, 0)), seatBase.clone().add(V(0, 0.06, 0)), 0.018, MATS.steel);
  addTube(steeringHead, frontHub.clone().add(V(0.05, 0.06, 0)), 0.026, MATS.steel);
  addTube(steeringHead, frontHub.clone().add(V(-0.05, 0.06, 0)), 0.026, MATS.steel);
  addTube(steeringHead, V(0, 1.02, 0.46), 0.028, MATS.brass);
  const spring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 6, 14, Math.PI), MATS.steel);
  spring.position.set(0, 0.68, 0.6); spring.rotation.x = Math.PI / 2; g.add(spring);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.56, 16), MATS.copper);
  tank.rotation.z = Math.PI / 2; tank.position.set(0, 0.86, 0.08); g.add(tank);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 10), MATS.brass);
  cap.rotation.z = Math.PI / 2; cap.position.set(0.31, 0.86, 0.08); g.add(cap);
  for (const x of [-0.16, 0.16]) { const strap = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.012, 8, 20), MATS.brass); strap.rotation.y = Math.PI / 2; strap.position.set(x, 0.86, 0.08); g.add(strap); }
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; rivet(g, V(0.26, 0.86 + Math.sin(a) * 0.14, 0.08 + Math.cos(a) * 0.14), 0.011); }
  const engine = new THREE.Group(); engine.position.copy(engineBase); g.add(engine);
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.38), MATS.iron); block.position.y = 0.02; engine.add(block);
  const cylinderL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.24, 10), MATS.copper); cylinderL.position.set(0.1, 0.12, 0.04); cylinderL.rotation.z = -0.35; engine.add(cylinderL);
  const cylinderR = cylinderL.clone(); cylinderR.position.x = -0.1; cylinderR.rotation.z = 0.35; engine.add(cylinderR);
  for (let i = 0; i < 3; i++) {
    const ringL = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.006, 6, 14), MATS.iron); ringL.rotation.y = Math.PI / 2; ringL.position.set(0.1, 0.06 + i * 0.055, 0.04); engine.add(ringL);
    const ringR = ringL.clone(); ringR.position.x = -0.1; engine.add(ringR);
  }
  const crank = new THREE.Group(); crank.position.set(0, 0.36, 0.14);
  const flywheel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 20), MATS.brass); flywheel.rotation.z = Math.PI / 2; crank.add(flywheel);
  for (let i = 0; i < 4; i++) { const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.26, 0.03), MATS.iron); spoke.rotation.x = (i / 4) * Math.PI * 2; crank.add(spoke); }
  const crankHub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 10), MATS.steel); crankHub.rotation.z = Math.PI / 2; crank.add(crankHub);
  g.add(crank);
  const pistonL = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.18, 8), MATS.steel); pistonL.position.set(0.1, 0.28, 0.04); pistonL.rotation.z = -0.35; g.add(pistonL);
  const pistonR = pistonL.clone(); pistonR.position.x = -0.1; pistonR.rotation.z = 0.35; g.add(pistonR);
  const exhaustL = tubeBetween(V(0.11, 0.3, 0.08), V(0.18, 0.18, -0.64), 0.028, MATS.steel); g.add(exhaustL);
  const exhaustR = tubeBetween(V(-0.11, 0.3, 0.08), V(-0.18, 0.18, -0.64), 0.028, MATS.steel); g.add(exhaustR);
  const muffler = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 12), MATS.copper); muffler.rotation.z = Math.PI / 2; muffler.position.set(0, 0.18, -0.7); g.add(muffler);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.26, 10), MATS.iron); stack.position.set(0.18, 0.34, -0.68); stack.rotation.x = -0.18; g.add(stack);
  const ember = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), MATS.ember); ember.position.set(0.18, 0.48, -0.7); g.add(ember);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.07, 0.42), MATS.leather); saddle.position.set(0, 0.92, -0.28); saddle.rotation.x = -0.08; g.add(saddle);
  const seatSpring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 6, 14, Math.PI), MATS.steel); seatSpring.position.set(0, 0.82, -0.3); seatSpring.rotation.y = Math.PI / 2; g.add(seatSpring);
  const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.3, 12), MATS.brass); boiler.rotation.z = Math.PI / 2; boiler.position.set(0, 0.78, -0.6); g.add(boiler);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; rivet(g, V(0.16, 0.78 + Math.sin(a) * 0.105, -0.6 + Math.cos(a) * 0.105), 0.01); }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.62, 8), MATS.brass); bar.rotation.z = Math.PI / 2; bar.position.set(0, 1.04, 0.46); g.add(bar);
  const gripL = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.11, 8), MATS.leather); gripL.rotation.z = Math.PI / 2; gripL.position.set(0.29, 1.04, 0.46); g.add(gripL);
  const gripR = gripL.clone(); gripR.position.x = -0.29; g.add(gripR);
  const leverL = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.12), MATS.steel); leverL.position.set(0.2, 1.03, 0.52); leverL.rotation.y = 0.35; g.add(leverL);
  const leverR = leverL.clone(); leverR.position.x = -0.2; leverR.rotation.y = -0.35; g.add(leverR);
  const lampHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.1, 12), MATS.brass); lampHousing.rotation.x = Math.PI / 2; lampHousing.position.set(0, 0.92, 0.68); g.add(lampHousing);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 12), MATS.lamp); lamp.position.set(0, 0.92, 0.74); g.add(lamp);
  const gaugeL = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), MATS.brass); gaugeL.rotation.x = Math.PI / 2; gaugeL.position.set(0.1, 0.98, 0.18); g.add(gaugeL);
  const gaugeFaceL = new THREE.Mesh(new THREE.CircleGeometry(0.028, 12), MATS.lamp); gaugeFaceL.position.set(0.1, 0.98, 0.196); g.add(gaugeFaceL);
  const gaugeR = gaugeL.clone(); gaugeR.position.x = -0.1; g.add(gaugeR);
  const gaugeFaceR = gaugeFaceL.clone(); gaugeFaceR.position.x = -0.1; g.add(gaugeFaceR);
  const bagL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.22), MATS.leather); bagL.position.set(0.19, 0.62, -0.42); g.add(bagL);
  const bagR = bagL.clone(); bagR.position.x = -0.19; g.add(bagR);
  rivet(g, bagL.position.clone().add(V(0.045, 0.08, 0.11)), 0.009);
  rivet(g, bagR.position.clone().add(V(-0.045, 0.08, 0.11)), 0.009);
  rivet(g, steeringHead.clone().add(V(0.04, -0.04, 0)), 0.012);
  rivet(g, steeringHead.clone().add(V(-0.04, -0.04, 0)), 0.012);
  rivet(g, engineBase.clone().add(V(0.08, 0.06, 0)), 0.012);
  rivet(g, engineBase.clone().add(V(-0.08, 0.06, 0)), 0.012);
  rivet(g, seatBase.clone().add(V(0.06, -0.04, 0)), 0.012);
  rivet(g, seatBase.clone().add(V(-0.06, -0.04, 0)), 0.012);
  return { group: g, wheelFront, wheelRear, crank, pistonL, pistonR, stack, lamp };
}

function buildDrone(kind: SteampunkDroneKind) {
  const g = new THREE.Group();
  const rotors: THREE.Group[] = [];
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), MATS.brass); body.scale.set(1, 0.82, 1.2); g.add(body);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 8, 20), MATS.copper); ring.rotation.x = Math.PI / 2; g.add(ring);
  const armPositions = [V(0.22, 0.03, 0.22), V(-0.22, 0.03, 0.22), V(0.22, 0.03, -0.22), V(-0.22, 0.03, -0.22)];
  for (const p of armPositions) {
    g.add(tubeBetween(V(0, 0.02, 0), p, 0.012, MATS.iron));
    const rotor = new THREE.Group(); rotor.position.copy(p);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.04, 8), MATS.brass); rotor.add(hub);
    const bladeA = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.004, 0.03), MATS.steel); bladeA.rotation.y = 0.35; rotor.add(bladeA);
    const bladeB = bladeA.clone(); bladeB.rotation.y = Math.PI / 2 + 0.35; rotor.add(bladeB);
    rotors.push(rotor); g.add(rotor);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), MATS.lamp); lamp.position.set(0, -0.08, 0.15); g.add(lamp);
  let cargo: THREE.Mesh | null = null;
  if (kind === "inventory") {
    cargo = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.2), MATS.wood); cargo.position.set(0, -0.18, 0); g.add(cargo);
    rivet(g, cargo.position.clone().add(V(0.08, 0.07, 0.1)), 0.009);
    rivet(g, cargo.position.clone().add(V(-0.08, 0.07, 0.1)), 0.009);
  }
  let arm: THREE.Object3D | null = null;
  if (kind === "worker") {
    arm = new THREE.Group();
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8), MATS.iron); shoulder.rotation.z = Math.PI / 2; arm.add(shoulder);
    const tool = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.1, 8), MATS.steel); tool.rotation.x = Math.PI; tool.position.set(0.1, -0.05, 0); arm.add(tool);
    arm.position.set(0.14, -0.04, 0.08); g.add(arm);
  }
  return { group: g, rotors, lamp, cargo, arm };
}

function buildWorkerBot() {
  const g = new THREE.Group();
  const trackL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.46), MATS.rubber); trackL.position.set(0.14, 0.05, 0); g.add(trackL);
  const trackR = trackL.clone(); trackR.position.x = -0.14; g.add(trackR);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.28, 12), MATS.copper); body.position.y = 0.24; g.add(body);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), MATS.brass); dome.position.y = 0.42; dome.scale.y = 0.72; g.add(dome);
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), MATS.lamp); eyeL.position.set(0.05, 0.42, 0.09); g.add(eyeL);
  const eyeR = eyeL.clone(); eyeR.position.x = -0.05; g.add(eyeR);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.035, 0.18, 8), MATS.iron); stack.position.set(0.07, 0.54, -0.08); g.add(stack);
  const armL = new THREE.Group();
  const upperL = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.18, 6), MATS.iron); upperL.position.y = -0.09; armL.add(upperL);
  const shovel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.08), MATS.steel); shovel.position.set(0, -0.19, 0.03); armL.add(shovel);
  armL.position.set(0.17, 0.34, 0.08); g.add(armL);
  const armR = armL.clone(); armR.position.x = -0.17; g.add(armR);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; rivet(g, V(Math.sin(a) * 0.15, 0.24, Math.cos(a) * 0.15), 0.009); }
  return { group: g, armL, armR, trackL, trackR, stack };
}

export class SteampunkBike {
  group: THREE.Group; pos = new THREE.Vector3(); yaw = 0; speed = 0;
  private wheelFront: THREE.Group; private wheelRear: THREE.Group; private crank: THREE.Group;
  private pistonL: THREE.Object3D; private pistonR: THREE.Object3D; private stack: THREE.Object3D; private lamp: THREE.Object3D;
  private pistonBaseL = 0; private pistonBaseR = 0; private exhaustT = 0; private lean = 0;

  constructor(private getHeight: (x: number, z: number) => number, spawn: THREE.Vector3, private fx?: any) {
    const parts = buildBike(); this.group = parts.group; this.wheelFront = parts.wheelFront; this.wheelRear = parts.wheelRear;
    this.crank = parts.crank; this.pistonL = parts.pistonL; this.pistonR = parts.pistonR; this.stack = parts.stack; this.lamp = parts.lamp;
    this.pistonBaseL = this.pistonL.position.y; this.pistonBaseR = this.pistonR.position.y;
    this.pos.copy(spawn); this.group.position.copy(this.pos);
  }

  get riderPos() { this.group.updateMatrixWorld(true); return this.group.localToWorld(V(0, 0.96, -0.2)); }

  update(dt: number, elapsed: number, input: InputLike, playerPos: THREE.Vector3, playerYaw: number, mounted: boolean) {
    if (mounted) {
      const fwd = V(Math.sin(input.yaw), 0, Math.cos(input.yaw));
      const right = V(Math.cos(input.yaw), 0, -Math.sin(input.yaw));
      const move = V().addScaledVector(fwd, input.forward).addScaledVector(right, input.right);
      const moving = move.lengthSq() > 1e-4;
      const targetSpeed = moving ? (input.sprint ? 21.0 : 12.5) * Math.min(move.length(), 1) : 0;
      if (moving) { const targetYaw = Math.atan2(move.x, move.z); this.yaw = lerpAngle(this.yaw, targetYaw, Math.min(dt * 4.5, 1)); }
      this.speed = lerp(this.speed, targetSpeed, Math.min(dt * 3.2, 1));
      const dir = V(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.pos.addScaledVector(dir, this.speed * dt);
      this.lean = lerp(this.lean, -input.right * 0.22 * clamp(this.speed / 8, 0, 1), Math.min(dt * 5, 1));
    } else {
      const toPlayer = V().subVectors(playerPos, this.pos); toPlayer.y = 0; const dist = toPlayer.length();
      const targetSpeed = dist > 3.0 ? clamp(dist - 1.8, 0, 10.0) : 0;
      if (dist > 0.8) { const targetYaw = Math.atan2(toPlayer.x, toPlayer.z); this.yaw = lerpAngle(this.yaw, targetYaw, Math.min(dt * 3, 1)); }
      this.speed = lerp(this.speed, targetSpeed, Math.min(dt * 2.5, 1));
      const dir = V(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.pos.addScaledVector(dir, this.speed * dt);
      this.lean = lerp(this.lean, 0, Math.min(dt * 4, 1));
    }
    const h = this.getHeight(this.pos.x, this.pos.z); this.pos.y = h;
    this.group.position.copy(this.pos); this.group.rotation.y = this.yaw; this.group.rotation.z = this.lean;
    const wheelSpin = (this.speed * dt) / 0.42; this.wheelFront.rotation.x += wheelSpin; this.wheelRear.rotation.x += wheelSpin;
    this.crank.rotation.x += this.speed * dt * 1.8;
    const pistonPhase = elapsed * 8 + this.speed * 0.5;
    this.pistonL.position.y = this.pistonBaseL + Math.sin(pistonPhase) * 0.025;
    this.pistonR.position.y = this.pistonBaseR + Math.sin(pistonPhase + Math.PI) * 0.025;
    this.exhaustT -= dt;
    if (this.speed > 1.2 && this.exhaustT <= 0 && this.fx?.spawnDust) { const p = this.stack.getWorldPosition(V()); this.fx.spawnDust(p.x, p.y + 0.08, p.z); this.exhaustT = 0.1; }
    const lampMat = this.lamp.material as THREE.MeshStandardMaterial; lampMat.emissiveIntensity = 1.4 + Math.sin(elapsed * 12) * 0.25 + Math.sin(elapsed * 3.7) * 0.12;
  }
}

export class SteampunkDrone {
  group: THREE.Group; pos = new THREE.Vector3(); yaw = 0; inventory: DroneInventoryItem[] = [];
  private rotors: THREE.Group[] = []; private lamp: THREE.Object3D; private arm: THREE.Object3D | null = null;
  private seed = Math.random() * 1000; private workTarget = new THREE.Vector3(); private workT = 0; private fxT = 0;
  constructor(public kind: SteampunkDroneKind, private getHeight: (x: number, z: number) => number, spawn: THREE.Vector3, private fx?: any, private trample?: TrampleLike) {
    const parts = buildDrone(kind); this.group = parts.group; this.rotors = parts.rotors; this.lamp = parts.lamp; this.arm = parts.arm;
    this.pos.copy(spawn); this.group.position.copy(this.pos);
  }
  addItem(id: string, name: string, qty = 1) { const item = this.inventory.find((i) => i.id === id); if (item) item.qty += qty; else this.inventory.push({ id, name, qty }); return true; }
  removeItem(id: string, qty = 1) { const item = this.inventory.find((i) => i.id === id); if (!item || item.qty < qty) return false; item.qty -= qty; if (item.qty <= 0) { this.inventory = this.inventory.filter((i) => i.id !== id); } return true; }
  update(dt: number, elapsed: number, playerPos: THREE.Vector3, playerYaw: number) {
    const t = elapsed + this.seed; let desired = V();
    if (this.kind === "movement") { const a = t * 0.9; desired.copy(playerPos).add(V(Math.sin(a) * 2.4, 0, Math.cos(a) * 2.4)); desired.y = this.getHeight(desired.x, desired.z) + 2.15 + Math.sin(t * 2.1) * 0.08; }
    else if (this.kind === "inventory") { const a = playerYaw + Math.PI + 0.55; desired.copy(playerPos).add(V(Math.sin(a) * 1.35, 0, Math.cos(a) * 1.35)); desired.y = this.getHeight(desired.x, desired.z) + 1.75 + Math.sin(t * 1.7) * 0.06; }
    else { const block = Math.floor(elapsed / 10); const r1 = rand(this.seed + block); const r2 = rand(this.seed * 3.7 + block); const radius = 2.5 + r1 * 5; const a = r2 * Math.PI * 2; if (this.workT <= 0) { this.workTarget.copy(playerPos).add(V(Math.sin(a) * radius, 0, Math.cos(a) * radius)); this.workT = 2.8 + r1 * 2.2; } desired.copy(this.workTarget); desired.y = this.getHeight(desired.x, desired.z) + 1.25 + Math.sin(t * 2.5) * 0.05; }
    this.pos.lerp(desired, Math.min(dt * 2.4, 1));
    const flat = V().subVectors(desired, this.pos); flat.y = 0;
    if (flat.lengthSq() > 0.0008) { const targetYaw = Math.atan2(flat.x, flat.z); this.yaw = lerpAngle(this.yaw, targetYaw, Math.min(dt * 3.5, 1)); }
    this.group.position.copy(this.pos); this.group.rotation.y = this.yaw; this.group.rotation.z = Math.sin(t * 2.2) * 0.04;
    for (let i = 0; i < this.rotors.length; i++) { this.rotors[i].rotation.y += dt * (34 + i * 3 + this.pos.length() * 0.05); }
    const lampMat = this.lamp.material as THREE.MeshStandardMaterial; lampMat.emissiveIntensity = 1.3 + Math.sin(t * 10) * 0.3 + Math.sin(t * 2.3) * 0.18;
    if (this.kind === "worker") {
      const d = this.pos.distanceTo(this.workTarget);
      if (d < 0.75 && this.workT > 0) { this.workT -= dt; this.fxT -= dt; if (this.arm) { this.arm.rotation.x = Math.sin(elapsed * 10) * 0.45; } if (this.fxT <= 0) { const p = this.group.getWorldPosition(V()); if (this.fx?.spawnMudChurn) { this.fx.spawnMudChurn(p.x, p.y - 1.05, p.z, 0.45); } else if (this.fx?.spawnDust) { this.fx.spawnDust(p.x, p.y - 1.05, p.z); } if (this.trample) { this.trample(p.x, p.z, 0.12, "dig"); } this.fxT = 0.55; } }
      else { this.workT = Math.max(0, this.workT - dt * 0.25); if (this.arm) { this.arm.rotation.x = lerp(this.arm.rotation.x, 0, Math.min(dt * 4, 1)); } }
    }
  }
}

export class SteampunkWorkerBot {
  group: THREE.Group; pos = new THREE.Vector3(); yaw = 0;
  private armL: THREE.Object3D; private armR: THREE.Object3D; private trackL: THREE.Object3D; private trackR: THREE.Object3D; private stack: THREE.Object3D;
  private target = new THREE.Vector3(); private state: "move" | "work" = "move"; private workT = 0; private fxT = 0; private seed = Math.random() * 1000;
  constructor(private getHeight: (x: number, z: number) => number, spawn: THREE.Vector3, private fx?: any, private trample?: TrampleLike) {
    const parts = buildWorkerBot(); this.group = parts.group; this.armL = parts.armL; this.armR = parts.armR; this.trackL = parts.trackL; this.trackR = parts.trackR; this.stack = parts.stack;
    this.pos.copy(spawn); this.target.copy(spawn); this.group.position.copy(this.pos);
  }
  update(dt: number, elapsed: number, playerPos: THREE.Vector3) {
    const t = elapsed + this.seed;
    if (this.state === "move") { const to = V().subVectors(this.target, this.pos); to.y = 0; const dist = to.length(); if (dist < 0.55) { this.state = "work"; this.workT = 2.4 + rand(this.seed + Math.floor(elapsed)) * 2.0; } else { const targetYaw = Math.atan2(to.x, to.z); this.yaw = lerpAngle(this.yaw, targetYaw, Math.min(dt * 4, 1)); const speed = 1.35; const dir = V(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.pos.addScaledVector(dir, speed * dt); } }
    else { this.workT -= dt; this.fxT -= dt; this.armL.rotation.x = Math.sin(t * 9) * 0.55; this.armR.rotation.x = Math.sin(t * 9 + Math.PI) * 0.55; if (this.fxT <= 0) { const p = this.group.getWorldPosition(V()); if (this.fx?.spawnMudChurn) { this.fx.spawnMudChurn(p.x, p.y + 0.05, p.z + 0.35, 0.55); } else if (this.fx?.spawnDust) { this.fx.spawnDust(p.x, p.y + 0.05, p.z + 0.35); } if (this.trample) { this.trample(p.x, p.z + 0.35, 0.16, "dig"); } this.fxT = 0.6; } if (this.workT <= 0) { this.state = "move"; const block = Math.floor(elapsed / 8); const r1 = rand(this.seed * 1.3 + block); const r2 = rand(this.seed * 5.1 + block); const radius = 2.2 + r1 * 6.5; const a = r2 * Math.PI * 2; this.target.copy(playerPos).add(V(Math.sin(a) * radius, 0, Math.cos(a) * radius)); } }
    const h = this.getHeight(this.pos.x, this.pos.z); this.pos.y = h;
    this.group.position.copy(this.pos); this.group.rotation.y = this.yaw; this.group.rotation.z = Math.sin(t * 4.5) * 0.015;
    const trackPulse = Math.sin(t * 8) * 0.004; this.trackL.position.y = 0.05 + trackPulse; this.trackR.position.y = 0.05 - trackPulse;
    if (this.fx?.spawnDust && Math.random() < dt * 1.2) { const p = this.stack.getWorldPosition(V()); this.fx.spawnDust(p.x, p.y + 0.05, p.z); }
  }
}

export class SteampunkFleet {
  group = new THREE.Group(); bike: SteampunkBike; drones: SteampunkDrone[] = []; bots: SteampunkWorkerBot[] = [];
  mounted = false; lastPlayerPos = new THREE.Vector3(); lastInput: InputLike | null = null;
  private keyHandler = (e: KeyboardEvent) => { if (e.code === "KeyE") this.toggleMount(); if (e.code === "KeyP") this.printInventory(); };
  constructor(scene: THREE.Scene, getHeight: (x: number, z: number) => number, spawn: THREE.Vector3, private fx?: any, private trample?: TrampleLike) {
    this.bike = new SteampunkBike(getHeight, spawn.clone(), fx); this.group.add(this.bike.group);
    const movementDrone = new SteampunkDrone("movement", getHeight, spawn.clone().add(V(1.5, 2.2, 1.2)), fx, trample);
    const inventoryDrone = new SteampunkDrone("inventory", getHeight, spawn.clone().add(V(-1.6, 1.9, 0.8)), fx, trample);
    const workerDrone = new SteampunkDrone("worker", getHeight, spawn.clone().add(V(0.4, 1.5, -2.0)), fx, trample);
    this.drones.push(movementDrone, inventoryDrone, workerDrone);
    for (const d of this.drones) { this.group.add(d.group); }
    const botA = new SteampunkWorkerBot(getHeight, spawn.clone().add(V(2.4, 0, -2.2)), fx, trample);
    const botB = new SteampunkWorkerBot(getHeight, spawn.clone().add(V(-2.8, 0, -1.2)), fx, trample);
    this.bots.push(botA, botB);
    for (const b of this.bots) { this.group.add(b.group); }
    inventoryDrone.addItem("boiler_parts", "Boiler Parts", 4); inventoryDrone.addItem("brass_cogs", "Brass Cogs", 12); inventoryDrone.addItem("lamp_oil", "Lamp Oil", 2);
    scene.add(this.group);
    if (typeof window !== "undefined") { window.addEventListener("keydown", this.keyHandler); }
  }
  dispose() { if (typeof window !== "undefined") { window.removeEventListener("keydown", this.keyHandler); } }
  toggleMount() { if (!this.mounted) { if (this.lastPlayerPos.distanceTo(this.bike.pos) < 3.5) { this.mounted = true; } } else { this.mounted = false; } }
  printInventory() { const inv = this.drones.find((d) => d.kind === "inventory"); console.table(inv?.inventory ?? []); }
  addItemToInventoryDrone(id: string, name: string, qty = 1) { const inv = this.drones.find((d) => d.kind === "inventory"); return inv?.addItem(id, name, qty) ?? false; }
  removeItemFromInventoryDrone(id: string, qty = 1) { const inv = this.drones.find((d) => d.kind === "inventory"); return inv?.removeItem(id, qty) ?? false; }
  update(dt: number, elapsed: number, playerPos: THREE.Vector3, playerYaw: number, input: InputLike, playerSpeed: number, onGround: boolean) {
    this.lastPlayerPos.copy(playerPos); this.lastInput = input;
    this.bike.update(dt, elapsed, input, playerPos, playerYaw, this.mounted);
    for (const d of this.drones) { d.update(dt, elapsed, playerPos, playerYaw); }
    for (const b of this.bots) { b.update(dt, elapsed, playerPos); }
    return { mounted: this.mounted, playerSpeed, onGround };
  }
}
