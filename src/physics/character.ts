import type Jolt from "jolt-physics";

import { OBJECT_LAYER } from "./layers";
import type { PhysicsWorld } from "./world";

/** Anything with mutable `x`/`y`/`z`, so `THREE.Vector3` fits without an import. */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

export interface CharacterParams {
  radius: number;
  standHeight: number;
  crouchHeight: number;
  /** Steepest ground, in radians, that still counts as standable. */
  maxSlope: number;
  /** Tallest ledge, in metres, the character steps onto instead of colliding with. */
  stepHeight: number;
  mass: number;
  /** Force in newtons the character can exert on dynamic bodies it walks into. */
  pushStrength: number;
}

/**
 * A `CharacterVirtual` — a shape swept through the world by hand rather than a
 * rigid body pushed by the solver.
 *
 * That is the right tool for a player: a rigid body has to be fought (locked
 * rotation, tuned friction, capsule-on-step wedging) to behave like a person,
 * whereas a virtual character resolves its own contacts, walks stairs, and
 * responds to input with zero solver latency. It costs us the responsibility of
 * integrating gravity ourselves — Jolt deliberately does not touch the
 * character's velocity — which is exactly the control an FPS needs.
 */
export class CharacterBody {
  readonly standShape: Jolt.Shape;
  readonly crouchShape: Jolt.Shape;

  private readonly character: Jolt.CharacterVirtual;
  private readonly updateSettings: Jolt.ExtendedUpdateSettings;
  private readonly penetrationSlop: number;
  private currentShape: Jolt.Shape;

  constructor(
    private readonly world: PhysicsWorld,
    params: CharacterParams,
    spawn: readonly [number, number, number],
  ) {
    const { jolt, scratch } = world;

    this.standShape = this.buildCapsule(params.radius, params.standHeight);
    this.crouchShape = this.buildCapsule(params.radius, params.crouchHeight);
    this.currentShape = this.standShape;

    const settings = new jolt.CharacterVirtualSettings();

    settings.mShape = this.standShape;
    settings.mMass = params.mass;
    settings.mMaxStrength = params.pushStrength;
    settings.mMaxSlopeAngle = params.maxSlope;
    settings.mUp = scratch.vec3(0, 1, 0);

    // Contacts below this plane hold the character up. Measuring from the
    // capsule's origin (the feet), one radius up is the equator of the lower
    // hemisphere: anything the character is genuinely standing on, and nothing
    // it has merely brushed with its side.
    const supportingVolume = new jolt.Plane(scratch.vec3(0, 1, 0), -params.radius);

    settings.mSupportingVolume = supportingVolume;
    jolt.destroy(supportingVolume);

    // Heightfields and brush seams present interior edges that are not real
    // features of the surface. Without this, walking across a triangle boundary
    // occasionally reports a vertical normal for one tick and launches the
    // character. This is the fix at the source rather than a velocity clamp.
    settings.mEnhancedInternalEdgeRemoval = true;

    // Look ahead far enough that a fast run cannot tunnel into a contact
    // between ticks, but not so far that distant geometry joins every solve.
    settings.mPredictiveContactDistance = 0.1;
    settings.mCharacterPadding = 0.02;
    settings.mPenetrationRecoverySpeed = 1;

    // An inner rigid body makes the character visible to the rest of the
    // simulation, so props collide with the player instead of passing through.
    settings.mInnerBodyShape = this.standShape;
    settings.mInnerBodyLayer = OBJECT_LAYER.MOVING;

    this.character = new jolt.CharacterVirtual(
      settings,
      scratch.rvec3(spawn[0], spawn[1], spawn[2]),
      scratch.quat(0, 0, 0, 1),
      world.system,
    );
    jolt.destroy(settings);

    this.updateSettings = new jolt.ExtendedUpdateSettings();
    this.updateSettings.mWalkStairsStepUp = scratch.vec3(0, params.stepHeight, 0);
    // Reaching down further than the step-up height keeps the character glued
    // to the ground when it runs off the top of a staircase, instead of
    // launching into a short ballistic arc on every descending step.
    this.updateSettings.mStickToFloorStepDown = scratch.vec3(0, -params.stepHeight - 0.1, 0);

    this.penetrationSlop = world.system.GetPhysicsSettings().mPenetrationSlop;
  }

