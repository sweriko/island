import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type Jolt from "jolt-physics";

import { OBJECT_LAYER } from "../physics/layers";
import type { PhysicsWorld } from "../physics/world";

/**
 * A box of level geometry.
 *
 * One description drives both the collider and the render mesh, so they cannot
 * drift: the same half-extents build the `BoxShape`, the same matrix bakes the
 * `BoxGeometry`. There is no authoring step where a mesh could be nudged
 * without its collider following.
 */
interface Brush {
  position: THREE.Vector3;
  size: THREE.Vector3;
  /** Euler XYZ in radians. */
  rotation: THREE.Euler;
  color: number;
}

const PALETTE = {
  deck: 0xb9b3a6,
  step: 0xa39a88,
  ramp: 0x8f9aa6,
  /** Marks the ramp that is deliberately too steep to climb. */
  blocked: 0xa8615a,
  pillar: 0x8b8578,
  wall: 0x9d9689,
  causeway: 0xa8a294,
  colonnade: 0xb4ae9f,
  tower: 0x8e897c,
  band: 0x6f6a5f,
} as const;

/** Jolt rounds box corners by this much; kept well under the smallest brush. */
const CONVEX_RADIUS = 0.03;

/**
 * Densities in kg/m³. Jolt defaults to 1000 — the density of water — which
 * quietly makes a 0.6 m "crate" weigh 216 kg and pins the player if one lands
 * on them. These are the real numbers: seasoned softwood, and a hollow ball.
 */
const DENSITY = {
  crate: 110,
  ball: 45,
} as const;

interface PropSet {
  mesh: THREE.InstancedMesh;
  bodies: Jolt.Body[];
  previous: Float32Array;
  current: Float32Array;
}

/**
 * The test course on the plateau: everything needed to judge whether a
 * character controller is correct rather than merely plausible.
 *
 * Staircases bracket the step-up limit, ramps bracket the slope limit, the
 * jump gallery brackets the launch arc, and the tunnel forces the crouch shape
 * swap to be refused. A controller that is wrong will be visibly wrong here.
 */
export class Course {
  readonly group = new THREE.Group();

  private readonly props: PropSet[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly staticMesh: THREE.Mesh;

  constructor(world: PhysicsWorld, base: number, groundAt: (x: number, z: number) => number) {
    this.group.name = "course";

    const brushes: Brush[] = [];

    buildStaircases(brushes, base);
    buildRamps(brushes, base);
    buildJumpGallery(brushes, base);
    buildCrouchTunnel(brushes, base);
    buildPillars(brushes, base);
    buildCauseway(brushes, base, groundAt);

    this.staticMesh = commitBrushes(world, brushes);
    this.group.add(this.staticMesh);

    this.props.push(buildCrates(world, base), buildBalls(world, base));

    for (const set of this.props) this.group.add(set.mesh);
  }

  /**
   * Snapshots prop transforms straight after a simulation tick.
   *
   * Two snapshots are kept because the renderer almost never lands exactly on a
   * tick boundary; presenting only the newest one makes every prop stutter at
   * the beat frequency between the display and the simulation.
   */
  captureState(): void {
    for (const set of this.props) {
      set.previous.set(set.current);

      for (let i = 0; i < set.bodies.length; i++) {
        const body = set.bodies[i];
        const p = body.GetPosition();
        const q = body.GetRotation();
        const o = i * 7;

        set.current[o] = p.GetX();
        set.current[o + 1] = p.GetY();
        set.current[o + 2] = p.GetZ();
        set.current[o + 3] = q.GetX();
        set.current[o + 4] = q.GetY();
        set.current[o + 5] = q.GetZ();
        set.current[o + 6] = q.GetW();
      }
    }
  }

  /** Writes interpolated transforms into the instance buffers. */
  sync(alpha: number): void {
    const { dummy } = this;

    for (const set of this.props) {
      const { previous, current, mesh } = set;

      for (let i = 0; i < set.bodies.length; i++) {
        const o = i * 7;

        dummy.position.set(
          previous[o] + (current[o] - previous[o]) * alpha,
          previous[o + 1] + (current[o + 1] - previous[o + 1]) * alpha,
          previous[o + 2] + (current[o + 2] - previous[o + 2]) * alpha,
        );

        // Rotations need the shortest arc on the unit sphere, not a component
        // lerp: a tumbling crate can rotate far enough in one tick that the
        // straight-line blend visibly shrinks it.
        previousRotation.set(previous[o + 3], previous[o + 4], previous[o + 5], previous[o + 6]);
        currentRotation.set(current[o + 3], current[o + 4], current[o + 5], current[o + 6]);
        dummy.quaternion.slerpQuaternions(previousRotation, currentRotation, alpha);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }

      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.staticMesh.geometry.dispose();
    (this.staticMesh.material as THREE.Material).dispose();

    for (const set of this.props) {
      set.mesh.geometry.dispose();
      (set.mesh.material as THREE.Material).dispose();
      set.mesh.dispose();
    }
  }
}

const previousRotation = new THREE.Quaternion();
const currentRotation = new THREE.Quaternion();

/** Realises every brush as one static body plus one merged draw call. */
function commitBrushes(world: PhysicsWorld, brushes: Brush[]): THREE.Mesh {
  const { jolt, scratch } = world;
  const geometries: THREE.BufferGeometry[] = [];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const colour = new THREE.Color();

  for (const item of brushes) {
    const half = item.size.clone().multiplyScalar(0.5);
    const radius = Math.min(CONVEX_RADIUS, Math.min(half.x, half.y, half.z) * 0.4);

    quaternion.setFromEuler(item.rotation);

    const shape = world.createShape(
      new jolt.BoxShapeSettings(scratch.vec3(half.x, half.y, half.z), radius),
    );

    world.createBody({
      shape,
      position: [item.position.x, item.position.y, item.position.z],
      rotation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      motionType: jolt.EMotionType_Static,
      layer: OBJECT_LAYER.STATIC,
      friction: 0.8,
    });

    const geometry = new THREE.BoxGeometry(item.size.x, item.size.y, item.size.z);

    matrix.compose(item.position, quaternion, ONE);
    geometry.applyMatrix4(matrix);
    geometry.setAttribute("color", solidColor(geometry, colour.setHex(item.color)));
    geometries.push(geometry);
  }

  const merged = mergeGeometries(geometries, false);

  for (const geometry of geometries) geometry.dispose();

  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 }),
  );

  mesh.name = "course-static";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;

  return mesh;
}

