/**
 * Collision layers.
 *
 * Object layers say *what a body is*; broad-phase layers say *which tree it
 * lives in*. Keeping static geometry in its own broad-phase tree is what lets
 * Jolt skip the whole terrain when it walks the moving bodies against each
 * other, so the two sets are deliberately mapped one-to-one here.
 */

export const OBJECT_LAYER = {
  /** Terrain and level brushes: never moves, never tested against itself. */
  STATIC: 0,
  /** Props, debris, and the character's inner body. */
  MOVING: 1,
} as const;

export const BROAD_PHASE_LAYER = {
  STATIC: 0,
  MOVING: 1,
} as const;

export const NUM_OBJECT_LAYERS = 2;
export const NUM_BROAD_PHASE_LAYERS = 2;
