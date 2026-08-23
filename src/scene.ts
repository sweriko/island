/**
 * The demo content: a lit floor, a spinning cube and an animated glTF
 * character. Swap this file out; nothing else knows what is in the scene.
 */

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import characterUrl from "../assets/dude.glb?url";

/**
 * Materials accept a TSL `vertexNode`. Materials that come out of a loader are
 * plain (non-node) materials, but `three/webgpu` converts them at build time
 * and carries extra properties over, so the assignment still takes effect.
 */
type Shadable = THREE.Material & { vertexNode: THREE.Node | null };

const materialsOf = (object: THREE.Object3D): THREE.Material[] => {
  const material = (object as Partial<THREE.Mesh>).material;

  if (!material) return [];

  return Array.isArray(material) ? material : [material];
};

export class DemoScene {
  readonly scene = new THREE.Scene();
  readonly ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
  readonly keyLight = new THREE.DirectionalLight(0xffffff, 1.6);

  /** Radians per second applied to the cube; the character follows at 35%. */
  spin = 0.65;

  private readonly cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardNodeMaterial({ color: 0xff6c43, metalness: 0.08, roughness: 0.58 }),
  );

  private readonly ground = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshStandardNodeMaterial({ color: 0xeeeeee, metalness: 0, roughness: 0.95 }),
  );

  private readonly grid = new THREE.GridHelper(10, 10, 0x000000, 0x000000);

  private character?: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private vertexNode: THREE.Node | null = null;

  constructor() {
    this.scene.background = new THREE.Color(0xffffff);

    this.cube.position.y = 0.5;
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.501;
    this.grid.position.y = -0.5;
    this.keyLight.position.set(3, 4, 2);

    this.scene.add(this.ambientLight, this.keyLight, this.ground, this.grid, this.cube);
  }

  /** Loads the character and drops it onto the floor. */
  async load(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(characterUrl);
    const character = gltf.scene;

    character.position.set(1.5, 0, 0);
    character.updateMatrixWorld(true);
    character.position.y += -0.5 - new THREE.Box3().setFromObject(character).min.y;

    this.scene.add(character);
    this.character = character;

    if (gltf.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(character);
      this.mixer.clipAction(gltf.animations[0]).play();
    }

    // Materials that arrived after the current vertex program was set.
    this.setVertexNode(this.vertexNode);
  }

  update(delta: number): void {
    const step = delta * this.spin;

    this.cube.rotation.x += step * 0.45;
    this.cube.rotation.y += step;
    if (this.character) this.character.rotation.y += step * 0.35;
    this.mixer?.update(delta);
  }

  /** Grafts a style's vertex program onto every shadable mesh material. */
  setVertexNode(node: THREE.Node | null): void {
    this.vertexNode = node;

    for (const object of [this.cube, this.character]) {
      if (!object) continue;

      object.traverse((child) => {
        for (const material of materialsOf(child)) {
          (material as Shadable).vertexNode = node;
          material.needsUpdate = true;
        }
      });
    }
  }

  dispose(): void {
    this.scene.traverse((object) => {
      (object as Partial<THREE.Mesh>).geometry?.dispose();
      for (const material of materialsOf(object)) material.dispose();
    });
  }
}
