import { NearestFilter, PassNode } from "three/webgpu";
import { mrt, normalView, output, uv } from "three/tsl";
import type { Camera, Node, Scene, UniformNode } from "three/webgpu";

import source from "./pixelation.wgsl?raw";
import { shader } from "./wgsl";

const pixelationShader = shader<{
  colorTex: Node;
  depthTex: Node;
  normalTex: Node;
  uv: Node;
  normalEdgeStrength: Node;
  depthEdgeStrength: Node;
}>(source);

export interface PixelationOptions {
  /** Screen pixels per rendered pixel. Drives the render target's size. */
  pixelSize: UniformNode<"float", number>;
  normalEdgeStrength: Node;
  depthEdgeStrength: Node;
}

/**
 * Renders the scene small — with normals and depth alongside colour — then
 * hands all three to `pixelation.wgsl` to draw the edges while upscaling.
 */
export class PixelationPass extends PassNode {
  constructor(
    scene: Scene,
    camera: Camera,
    private readonly options: PixelationOptions,
  ) {
    super(PassNode.COLOR, scene, camera, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });

    this.setMRT(mrt({ output, normal: normalView }));
  }

  /**
   * Called every frame with the drawing buffer size, so reading `pixelSize`
   * here is what lets the control resize the target live.
   */
  override setSize(width: number, height: number): void {
    this.setResolutionScale(1 / this.options.pixelSize.value);
    super.setSize(width, height);
  }

  override setup(): Node {
    return pixelationShader({
      colorTex: this.getTextureNode("output"),
      depthTex: this.getTextureNode("depth"),
      normalTex: this.getTextureNode("normal"),
      uv: uv(),
      normalEdgeStrength: this.options.normalEdgeStrength,
      depthEdgeStrength: this.options.depthEdgeStrength,
    });
  }
}
