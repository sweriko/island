/**
 * The scene composition root: the only file that knows what is actually in the
 * level. Everything else talks to it through `GameWorld`.
 */

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { color, mix, normalWorldGeometry, uniform } from "three/tsl";

import type { PhysicsWorld } from "../physics/world";
import characterUrl from "../../assets/dude.glb?url";
import { Course } from "./course";
import { DEFAULT_TERRAIN, Terrain } from "./terrain";

/**
 * `backgroundNode` is a runtime feature of the WebGPU renderer that the shipped
 * `Scene` typings do not describe yet. Narrowing it here beats loosening the
 * scene type everywhere it is touched.
 */
type NodeScene = THREE.Scene & { backgroundNode: THREE.Node | null };

/**
 * Materials that come out of a loader are plain (non-node) materials, but
 * `three/webgpu` upgrades them at build time and carries extra properties
 * across, so assigning a TSL vertex program still takes effect.
 */
type Shadable = THREE.Material & { vertexNode: THREE.Node | null };

const HORIZON = 0x9fb8cc;
const ZENITH = 0x3d6b9e;
const SUN_TINT = 0xfff2d6;

/**
 * Half-width of the shadowed region around the player, in metres.
 *
 * A single cascade this size is honest about what it is: crisp contact shadows
 * near the player, nothing at all past the ring. Cascaded maps for the whole
 * island are the next piece of work, not something to fake with a wider,
 * blurrier map.
 */
const SHADOW_RADIUS = 46;
const SHADOW_MAP_SIZE = 2048;
const SUN_DISTANCE = 140;

export class GameWorld {
  readonly scene = new THREE.Scene() as NodeScene;
  readonly sky = new THREE.HemisphereLight(HORIZON, 0x4a4436, 0.55);
  readonly sun = new THREE.DirectionalLight(SUN_TINT, 3.1);

  readonly terrain: Terrain;
  readonly course: Course;
  readonly spawn: THREE.Vector3;

  /** Radians per second applied to the calibration cube. */
  spin = 0.65;

  private readonly sunDirection = uniform(new THREE.Vector3(0.42, 0.58, 0.7).normalize());
  private readonly lightOrientation = new THREE.Quaternion();
  private readonly inverseLightOrientation = new THREE.Quaternion();
  private readonly shadowFocus = new THREE.Vector3();
  private readonly cube: THREE.Mesh;

  private character?: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private vertexNode: THREE.Node | null = null;

