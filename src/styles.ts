/**
 * The render styles this boilerplate ships with.
 *
 * A style owns everything that changes when you pick it: the uniforms it
 * exposes to the UI, an optional vertex program grafted onto scene materials,
 * an optional post-processing chain, and how the scene is dressed for it.
 */

import { pixelationPass } from "three/addons/tsl/display/PixelationPassNode.js";
import {
  Fn,
  cameraProjectionMatrix,
  cameraViewMatrix,
  pass,
  positionWorld,
  screenSize,
  uniform,
  vec4,
} from "three/tsl";
import type { Camera, Node, Scene, UniformNode } from "three/webgpu";

import { painterly } from "./painterly";

export type StyleId = "basic" | "psx" | "painterly";

/** A uniform surfaced as a slider. */
export interface Control {
  label: string;
  uniform: UniformNode<"float", number>;
  min: number;
  max: number;
  step: number;
}

/** A live post-processing chain, owned by whoever built it. */
export interface StyleOutput {
  node: Node;
  dispose(): void;
}

export interface RenderStyle {
  label: string;
  controls: Control[];
  /** Grafted onto every shadable scene material while the style is active. */
  vertexNode: Node | null;
  /** `null` renders the scene straight to the canvas, with no extra targets. */
  createOutput: ((scene: Scene, camera: Camera) => StyleOutput) | null;
  background: number;
  groundColor: number;
  showGrid: boolean;
}

const psx = {
  pixelSize: uniform(3),
  normalEdge: uniform(0.3),
  depthEdge: uniform(0.4),
  jitter: uniform(0.5),
  snap: uniform(4),
};

const paint = {
  brushSize: uniform(2),
  edgeStrength: uniform(1.2),
  paperStrength: uniform(0.45),
  saturation: uniform(1.25),
};

/**
 * PSX-era vertex wobble: project to clip space by hand, snap the result to a
 * coarse screen grid, then blend back toward the exact position.
 *
 * Chained `.mix()` takes the blend factor as its receiver, so this reads as
 * `mix(exact, snapped, jitter)`.
 */
const psxVertexNode = Fn(() => {
  const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(positionWorld);
  const grid = screenSize.div(psx.snap);
  const snapped = clip.xy.div(clip.w.mul(2)).mul(grid).round().div(grid).mul(clip.w.mul(2));

  return vec4(psx.jitter.mix(clip.xy, snapped), clip.zw);
})();

export const RENDER_STYLES: Record<StyleId, RenderStyle> = {
  basic: {
    label: "Basic",
    controls: [],
    vertexNode: null,
    createOutput: null,
    background: 0xffffff,
    groundColor: 0xeeeeee,
    showGrid: true,
  },

  psx: {
    label: "PSX",
    controls: [
      { label: "Pixel size", uniform: psx.pixelSize, min: 1, max: 16, step: 1 },
      { label: "Normal edges", uniform: psx.normalEdge, min: 0, max: 2, step: 0.05 },
      { label: "Depth edges", uniform: psx.depthEdge, min: 0, max: 1, step: 0.05 },
      { label: "Vertex jitter", uniform: psx.jitter, min: 0, max: 1, step: 0.05 },
      { label: "Vertex snap", uniform: psx.snap, min: 1, max: 24, step: 1 },
    ],
    vertexNode: psxVertexNode,
    createOutput: (scene, camera) => {
      // Renders the scene itself with an MRT for normals and depth.
      const node = pixelationPass(scene, camera, psx.pixelSize, psx.normalEdge, psx.depthEdge);

      return { node, dispose: () => node.dispose() };
    },
    background: 0xffffff,
    groundColor: 0xeeeeee,
    showGrid: true,
  },

  painterly: {
    label: "Painterly",
    controls: [
      { label: "Brush size", uniform: paint.brushSize, min: 1, max: 6, step: 1 },
      { label: "Ink edges", uniform: paint.edgeStrength, min: 0, max: 3, step: 0.05 },
      { label: "Paper grain", uniform: paint.paperStrength, min: 0, max: 1, step: 0.02 },
      { label: "Saturation", uniform: paint.saturation, min: 0.5, max: 2, step: 0.05 },
    ],
    vertexNode: null,
    createOutput: (scene, camera) => {
      const scenePass = pass(scene, camera);

      return { node: painterly(scenePass, paint), dispose: () => scenePass.dispose() };
    },
    // Dressed like a canvas: warm off-white, softer floor, no helper grid.
    background: 0xf2ead6,
    groundColor: 0xe6dcc1,
    showGrid: false,
  },
};
