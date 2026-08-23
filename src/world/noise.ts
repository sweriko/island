/**
 * Deterministic 2D gradient noise.
 *
 * Hash-based rather than permutation-table based: no setup, no shared mutable
 * state, and the same `(x, z, seed)` always returns the same height on every
 * machine. That reproducibility is the point — a world is fully described by
 * its seed, so a bug found while walking around can be walked into again.
 */

const TAU = Math.PI * 2;
/** 2^32, for mapping a `uint32` hash into the unit interval. */
const UINT32_SCALE = 4294967296;

/** A 32-bit integer avalanche (the finaliser from MurmurHash3). */
function hash(value: number): number {
  let x = value | 0;

  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);

  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Dot product of the pseudo-random unit gradient at lattice point `(ix, iy)`
 * with the offset to the sample. Sampling the gradient as an angle keeps every
 * gradient exactly unit length, which classic Perlin's 8-direction table does
 * not — and unequal gradient lengths show up as a faint grid in the result.
 */
function gradientDot(ix: number, iy: number, dx: number, dy: number, seed: number): number {
  const angle = (hash(Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed) /
    UINT32_SCALE) * TAU;

  return Math.cos(angle) * dx + Math.sin(angle) * dy;
}

/** Quintic interpolant: zero first *and* second derivative at the lattice. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Gradient noise in roughly [-1, 1]. */
function noise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const u = fade(fx);
  const v = fade(fy);

  const n00 = gradientDot(ix, iy, fx, fy, seed);
  const n10 = gradientDot(ix + 1, iy, fx - 1, fy, seed);
  const n01 = gradientDot(ix, iy + 1, fx, fy - 1, seed);
  const n11 = gradientDot(ix + 1, iy + 1, fx - 1, fy - 1, seed);

  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);

  // Gradient noise peaks near 1/sqrt(2); scale so the range is usable as-is.
  return (a + v * (b - a)) * Math.SQRT2;
}

interface FbmOptions {
  octaves: number;
  /** Frequency multiplier per octave. */
  lacunarity: number;
  /** Amplitude multiplier per octave. */
  gain: number;
}

/** Fractal sum of gradient noise, normalised to roughly [-1, 1]. */
export function fbm2D(x: number, y: number, seed: number, options: FbmOptions): number {
  let frequency = 1;
  let amplitude = 1;
  let total = 0;
  let normalisation = 0;

  for (let i = 0; i < options.octaves; i++) {
    // Each octave gets its own seed, so octaves do not correlate at the origin.
    total += noise2D(x * frequency, y * frequency, seed + i * 0x9e3779b1) * amplitude;
    normalisation += amplitude;

    frequency *= options.lacunarity;
    amplitude *= options.gain;
  }

  return total / normalisation;
}

/**
 * Ridged noise: folds the signal about zero and inverts it, so the maxima
 * become sharp crests while the valleys stay broad. Layered under plain fBm it
 * is what stops rolling hills from reading as a bedsheet.
 */
export function ridged2D(x: number, y: number, seed: number, options: FbmOptions): number {
  let frequency = 1;
  let amplitude = 1;
  let total = 0;
  let normalisation = 0;

  for (let i = 0; i < options.octaves; i++) {
    const value = 1 - Math.abs(noise2D(x * frequency, y * frequency, seed + i * 0x85ebca6b));

    total += value * value * amplitude;
    normalisation += amplitude;

    frequency *= options.lacunarity;
    amplitude *= options.gain;
  }

  return (total / normalisation) * 2 - 1;
}
