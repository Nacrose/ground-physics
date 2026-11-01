/**
 * Animator: procedural skeletal animation with subtle variation for every
 * player action. Poses accumulate into a per-frame rotation buffer which is
 * flushed onto the bones at the end of update(). Layer order:
 *   1. gait cycle (walk/run, phase-driven, per-stride amplitude variance)
 *   2. action overlays (jump/fall, landing crouch, spade dig choreography)
 *   3. state blends (mud wade, tired breathing, cold shiver, rain hunch)
 *   4. secondary motion (breathing, idle head-look, roll-bone twist, bob)
 * All "randomness" is smooth value noise — each stride, breath and sway is
 * slightly different, so the character never reads as a hard loop.
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
  rootOffset = new THREE.Vector3();

  private acc = new Map<BoneName, Rot3>();
  private airW = 0; // smoothed airborne blend weight

  constructor(private skel: Skeleton) {}

  triggerLand(fallSpeed: number) {
    this.landDepth = Math.min(1.6, 0.45 + fallSpeed / 4.6);
    this.landT = 1;
  }

  update(dt: number) {
    this.time += dt;
    const acc = this.acc;
    acc.clear();
    // every frame starts from the REST pose — the flush below ADDS deltas,
    // so without this the pose accumulates frame-over-frame and the rig
    // winds up (chest reached 12 rad in 2 s of walk before this line)
    this.skel.reset();
    const p = this.gaitPhase;
    const spd = this.gaitSpeed;

    // ==================== 1. gait cycle ====================
    const freq = 2.4 + spd * 4.8; // phase rad/s-ish
    this.gaitPhase += dt * freq;
    const strideVar = 1 + 0.12 * noise1(this.gaitPhase * 0.16, 3); // +-12% per stride
    const amp = Math.min(spd, 1.4) * strideVar;
    const mudDrag = this.mudAmount * 0.45;
    const swing = Math.sin(this.gaitPhase) * amp;
    const liftA = Math.max(0, Math.sin(this.gaitPhase)) * amp;
    const liftB = Math.max(0, -Math.sin(this.gaitPhase)) * amp;

    if (amp > 0.02 && this.digPhase == null) {
      this.set("thighL", [swing * 0.8 * (1 - mudDrag), 0.05 * mudDrag, 0]);
      this.set("thighR", [-swing * 0.8 * (1 - mudDrag), -0.05 * mudDrag, 0]);
      // knees flex only backwards, mostly during the swing/heel-strike
      this.set("shinL", [-Math.max(0, -swing) * 0.85 - liftA * 0.3, 0, 0]);
      this.set("shinR", [-Math.max(0, swing) * 0.85 - liftB * 0.3, 0, 0]);
      // ankles: toe-off push-off then heel-strike dorsiflexion
      this.set("footL", [swing * 0.3 - 0.05, 0, 0]);
      this.set("footR", [-swing * 0.3 - 0.05, 0, 0]);
      this.set("toeL", [Math.max(0, -swing) * 0.4, 0, 0]);
      this.set("toeR", [Math.max(0, swing) * 0.4, 0, 0]);
      // pelvis counter-yaw + slight lateral tilt; spine twists opposite
      this.set("hips", [0, swing * 0.06, swing * 0.025]);
      this.set("spine", [0, -swing * 0.05, 0]);
      const lean = Math.min(spd * 0.09, 0.17) + (this.mudAmount > 0.4 ? 0.1 : 0);
      this.set("chest", [lean, -swing * 0.09, 0]);
      // arms counter-swing, elbow flex grows with speed
      const armSwing = swing * (this.sprint ? 0.55 : 0.65);
      this.set("upperArmL", [-armSwing, 0, 0]);
      this.set("upperArmR", [armSwing, 0, 0]);
      this.set("foreArmL", [-0.2 - Math.abs(armSwing) * 0.7, 0, 0]);
      this.set("foreArmR", [-0.2 - Math.abs(armSwing) * 0.7, 0, 0]);
      // two-beat vertical bob + slight fore-aft sway
      const bob = (Math.abs(Math.sin(this.gaitPhase)) * 0.03 + Math.sin(2 * this.gaitPhase) * 0.005)
        * Math.min(spd, 1.3);
      this.rootOffset.y = bob;
      this.rootOffset.x = noise1(this.gaitPhase * 0.5, 21) * 0.008 * amp;
      // head stabilizes against body bob (eyes stay level)
      this.add("head", [-bob * 3.5, 0, 0]);
    } else if (this.digPhase == null) {
      // standing weight shift: slow side-to-side settle
      const shift = noise1(this.time * 0.32, 7) * 0.02;
      this.set("hips", [0, shift * 0.4, shift]);
      this.set("spine", [0, -shift * 0.3, -shift * 0.5]);
      this.rootOffset.y = Math.abs(shift) * 0.12;
    }

    // ==================== 2. action overlays ====================
    // airborne (jump rise vs fall tuck), smoothed so takeoff/landing blend
    const airTarget = this.onGround ? 0 : 1;
    this.airW = lerp(this.airW, airTarget, Math.min(dt * (airTarget > 0.5 ? 14 : 9), 1));
    if (this.airW > 0.01 && this.digPhase == null) {
      const t = this.airW;
      if (this.velY > 0) {
        // rising: arms up-and-back, legs trailing (takeoff extension)
        this.mix("upperArmL", [-2.2, 0, 0.2], t);
        this.mix("upperArmR", [-2.2, 0, -0.2], t);
        this.mix("foreArmL", [-1.1, 0, 0], t);
        this.mix("foreArmR", [-1.1, 0, 0], t);
        this.mix("thighL", [0.45, 0, 0], t);
        this.mix("shinL", [-1.2, 0, 0], t);
        this.mix("thighR", [-0.25, 0, 0], t);
        this.mix("shinR", [-0.6, 0, 0], t);
        this.mix("chest", [-0.08, 0, 0], t);
      } else {
        // falling: reach forward for balance, legs search
        this.mix("upperArmL", [-1.5, 0, 0.45], t);
        this.mix("upperArmR", [-1.5, 0, -0.45], t);
        this.mix("foreArmL", [-0.6, 0, 0], t);
        this.mix("foreArmR", [-0.6, 0, 0], t);
        const search = noise1(this.time * 5, 1) * 0.06 * t;
        this.mix("thighL", [0.35 + search, 0, 0], t);
        this.mix("thighR", [0.35 - search, 0, 0], t);
        this.mix("shinL", [-0.75, 0, 0], t);
        this.mix("shinR", [-0.75, 0, 0], t);
        this.mix("footL", [0.3, 0, 0], t); // toes reach for the ground
        this.mix("footR", [0.3, 0, 0], t);
      }
    }
    // landing crouch: deepens with fall speed, eases out over ~0.3 s
    if (this.landT > 0) {
      this.landT = Math.max(0, this.landT - dt * 3.4);
      const t = this.landT * this.landT;
      const d = this.landDepth;
      this.mix("thighL", [d * 0.45, 0, 0.06 * t], t);
      this.mix("thighR", [d * 0.45, 0, -0.06 * t], t);
      this.mix("shinL", [-d * 0.85, 0, 0], t);
      this.mix("shinR", [-d * 0.85, 0, 0], t);
      this.mix("footL", [d * 0.35, 0, 0], t);
      this.mix("heelL", [-d * 0.3, 0, 0], t);
      this.mix("footR", [d * 0.35, 0, 0], t);
      this.mix("heelR", [-d * 0.3, 0, 0], t);
      this.mix("chest", [d * 0.3, 0, 0], t);
      this.mix("upperArmL", [-d * 0.55, 0, 0.25 * t], t); // flail for balance
      this.mix("upperArmR", [-d * 0.55, 0, -0.25 * t], t);
      this.mix("neck", [d * 0.2, 0, 0], t); // chin tucks
      this.rootOffset.y -= d * 0.14 * t;
    }
    // spade dig choreography: wind-up -> strike -> twist recovery
    if (this.digPhase != null) {
      const d = this.digPhase;
      const wind = Math.min(d / 0.35, 1);
      const strike = d < 0.35 ? 0 : Math.min((d - 0.35) / 0.2, 1);
      const recover = d < 0.55 ? 0 : (d - 0.55) / 0.45;
      const twist = Math.sin(recover * Math.PI);
      this.set("upperArmR", [-2.1 * wind + 2.5 * strike - 0.3 * recover, 0, 0.12 * twist]);
      this.set("foreArmR", [-0.8 * wind - 0.6 * strike, 0, 0.35 * twist]);
      this.set("handR", [-0.35 * strike, 0, 0]);
      this.set("upperArmL", [-1.5 * wind - 0.35 * strike + 0.2 * recover, 0, -0.18 * twist]);
      this.set("foreArmL", [-1.0 * wind - 0.2 * strike, 0, 0]);
      this.set("chest", [0.22 * wind + 0.4 * strike - 0.08 * recover, 0.38 * twist, 0]);
      this.set("spine", [0.12 * strike, -0.22 * twist, 0]);
      this.set("hips", [0, -0.28 * twist, 0]);
      this.set("thighL", [0.32 * wind, 0, 0]); // left foot braces forward
      this.set("shinL", [-0.45 * wind, 0, 0]);
      this.set("thighR", [-0.15 * wind, 0, 0]);
      this.set("shinR", [-0.25 * wind, 0, 0]);
      this.set("heelR", [-0.5 * strike, 0, 0]); // heel lifts on impact
      this.set("head", [0.18 * strike - 0.1 * recover, -0.22 * twist, 0]); // eyes on blade
      this.rootOffset.y = -0.05 * strike; // whole body drops into the blow
    }

    // ==================== 3. state blends ====================
    // mud wade: wide unstable stance, high knee lift, arms out, hip sway
    if (this.mudAmount > 0.3 && this.digPhase == null) {
      const m = (this.mudAmount - 0.3) / 0.7;
      this.mix("thighL", [0, 0.15 * m, 0], m * 0.8);
      this.mix("thighR", [0, -0.15 * m, 0], m * 0.8);
      this.mix("shinL", [-0.35 * m * Math.max(0, Math.sin(p)), 0, 0], m * 0.8);
      this.mix("shinR", [-0.35 * m * Math.max(0, -Math.sin(p)), 0, 0], m * 0.8);
      this.mix("hips", [0, 0, noise1(this.time * 2.2, 5) * 0.05 * m], m);
      this.mix("upperArmL", [0, 0, 0.3 * m], m * 0.7);
      this.mix("upperArmR", [0, 0, -0.3 * m], m * 0.7);
      this.mix("footL", [0, 0, 0.1 * m], m); // suction pull-out twist
      this.mix("footR", [0, 0, -0.1 * m], m);
    }
    // tired idle: heavy diaphragmatic breathing, dropped shoulders, head droop
    const tiredW = Math.max(0, 1 - spd * 1.5) * this.tired;
    if (tiredW > 0.02) {
      const br = Math.sin(this.time * 3.3) * 0.5 + 0.5;
      this.mix("chest", [0.16 * br * tiredW + 0.06 * tiredW, 0, 0], tiredW);
      this.mix("shoulderL", [0.1 * tiredW, 0, -0.15 * tiredW], tiredW);
      this.mix("shoulderR", [0.1 * tiredW, 0, 0.15 * tiredW], tiredW);
      this.mix("jaw", [0.14 * br * tiredW, 0, 0], tiredW);
      this.mix("neck", [0.08 * tiredW, 0, 0], tiredW);
      // rare slow head-shake ("shake it off") driven by low-freq noise
      const shake = Math.max(0, noise1(this.time * 0.13, 11)) ** 3;
      this.mix("head", [0, shake * 0.3 * tiredW, 0], tiredW);
    }
    // cold shiver while stationary: fast micro-tremor in hips/shoulders/jaw
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
    // rain soak: hunched shoulders, dipped chin, arms held closer
    if (this.wetAmount > 0.2) {
      const w = (this.wetAmount - 0.2) / 0.8;
      this.add("shoulderL", [0.09 * w, 0, -0.05 * w]);
      this.add("shoulderR", [0.09 * w, 0, 0.05 * w]);
      this.add("neck", [0.07 * w, 0, 0]);
      this.add("upperArmL", [0, 0, 0.06 * w]);
      this.add("upperArmR", [0, 0, -0.06 * w]);
    }

    // ==================== 4. secondary motion ====================
    // breathing always present, faster/deeper with exertion
    const breathe = Math.sin(this.time * (1.0 + spd * 1.8) + noise1(this.time * 0.3, 33) * 0.4) * 0.5 + 0.5;
    const bd = 0.018 + this.tired * 0.05;
    this.add("chest", [breathe * bd, 0, 0]);
    this.add("jaw", [breathe * 0.012, 0, 0]);
    this.add("shoulderL", [0, 0, -breathe * 0.012]);
    this.add("shoulderR", [0, 0, breathe * 0.012]);
    // idle head look-around (fades out once moving)
    if (spd < 0.35 && this.digPhase == null) {
      const gate = 1 - spd / 0.35;
      const hy = noise1(this.time * 0.21, 13) * 0.4 * gate;
      const hp = noise1(this.time * 0.16, 17) * 0.1 * gate;
      this.add("neck", [hp, hy * 0.4, 0]);
      this.add("head", [-hp * 0.6, hy * 0.6, 0]);
    }
    // roll-bone twist follows arm swing (fake supination / muscle slide)
    const tw = Math.sin(p) * amp * 0.12;
    this.add("rollArmL", [0, 0, tw]);
    this.add("rollArmR", [0, 0, -tw]);
    this.add("rollForeL", [0, 0, tw * 0.6]);
    this.add("rollForeR", [0, 0, -tw * 0.6]);
    // cloth settle: spine lags hips by a hair
    this.add("spine", [0, noise1(this.time * 1.5, 9) * 0.012, 0]);

    // ==================== flush onto bones ====================
    // reset() restored every bone to its rest rotation this frame; now add
    // the accumulated pose deltas. Bones not in the accumulator simply stay
    // at rest (no drift, no snap — the blend is inherently clean).
    for (const [bone, r] of acc) {
      const b = this.skel.get(bone);
      b.rotation.x += r[0];
      b.rotation.y += r[1];
      b.rotation.z += r[2];
    }
    this.skel.get("root").position.set(
      this.rootOffset.x, this.rootOffset.y - this.sinkage, this.rootOffset.z);
  }

  // --- accumulator helpers ---------------------------------------------------
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
