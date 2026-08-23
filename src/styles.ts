/**
 * The render styles this playground ships with.
 *
 * A style owns everything that changes when you pick it: the uniforms it
 * exposes to the UI, an optional vertex program grafted onto scene materials,
 * and the node it builds to turn the lens's output into pixels.
 *
 * Note what a style is *not* handed: the scene. The lens has already resolved
 * colour, world normal and radial distance through whatever projection is
 * active, so a style never learns whether the camera it is decorating was
 * linear. That seam is the whole reason a nonlinear camera can be dropped into
 * an existing effect stack without rewriting the stack.
 *
 * All shader code lives in `effects/*.wgsl`; the nodes below only decide which
 * inputs each shader is handed.
 */

import { uniform } from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";

import { painterly } from "./effects/painterly";
import { pixelation } from "./effects/pixelation";
import { psxJitter } from "./effects/psxJitter";
import type { LensSource } from "./lens/lens";

export type StyleId = "basic" | "psx" | "painterly";

/** A uniform surfaced as a slider. */
export interface Control {
  label: string;
  uniform: UniformNode<"float", number>;
  min: number;
  max: number;
  step: number;
}

export interface RenderStyle {
  label: string;
  controls: Control[];
  /** Grafted onto every shadable scene material while the style is active. */
  vertexNode: Node | null;
  /** True if the style reads the lens's normal and distance buffer. */
  needsNormalDepth: boolean;
  /** Fraction of the canvas the lens should resolve at, read every frame. */
  resolutionScale: () => number;
  /** Builds the node the pipeline presents, out of the lens's buffers. */
  createOutput: (lens: LensSource) => Node;
}

const plate = {
  weld: uniform(1),
  spacing: uniform(9),
  strength: uniform(0.7),
  levels: uniform(4),
  grain: uniform(0.1),
};

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
    needsNormalDepth: false,
    resolutionScale: () => 1,
    createOutput: (lens) => lens.present,
  },

  painterly: {
    label: "Engraved plate",
    controls: [
      { label: "Weld to world", uniform: plate.weld, min: 0, max: 1, step: 0.01 },
      { label: "Ruling pitch", uniform: plate.spacing, min: 3, max: 20, step: 0.5 },
      { label: "Ink", uniform: plate.strength, min: 0, max: 1, step: 0.02 },
      { label: "Tone steps", uniform: plate.levels, min: 2, max: 12, step: 1 },
      { label: "Paper grain", uniform: plate.grain, min: 0, max: 0.5, step: 0.01 },
    ],
    vertexNode: null,
    needsNormalDepth: false,
    resolutionScale: () => 1,
    createOutput: (lens) => painterly(lens, plate),
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
    needsNormalDepth: true,
    resolutionScale: () => 1 / psx.pixelSize.value,
    createOutput: (lens) => pixelation(lens, psx),
  },
};