const ONE = new THREE.Vector3(1, 1, 1);

function solidColor(geometry: THREE.BufferGeometry, colour: THREE.Color): THREE.BufferAttribute {
  const count = geometry.getAttribute("position").count;
  const array = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    array[i * 3] = colour.r;
    array[i * 3 + 1] = colour.g;
    array[i * 3 + 2] = colour.b;
  }

  return new THREE.BufferAttribute(array, 3);
}

function brush(
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  color: number,
  pitch = 0,
  yawAngle = 0,
): Brush {
  return {
    position: new THREE.Vector3(x, y, z),
    size: new THREE.Vector3(width, height, depth),
    rotation: new THREE.Euler(pitch, yawAngle, 0),
    color,
  };
}

/**
 * Three flights that bracket the controller's step height: comfortably under,
 * around a normal building code rise, and right at the limit. The last flight
 * is the one that tells you whether `WalkStairs` is actually engaging.
 */
function buildStaircases(out: Brush[], base: number): void {
  const flights = [
    { x: -20, rise: 0.18, run: 0.38, steps: 12 },
    { x: -15, rise: 0.3, run: 0.38, steps: 12 },
    { x: -10, rise: 0.44, run: 0.42, steps: 9 },
  ];

  for (const flight of flights) {
    let top = base;

    for (let i = 0; i < flight.steps; i++) {
      const height = flight.rise * (i + 1);

      // Each step is a full-height block rather than a floating slab, so there
      // is no cavity underneath for a fast character to clip into.
      out.push(
        brush(
          flight.x,
          base + height / 2,
          -14 + i * flight.run + flight.run / 2,
          3.4,
          height,
          flight.run,
          PALETTE.step,
        ),
      );
      top = base + height;
    }

    // A landing at the top, so the flight ends somewhere worth standing.
    out.push(brush(flight.x, top - 0.15, -14 + flight.steps * flight.run + 1.6, 3.4, 0.3, 3.2, PALETTE.deck));
  }
}

/**
 * A slope ladder around the 47° standable limit. The steepest ramp is meant to
 * be unclimbable: it is the visible proof that the slope rejection works, and
 * that the character slides rather than sticking.
 */
function buildRamps(out: Brush[], base: number): void {
  const angles = [12, 25, 40, 55];
  const length = 7;
  const thickness = 0.5;

  angles.forEach((degrees, index) => {
    const angle = THREE.MathUtils.degToRad(degrees);
    const x = 8 + index * 4.4;

    // Sink the slab so the *top* surface meets the plateau exactly at its low
    // end; anything else leaves a lip the player has to step over first.
    const y =
      base - (thickness / 2) * Math.cos(angle) + (length / 2) * Math.sin(angle);

    out.push(
      brush(
        x,
        y,
        -8,
        3.6,
        thickness,
        length,
        degrees > 47 ? PALETTE.blocked : PALETTE.ramp,
        -angle,
      ),
    );
  });
}

