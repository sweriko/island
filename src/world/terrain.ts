import * as THREE from "three/webgpu";
import type Jolt from "jolt-physics";

import { OBJECT_LAYER } from "../physics/layers";
import type { PhysicsWorld } from "../physics/world";
import { fbm2D, ridged2D } from "./noise";

export interface TerrainOptions {
  seed: number;
  /** Samples per side. Must be a multiple of `BLOCK_SIZE`. */
  sampleCount: number;
  /** Metres between samples. */
  spacing: number;
  /** Radius of the flat build area at the origin. */
  plateauRadius: number;
  /** Width of the ramp that blends the plateau into the hills. */
  plateauFalloff: number;
  plateauHeight: number;
  /** Peak-to-trough scale of the rolling hills. */
  relief: number;
  /** Fraction of the half-extent where the island starts dropping to the sea. */
  shoreStart: number;
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  seed: 0x1_51a_11d,
  sampleCount: 192,
  spacing: 1.75,
  plateauRadius: 34,
  plateauFalloff: 20,
  plateauHeight: 8,
  relief: 26,
  shoreStart: 0.52,
};

/**
 * Jolt compresses a heightfield in blocks, each with its own local range, so
 * eight bits per sample is far more precise than a global 8-bit quantisation
 * would suggest — centimetres, not decimetres, at this relief.
 */
const BLOCK_SIZE = 4;
const BITS_PER_SAMPLE = 8;

