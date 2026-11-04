/**
 * Animator: procedural skeletal animation with subtle variation for every
 * player action. Poses accumulate into a per-frame rotation buffer which is
 * flushed onto the bones at the end of update(). Layer order:
 *   1. gait cycle (walk/run, phase-driven, per-stride amplitude variance) OR mounted riding pose
 *   2. action overlays (jump/fall, landing crouch, spade dig choreography)
 *   3. state blends (mud wade, tired breathing, cold shiver, rain hunch)
 *   4. secondary motion (breathing, idle head-look, roll-bone twist, bob, slope lean)
 */
import * as THREE from "three";
import { Skeleton, BoneName } from "./skeleton";

/** cheap smooth 1-D value noise (hash + cosine interpolation), range -1..1 */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number) => {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
type Rot3 = [number, number, number];

class Spring {
  pos = 0; vel = 0;
  constructor(public stiffness = 80, public damping = 10) {}
  update(target: number, dt: number) {
    const f = (target - this.pos) * this.stiffness;
    this.vel += f * dt;
    this.vel *= Math.max(0, 1 - this.damping * dt);
    this.pos += this.vel * dt;
  }
}

export class Animator {
  time = 0;
  gaitPhase = 0;
  /** normalized gait speed: 0 standing, ~1 walk, ~1.8 sprint */
  gaitSpeed = 0;
  sprint = false;
  mudAmount = 0;   // 0..1 softness underfoot
  wetAmount = 0;   // 0..1 soak level
  tired = 0;       // 0..1 stamina depletion hint
  cold = 0;        // 0..1 chill hint (cold front / freezing rain)
  velY = 0;        // vertical velocity for rise/fall pose selection
  onGround = true;
  sinkage = 0;     // [m] feet below surface (mud suction)
  digPhase: number | null = null; // engine drives 0..1 while digging
  landT = 0;       // decaying 1->0 after touchdown
  landDepth = 1;   // crouch intensity scale
  yaw = 0;
  mounted = false; // mounted on steampunk motorcycle
  rootOffset = new THREE.Vector3();

  slopeNormal = new THREE.Vector3(0, 1, 0);
  worldVelocity = new THREE.Vector3();
  windVelocity = new THREE.Vector3();
  leftFootTerrainY = 0;
  rightFootTerrainY = 0;

  private acc = new Map<BoneName, Rot3>();
  private airW = 0; // smoothed airborne blend weight
  private springHipsPitch = new Spring(90, 12);
  private springHipsRoll = new Spring(90, 12);

  constructor(private skel: Skeleton) {}

  triggerLand(fallSpeed: number) {
    this.landDepth = Math.min(1.6, 0.45 + fallSpeed / 4.6);
    this.landT = 1;
  }

  update(dt: number) {
    this.time += dt;
    const acc = this.acc;
    acc.clear();
    this.skel.reset();
    const spd = this.gaitSpeed;

    // ==================== MOUNTED POSE (Motorcycle) ====================
    if (this.mounted) {
      this.rootOffset.set(0, 0, 0);
      const spdNorm = Math.min(spd, 2.0);
      const vibe = Math.sin(this.time * 28) * 0.012;
      const speedLean = spdNorm * 0.08;

      // Hips seated on saddle, thighs hugging tank (-rot.x = forward), knees bent back (+rot.x = back)
      this.set("thighL", [-1.15, 0.16, 0.08]);
      this.set("thighR", [-1.15, -0.16, -0.08]);
      this.set("shinL", [1.42, 0, 0]);
      this.set("shinR", [1.42, 0, 0]);
      this.set("footL", [-0.25, 0, 0]);
      this.set("footR", [-0.25, 0, 0]);

      // Torso leans forward onto handlebars
      this.set("hips", [0.05, 0, 0]);
      this.set("spine", [0.20 + speedLean * 0.5, 0, 0]);
      this.set("chest", [0.25 + speedLean + vibe, 0, 0]);
      this.set("neck", [-0.15, 0, 0]);
      this.set("head", [-0.25, 0, 0]);

      // Arms gripping handlebars (upperArm negative rot.x = forward, foreArm negative = elbow bent)
      this.set("upperArmL", [-0.85 + vibe, -0.12, 0.22]);
      this.set("upperArmR", [-0.85 + vibe, 0.12, -0.22]);
      this.set("foreArmL", [-0.45, 0, 0]);
      this.set("foreArmR", [-0.45, 0, 0]);

      this.flush();
      return;
    }

    // ==================== 1. GAIT CYCLE (On Foot) ====================
    const freq = 2.6 + spd * 3.8;
    this.gaitPhase += dt * freq;
    const strideVar = 1 + 0.10 * noise1(this.gaitPhase * 0.16, 3);
    const amp = Math.min(spd, 1.4) * strideVar;
    const mudDrag = this.mudAmount * 0.45;

    // Convert world slope normal to player's local frame
    const localSlopeFwd = -(this.slopeNormal.x * Math.sin(this.yaw) + this.slopeNormal.z * Math.cos(this.yaw));
    const localSlopeRight = -(this.slopeNormal.x * Math.cos(this.yaw) - this.slopeNormal.z * Math.sin(this.yaw));
    const targetHipsPitch = Math.max(-0.25, Math.min(0.25, localSlopeFwd * 0.35));
    const targetHipsRoll = Math.max(-0.2, Math.min(0.2, localSlopeRight * 0.3));
    this.springHipsPitch.update(targetHipsPitch, dt);
    this.springHipsRoll.update(targetHipsRoll, dt);

    if (amp > 0.02 && this.digPhase == null) {
      const p = this.gaitPhase;
      const sinP = Math.sin(p);
      const cosP = Math.cos(p);

      // Thighs: swing forward (negative rot.x) and backward (positive rot.x)
      const thighAmp = (this.sprint ? 0.65 : 0.52) * amp * (1 - mudDrag);
      this.set("thighL", [-sinP * thighAmp, 0.04 * mudDrag, 0]);
      this.set("thighR", [sinP * thighAmp, -0.04 * mudDrag, 0]);

      // Knees (Shin): flex BACKWARD (positive rot.x only!) during forward swing
      // Peaks at mid-swing (cosP > 0 for L, -cosP > 0 for R) and extends straight before heel strike
      const kneeFlexMax = (this.sprint ? 0.95 : 0.78) + this.mudAmount * 0.25;
      const kneeL = Math.max(0, cosP) * kneeFlexMax;
      const kneeR = Math.max(0, -cosP) * kneeFlexMax;
      this.set("shinL", [kneeL, 0, 0]);
      this.set("shinR", [kneeR, 0, 0]);

      // Ankles (Foot): slight heel dorsiflexion (-rot.x) at strike, toe plantarflexion (+rot.x) at push-off
      this.set("footL", [-sinP * 0.18 + 0.04, 0, 0]);
      this.set("footR", [sinP * 0.18 + 0.04, 0, 0]);
      this.set("toeL", [Math.max(0, -sinP) * 0.25, 0, 0]);
      this.set("toeR", [Math.max(0, sinP) * 0.25, 0, 0]);

      // Pelvis counter-yaw + lateral tilt + slope lean
      this.set("hips", [this.springHipsPitch.pos, sinP * 0.07, this.springHipsRoll.pos + sinP * 0.025]);
      this.set("spine", [-this.springHipsPitch.pos * 0.5, -sinP * 0.05, -this.springHipsRoll.pos * 0.5]);
      const lean = Math.min(spd * 0.06, 0.15) + (this.sprint ? 0.08 : 0) + (this.mudAmount > 0.4 ? 0.08 : 0);
      this.set("chest", [lean, -sinP * 0.03, 0]);

      // Contralateral Arm Swing: Left leg forward -> Right arm forward (negative rot.x)
      const armAmp = (this.sprint ? 0.75 : 0.58) * amp;
      this.set("upperArmL", [sinP * armAmp, 0, 0.08]);
      this.set("upperArmR", [-sinP * armAmp, 0, -0.08]);

      // Elbows flex forward (negative rot.x), flexing more on forward swing
      const elbowBase = -0.25 - (this.sprint ? 0.25 : 0.10);
      this.set("foreArmL", [elbowBase - Math.max(0, -sinP) * 0.40, 0, 0]);
      this.set("foreArmR", [elbowBase - Math.max(0, sinP) * 0.40, 0, 0]);

      // Two-beat vertical bob: peaks during mid-stance on each foot
      const bob = (Math.abs(cosP) * 0.032) * Math.min(spd, 1.3);
      this.rootOffset.y = bob;
      this.rootOffset.x = noise1(this.gaitPhase * 0.5, 21) * 0.006 * amp;
      this.rootOffset.z = 0;
    } else {
      this.rootOffset.set(0, 0, 0);
      this.set("hips", [this.springHipsPitch.pos, 0, this.springHipsRoll.pos]);
      this.set("spine", [-this.springHipsPitch.pos * 0.5, 0, -this.springHipsRoll.pos * 0.5]);
    }

    // ==================== 2. ACTION OVERLAYS ====================
    // Airborne (jump rise vs fall tuck)
    const airTarget = this.onGround ? 0 : 1;
    this.airW = lerp(this.airW, airTarget, Math.min(dt * (airTarget > 0.5 ? 14 : 9), 1));
    if (this.airW > 0.01 && this.digPhase == null) {
      const t = this.airW;
      if (this.velY > 0) {
        // rising: legs trail behind, arms reach up/back
        this.mix("upperArmL", [1.1, 0, 0.2], t);
        this.mix("upperArmR", [1.1, 0, -0.2], t);
        this.mix("foreArmL", [-0.4, 0, 0], t);
        this.mix("foreArmR", [-0.4, 0, 0], t);
        this.mix("thighL", [0.35, 0, 0], t);
        this.mix("shinL", [0.75, 0, 0], t);
        this.mix("thighR", [0.20, 0, 0], t);
        this.mix("shinR", [0.55, 0, 0], t);
        this.mix("chest", [-0.08, 0, 0], t);
      } else {
        // falling: reach forward for balance, legs reach down/forward for touchdown
        this.mix("upperArmL", [-1.1, 0, 0.3], t);
        this.mix("upperArmR", [-1.1, 0, -0.3], t);
        this.mix("foreArmL", [-0.5, 0, 0], t);
        this.mix("foreArmR", [-0.5, 0, 0], t);
        const search = noise1(this.time * 5, 1) * 0.06 * t;
        this.mix("thighL", [-0.25 + search, 0, 0], t);
        this.mix("thighR", [-0.25 - search, 0, 0], t);
        this.mix("shinL", [0.35, 0, 0], t);
        this.mix("shinR", [0.35, 0, 0], t);
        this.mix("footL", [-0.15, 0, 0], t);
        this.mix("footR", [-0.15, 0, 0], t);
      }
    }

    // Landing crouch: knees bend backward (+rot.x), thighs flex forward (-rot.x)
    if (this.landT > 0) {
      this.landT = Math.max(0, this.landT - dt * 3.4);
      const t = this.landT * this.landT;
      const d = this.landDepth;
      this.add("thighL", [-d * 0.30 * t, 0, 0]);
      this.add("thighR", [-d * 0.30 * t, 0, 0]);
      this.add("shinL", [d * 0.65 * t, 0, 0]);
      this.add("shinR", [d * 0.65 * t, 0, 0]);
      this.add("chest", [d * 0.15 * t, 0, 0]);
    }

    // Spade dig choreography
    if (this.digPhase != null) {
      const d = this.digPhase;
      const lift = d < 0.35 ? d / 0.35 : Math.max(0, 1 - (d - 0.35) / 0.25);
      const strike = d < 0.35 ? 0 : Math.min((d - 0.35) / 0.2, 1);
      this.mix("upperArmR", [-1.2 * lift + 0.3 * strike, -0.3 * lift, -0.2], lift);
      this.mix("foreArmR", [-1.0 * lift, 0, 0], lift);
      this.mix("upperArmL", [-0.5 * lift, 0.4 * lift, 0.3], lift);
      this.mix("chest", [0.15 * lift + 0.25 * strike, -0.25 * lift, 0], lift);
      this.mix("spine", [0.15 * strike, -0.15 * lift, 0], lift);
      this.rootOffset.y = -0.05 * strike;
    }

    // ==================== 3. STATE BLENDS ====================
    // Mud wade: wide stance, high knee lift, arms out for balance
    if (this.mudAmount > 0.3 && this.digPhase == null) {
      const m = (this.mudAmount - 0.3) / 0.7;
      this.mix("thighL", [0, 0.15 * m, 0], m * 0.8);
      this.mix("thighR", [0, -0.15 * m, 0], m * 0.8);
      this.mix("hips", [0, 0, noise1(this.time * 2.2, 5) * 0.05 * m], m);
      this.mix("upperArmL", [0, 0, 0.3 * m], m * 0.7);
      this.mix("upperArmR", [0, 0, -0.3 * m], m * 0.7);
      this.mix("footL", [0, 0, 0.1 * m], m);
      this.mix("footR", [0, 0, -0.1 * m], m);
    }

    // Tired idle
    const tiredW = Math.max(0, 1 - spd * 1.5) * this.tired;
    if (tiredW > 0.02) {
      const br = Math.sin(this.time * 3.3) * 0.5 + 0.5;
      this.mix("chest", [0.16 * br * tiredW + 0.06 * tiredW, 0, 0], tiredW);
      this.mix("shoulderL", [0.1 * tiredW, 0, -0.15 * tiredW], tiredW);
      this.mix("shoulderR", [0.1 * tiredW, 0, 0.15 * tiredW], tiredW);
      this.mix("jaw", [0.14 * br * tiredW, 0, 0], tiredW);
      this.mix("neck", [0.08 * tiredW, 0, 0], tiredW);
      const shake = Math.max(0, noise1(this.time * 0.13, 11)) ** 3;
      this.mix("head", [0, shake * 0.3 * tiredW, 0], tiredW);
    }

    // Cold shiver
    if (this.cold > 0.05 && spd < 0.15) {
      const s = this.cold;
      const t1 = Math.sin(this.time * 21) * 0.012 * s;
      const t2 = Math.sin(this.time * 26 + 1.3) * 0.010 * s;
      this.add("hips", [t1, t2, 0]);
      this.add("shoulderL", [0, 0, t2]);
      this.add("shoulderR", [0, 0, -t2]);
      this.add("chest", [t1 * 0.6, 0, 0]);
      this.add("jaw", [Math.sin(this.time * 18) * 0.02 * s, 0, 0]);
    }

    // Rain soak
    if (this.wetAmount > 0.2) {
      const w = (this.wetAmount - 0.2) / 0.8;
      this.add("shoulderL", [0.09 * w, 0, -0.05 * w]);
      this.add("shoulderR", [0.09 * w, 0, 0.05 * w]);
      this.add("neck", [0.07 * w, 0, 0]);
      this.add("upperArmL", [0, 0, 0.06 * w]);
      this.add("upperArmR", [0, 0, -0.06 * w]);
    }

    // ==================== 4. SECONDARY MOTION ====================
    // Breathing
    const breathe = Math.sin(this.time * (1.0 + spd * 1.8) + noise1(this.time * 0.3, 33) * 0.4) * 0.5 + 0.5;
    const bd = 0.018 + this.tired * 0.05;
    this.add("chest", [breathe * bd, 0, 0]);
    this.add("jaw", [breathe * 0.012, 0, 0]);
    this.add("shoulderL", [0, 0, -breathe * 0.012]);
    this.add("shoulderR", [0, 0, breathe * 0.012]);

    // Idle head look-around
    if (spd < 0.35 && this.digPhase == null) {
      const gate = 1 - spd / 0.35;
      const hy = noise1(this.time * 0.21, 13) * 0.4 * gate;
      const hp = noise1(this.time * 0.16, 17) * 0.1 * gate;
      this.add("neck", [hp, hy * 0.4, 0]);
      this.add("head", [-hp * 0.6, hy * 0.6, 0]);
    }

    // Roll-bone twist
    const tw = Math.sin(this.gaitPhase) * amp * 0.12;
    this.add("rollArmL", [0, 0, tw]);
    this.add("rollArmR", [0, 0, -tw]);
    this.add("rollForeL", [0, 0, tw * 0.6]);
    this.add("rollForeR", [0, 0, -tw * 0.6]);

    this.flush();
  }

  private flush() {
    for (const [bone, r] of this.acc) {
      const b = this.skel.get(bone);
      b.rotation.x += r[0];
      b.rotation.y += r[1];
      b.rotation.z += r[2];
    }
    this.skel.get("root").position.set(
      this.rootOffset.x, this.rootOffset.y, this.rootOffset.z);
  }

  private set(b: BoneName, r: Rot3) { this.acc.set(b, [r[0], r[1], r[2]]); }
  private add(b: BoneName, r: Rot3) {
    const c = this.acc.get(b) ?? [0, 0, 0];
    this.acc.set(b, [c[0] + r[0], c[1] + r[1], c[2] + r[2]]);
  }
  private mix(b: BoneName, r: Rot3, w: number) {
    const c = this.acc.get(b) ?? [0, 0, 0];
    this.acc.set(b, [lerp(c[0], r[0], w), lerp(c[1], r[1], w), lerp(c[2], r[2], w)]);
  }
}