/** Widening gaps, to read the jump arc off the world instead of off a graph. */
function buildJumpGallery(out: Brush[], base: number): void {
  const gaps = [1.4, 2.2, 3, 3.8];
  let z = 2;

  out.push(brush(-4, base + 0.6, z, 4, 1.2, 4, PALETTE.deck));

  for (const gap of gaps) {
    z += 4 + gap;
    out.push(brush(-4, base + 0.6, z, 4, 1.2, 4, PALETTE.deck));
  }
}

/**
 * A corridor with 1.1 m of headroom. Standing up inside must be refused by the
 * shape swap itself — if the player pops up here, the crouch is faked.
 */
function buildCrouchTunnel(out: Brush[], base: number): void {
  const length = 9;
  const clearance = 1.1;

  out.push(brush(4.6, base + 1.1, 8, 0.6, 2.2, length, PALETTE.wall));
  out.push(brush(8.4, base + 1.1, 8, 0.6, 2.2, length, PALETTE.wall));
  out.push(brush(6.5, base + clearance + 0.25, 8, 4.4, 0.5, length, PALETTE.wall));
}

/**
 * The camera's test rig: a straight colonnaded causeway running off the island
 * to a banded tower.
 *
 * Every piece of it exists to make one property of a projection legible.
 *
 * - The **deck and lintels** are long straight lines running to a vanishing
 *   point. They are horizontal, so they are exactly the lines a cylindrical
 *   lens bows — verticals and the horizon stay straight, everything else
 *   curves, and this is where you decide whether you can live with that.
 * - The **columns** are verticals at every distance and every screen position.
 *   Under a world-axis cylindrical lens they must stay perfectly upright no
 *   matter where you look; anything else is a bug you can see from across the
 *   room.
 * - The **tower's bands** are evenly spaced in the world, so the way they
 *   compress towards the top reads the vertical map straight off the screen:
 *   at α = 1 they taper by cos ε, at α = 2 they stay even all the way up.
 * - The **walk towards the tower** is the honest cost. Its crown climbs past
 *   the pitch limit long before you reach the base, because a yaw-rigid
 *   projection cannot show you the zenith. That is not a bug to be tuned out;
 *   it is the trade, and it should be felt rather than argued about.
 *
 * The deck height is measured off the terrain rather than guessed, so the run
 * stays a single straight line while still clearing whatever the seed grew
 * underneath it.
 */
function buildCauseway(
  out: Brush[],
  base: number,
  groundAt: (x: number, z: number) => number,
): void {
  const startZ = -24;
  const endZ = -128;
  const halfWidth = 3.5;
  const spacing = 8;
  const columnHeight = 6.4;
  const towerZ = -142;
  const towerHalf = 8;
  const towerRise = 108;
  const bandStep = 6;

  let crest = base;

  for (let z = startZ; z >= towerZ; z -= 2) {
    for (const x of [-halfWidth, 0, halfWidth]) crest = Math.max(crest, groundAt(x, z));
  }

  const deck = crest + 2.5;
  const midZ = (startZ + endZ) / 2;
  const run = startZ - endZ;

  // A ramp from the plateau up to the deck, so the causeway is walked onto
  // rather than stepped up to.
  const rampRise = deck - base;
  const rampRun = Math.max(rampRise / Math.tan(THREE.MathUtils.degToRad(24)), 4);
  const rampAngle = Math.atan2(rampRise, rampRun);

  out.push(
    brush(
      0,
      base + rampRise / 2 - 0.3 * Math.cos(rampAngle),
      startZ + rampRun / 2,
      halfWidth * 2,
      0.6,
      Math.hypot(rampRun, rampRise),
      PALETTE.causeway,
      -rampAngle,
    ),
  );

  out.push(brush(0, deck - 0.4, midZ, halfWidth * 2, 0.8, run, PALETTE.causeway));

  for (let z = startZ - spacing / 2; z >= endZ; z -= spacing) {
    const ground = groundAt(0, z);
    const pierTop = deck - 0.8;

    if (pierTop > ground) {
      out.push(
        brush(0, (ground + pierTop) / 2, z, 2.2, pierTop - ground, 2.2, PALETTE.pillar),
      );
    }

    for (const side of [-1, 1]) {
      out.push(
        brush(
          side * (halfWidth - 0.6),
          deck + columnHeight / 2,
          z,
          0.7,
          columnHeight,
          0.7,
          PALETTE.colonnade,
        ),
      );
    }
  }

  for (const side of [-1, 1]) {
    out.push(
      brush(
        side * (halfWidth - 0.6),
        deck + columnHeight + 0.35,
        midZ,
        0.9,
        0.7,
        run,
        PALETTE.colonnade,
      ),
    );
  }

  const footing = groundAt(0, towerZ) - 6;

  out.push(
    brush(
      0,
      (footing + deck + towerRise) / 2,
      towerZ,
      towerHalf * 2,
      deck + towerRise - footing,
      towerHalf * 2,
      PALETTE.tower,
    ),
  );

  for (let y = deck + bandStep; y < deck + towerRise; y += bandStep) {
    out.push(brush(0, y, towerZ, towerHalf * 2 + 1.2, 0.5, towerHalf * 2 + 1.2, PALETTE.band));
  }
}

