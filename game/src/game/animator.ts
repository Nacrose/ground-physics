/**
 * Animator: Fully physics-driven, procedural skeletal system.
 * Replaces canned keyframes with Spring-Damper physics, Two-Bone IK for
 * micro-terrain foot planting, Slope Normal alignment, and Wind/Momentum bracing.
 * No two strides are mathematically identical.
 */
import * as THREE from "three";
import { Skeleton, BoneName } from "./skeleton";

// --- 1. Spring-Damper Physics (Simulates Mass/Inertia) ----------------------
class Spring {
  pos = 0; vel = 0;
  constructor(public stiffness = 80, public damping = 10) {}
  update(target: number, dt: number) {
    const f = (target - this.pos) * this.stiffness;
    this.vel += f * dt;
    this.vel *= Math.max(0, 1 - this.damping * dt); // drag
    this.pos += this.vel * dt;
  }
}

class Spring3D {
  x: Spring; y: Spring; z: Spring;
  constructor(s = 80, d = 10) {
    this.x = new Spring(s, d); this.y = new Spring(s, d); this.z = new Spring(s, d);
  }
  update(target: [number, number, number], dt: number) {
    this.x.update(target[0], dt); this.y.update(target[1], dt); this.z.update(target[2], dt);
  }
  get v(): [number, number, number] { return [this.x.pos, this.y.pos, this.z.pos]; }
}

// --- 2. Non-Repeating 1D Value Noise (For organic stride jitter) ------------
function hashNoise(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}
function smoothNoise(t: number, seed: number): number {
  const i = Math.floor(t); const f = t - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  return hashNoise(i, seed, 0) * (1 - u) + hashNoise(i + 1, seed, 0) * u;
}

// --- 3. Two-Bone IK Solver --------------------------------------------------
function solveIK(aLen: number, bLen: number, tx: number, ty: number, bendSign: 1 | -1 = 1) {
  const dist = Math.sqrt(tx * tx + ty * ty);
  const maxReach = aLen + bLen - 0.001;
  const cDist = Math.min(dist, maxReach);
  const angToTarget = Math.atan2(ty, tx);
  
  const cosMid = (aLen * aLen + bLen * bLen - cDist * cDist) / (2 * aLen * bLen);
  const midAng = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosMid)));
  
  const cosRoot = (aLen * aLen + cDist * cDist - bLen * bLen) / (2 * aLen * cDist);
  const rootOffset = Math.acos(Math.max(-1, Math.min(1, cosRoot)));
  
  return { rootAng: angToTarget - bendSign * rootOffset, midAng: midAng * bendSign };
}

// ============================================================================
export class Animator {
  time = 0;
  gaitPhase = 0;
  gaitSpeed = 0;
  sprint = false;
  mudAmount = 0;
  wetAmount = 0;
  tired = 0;
  cold = 0;
  velY = 0;
  onGround = true;
  sinkage = 0;
  digPhase: number | null = null;
  landT = 0;
  landDepth = 1;
  yaw = 0;

  // --- NEW: Circumstance Physics Data (Fed by player.ts) ---
  slopeNormal = new THREE.Vector3(0, 1, 0);
  worldVelocity = new THREE.Vector3();
  windVelocity = new THREE.Vector3();
  leftFootTerrainY = 0;  // Height of ground under left foot relative to hips
  rightFootTerrainY = 0; // Height of ground under right foot relative to hips
  digTarget: THREE.Vector3 | null = null;

  private rootOffset = new THREE.Vector3();
  
  // Physics springs for secondary motion (Simulates flesh/muscle mass)
  private springSpine = new Spring3D(60, 9);
  private springHead = new Spring3D(80, 11);
  private springArmL = new Spring3D(50, 7);
  private springArmR = new Spring3D(50, 7);
  private springHipsRoll = new Spring(120, 15);
  private springHipsPitch = new Spring(120, 15);

  constructor(private skel: Skeleton) {}

  triggerLand(fallSpeed: number) {
    this.landDepth = Math.min(1.6, 0.45 + fallSpeed / 4.6);
    this.landT = 1;
    // Impact shockwave travels up the springs
    this.springSpine.y.vel += fallSpeed * 0.8;
    this.springHead.y.vel += fallSpeed * 1.2;
    this.springHipsPitch.vel += fallSpeed * 0.5;
  }

