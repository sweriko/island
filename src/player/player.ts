import * as THREE from "three/webgpu";

import { CharacterBody } from "../physics/character";
import type { PhysicsWorld } from "../physics/world";
import type { Input } from "./input";

/**
 * Everything about how the player moves, in one editable block.
 *
 * Speeds are m/s, accelerations m/s², angles radians. The locomotion model is
 * the accelerate/friction pair that came out of Quake and stayed in every
 * shooter since — not out of nostalgia, but because velocity-projected
 * acceleration is the only cheap model where input authority and momentum
 * coexist. Lerping toward a target velocity, the obvious alternative, throws
 * momentum away and turns air control into ice.
 */
export interface PlayerTuning {
  /** Radians of yaw per unit of raw mouse movement. */
  lookSensitivity: number;
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  /** Ground acceleration, expressed per unit of target speed. */
  groundAccel: number;
  airAccel: number;
  /**
   * Ceiling on the speed air acceleration may add *along the wish direction*.
   * Low values are what make strafing steer the existing velocity vector
   * instead of simply adding to it.
   */
  airSpeedCap: number;
  friction: number;
  /** Floor under the friction calculation, so a slow walk still stops crisply. */
  stopSpeed: number;
  jumpHeight: number;
  /** Gravity multiplier while rising with jump released: a variable-height jump. */
  jumpCutGravity: number;
  /** Gravity multiplier while falling, so the arc lands sooner than it rose. */
  fallGravity: number;
  /** Grace period after walking off a ledge during which a jump still fires. */
  coyoteTime: number;
  /** How early a jump press is remembered while still airborne. */
  jumpBuffer: number;
  eyeHeight: number;
  crouchEyeHeight: number;
  fov: number;
}

const DEFAULT_TUNING: PlayerTuning = {
  lookSensitivity: 0.0022,
  walkSpeed: 4.4,
  sprintSpeed: 7.4,
  crouchSpeed: 1.9,
  groundAccel: 14,
  airAccel: 12,
  airSpeedCap: 1.1,
  friction: 9,
  stopSpeed: 1.6,
  jumpHeight: 1.15,
  jumpCutGravity: 2.2,
  fallGravity: 1.25,
  coyoteTime: 0.11,
  jumpBuffer: 0.14,
  eyeHeight: 1.62,
  crouchEyeHeight: 0.92,
  fov: 72,
};

const CHARACTER = {
  radius: 0.32,
  standHeight: 1.82,
  crouchHeight: 1.05,
  maxSlope: THREE.MathUtils.degToRad(47),
  stepHeight: 0.45,
  mass: 82,
  // Newtons the character can exert on a dynamic body. A person leaning into a
  // crate is worth a few hundred; this is enough to shove the props around
  // without launching them, and nowhere near enough to move the world.
  pushStrength: 600,
} as const;

/** Falling past this depth means the player left the level; put them back. */
const VOID_DEPTH = -60;

/** Ceiling on the camera lag used to hide stair steps. */
const MAX_STEP_SMOOTH = 0.5;

const PITCH_LIMIT = Math.PI / 2 - 0.008;

type GroundState = "ground" | "steep" | "air";

export class Player {
  readonly tuning: PlayerTuning = { ...DEFAULT_TUNING };
  readonly body: CharacterBody;

  /** Interpolated eye position, in world space. Written every frame. */
  readonly eye = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  private readonly spawn: THREE.Vector3;

  // Simulation state, sampled once per tick.
  private readonly previousFoot = new THREE.Vector3();
  private readonly currentFoot = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly groundVelocity = new THREE.Vector3();
  private readonly wish = new THREE.Vector3();
  private readonly renderFoot = new THREE.Vector3();
  private readonly look = { x: 0, y: 0 };
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");

  private airTime = 0;
  private jumpBufferTimer = 0;
  private jumpLockout = 0;
  private jumpHeld = false;
  private crouched = false;
  private groundState: GroundState = "air";

  // Presentation state, advanced at render rate.
  private eyeOffset = DEFAULT_TUNING.eyeHeight;
  private stepSmooth = 0;

  constructor(
    private readonly world: PhysicsWorld,
    private readonly input: Input,
    private readonly camera: THREE.PerspectiveCamera,
    spawn: THREE.Vector3,
  ) {
    this.spawn = spawn.clone();
    this.body = new CharacterBody(world, CHARACTER, [spawn.x, spawn.y, spawn.z]);
    this.body.readPosition(this.currentFoot);
    this.previousFoot.copy(this.currentFoot);
    this.eye.copy(this.currentFoot).y += this.tuning.eyeHeight;
  }

