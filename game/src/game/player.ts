/**
 * Player: a low-poly frontier rider on foot. Third-person over-the-shoulder
 * camera (RDR2 style), WASD + sprint + jump, and the physical link to the
 * ground engine — walking through wet clay slows you, you sink into liquid
 * mud, you leave footprints and ruts, and puddle wading throws splashes.
 */
import * as THREE from "three";
import { TerrainData, sampleHeight, terrainNormal } from "./terrain";
import { Ground } from "./ground";
import { StormFX, StepKind } from "./fx";
import { MicroTerrain, SoilTouch } from "./contact";
import type { Tunnel } from "./tunnel";
import { Skeleton } from "./skeleton";
import { buildSkin, buildSpade, buildLantern, Skin } from "./skin";
import { Animator } from "./animator";

export interface InputState {
  forward: number; // -1..1
  right: number; // -1..1
  sprint: boolean;
  jump: boolean;
  dig: boolean; // hold F: spade strokes at the aim point
  yaw: number; // camera yaw (radians)
  pitch: number;
  zoom: number;
}

export type TrampleFn = (x: number, z: number, r: number, mode: "trample" | "dig") => void;

const JEANS_BASE = new THREE.Color(0x35404d);
const BOOT_BASE = new THREE.Color(0x2a211c);
const BOOT_MUD_COL = new THREE.Color(0x241a12);

export class Player {
  group: THREE.Group; // character root
  pos = new THREE.Vector3(0, 0, 0);
  vel = new THREE.Vector3();
  yaw = 0; // facing direction
  speed = 0;
  onGround = true;
  sinkage = 0;
  mud = 0;
  pondM = 0;
  footprints: THREE.InstancedMesh;
  private fpIdx = 0;
  private fpMax = 170;
  private lastFootSign = 1;
  private jumpVel = 0;

  // ---- skeletal rig ---------------------------------------------------------
  /** fine bone hierarchy (32 pivots) — the single source of pose truth */
  skeleton: Skeleton;
  /** procedural animator driving every action with subtle variation */
  animator: Animator;

  camera: THREE.PerspectiveCamera;
  private camPitch = 0.18;
  private camZoom = 6.2;
  /** mud caked on the boots 0..1 — picked up in plastic/liquid mud, dries
   *  and flakes off on dry ground; weighs the walk down and glosses the legs */
  bootMud = 0;
  /** dwell timer while standing still on soft mud (viscoplastic creep) */
  private dwellT = 0;
  /** the skinned character (jeans/boot materials stain with boot mud) */
  skin!: Skin;
  /** miner's lantern — the only light underground */
  private lantern: THREE.PointLight | null = null;
  private lanternBody: THREE.Mesh | null = null;
  /** spade swing animation phase 0..1, or null when idle */
  digPhase: number | null = null;
  /** stamina / chill state fed to the animator for tired & shiver layers */
  private tired = 0;
  private cold = 0;
  /** tunnel the player can enter (wired by the engine after creation) */
  tunnel: Tunnel | null = null;

  constructor(scene: THREE.Scene, private terrain: TerrainData, private ground: Ground,
    private fx: StormFX, private micro: MicroTerrain, spawnX: number, spawnZ: number,
    private trample?: TrampleFn) {
    // ---- character: fine skeleton + human skin draped over it ---------------
    // The old flat box-puppet is replaced by a 32-bone hierarchical rig
    // (skeleton.ts) with capsule/box skin parts parented per bone (skin.ts).
    // All motion comes from the procedural Animator — nothing here poses meshes.
    this.group = new THREE.Group();
    this.skeleton = new Skeleton(false);
    this.skin = buildSkin(this.skeleton);
    buildSpade(this.skeleton);
    const lanternRig = buildLantern(this.skeleton);
    this.lantern = lanternRig.light;
    this.lanternBody = lanternRig.body;
    this.animator = new Animator(this.skeleton);
    this.group.add(this.skeleton.group);
    scene.add(this.group);

    // ---- footprints (instanced dark ellipses) ------------------------------
    const fpGeo = new THREE.PlaneGeometry(0.34, 0.62);
    fpGeo.rotateX(-Math.PI / 2);
    const fpMat = new THREE.MeshBasicMaterial({
      color: 0x241a10, transparent: true, opacity: 0.55, depthWrite: false,
    });
    this.footprints = new THREE.InstancedMesh(fpGeo, fpMat, this.fpMax);
    this.footprints.frustumCulled = false;
    this.footprints.renderOrder = 3;
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.fpMax; i++) {
      m.makeTranslation(0, -999, 0);
      this.footprints.setMatrixAt(i, m);
    }
    scene.add(this.footprints);