/** Vertical occluders: silhouettes for shadow and edge-detection work. */
function buildPillars(out: Brush[], base: number): void {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 3; j++) {
      const height = 2.5 + ((i * 3 + j) % 4) * 1.4;

      out.push(
        brush(
          -18 + i * 3.6,
          base + height / 2,
          10 + j * 3.6,
          0.8,
          height,
          0.8,
          PALETTE.pillar,
          0,
          (i + j) * 0.3,
        ),
      );
    }
  }
}

function buildCrates(world: PhysicsWorld, base: number): PropSet {
  const { jolt, scratch } = world;
  const size = 0.6;
  const half = size / 2;
  const count = 24;

  const shapeSettings = new jolt.BoxShapeSettings(scratch.vec3(half, half, half), CONVEX_RADIUS);

  shapeSettings.mDensity = DENSITY.crate;

  const shape = world.createShape(shapeSettings);
  const bodies: Jolt.Body[] = [];

  for (let i = 0; i < count; i++) {
    const column = i % 4;
    const row = Math.floor(i / 4) % 3;
    const layer = Math.floor(i / 12);

    bodies.push(
      world.createBody({
        shape,
        position: [
          -2 + column * (size + 0.04),
          base + half + 0.05 + layer * (size + 0.02),
          -3 + row * (size + 0.04),
        ],
        motionType: jolt.EMotionType_Dynamic,
        layer: OBJECT_LAYER.MOVING,
        friction: 0.45,
        restitution: 0.05,
        activate: true,
      }),
    );
  }

  return makePropSet(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardNodeMaterial({ color: 0xb07a4a, roughness: 0.7, metalness: 0.05 }),
    bodies,
  );
}

function buildBalls(world: PhysicsWorld, base: number): PropSet {
  const { jolt } = world;
  const radius = 0.34;
  const count = 10;

  const shapeSettings = new jolt.SphereShapeSettings(radius);

  shapeSettings.mDensity = DENSITY.ball;

  const shape = world.createShape(shapeSettings);
  const bodies: Jolt.Body[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;

    bodies.push(
      world.createBody({
        shape,
        position: [Math.cos(angle) * 5 + 14, base + radius + 4, Math.sin(angle) * 5 + 6],
        motionType: jolt.EMotionType_Dynamic,
        layer: OBJECT_LAYER.MOVING,
        friction: 0.35,
        restitution: 0.45,
        activate: true,
      }),
    );
  }

  return makePropSet(
    new THREE.SphereGeometry(radius, 24, 16),
    new THREE.MeshStandardNodeMaterial({ color: 0xd8d2c4, roughness: 0.35, metalness: 0.1 }),
    bodies,
  );
}

function makePropSet(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  bodies: Jolt.Body[],
): PropSet {
  const mesh = new THREE.InstancedMesh(geometry, material, bodies.length);

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const stride = bodies.length * 7;
  const set: PropSet = {
    mesh,
    bodies,
    previous: new Float32Array(stride),
    current: new Float32Array(stride),
  };

  // Seed both snapshots from the spawn pose, or the first frame interpolates
  // out of the origin.
  for (let i = 0; i < bodies.length; i++) {
    const p = bodies[i].GetPosition();
    const q = bodies[i].GetRotation();
    const o = i * 7;

    set.current.set([p.GetX(), p.GetY(), p.GetZ(), q.GetX(), q.GetY(), q.GetZ(), q.GetW()], o);
  }
  set.previous.set(set.current);

  return set;
}