  respawn(): void {
    const { spawn } = this;

    this.body.setPosition(spawn.x, spawn.y, spawn.z);
    this.body.setVelocity(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.body.readPosition(this.currentFoot);
    this.previousFoot.copy(this.currentFoot);
    this.stepSmooth = 0;
  }

  /**
   * Render-rate work: aim, and the intent edges that must not be missed
   * between simulation ticks.
   *
   * Look runs here rather than in the tick precisely because it is not
   * simulation. Sampling the mouse at display rate means the view answers the
   * hand within one frame no matter how the fixed step happens to line up,
   * which is the single largest contributor to whether aiming feels connected.
   */
  frameUpdate(active: boolean): void {
    if (!active) return;

    const { lookSensitivity } = this.tuning;
    const look = this.input.consumeLook(this.look);

    this.yaw -= look.x * lookSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - look.y * lookSensitivity,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );

    // Keep yaw in range so it never loses precision over a long session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    if (this.input.consumePress("Space")) this.jumpBufferTimer = this.tuning.jumpBuffer;
    if (this.input.consumePress("KeyR")) this.respawn();

    this.jumpHeld = this.input.isDown("Space");
  }

  /** Fixed-rate work: the whole locomotion model. */
  tick(deltaTime: number, active: boolean): void {
    const { tuning, velocity } = this;

    this.previousFoot.copy(this.currentFoot);

    this.groundState = this.readGroundState();
    this.body.readVelocity(velocity);
    this.body.readGroundVelocity(this.groundVelocity);

    const grounded = this.groundState === "ground";

    if (grounded) this.airTime = 0;
    else this.airTime += deltaTime;

    this.jumpBufferTimer = Math.max(this.jumpBufferTimer - deltaTime, 0);
    this.jumpLockout = Math.max(this.jumpLockout - deltaTime, 0);

    this.updateStance(active);

    // Standing still on a slope still accumulates a tick of gravity, which is
    // what keeps `StickToFloor` in contact with the ground.
    if (grounded && velocity.y - this.groundVelocity.y < 0.1) velocity.y = this.groundVelocity.y;

    const gravity = this.effectiveGravity();

    velocity.y -= gravity * deltaTime;

    const canJump = this.airTime <= tuning.coyoteTime && this.jumpLockout <= 0;

    if (active && this.jumpBufferTimer > 0 && canJump) {
      // Solve the launch speed from the height we actually want, so tuning the
      // jump never has to be redone when gravity changes.
      velocity.y = Math.sqrt(2 * this.world.gravity * tuning.jumpHeight);
      this.jumpBufferTimer = 0;
      this.jumpLockout = 0.1;
      this.airTime = tuning.coyoteTime + 1;
    }

    this.horizontalMove(deltaTime, grounded, active);

    this.body.cancelIntoSteepSlopes(velocity);
    this.body.setVelocity(velocity.x, velocity.y, velocity.z);
    this.body.update(deltaTime, gravity);
    this.body.readPosition(this.currentFoot);

    this.trackStepSmoothing(grounded, deltaTime);

    if (this.currentFoot.y < VOID_DEPTH) this.respawn();
  }