  update(dt: number) {
    this.time += dt;
    this.skel.reset();
    const p = this.gaitPhase;
    const spd = this.gaitSpeed;
    const acc = new Map<BoneName, [number, number, number]>();

    const set = (b: BoneName, r: [number, number, number]) => acc.set(b, r);
    const add = (b: BoneName, r: [number, number, number]) => {
      const c = acc.get(b) ?? [0, 0, 0];
      acc.set(b, [c[0] + r[0], c[1] + r[1], c[2] + r[2]]);
    };

    // --- 1. SLOPE ALIGNMENT & MOMENTUM (Vestibular Reflex) -----------------
    const slopePitch = Math.atan2(this.slopeNormal.z, this.slopeNormal.y);
    const slopeRoll = Math.atan2(this.slopeNormal.x, this.slopeNormal.y);
    
    // Forward momentum lean (braking/sprinting inertia)
    const horizSpd = Math.sqrt(this.worldVelocity.x ** 2 + this.worldVelocity.z ** 2);
    const targetLean = Math.min(horizSpd * 0.04, 0.2) * (this.sprint ? 1.5 : 1);
    
    this.springHipsPitch.update(-slopePitch, dt);
    this.springHipsRoll.update(-slopeRoll, dt);
    
    set("hips", [this.springHipsPitch.pos, 0, this.springHipsRoll.pos]);
    // Spine counter-rotates to keep head level
    set("spine", [-this.springHipsPitch.pos * 0.6, 0, -this.springHipsRoll.pos * 0.6]);
    
    // Chest leans into movement and wind gusts
    const windPush = this.windVelocity.length() * 0.02;
    const chestTarget: [number, number, number] = [
      targetLean + windPush + 0.05, 0, 0
    ];
    this.springSpine.update(chestTarget, dt);
    set("chest", this.springSpine.v);

    // --- 2. PROCEDURAL GAIT & MICRO-TERRAIN IK -----------------------------
    // Frequency drops in mud; stride height jitters organically via noise
    const freq = 2.4 + spd * 4.8;
    this.gaitPhase += dt * freq * (1 - this.mudAmount * 0.4); 
    const strideHeightJitter = smoothNoise(this.time * 1.3, 42) * 0.15;
    
    if (spd > 0.05 && this.digPhase == null) {
      const amp = Math.min(spd, 1.4);
      const swing = Math.sin(p) * amp;
      const liftL = Math.max(0, Math.sin(p)) * amp;
      const liftR = Math.max(0, -Math.sin(p)) * amp;

      const thighLen = 0.42, shinLen = 0.40;
      
      // LEFT LEG IK
      const lTargetX = -Math.sin(swing * 0.8) * amp * 0.6;
      const lTargetY = -0.80 + liftL * 0.3 + this.leftFootTerrainY * 1.2 + strideHeightJitter;
      const lIK = solveIK(thighLen, shinLen, lTargetX, lTargetY, 1);
      set("thighL", [lIK.rootAng + (this.mudAmount > 0.3 ? 0.4 : 0), 0, 0]);
      set("shinL", [lIK.midAng, 0, 0]);
      set("footL", [-swing * 0.3 - 0.05 + this.leftFootTerrainY * 0.5, 0, 0]);
      
      // RIGHT LEG IK
      const rTargetX = Math.sin(swing * 0.8) * amp * 0.6;
      const rTargetY = -0.80 + liftR * 0.3 + this.rightFootTerrainY * 1.2 - strideHeightJitter;
      const rIK = solveIK(thighLen, shinLen, rTargetX, rTargetY, 1);
      set("thighR", [rIK.rootAng + (this.mudAmount > 0.3 ? 0.4 : 0), 0, 0]);
      set("shinR", [rIK.midAng, 0, 0]);
      set("footR", [swing * 0.3 - 0.05 + this.rightFootTerrainY * 0.5, 0, 0]);

      this.rootOffset.y = (Math.abs(Math.sin(p)) * 0.03) * amp;
    }

    // --- 3. ACTION OVERLAYS (Physics Impulses) -----------------------------
    if (this.digPhase != null) {
      const d = this.digPhase;
      const strike = d < 0.35 ? 0 : Math.min((d - 0.35) / 0.2, 1);
      // Inject physical impulse into the spine during the strike
      this.springSpine.x.update(0.5 * strike, dt); 
    }

    if (this.landT > 0) {
      this.landT = Math.max(0, this.landT - dt * 3.4);
      const t = this.landT * this.landT;
      const d = this.landDepth;
      add("thighL", [d * 0.45 * t, 0, 0]); add("thighR", [d * 0.45 * t, 0, 0]);
      add("shinL", [-d * 0.85 * t, 0, 0]); add("shinR", [-d * 0.85 * t, 0, 0]);
    }

    // --- 4. PHYSICS-DRIVEN SECONDARY MOTION ----------------------------------
    // Inertia from turning, jumping, and wind acts on the arms
    const turnVel = this.worldVelocity.x * Math.cos(this.yaw) - this.worldVelocity.z * Math.sin(this.yaw);
    const inertiaY = -this.velY * 0.1;
    
    const armSwing = Math.sin(p) * spd * 0.4;
    this.springArmL.update([armSwing, 0, -turnVel * 0.2 + inertiaY], dt);
    this.springArmR.update([-armSwing, 0, turnVel * 0.2 + inertiaY], dt);
    
    set("upperArmL", [this.springArmL.v[0], this.springArmL.v[1], this.springArmL.v[2] - 0.1]);
    set("upperArmR", [this.springArmR.v[0], this.springArmR.v[1], this.springArmR.v[2] + 0.1]);
    set("foreArmL", [-0.3 - Math.abs(this.springArmL.v[0]) * 0.5, 0, 0]);
    set("foreArmR", [-0.3 - Math.abs(this.springArmR.v[0]) * 0.5, 0, 0]);

    // Head stabilization (tracks horizon despite chest bouncing)
    const headTarget: [number, number, number] = [
      -this.springSpine.v[0] * 0.5 + this.velY * 0.05, 
      -turnVel * 0.1, 
      -this.springHipsRoll.pos * 0.5
    ];
    this.springHead.update(headTarget, dt);
    set("head", this.springHead.v);

    // Environmental reactions
    if (this.mudAmount > 0.4) {
      add("upperArmL", [0, 0, 0.3 * this.mudAmount + smoothNoise(this.time*3, 11)*0.2]);
      add("upperArmR", [0, 0, -0.3 * this.mudAmount + smoothNoise(this.time*3.2, 13)*0.2]);
    }
    if (this.cold > 0.1 && spd < 0.2) {
      add("chest", [Math.sin(this.time*22)*0.01*this.cold, 0, 0]);
      add("jaw", [Math.sin(this.time*18)*0.02*this.cold, 0, 0]);
    }

    // --- FLUSH DELTAS TO BONES ---------------------------------------------
    for (const [bone, r] of acc) {
      const b = this.skel.get(bone);
      b.rotation.x += r[0]; b.rotation.y += r[1]; b.rotation.z += r[2];
    }
    this.skel.get("root").position.set(
      this.rootOffset.x, this.rootOffset.y - this.sinkage, this.rootOffset.z);
  }
}