  get groundState(): Jolt.EGroundState {
    return this.character.GetGroundState();
  }

  readPosition(out: MutableVec3): MutableVec3 {
    const p = this.character.GetPosition();

    out.x = p.GetX();
    out.y = p.GetY();
    out.z = p.GetZ();

    return out;
  }

  readVelocity(out: MutableVec3): MutableVec3 {
    const v = this.character.GetLinearVelocity();

    out.x = v.GetX();
    out.y = v.GetY();
    out.z = v.GetZ();

    return out;
  }

  readGroundVelocity(out: MutableVec3): MutableVec3 {
    const v = this.character.GetGroundVelocity();

    out.x = v.GetX();
    out.y = v.GetY();
    out.z = v.GetZ();

    return out;
  }

  setPosition(x: number, y: number, z: number): void {
    this.character.SetPosition(this.world.scratch.rvec3(x, y, z));
  }

  setVelocity(x: number, y: number, z: number): void {
    this.character.SetLinearVelocity(this.world.scratch.vec3(x, y, z));
  }

  /**
   * Zeroes the component of `velocity` that points into ground too steep to
   * stand on, in place. Without it the character accelerates into an unclimbable
   * slope every tick and the collision solve has to cancel the same motion
   * again and again, which reads as a stutter against the wall.
   */
  cancelIntoSteepSlopes(velocity: MutableVec3): void {
    const { scratch } = this.world;
    const cancelled = this.character.CancelVelocityTowardsSteepSlopes(
      scratch.vec3(velocity.x, velocity.y, velocity.z),
    );

    velocity.x = cancelled.GetX();
    velocity.y = cancelled.GetY();
    velocity.z = cancelled.GetZ();
  }

  /**
   * Swaps the collision shape, refusing the swap if it would leave the
   * character embedded in geometry. That refusal *is* the stand-up check: no
   * separate ceiling raycast, no guessing at the clearance the shape needs.
   */
  trySetShape(shape: Jolt.Shape): boolean {
    if (shape === this.currentShape) return true;

    const world = this.world;
    const accepted = this.character.SetShape(
      shape,
      // Jolt's own slop, scaled the way its character sample does, so a shape
      // that is merely touching still counts as fitting.
      1.5 * this.penetrationSlop,
      world.movingBroadPhaseFilter,
      world.movingObjectFilter,
      world.anyBodyFilter,
      world.anyShapeFilter,
      world.tempAllocator,
    );

    if (accepted) {
      this.currentShape = shape;
      // The inner body has to follow, or props keep colliding with the
      // standing silhouette of a crouched character.
      this.character.SetInnerBodyShape(shape);
    }

    return accepted;
  }

  /** Sweeps the character through the world for one simulation tick. */
  update(deltaTime: number, gravity: number): void {
    const world = this.world;

    this.character.ExtendedUpdate(
      deltaTime,
      world.scratch.vec3(0, -gravity, 0),
      this.updateSettings,
      world.movingBroadPhaseFilter,
      world.movingObjectFilter,
      world.anyBodyFilter,
      world.anyShapeFilter,
      world.tempAllocator,
    );
  }

  dispose(): void {
    const { jolt } = this.world;

    jolt.destroy(this.updateSettings);
    jolt.destroy(this.character);
    this.standShape.Release();
    this.crouchShape.Release();
  }

  /**
   * A capsule whose origin sits at the character's feet rather than at its
   * centre. Feet-relative is the only origin that stays put when the shape
   * changes height, so crouching does not teleport the character.
   */
  private buildCapsule(radius: number, height: number): Jolt.Shape {
    const { jolt, scratch } = this.world;
    const halfCylinder = Math.max(height * 0.5 - radius, 0.01);

    const shape = this.world.createShape(
      new jolt.RotatedTranslatedShapeSettings(
        scratch.vec3(0, height * 0.5, 0),
        scratch.quat(0, 0, 0, 1),
        new jolt.CapsuleShapeSettings(halfCylinder, radius),
      ),
    );

    // The world already holds one reference. Taking a second makes the
    // character's shapes outlive any teardown order between the two.
    shape.AddRef();

    return shape;
  }
}