    // ---- camera -------------------------------------------------------------
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 2600);
    this.pos.set(spawnX, sampleHeight(terrain, spawnX + 384, spawnZ + 384), spawnZ);
    this.group.position.copy(this.pos);
    this.micro.centerOn(spawnX, spawnZ);
  }

  addPitch(d: number) { this.camPitch = Math.max(-0.5, Math.min(0.9, this.camPitch + d)); }
  addZoom(d: number) { this.camZoom = Math.max(2.8, Math.min(14, this.camZoom + d)); }
  /** settings slider: set the camera follow distance directly [m] */
  setZoom(z: number) { this.camZoom = Math.max(2.8, Math.min(14, z)); }

  /** ground height incl. micro deformations (prints, craters, spoil) and the tunnel invert */
  groundHeightAt(x: number, z: number): number {
    const th = sampleHeight(this.terrain, x + 384, z + 384)
      + this.ground.dynLiftBilerp(x, z); // fine-tier erosion / settling rides too
      // (bilerp = the exact field both meshes render, so your feet match the
      //  visible ground inside the window AND out in the world)
    if (this.tunnel) {
      // the height gate keeps surface walkers above a drive on the terrain
      // floor; inside the tube (or the portal cut) the tunnel owns the floor
      const f = this.tunnel.floorAt(x, z, th, this.pos.y);
      if (f != null) return f;
    }
    return th + this.micro.sampleDelta(x, z);
  }

  /** footfall classification from the live soil state */
  private stepKind(s: SoilTouch): StepKind {
    if (s.mud > 0.5 || s.consistency === 2) return "mud";
    if (s.wetness > 0.8 && s.sr > 0.9) return "wet";
    if (s.wetness > 0.3) return "moist";
    return "dry";
  }

  update(dt: number, input: InputState, elapsed: number) {
    // ----- movement ----------------------------------------------------------
    const sample = this.ground.sampleMud(this.pos.x, this.pos.z);
    this.mud = sample.mud;
    this.pondM = sample.pondM;
    const mudSlow = sample.slow;
    // the sub-grid film counts too: water in your dug hole wades like a pond
    const filmDepth = this.micro.waterAt(this.pos.x, this.pos.z);
    if (filmDepth > this.pondM) this.pondM = filmDepth;
    const filmSlow = Math.min(filmDepth / 0.25, 1) * 0.45;
    // slow: mud drag + pond/film wading + sticky-limit adhesion (FAO: soil
    // that "sticks to both fingers and tends to stretch") + caked boots
    const slow = Math.max(0.16, 1 - 0.68 * this.mud - Math.max(
      Math.min(this.pondM / 0.25, 1) * 0.45, filmSlow)
      - sample.stick * 0.09 * (1 - this.mud * 0.45)
      - 0.11 * this.bootMud);

    // ----- boot mud: pick it up in mud, dry it off on dry ground ----------
    if (this.onGround) {
      if (this.mud > 0.3 || this.pondM > 0.01) {
        this.bootMud = Math.min(1, this.bootMud
          + dt * (0.05 + 0.45 * this.mud + 0.2 * sample.stick));
      } else if (filmDepth < 0.01) {
        const dryHere = 1 - this.micro.touchAt(this.pos.x, this.pos.z).wetness;
        this.bootMud = Math.max(0, this.bootMud - dt * (0.015 + 0.05 * dryHere));
      }
    }
    const baseSpeed = input.sprint ? 7.2 : 4.1;
    const maxSpeed = baseSpeed * slow;

    const cy = input.yaw;
    const fwd = new THREE.Vector3(Math.sin(cy), 0, Math.cos(cy));
    const right = new THREE.Vector3(Math.cos(cy), 0, -Math.sin(cy));
    const move = new THREE.Vector3()
      .addScaledVector(fwd, input.forward)
      .addScaledVector(right, input.right);
    const moving = move.lengthSq() > 1e-4;
    if (moving) move.normalize();

    // slope resistance walking uphill
    const nrm: [number, number, number] = [0, 1, 0];
    terrainNormal(this.terrain, this.pos.x + 384, this.pos.z + 384, nrm);
    let slopeFactor = 1;
    if (moving) {
      const uphill = -(nrm[0] * move.x + nrm[1] * 0 + nrm[2] * move.z);
      slopeFactor = Math.max(0.55, 1 - Math.max(uphill, 0) * 2.2);
    }

    const target = moving ? maxSpeed * slopeFactor : 0;
    const accel = moving ? 14 : 16;
    this.speed += (target - this.speed) * Math.min(dt * accel, 1);

    // ----- standing in soft mud: the load dwells, mud creeps ---------------
    // (Herschel-Bulkley: below yield it holds you; past yield you keep going
    //  down — that's why a rested wagon sinks by sitting, not by arriving)
    if (this.onGround && !moving && this.mud > 0.25) {
      this.dwellT += dt;
      if (this.dwellT >= 0.5) {
        this.ground.creepSink(this.pos.x, this.pos.z, 55, this.dwellT);
        this.dwellT = 0.5;
      }
    } else this.dwellT = 0;

    if (moving) {
      this.pos.x += move.x * this.speed * dt;
      this.pos.z += move.z * this.speed * dt;
      this.yaw = Math.atan2(move.x, move.z);
    }

    // ----- vertical: jump + mud sinking --------------------------------------
    const groundH = this.groundHeightAt(this.pos.x, this.pos.z);
    if (input.jump && this.onGround) {
      this.jumpVel = 4.6 * (0.55 + 0.45 * mudSlow); // bogged jumps are pathetic
      this.onGround = false;
    }
    this.jumpVel -= 12.5 * dt;
    this.pos.y += this.jumpVel * dt;
    const restH = groundH - sample.sink; // sink into mud (and into your own churn)
    this.sinkage = this.onGround ? sample.sink : 0;
    if (this.pos.y <= restH) {
      if (!this.onGround) {
        // rate-dependent landing: 3-5x body weight through the legs
        const fallSpd = Math.max(0, -this.jumpVel);
        const impact = Math.min(4, 1 + (fallSpd / 4.6) * 2.4);
        const s = this.micro.touchAt(this.pos.x, this.pos.z);
        if (sample.mud > 0.2 || sample.pondM > 0.02) {
          for (let i = 0; i < 6; i++) {
            this.fx.spawnSplash(
              this.pos.x + (Math.random() - 0.5) * 0.8,
              groundH + 0.05,
              this.pos.z + (Math.random() - 0.5) * 0.8);
          }
        } else if (s.wetness < 0.4) {
          // dry impact: dust burst
          for (let i = 0; i < 3; i++) {
            this.fx.spawnDust(
              this.pos.x + (Math.random() - 0.5) * 0.7,
              groundH + 0.06,
              this.pos.z + (Math.random() - 0.5) * 0.7);
          }
        }
        this.fx.playStep(this.stepKind(s), Math.min(1.8, impact * 0.6));
        // skeletal landing crouch — depth scales with the fall speed
        this.animator.triggerLand(fallSpd);
        // a hard landing in soft mud throws brown churn
        if (sample.mud > 0.2) {
          this.fx.spawnMudChurn(this.pos.x, groundH + 0.05, this.pos.z, Math.min(1.6, impact));
        }
        // the crater of a hard landing + the rut it leaves behind
        this.micro.stampBoot(this.pos.x, this.pos.z, this.yaw, s, 1.6 + impact * 0.6);
        this.trample?.(this.pos.x, this.pos.z, 0.2, "trample");
        if (sample.mud > 0.35) this.ground.applyWheelLoad(this.pos.x, this.pos.z, 60 * impact, true);
      }
      this.pos.y = restH;
      this.jumpVel = 0;
      this.onGround = true;
    }

    // keep in bounds
    const LIM = 372;
    this.pos.x = Math.max(-LIM, Math.min(LIM, this.pos.x));
    this.pos.z = Math.max(-LIM, Math.min(LIM, this.pos.z));

    // tunnel walls + face: clamp into the tube cross-section
    if (this.tunnel && this.tunnel.insideTube(this.pos.x, this.pos.z)
        && this.pos.y < this.tunnel.crownY() + 0.4) {
      const c = this.tunnel.clampToTube(this.pos.x, this.pos.z);
      this.pos.x = c.x; this.pos.z = c.z;
    }

    // ----- skeletal animation feed -------------------------------------------
    // Physics state drives the animator's layers; the animator poses every
    // bone (gait + actions + secondary motion). We only read its gait phase
    // for footfall timing so steps and strides stay in sync with the rig.
    const spd = this.speed;
    const a = this.animator;
    a.gaitSpeed = spd / 4.1;               // 1.0 == brisk walk, ~1.75 sprint
    a.sprint = input.sprint;
    a.mudAmount = this.mud;
    a.wetAmount = Math.min(1, this.pondM * 2.5 + (this.micro.waterAt(this.pos.x, this.pos.z) > 0.01 ? 0.3 : 0));
    a.velY = this.jumpVel;
    a.onGround = this.onGround;
    a.sinkage = this.sinkage;
    a.digPhase = this.digPhase;
    // stamina: sprinting drains, standing recovers — feeds tired breathing
    this.tired = Math.max(0, Math.min(1,
      this.tired + dt * (input.sprint && spd > 3 ? 0.16 : -0.09)));
    a.tired = this.tired;
    // chill: soaked + moving slowly in rain => shiver layer
    this.cold = Math.max(0, Math.min(1, this.cold
      + dt * (a.wetAmount > 0.4 && spd < 1.5 ? 0.1 : -0.12)));
    a.cold = this.cold;
    a.update(dt);

    this.group.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.group.rotation.y = this.yaw;

    // ----- muddy boots: jeans + boots darken + gloss as mud cakes on ------
    const stain = this.bootMud * 0.85;
    this.skin.jeansMat.color.copy(JEANS_BASE).lerp(BOOT_MUD_COL, stain);
    this.skin.bootMat.color.copy(BOOT_BASE).lerp(BOOT_MUD_COL, stain);
    this.skin.jeansMat.roughness = 0.95 - this.bootMud * 0.55;
    this.skin.bootMat.roughness = 0.90 - this.bootMud * 0.60;

    // footprint every half stride — a real write into the deformable ground
    const footSign = Math.sin(a.gaitPhase) > 0 ? 1 : -1;
    if (footSign !== this.lastFootSign) {
      this.lastFootSign = footSign;
      const s = this.micro.touchAt(this.pos.x, this.pos.z);
      const off = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(0.13 * footSign);
      const fx0 = this.pos.x + off.x;
      const fz0 = this.pos.z + off.z;
      if (spd > 0.6 && this.onGround) {
        // geometry: state-shaped crater + conserving rim
        this.micro.stampBoot(fx0, fz0, this.yaw, s, input.sprint ? 1.55 : 1);
        this.trample?.(fx0, fz0, 0.16, "trample");
        // fine-tier compaction memory (plastic-optimum weighting)
        this.ground.footPass(fx0, fz0, input.sprint);
        // audio by state
        this.fx.playStep(this.stepKind(s), input.sprint ? 1.4 : 1);
        // dry dust puffs; wet churn gets splashes
        if (s.wetness < 0.35 && s.mud < 0.2) {
          this.fx.spawnDust(fx0, groundH + 0.05, fz0);
        }
        if (this.pondM > 0.015 || this.mud > 0.5) {
          this.fx.spawnSplash(this.pos.x, groundH + 0.04, this.pos.z);
          // each footfall churns brown droplets out of soft mud
          this.fx.spawnMudChurn(fx0, groundH + 0.06, fz0, input.sprint ? 1.1 : 0.7);
          // sprinting through soft clay churns ruts
          if (input.sprint && this.mud > 0.45) {
            this.ground.applyWheelLoad(this.pos.x, this.pos.z, 55, true);
          }
        }
        // suction pop when a boot leaves saturated fines
        if (s.mud > 0.55 || (s.sr > 0.92 && s.wetness > 0.75)) {
          this.fx.playSuction(Math.max(s.mud, 0.5));
        }
        // dark decal on top for far contrast (wet ground only)
        if (s.wetness > 0.28) this.stampFootprint(footSign);
      }
    }

    // ----- camera: over-the-shoulder follow -----------------------------------
    const camTargetY = this.pos.y + 1.5;
    // a 1.85 m bore can't host a 6 m crane shot — pull in tight underground
    const inTunnel = !!this.tunnel && this.tunnel.insideTube(this.pos.x, this.pos.z)
      && this.pos.y < this.tunnel.crownY() + 0.4;
    const dist = inTunnel ? Math.min(this.camZoom, 1.9) : this.camZoom;
    const pitch = inTunnel ? Math.max(this.camPitch, -0.08) : this.camPitch;
    const cx = this.pos.x - Math.sin(this.yaw === undefined ? 0 : input.yaw) * Math.cos(pitch) * dist * 0.96;
    const cz = this.pos.z - Math.cos(input.yaw) * Math.cos(pitch) * dist * 0.96;
    let cyPos = camTargetY + Math.sin(pitch) * dist;
    if (inTunnel) {
      // keep the rig inside the bore: walls, roof, mouth — a yaw swing must
      // never push the camera under virgin ground (the void behind the hill)
      const c = this.tunnel!.clampPointToTube(cx, cyPos, cz);
      this.camera.position.set(c.x, c.y, c.z);
    } else {
      // camera stays above terrain (micro deformations included)
      const camGround = this.groundHeightAt(cx, cz) + 0.55;
      this.camera.position.set(cx, Math.max(cyPos, camGround), cz);
    }
    // miner's lantern: fades in underground, out in daylight — with a subtle
    // flicker so the hanging lamp feels physically swaying on the hand bone
    if (this.lantern) {
      const target = inTunnel ? 9 : 0;
      this.lantern.intensity += (target - this.lantern.intensity) * Math.min(dt * 3, 1);
      this.lantern.visible = this.lantern.intensity > 0.05;
      if (this.lanternBody) {
        const em = (this.lanternBody.material as THREE.MeshStandardMaterial);
        em.emissiveIntensity = this.lantern.intensity / 9 * (0.85 + 0.15 * Math.sin(elapsed * 21) * Math.sin(elapsed * 7.3));
      }
    }
    const look = new THREE.Vector3(this.pos.x, this.pos.y + 1.35, this.pos.z);
    const side = new THREE.Vector3(Math.cos(input.yaw), 0, -Math.sin(input.yaw)).multiplyScalar(0.5);
    look.add(side);
    this.camera.lookAt(look);
  }

  private stampFootprint(sign: number) {
    const i = this.fpIdx = (this.fpIdx + 1) % this.fpMax;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const off = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(0.13 * sign);
    const p = new THREE.Vector3(this.pos.x + off.x, this.pos.y + 0.02, this.pos.z + off.z);
    const s = new THREE.Vector3(0.9 + this.mud * 0.7, 1, 0.9 + this.mud * 0.7);
    m.compose(p, q, s);
    this.footprints.setMatrixAt(i, m);
    this.footprints.instanceMatrix.needsUpdate = true;
    // footprints slowly fade via opacity of shared material (global approx)
    const mat = this.footprints.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.5;
  }
}
