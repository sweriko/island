import { cameraProjectionMatrix, cameraViewMatrix, positionWorld, viewportSize } from "three/tsl";
import type { Node } from "three/webgpu";

import source from "./psxJitter.wgsl?raw";
import { shader } from "./wgsl";

const psxJitterShader = shader<{
  projection: Node;
  view: Node;
  worldPosition: Node;
  viewportSize: Node;
  snapPixels: Node;
  strength: Node;
}>(source);

export interface PsxJitterOptions {
  /** Width of a grid cell, in screen pixels. */
  snapPixels: Node;
  /** How far to blend from the exact position toward the snapped one. */
  strength: Node;
}

/** A vertex program for `material.vertexNode`, returning a clip-space position. */
export function psxJitter(options: PsxJitterOptions): Node {
  return psxJitterShader({
    projection: cameraProjectionMatrix,
    view: cameraViewMatrix,
    worldPosition: positionWorld,
    viewportSize,
    ...options,
  });
}
