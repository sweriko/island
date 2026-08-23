/**
 * Painterly post-processing effect, in TSL.
 *
 * One 3x3 tap grid feeds the whole effect: its four overlapping 2x2 quadrants
 * form a Kuwahara filter that flattens shading into brush-like patches, and the
 * same nine taps drive a Sobel operator on luminance for the ink outline. Nine
 * texture reads total.
 *
 * Loosely modelled on the look of EllyKher's UE5 PainterlyShaderMaterial.
 */

import {
  Fn,
  add,
  convertToTexture,
  dot,
  float,
  luminance,
  mix,
  screenSize,
  sin,
  smoothstep,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";

export interface PainterlyOptions {
  /** Radius of the tap grid, in pixels. Wider reads as coarser brushwork. */
  brushSize: Node<"float">;
  /** Contrast of the Sobel ink outline. */
  edgeStrength: Node<"float">;
  /** Depth of the canvas grain. */
  paperStrength: Node<"float">;
  /** Chroma lift applied after the filter. */
  saturation: Node<"float">;
}

const INK = vec3(0.06, 0.05, 0.08);

interface Quadrant {
  mean: Node<"vec3">;
  variance: Node<"float">;
}

/** Mean colour and summed variance of one 2x2 corner of the tap grid. */
function quadrant(a: Node<"vec3">, b: Node<"vec3">, c: Node<"vec3">, d: Node<"vec3">): Quadrant {
  const mean = add(a, b, c, d).mul(0.25);
  const da = a.sub(mean);
  const db = b.sub(mean);
  const dc = c.sub(mean);
  const dd = d.sub(mean);

  return { mean, variance: add(dot(da, da), dot(db, db), dot(dc, dc), dot(dd, dd)) };
}

/** Branchless "keep whichever quadrant is flatter" — the Kuwahara selection. */
function flatter(a: Quadrant, b: Quadrant): Quadrant {
  const preferB = b.variance.lessThan(a.variance);

  return {
    mean: preferB.select(b.mean, a.mean),
    variance: preferB.select(b.variance, a.variance),
  };
}

/**
 * Wraps a full-screen colour node (typically a `pass()`) in the painterly look.
 */
export function painterly(input: Node, options: PainterlyOptions) {
  const { brushSize, edgeStrength, paperStrength, saturation } = options;
  const texture = convertToTexture(input);
  const resolution = screenSize;
  const texel = float(1).div(resolution);

  return Fn(() => {
    const screenUv = uv();
    /** Tap at a grid offset in units of `brushSize` pixels. */
    const tap = (x: number, y: number) =>
      texture.sample(screenUv.add(vec2(x, y).mul(brushSize).mul(texel))).rgb.toVar();

    // Suffix is (column, row), origin top-left.
    const c00 = tap(-1, -1);
    const c10 = tap(0, -1);
    const c20 = tap(1, -1);
    const c01 = tap(-1, 0);
    const c11 = tap(0, 0);
    const c21 = tap(1, 0);
    const c02 = tap(-1, 1);
    const c12 = tap(0, 1);
    const c22 = tap(1, 1);

    const painted = [
      quadrant(c10, c20, c11, c21), // NE
      quadrant(c01, c11, c02, c12), // SW
      quadrant(c11, c21, c12, c22), // SE
    ].reduce(flatter, quadrant(c00, c10, c01, c11)).mean;

    // Sobel on luminance, reusing the taps. The centre tap has zero weight.
    const gx = add(luminance(c20), luminance(c22), luminance(c21).mul(2))
      .sub(add(luminance(c00), luminance(c02), luminance(c01).mul(2)));
    const gy = add(luminance(c02), luminance(c22), luminance(c12).mul(2))
      .sub(add(luminance(c00), luminance(c20), luminance(c10).mul(2)));
    const ink = smoothstep(0.15, 0.7, gx.mul(gx).add(gy.mul(gy)).sqrt().mul(edgeStrength));

    // Chained `.mix()` takes the blend factor as its receiver: a.mix(b, c) is mix(b, c, a).
    const saturated = saturation.mix(vec3(luminance(painted)), painted);

    // Canvas grain: two sin lattices in pixel space, biased into [0, 1].
    const pixel = screenUv.mul(resolution);
    const grain = sin(pixel.x.mul(0.73).add(pixel.y.mul(1.21))).mul(0.3)
      .add(sin(pixel.x.mul(1.31).sub(pixel.y.mul(0.47))).mul(0.2))
      .add(0.5);
    const paper = paperStrength.mix(float(1), grain.mul(0.45).add(0.6));

    return vec4(mix(saturated.mul(paper), INK, ink), 1);
  })();
}
