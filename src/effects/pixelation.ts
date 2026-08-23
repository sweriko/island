import { screenUV } from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";

import type { LensSource } from "../lens/lens";
import source from "./pixelation.wgsl?raw";
import { shader } from "./wgsl";

const pixelationShader = shader<{
  colorTex: Node;
  normalDepthTex: Node;
  uv: Node;
  normalEdgeStrength: Node;
  depthEdgeStrength: Node;
}>(source);

export interface PixelationOptions {
  /** Canvas pixels per rendered pixel. Drives the lens's resolve resolution. */
  pixelSize: UniformNode<"float", number>;
  normalEdgeStrength: Node;
  depthEdgeStrength: Node;
}

/**
 * Draws PSX-era edges over the lens's own output.
 *
 * The scene is never rendered here. The lens has already resolved colour,
 * world normal and radial distance at whatever resolution this style asked for,
 * so all that is left is to read them — which is the entire point of putting a
 * camera behind a seam: an effect written against a linear frustum keeps
 * working when the frustum stops being one.
 */
export function pixelation(lens: LensSource, options: PixelationOptions): Node {
  return pixelationShader({
    colorTex: lens.color,
    normalDepthTex: lens.normalDepth,
    // Top-left normalised coordinates, matching `textureLoad`'s own origin.
    uv: screenUV,
    normalEdgeStrength: options.normalEdgeStrength,
    depthEdgeStrength: options.depthEdgeStrength,
  });
}
