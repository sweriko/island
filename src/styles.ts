/**
 * The render styles this boilerplate ships with.
 *
 * A style owns everything that changes when you pick it: the uniforms it
 * exposes to the UI, an optional vertex program grafted onto scene materials,
 * and an optional post-processing chain.
 *
 * All shader code lives in `effects/*.wgsl`; the nodes below only decide which
 * inputs each shader is handed.
 */

import { uniform } from "three/tsl";
import type { Camera, Node, Scene, UniformNode } from "three/webgpu";

import { PixelationPass } from "./effects/pixelation";
import { psxJitter } from "./effects/psxJitter";

export type StyleId = "basic" | "psx";

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
}

const psx = {
  pixelSize: uniform(3),
  normalEdgeStrength: uniform(0.3),
  depthEdgeStrength: uniform(0.4),
  snapPixels: uniform(4),
  strength: uniform(0.5),
};

export const RENDER_STYLES: Record<StyleId, RenderStyle> = {
  basic: {
    label: "Basic",
    controls: [],
    vertexNode: null,
    createOutput: null,
  },

  psx: {
    label: "PSX",
    controls: [
      { label: "Pixel size", uniform: psx.pixelSize, min: 1, max: 16, step: 1 },
      { label: "Normal edges", uniform: psx.normalEdgeStrength, min: 0, max: 2, step: 0.05 },
      { label: "Depth edges", uniform: psx.depthEdgeStrength, min: 0, max: 1, step: 0.05 },
      { label: "Vertex jitter", uniform: psx.strength, min: 0, max: 1, step: 0.05 },
      { label: "Vertex snap", uniform: psx.snapPixels, min: 1, max: 24, step: 1 },
    ],
    vertexNode: psxJitter(psx),
    createOutput: (scene, camera) => {
      const node = new PixelationPass(scene, camera, psx);

      return { node, dispose: () => node.dispose() };
    },
  },
};
