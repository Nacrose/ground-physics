// headless smoke test: build skeleton+skin, run the animator through every action
import * as THREE from "three";
import { Skeleton } from "../src/game/skeleton";
import { buildSkin, buildSpade, buildLantern } from "../src/game/skin";
import { Animator } from "../src/game/animator";

const skel = new Skeleton(false);
buildSkin(skel);
buildSpade(skel);
buildLantern(skel);
const anim = new Animator(skel);

let t = 0;
const step = (dt: number) => { anim.update(dt); t += dt; };
const finite = () => {
  let ok = true;
  skel.group.updateMatrixWorld(true);
  skel.bones.forEach((b) => {
    const m = b.matrixWorld.elements;
    if (m.some((v) => !Number.isFinite(v))) { ok = false; console.log("NaN in", b.name); }
  });
  return ok;
};

// walk
anim.gaitSpeed = 1.0; for (let i = 0; i < 120; i++) step(1/60);
console.log("walk ok:", finite(), "phase", anim.gaitPhase.toFixed(2));
// sprint + tired
anim.gaitSpeed = 1.75; anim.sprint = true; anim.tired = 0.8; for (let i = 0; i < 120; i++) step(1/60);
console.log("sprint/tired ok:", finite());
// jump rise then fall then land
anim.onGround = false; anim.velY = 4; anim.tired = 0; for (let i = 0; i < 30; i++) step(1/60);
anim.velY = -4; for (let i = 0; i < 30; i++) step(1/60);
anim.onGround = true; anim.velY = 0; anim.triggerLand(4); for (let i = 0; i < 60; i++) step(1/60);
console.log("jump/land ok:", finite());
// dig cycle x3
for (let c = 0; c < 3; c++) { for (let p = 0; p <= 1.001; p += 0.02) { anim.digPhase = p; step(1/60); } anim.digPhase = null; step(1/60);}
console.log("dig ok:", finite());
// mud wade + cold shiver idle
anim.gaitSpeed = 0.5; anim.mudAmount = 0.9; for (let i = 0; i < 120; i++) step(1/60);
anim.gaitSpeed = 0; anim.cold = 1; anim.wetAmount = 1; for (let i = 0; i < 180; i++) step(1/60);
console.log("mud/shiver ok:", finite());

// verify bones actually move between poses
const readPose = () => ["thighL","upperArmR","chest","head"].map(n => skel.get(n as never).rotation.x.toFixed(3)).join(",");
anim.digPhase = null; anim.gaitSpeed = 0; anim.cold = 0; anim.wetAmount = 0; anim.mudAmount = 0; anim.tired = 0;
for (let i = 0; i < 60; i++) step(1/60);
const idlePose = readPose();
anim.gaitSpeed = 1.2; for (let i = 0; i < 20; i++) step(1/60);
const walkPose = readPose();
console.log("idle pose:", idlePose, "\nwalk pose:", walkPose, "\nposes differ:", idlePose !== walkPose);