  /**
   * Places the camera for this frame.
   *
   * `alpha` is how far the frame sits past the newest simulation state, so the
   * eye rides a straight line between the last two ticks instead of snapping
   * to whichever tick happened most recently.
   *
   * The rig is advanced whether or not it is driving the camera, so the eye
   * position stays truthful while an inspection camera is flying around.
   */
  applyCamera(alpha: number, deltaTime: number, attach: boolean): void {
    const { tuning, camera } = this;

    this.renderFoot.lerpVectors(this.previousFoot, this.currentFoot, alpha);

    const targetEye = this.crouched ? tuning.crouchEyeHeight : tuning.eyeHeight;

    this.eyeOffset = THREE.MathUtils.damp(this.eyeOffset, targetEye, 14, deltaTime);

    // A step-up moves the character a whole step in one tick. Carrying that
    // jolt as a decaying offset turns a staircase into a ramp for the eye
    // while the collision shape keeps its honest, discrete position.
    this.stepSmooth = THREE.MathUtils.damp(this.stepSmooth, 0, 13, deltaTime);

    this.eye.set(
      this.renderFoot.x,
      this.renderFoot.y + this.eyeOffset + this.stepSmooth,
      this.renderFoot.z,
    );

    if (!attach) return;

    camera.position.copy(this.eye);
    this.euler.set(this.pitch, this.yaw, 0);
    camera.quaternion.setFromEuler(this.euler);

    if (camera.fov !== tuning.fov) {
      camera.fov = tuning.fov;
      camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.body.dispose();
  }

  private readGroundState(): GroundState {
    const { jolt } = this.world;
    const state = this.body.groundState;

    if (state === jolt.EGroundState_OnGround) return "ground";
    if (state === jolt.EGroundState_OnSteepGround) return "steep";

    return "air";
  }

  /** Crouch is a shape swap; standing back up is whether the swap is accepted. */
  private updateStance(active: boolean): void {
    const wantsCrouch = active && (this.input.isDown("ControlLeft") || this.input.isDown("KeyC"));

    if (wantsCrouch === this.crouched) return;

    if (wantsCrouch) {
      this.crouched = this.body.trySetShape(this.body.crouchShape);
    } else if (this.body.trySetShape(this.body.standShape)) {
      // Refused means there is a ceiling in the way; stay crouched and try
      // again next tick, with no raycast and no guessing.
      this.crouched = false;
    }
  }

  /**
   * Gravity for this tick.
   *
   * A single constant produces a symmetric parabola, which reads as floaty on
   * the way up and weightless on the way down. Cutting the rise when the key is
   * released and weighting the fall gives the player height control and a
   * decisive landing, without ever changing the peak they can reach by holding.
   */
  private effectiveGravity(): number {
    const base = this.world.gravity;

    if (this.velocity.y > 0) return this.jumpHeld ? base : base * this.tuning.jumpCutGravity;
    if (this.velocity.y < 0) return base * this.tuning.fallGravity;

    return base;
  }

  private horizontalMove(deltaTime: number, grounded: boolean, active: boolean): void {
    const { tuning, velocity, wish } = this;
    const forward = active
      ? Number(this.input.isDown("KeyW") || this.input.isDown("ArrowUp")) -
        Number(this.input.isDown("KeyS") || this.input.isDown("ArrowDown"))
      : 0;
    const strafe = active
      ? Number(this.input.isDown("KeyD") || this.input.isDown("ArrowRight")) -
        Number(this.input.isDown("KeyA") || this.input.isDown("ArrowLeft"))
      : 0;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);

    // -Z is forward in three's convention, so forward is (-sin, -cos).
    wish.set(strafe * cos - forward * sin, 0, -strafe * sin - forward * cos);

    const magnitude = Math.hypot(wish.x, wish.z);
    const sprinting =
      active && magnitude > 0 && forward > 0 && !this.crouched && this.input.isDown("ShiftLeft");

    if (magnitude > 0) {
      wish.x /= magnitude;
      wish.z /= magnitude;
    }

    const targetSpeed = this.crouched
      ? tuning.crouchSpeed
      : sprinting
        ? tuning.sprintSpeed
        : tuning.walkSpeed;

    if (grounded) {
      applyFriction(velocity, tuning.friction, tuning.stopSpeed, deltaTime);
      accelerate(velocity, wish, magnitude > 0 ? targetSpeed : 0, tuning.groundAccel, deltaTime);
    } else {
      // Capping the *target* rather than the result is the whole trick: it
      // leaves acceleration perpendicular to current motion untouched, so a
      // held strafe curves the trajectory instead of stalling against the cap.
      const airTarget = Math.min(targetSpeed, tuning.airSpeedCap);

      accelerate(velocity, wish, magnitude > 0 ? airTarget : 0, tuning.airAccel, deltaTime);
    }
  }

  /**
   * Feeds vertical position changes that the solver made — stairs, and the
   * stick-to-floor pull over crests — into the camera's smoothing offset.
   */
  private trackStepSmoothing(grounded: boolean, deltaTime: number): void {
    if (!grounded) return;

    const delta = this.currentFoot.y - this.previousFoot.y;

    // Anything explained by the character's own vertical velocity is real
    // motion the eye should see; only the solver's correction gets hidden.
    const corrected = delta - this.velocity.y * deltaTime;

    this.stepSmooth = THREE.MathUtils.clamp(
      this.stepSmooth - corrected,
      -MAX_STEP_SMOOTH,
      MAX_STEP_SMOOTH,
    );
  }
}

/**
 * Adds speed along `wish` only up to `targetSpeed`, measured *along that
 * direction*. Motion perpendicular to the wish direction is never taxed, which
 * is what preserves momentum through a turn.
 */
function accelerate(
  velocity: THREE.Vector3,
  wish: THREE.Vector3,
  targetSpeed: number,
  acceleration: number,
  deltaTime: number,
): void {
  if (targetSpeed <= 0) return;

  const projected = velocity.x * wish.x + velocity.z * wish.z;
  const missing = targetSpeed - projected;

  if (missing <= 0) return;

  const step = Math.min(acceleration * targetSpeed * deltaTime, missing);

  velocity.x += step * wish.x;
  velocity.z += step * wish.z;
}

/**
 * Sheds horizontal speed at a rate proportional to the current speed, with a
 * floor so that walking pace still stops in a stride rather than trailing off
 * asymptotically.
 */
function applyFriction(
  velocity: THREE.Vector3,
  friction: number,
  stopSpeed: number,
  deltaTime: number,
): void {
  const speed = Math.hypot(velocity.x, velocity.z);

  if (speed < 1e-4) {
    velocity.x = 0;
    velocity.z = 0;

    return;
  }

  const drop = Math.max(speed, stopSpeed) * friction * deltaTime;
  const scale = Math.max(speed - drop, 0) / speed;

  velocity.x *= scale;
  velocity.z *= scale;
}
