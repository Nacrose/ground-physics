import { Skeleton } from "../src/game/skeleton";
const s = new Skeleton(false);
s.group.updateMatrixWorld(true);
const wp = (n: string) => { const v = new (Object.getPrototypeOf(s.group.position).constructor)(); s.bones.get(n as never)!.getWorldPosition(v); return v; };
for (const n of ["hips","chest","neck","head","upperArmL","foreArmL","handL","thighL","shinL","footL","toeL"]) {
  const p = wp(n); console.log(n.padEnd(10), "y=", p.y.toFixed(3), "x=", p.x.toFixed(3), "z=", p.z.toFixed(3));
}