/**
 * A procedural island: one Jolt `HeightFieldShape`, and a render mesh read back
 * out of that shape.
 *
 * The render mesh is *derived from the collider*, not generated alongside it.
 * Generating both from the same height function would still leave two
 * surfaces — Jolt quantises its samples and picks its own diagonal per quad —
 * and the disagreement between them is exactly where invisible ledges and
 * floating feet come from. Reading the triangles back costs one pass at load
 * and removes the entire class of bug.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly body: Jolt.Body;

  /** Half the width of the island, in metres. */
  readonly extent: number;

  private readonly heights: Float32Array;
  private readonly sampleCount: number;
  private readonly spacing: number;
  /** Lattice corner of the heightfield in shape space, from the collider itself. */
  private readonly originX: number;
  private readonly originZ: number;

  constructor(world: PhysicsWorld, options: TerrainOptions) {
    const { jolt, scratch } = world;
    const n = options.sampleCount;

    if (n % BLOCK_SIZE !== 0) {
      throw new Error(`Terrain sampleCount must be a multiple of ${BLOCK_SIZE}, got ${n}.`);
    }

    this.sampleCount = n;
    this.spacing = options.spacing;
    this.extent = ((n - 1) * options.spacing) / 2;

    const corner = -this.extent;
    const settings = new jolt.HeightFieldShapeSettings();

    settings.mOffset = scratch.vec3(corner, 0, corner);
    settings.mScale = scratch.vec3(options.spacing, 1, options.spacing);
    settings.mSampleCount = n;
    settings.mBlockSize = BLOCK_SIZE;
    settings.mBitsPerSample = BITS_PER_SAMPLE;

    const samples = settings.mHeightSamples;

    samples.resize(n * n);

    // Resizing can grow the WASM heap and detach any earlier view, so the
    // typed-array window is opened only once the storage is final.
    const heap = new Float32Array(jolt.HEAPF32.buffer, jolt.getPointer(samples.data()), n * n);

    for (let z = 0; z < n; z++) {
      const worldZ = corner + z * options.spacing;

      for (let x = 0; x < n; x++) {
        const worldX = corner + x * options.spacing;

        heap[z * n + x] = sampleHeight(worldX, worldZ, options, this.extent);
      }
    }

    const shape = world.createShape(settings);

    this.body = world.createBody({
      shape,
      position: [0, 0, 0],
      motionType: jolt.EMotionType_Static,
      layer: OBJECT_LAYER.STATIC,
      friction: 0.85,
    });

    const extracted = extractGeometry(world, shape, n, options.spacing);

    this.heights = extracted.heights;
    this.originX = extracted.originX;
    this.originZ = extracted.originZ;

    const geometry = extracted.geometry;

    this.mesh = new THREE.Mesh(geometry, buildMaterial());
    this.mesh.name = "terrain";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * Surface height at a world position, bilinearly interpolated from the
   * collider's own samples — so anything placed with it sits on the surface the
   * player will actually walk on.
   */
  heightAt(x: number, z: number): number {
    const n = this.sampleCount;
    const fx = THREE.MathUtils.clamp((x - this.originX) / this.spacing, 0, n - 1.0001);
    const fz = THREE.MathUtils.clamp((z - this.originZ) / this.spacing, 0, n - 1.0001);

    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;

    const h00 = this.heights[iz * n + ix];
    const h10 = this.heights[iz * n + ix + 1];
    const h01 = this.heights[(iz + 1) * n + ix];
    const h11 = this.heights[(iz + 1) * n + ix + 1];

    return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/**
 * The island's height field.
 *
 * Three layers with different jobs: broad fBm for the landmass, ridged noise
 * for crests that read as erosion rather than dunes, and a fine octave so
 * grazing light has something to catch. The plateau and the shore are shaped by
 * smoothstep masks so their seams have continuous slope — a linear blend leaves
 * a crease that the lighting finds immediately.
 */
function sampleHeight(x: number, z: number, options: TerrainOptions, extent: number): number {
  const { seed, relief } = options;

  // Domain warp: displacing the sample point by a low-frequency noise field
  // bends the ridges into something geological instead of isotropic mush.
  const warpX = x + fbm2D(x * 0.004, z * 0.004, seed + 991, WARP_FBM) * 40;
  const warpZ = z + fbm2D(x * 0.004 + 5.7, z * 0.004 - 3.1, seed + 991, WARP_FBM) * 40;

  const base = fbm2D(warpX * 0.0055, warpZ * 0.0055, seed, BASE_FBM);
  const ridges = ridged2D(warpX * 0.017, warpZ * 0.017, seed + 77, RIDGE_FBM);
  const detail = fbm2D(x * 0.085, z * 0.085, seed + 313, DETAIL_FBM);

  // Ridges only appear where the land is already high, so the lowlands stay
  // walkable and the silhouette gains its interest at altitude.
  const highland = THREE.MathUtils.smoothstep(base, -0.05, 0.55);

  let height = (base * 0.62 + ridges * 0.38 * highland) * relief + detail * 0.55;

  // Island falloff, measured on the inscribed circle so the four corners drop
  // away as cleanly as the edge midpoints.
  const radius = Math.hypot(x, z) / extent;
  const shore = 1 - THREE.MathUtils.smoothstep(radius, options.shoreStart, 1);

  height = height * shore - (1 - shore) * 9;

  // The build plateau: flat, then a graded apron out to the natural terrain.
  const plateau =
    1 -
    THREE.MathUtils.smoothstep(
      Math.hypot(x, z),
      options.plateauRadius,
      options.plateauRadius + options.plateauFalloff,
    );

  return THREE.MathUtils.lerp(height, options.plateauHeight, plateau);
}

/**
 * Octave counts are a load-time budget, not a quality dial to max out: every
 * octave costs four trigonometric gradient evaluations at each of ~37k samples,
 * and the warp field is evaluated twice more on top. Lacunarity is deliberately
 * off exactly 2 so successive octaves do not align on the same lattice and
 * print a grid into the terrain.
 */
const WARP_FBM = { octaves: 2, lacunarity: 2.1, gain: 0.5 } as const;
const BASE_FBM = { octaves: 4, lacunarity: 2.05, gain: 0.5 } as const;
const RIDGE_FBM = { octaves: 3, lacunarity: 2.2, gain: 0.45 } as const;
const DETAIL_FBM = { octaves: 2, lacunarity: 2.3, gain: 0.4 } as const;

/**
 * Reads the collider's triangles back and re-welds them into an indexed grid.
 *
 * Jolt hands back loose triangles — three vertices each, every interior vertex
 * repeated six times. A general-purpose weld would hash a quarter of a million
 * vertices to rediscover a structure we already know: every vertex sits on a
 * lattice. Recovering the lattice index by rounding is one linear pass with no
 * hashing at all, and it yields a mesh whose shared normals are exact.
 */
function extractGeometry(
  world: PhysicsWorld,
  shape: Jolt.Shape,
  sampleCount: number,
  spacing: number,
): { geometry: THREE.BufferGeometry; heights: Float32Array; originX: number; originZ: number } {
  const { jolt, scratch } = world;

  const context = new jolt.ShapeGetTriangles(
    shape,
    jolt.AABox.prototype.sBiggest(),
    shape.GetCenterOfMass(),
    scratch.quat(0, 0, 0, 1),
    scratch.vec3(1, 1, 1),
  );

  const source = new Float32Array(
    jolt.HEAPF32.buffer,
    context.GetVerticesData() as number,
    context.GetVerticesSize() / Float32Array.BYTES_PER_ELEMENT,
  );

  const vertexCount = source.length / 3;

  let minX = Infinity;
  let minZ = Infinity;

  for (let i = 0; i < vertexCount; i++) {
    minX = Math.min(minX, source[i * 3]);
    minZ = Math.min(minZ, source[i * 3 + 2]);
  }

  const n = sampleCount;
  const positions = new Float32Array(n * n * 3);
  const heights = new Float32Array(n * n);
  const indices = new Uint32Array(vertexCount);
  const limit = n - 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = source[i * 3];
    const y = source[i * 3 + 1];
    const z = source[i * 3 + 2];

    const ix = THREE.MathUtils.clamp(Math.round((x - minX) / spacing), 0, limit);
    const iz = THREE.MathUtils.clamp(Math.round((z - minZ) / spacing), 0, limit);
    const index = iz * n + ix;

    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
    heights[index] = y;
    indices[i] = index;
  }

  // The WASM-side copy is large and no longer needed; release it before the
  // renderer starts allocating buffers of its own.
  jolt.destroy(context);

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.setAttribute("color", buildVertexColors(positions, geometry));
  geometry.computeBoundingSphere();

  return { geometry, heights, originX: minX, originZ: minZ };
}

/**
 * Height and slope banding, baked per vertex.
 *
 * Deliberately data, not a shader: the render styles in `styles.ts` swap the
 * material's programs out from under the terrain, and anything that must
 * survive that swap has to live in the geometry.
 */
function buildVertexColors(
  positions: Float32Array,
  geometry: THREE.BufferGeometry,
): THREE.BufferAttribute {
  const normals = geometry.getAttribute("normal");
  const count = positions.length / 3;
  const colors = new Float32Array(count * 3);

  const sand = new THREE.Color(0x9c8f6a);
  const grass = new THREE.Color(0x59714a);
  const highland = new THREE.Color(0x6e7358);
  const rock = new THREE.Color(0x6b6660);
  const scratch = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const height = positions[i * 3 + 1];
    const slope = 1 - normals.getY(i);

    scratch.copy(sand).lerp(grass, THREE.MathUtils.smoothstep(height, 0.4, 4));
    scratch.lerp(highland, THREE.MathUtils.smoothstep(height, 12, 26));
    // Steep faces shed soil, so slope wins over altitude wherever they disagree.
    scratch.lerp(rock, THREE.MathUtils.smoothstep(slope, 0.28, 0.62));

    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  return new THREE.BufferAttribute(colors, 3);
}

function buildMaterial(): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  });
}
