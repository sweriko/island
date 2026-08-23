import type Jolt from "jolt-physics";

import type { JoltModule } from "./jolt";
import {
  BROAD_PHASE_LAYER,
  NUM_BROAD_PHASE_LAYERS,
  NUM_OBJECT_LAYERS,
  OBJECT_LAYER,
} from "./layers";
import { Scratch } from "./scratch";

/**
 * Frames longer than this many simulation ticks are treated as a stall and the
 * surplus time is dropped. Without the clamp, one long frame schedules extra
 * ticks, which make the next frame longer, which schedules more ticks — the
 * classic spiral of death. Dropping time is the only honest recovery: the
 * simulation falls behind the wall clock instead of falling apart.
 */
const MAX_TICKS_PER_FRAME = 6;

export interface BodyParams {
  shape: Jolt.Shape;
  position: readonly [number, number, number];
  /** Quaternion `[x, y, z, w]`. Identity when omitted. */
  rotation?: readonly [number, number, number, number];
  motionType: Jolt.EMotionType;
  layer: number;
  friction?: number;
  restitution?: number;
  /** Kept awake from creation. Static bodies ignore this. */
  activate?: boolean;
}

/**
 * The simulation, and everything Jolt allocates on its behalf.
 *
 * Time is advanced in fixed increments only. `step()` reports how far the
 * renderer is *between* the last two ticks so presentation can interpolate;
 * nothing outside this class ever sees a variable simulation delta.
 */
export class PhysicsWorld {
  readonly system: Jolt.PhysicsSystem;
  readonly bodyInterface: Jolt.BodyInterface;
  readonly scratch: Scratch;

  /** Reusable query filters restricted to layers a moving body can touch. */
  readonly movingBroadPhaseFilter: Jolt.DefaultBroadPhaseLayerFilter;
  readonly movingObjectFilter: Jolt.DefaultObjectLayerFilter;
  readonly anyBodyFilter: Jolt.BodyFilter;
  readonly anyShapeFilter: Jolt.ShapeFilter;

  /** Fraction of a tick the renderer currently sits past the newest state. */
  alpha = 0;

  private readonly joltInterface: Jolt.JoltInterface;
  private readonly ownedShapes: Jolt.Shape[] = [];
  private readonly ownedBodies: Jolt.Body[] = [];

  private accumulator = 0;
  private tickRate = 60;
  private tickDelta = 1 / 60;

  constructor(readonly jolt: JoltModule) {
    const settings = new jolt.JoltSettings();

    settings.mMaxBodies = 4096;
    settings.mMaxBodyPairs = 16384;
    settings.mMaxContactConstraints = 8192;

    // Static geometry lives in its own broad-phase tree so moving-vs-moving
    // queries never walk the terrain's BVH.
    const broadPhase = new jolt.BroadPhaseLayerInterfaceTable(
      NUM_OBJECT_LAYERS,
      NUM_BROAD_PHASE_LAYERS,
    );

    broadPhase.MapObjectToBroadPhaseLayer(
      OBJECT_LAYER.STATIC,
      new jolt.BroadPhaseLayer(BROAD_PHASE_LAYER.STATIC),
    );
    broadPhase.MapObjectToBroadPhaseLayer(
      OBJECT_LAYER.MOVING,
      new jolt.BroadPhaseLayer(BROAD_PHASE_LAYER.MOVING),
    );

    // The table starts with every pair disabled; static-vs-static stays that
    // way because nothing in it can ever move into anything else.
    const pairFilter = new jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS);

    pairFilter.EnableCollision(OBJECT_LAYER.MOVING, OBJECT_LAYER.STATIC);
    pairFilter.EnableCollision(OBJECT_LAYER.MOVING, OBJECT_LAYER.MOVING);

    settings.mBroadPhaseLayerInterface = broadPhase;
    settings.mObjectLayerPairFilter = pairFilter;
    settings.mObjectVsBroadPhaseLayerFilter = new jolt.ObjectVsBroadPhaseLayerFilterTable(
      broadPhase,
      NUM_BROAD_PHASE_LAYERS,
      pairFilter,
      NUM_OBJECT_LAYERS,
    );

    // `JoltInterface` takes ownership of the three filter objects above; only
    // the settings struct itself is ours to release.
    this.joltInterface = new jolt.JoltInterface(settings);
    jolt.destroy(settings);

    this.system = this.joltInterface.GetPhysicsSystem();
    this.bodyInterface = this.system.GetBodyInterface();
    this.scratch = new Scratch(jolt);

    this.movingBroadPhaseFilter = new jolt.DefaultBroadPhaseLayerFilter(
      this.joltInterface.GetObjectVsBroadPhaseLayerFilter(),
      OBJECT_LAYER.MOVING,
    );
    this.movingObjectFilter = new jolt.DefaultObjectLayerFilter(
      this.joltInterface.GetObjectLayerPairFilter(),
      OBJECT_LAYER.MOVING,
    );
    this.anyBodyFilter = new jolt.BodyFilter();
    this.anyShapeFilter = new jolt.ShapeFilter();

