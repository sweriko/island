import { screenUV } from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";

import type { LensSource } from "../lens/lens";
import source from "./painterly.wgsl?raw";
import { shader } from "./wgsl";

const painterlyShader = shader<{
  colorTex: Node;
  uv: Node;
  anchor: Node;
  spacing: Node;
  strength: Node;
  levels: Node;
  grain: Node;
}>(source);

export interface PainterlyOptions {
  /** 0 pins the marks to the screen, 1 pins them to the world. */
  weld: UniformNode<"float", number>;
  /** Ruling pitch in canvas pixels — constant on screen at any distance. */
  spacing: Node;
  strength: Node;
  /** Ink densities the plate is printed at. */
  levels: Node;
  grain: Node;
}

/**
 * Crosshatched tone, addressed in the lens's panorama space.
 *
 * The style itself is unremarkable engraving; what it is here to demonstrate is
 * the address. `lens.anchor` hands back where each fragment sits on the fixed
 * image plane wrapped around the eye, so the marks stay on the surfaces they
 * were drawn on while keeping a constant size in pixels. Turn `weld` down and
 * this becomes the ordinary screen-space version, for comparison.
 */
export function painterly(lens: LensSource, options: PainterlyOptions): Node {
  return painterlyShader({
    colorTex: lens.color,
    uv: screenUV,
    anchor: lens.anchor(options.weld),
    spacing: options.spacing,
    strength: options.strength,
    levels: options.levels,
    grain: options.grain,
  });
}