  constructor(physics: PhysicsWorld) {
    this.terrain = new Terrain(physics, DEFAULT_TERRAIN);

    const base = DEFAULT_TERRAIN.plateauHeight;

    this.course = new Course(physics, base);
    this.spawn = new THREE.Vector3(0, base + 0.4, 16);

    this.buildAtmosphere();
    this.buildSun();

    this.cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.4, 1.4),
      new THREE.MeshStandardNodeMaterial({ color: 0xff6c43, metalness: 0.08, roughness: 0.58 }),
    );
    this.cube.position.set(3.4, base + 1.4, 6);
    this.cube.castShadow = true;
    this.cube.receiveShadow = true;

    this.scene.add(this.sky, this.sun, this.sun.target, this.terrain.mesh, this.course.group, this.cube);
    this.scene.add(buildSea(this.terrain.extent));
  }

  /** Loads the animated glTF prop and stands it on the plateau. */
  async load(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(characterUrl);
    const character = gltf.scene;

    character.position.set(-1.5, 0, 8);
    character.updateMatrixWorld(true);
    // Drop it exactly onto the collision surface rather than a guessed offset.
    character.position.y =
      this.terrain.heightAt(character.position.x, character.position.z) -
      new THREE.Box3().setFromObject(character).min.y;

    character.traverse((child) => {
      child.castShadow = true;
      child.receiveShadow = true;
    });

    this.scene.add(character);
    this.character = character;

    if (gltf.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(character);
      this.mixer.clipAction(gltf.animations[0]).play();
    }

    // Materials that arrived after the current vertex program was set.
    this.setVertexNode(this.vertexNode);
  }

  update(deltaTime: number): void {
    const step = deltaTime * this.spin;

    this.cube.rotation.x += step * 0.45;
    this.cube.rotation.y += step;
    if (this.character) this.character.rotation.y += step * 0.35;
    this.mixer?.update(deltaTime);
  }

  /** Presents the physics props at the renderer's position between ticks. */
  sync(alpha: number): void {
    this.course.sync(alpha);
  }

  /**
   * Re-centres the shadow cascade on the player, snapped to the shadow map's
   * own texel grid.
   *
   * Without the snap, sliding the ortho frustum by a fraction of a texel
   * reassigns which depth sample every edge lands in, and every shadow boundary
   * crawls as the player walks. Quantising the centre in light space makes the
   * projection move in whole texels, so the pattern is stationary relative to
   * the world.
   */
  focusShadows(target: THREE.Vector3): void {
    const texelSize = (SHADOW_RADIUS * 2) / SHADOW_MAP_SIZE;
    const focus = this.shadowFocus.copy(target).applyQuaternion(this.inverseLightOrientation);

    focus.x = Math.round(focus.x / texelSize) * texelSize;
    focus.y = Math.round(focus.y / texelSize) * texelSize;
    focus.applyQuaternion(this.lightOrientation);

    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.sun.position.copy(focus).addScaledVector(this.sunDirection.value, SUN_DISTANCE);
    this.sun.updateMatrixWorld();
  }

  /**
   * Grafts a render style's vertex program onto every material in the scene.
   *
   * Scene-wide rather than per-object: a style that only reaches some of the
   * geometry produces a world that disagrees with itself, with jittered props
   * floating over stable ground.
   */
  setVertexNode(node: THREE.Node | null): void {
    this.vertexNode = node;

    this.scene.traverse((object) => {
      for (const material of materialsOf(object)) {
        (material as Shadable).vertexNode = node;
        material.needsUpdate = true;
      }
    });
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.terrain.dispose();
    this.course.dispose();

    this.scene.traverse((object) => {
      (object as Partial<THREE.Mesh>).geometry?.dispose();
      for (const material of materialsOf(object)) material.dispose();
    });
  }

  /**
   * A procedural sky, evaluated per background fragment.
   *
   * `normalWorldGeometry` is the outward direction of the background sphere —
   * the shading normal would be flipped by the mesh's back-facing material and
   * hand back an upside-down sky.
   */
  private buildAtmosphere(): void {
    const direction = normalWorldGeometry;
    const elevation = direction.y.max(0).pow(0.62);
    const towardsSun = direction.dot(this.sunDirection).max(0);

    this.scene.backgroundNode = mix(color(HORIZON), color(ZENITH), elevation)
      // Two lobes of the same dot product: a wide forward-scattering haze and
      // a tight bloom around the sun. Cheapest thing that still reads as air.
      .add(color(0xffd9a0).mul(towardsSun.pow(8)).mul(0.3))
      .add(color(SUN_TINT).mul(towardsSun.pow(220)).mul(2.6));

    // Matching the fog to the horizon is what lets distant terrain dissolve
    // into the sky instead of ending at a visible silhouette.
    this.scene.fog = new THREE.Fog(HORIZON, 110, 460);
  }

  private buildSun(): void {
    const shadow = this.sun.shadow;

    this.sun.castShadow = true;
    shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    shadow.camera.left = -SHADOW_RADIUS;
    shadow.camera.right = SHADOW_RADIUS;
    shadow.camera.top = SHADOW_RADIUS;
    shadow.camera.bottom = -SHADOW_RADIUS;
    shadow.camera.near = 1;
    shadow.camera.far = SUN_DISTANCE * 2;
    shadow.camera.updateProjectionMatrix();

    // Constant bias fights acne on flat ground; normal bias fights it on
    // slopes, where the depth gradient across one texel is what causes it.
    shadow.bias = -0.0004;
    shadow.normalBias = 0.05;

    this.orientLight();
    this.focusShadows(new THREE.Vector3());
  }

  /** Caches the light's world rotation, which only the sun direction changes. */
  private orientLight(): void {
    const matrix = new THREE.Matrix4().lookAt(
      this.sunDirection.value,
      ORIGIN,
      THREE.Object3D.DEFAULT_UP,
    );

    this.lightOrientation.setFromRotationMatrix(matrix);
    this.inverseLightOrientation.copy(this.lightOrientation).invert();
  }
}

const ORIGIN = new THREE.Vector3();

/**
 * Placeholder sea: a flat plane at the waterline so the island reads as an
 * island. Deliberately inert — no collider, no waves, no refraction — and
 * marked as such so it is replaced rather than extended.
 */
function buildSea(extent: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(extent * 4, extent * 4),
    new THREE.MeshStandardNodeMaterial({
      color: 0x2f5a73,
      roughness: 0.22,
      metalness: 0.02,
    }),
  );

  mesh.name = "sea-placeholder";
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return mesh;
}

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const material = (object as Partial<THREE.Mesh>).material;

  if (!material) return [];

  return Array.isArray(material) ? material : [material];
}