    this.gravity = 22;
  }

  get tempAllocator(): Jolt.TempAllocator {
    return this.joltInterface.GetTempAllocator();
  }

  /**
   * Downward acceleration in m/s². Deliberately far above 9.81: real gravity
   * makes a human-scaled jump hang long enough to feel like low earth orbit,
   * so shipped shooters run roughly 2× and shorten the arc to match.
   */
  get gravity(): number {
    return -this.system.GetGravity().GetY();
  }

  set gravity(value: number) {
    this.system.SetGravity(this.scratch.vec3(0, -value, 0));
  }

  /** Simulation frequency in Hz. Changing it discards accumulated time. */
  get rate(): number {
    return this.tickRate;
  }

  set rate(hz: number) {
    this.tickRate = hz;
    this.tickDelta = 1 / hz;
    this.accumulator = 0;
  }

  /**
   * Advances the simulation by whole ticks and updates `alpha`.
   *
   * `beforeTick` runs immediately before each `Step`, so controllers write
   * their intent into the same substep that resolves it. `afterTick` runs
   * immediately after, which is the only moment the newest body transforms
   * exist — snapshotting anywhere else is off by a tick and shows up as
   * permanent interpolation lag.
   */
  step(
    deltaTime: number,
    beforeTick: (tickDelta: number) => void,
    afterTick: (tickDelta: number) => void,
  ): void {
    const dt = this.tickDelta;

    this.accumulator = Math.min(this.accumulator + deltaTime, dt * MAX_TICKS_PER_FRAME);

    while (this.accumulator >= dt) {
      beforeTick(dt);
      // One collision step per tick: Jolt's own guidance is ~60 Hz per step,
      // and we never run the fixed rate low enough to need substepping.
      this.joltInterface.Step(dt, 1);
      afterTick(dt);

      this.accumulator -= dt;
    }

    this.alpha = this.accumulator / dt;
  }

  /**
   * Realises a shape and takes ownership of it.
   *
   * `Create()` returns into a static scratch inside the WASM module, so the
   * result must be pinned with `AddRef` before anything else calls `Create`.
   * Destroying the settings then drops every reference it holds — including
   * nested child settings — which is why callers must not destroy those
   * themselves.
   */
  createShape(settings: Jolt.ShapeSettings): Jolt.Shape {
    const result = settings.Create();

    if (result.HasError()) {
      const message = result.GetError().c_str();

      this.jolt.destroy(settings);
      throw new Error(`Jolt could not build shape: ${message}`);
    }

    const shape = result.Get();

    shape.AddRef();
    this.jolt.destroy(settings);
    this.ownedShapes.push(shape);

    return shape;
  }

  /** Creates a body, adds it to the simulation, and takes ownership of it. */
  createBody(params: BodyParams): Jolt.Body {
    const { jolt, scratch } = this;
    const [x, y, z] = params.position;
    const [qx, qy, qz, qw] = params.rotation ?? [0, 0, 0, 1];

    const settings = new jolt.BodyCreationSettings(
      params.shape,
      scratch.rvec3(x, y, z),
      scratch.quat(qx, qy, qz, qw),
      params.motionType,
      params.layer,
    );

    if (params.friction !== undefined) settings.mFriction = params.friction;
    if (params.restitution !== undefined) settings.mRestitution = params.restitution;

    const body = this.bodyInterface.CreateBody(settings);

    jolt.destroy(settings);

    this.bodyInterface.AddBody(
      body.GetID(),
      params.activate ? jolt.EActivation_Activate : jolt.EActivation_DontActivate,
    );
    this.ownedBodies.push(body);

    return body;
  }

  /**
   * Rebuilds the static broad-phase tree. Worth calling once after the level
   * is populated; the incremental insertions leave a lopsided tree behind.
   */
  optimize(): void {
    this.system.OptimizeBroadPhase();
  }

  dispose(): void {
    const { jolt } = this;

    for (const body of this.ownedBodies) {
      const id = body.GetID();

      this.bodyInterface.RemoveBody(id);
      this.bodyInterface.DestroyBody(id);
    }
    this.ownedBodies.length = 0;

    for (const shape of this.ownedShapes) shape.Release();
    this.ownedShapes.length = 0;

    jolt.destroy(this.movingBroadPhaseFilter);
    jolt.destroy(this.movingObjectFilter);
    jolt.destroy(this.anyBodyFilter);
    jolt.destroy(this.anyShapeFilter);

    this.scratch.dispose();
    jolt.destroy(this.joltInterface);
  }
}
