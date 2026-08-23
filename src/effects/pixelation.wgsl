// PSX-era pixelation.
//
// The scene is already rendered small and upscaled with a nearest filter, so
// this pass only has to draw the edges: neighbouring depths give silhouette
// outlines, neighbouring normals give interior creases.
//
// Every comparison is made on *linear view distance*, and every threshold is a
// fraction of that distance rather than an absolute. Raw depth-buffer values
// are crushed towards 1 with distance, so an absolute threshold silently stops
// finding edges as soon as the world is larger than the one it was tuned in —
// and a playground whose effects only work at one scale is not a playground.
//
// Every tap is an exact texel neighbour, and a nearest-filtered target carries
// no sampler, so the reads are `textureLoad` rather than `textureSample`.

fn pixelation(
  colorTex: texture_2d<f32>,
  depthTex: texture_depth_2d,
  normalTex: texture_2d<f32>,
  uv: vec2f,
  near: f32,
  far: f32,
  normalEdgeStrength: f32,
  depthEdgeStrength: f32
) -> vec4f {
  let size = vec2i(textureDimensions(colorTex));
  let coord = vec2i(uv * vec2f(size));

  let color = textureLoad(colorTex, pixelationClamp(coord, size), 0);
  let distance = pixelationDistance(depthTex, coord, size, near, far);
  let normal = pixelationNormal(normalTex, coord, size);

  let right = vec2i(1, 0);
  let up = vec2i(0, 1);

  // Depth edge: how much further away the four neighbours are, relative to how
  // far away this pixel already is. One percent of the distance is an edge
  // whether that distance is one metre or three hundred.
  let inverseDistance = 1.0 / max(distance, near);
  var depthDiff = 0.0;
  depthDiff += saturate((pixelationDistance(depthTex, coord + right, size, near, far) - distance) * inverseDistance);
  depthDiff += saturate((pixelationDistance(depthTex, coord - right, size, near, far) - distance) * inverseDistance);
  depthDiff += saturate((pixelationDistance(depthTex, coord + up, size, near, far) - distance) * inverseDistance);
  depthDiff += saturate((pixelationDistance(depthTex, coord - up, size, near, far) - distance) * inverseDistance);
  let depthEdge = floor(smoothstep(0.012, 0.03, depthDiff) * 2.0) / 2.0;

  // Background pixels carry no normal, so they get no creases.
  var normalEdge = 0.0;
  if (length(normal) > 0.0) {
    var sum = 0.0;
    sum += pixelationCrease(depthTex, normalTex, coord, right, size, distance, normal, near, far);
    sum += pixelationCrease(depthTex, normalTex, coord, -right, size, distance, normal, near, far);
    sum += pixelationCrease(depthTex, normalTex, coord, up, size, distance, normal, near, far);
    sum += pixelationCrease(depthTex, normalTex, coord, -up, size, distance, normal, near, far);
    normalEdge = step(0.1, sum);
  }

  // A depth edge darkens the pixel; otherwise a normal edge lifts it.
  var strength = 1.0 + normalEdge * normalEdgeStrength;
  if (depthEdge > 0.0) {
    strength = 1.0 - depthEdge * depthEdgeStrength;
  }

  return vec4f(color.rgb * strength, color.a);
}

fn pixelationClamp(coord: vec2i, size: vec2i) -> vec2i {
  return clamp(coord, vec2i(0), size - vec2i(1));
}

/**
 * View-space distance along the eye axis, in world units.
 *
 * Inverts the standard perspective depth mapping, `d = far / (far - near) *
 * (1 - near / z)`, so that differences between neighbours mean metres instead
 * of an arbitrary non-linear quantity.
 */
fn pixelationDistance(tex: texture_depth_2d, coord: vec2i, size: vec2i, near: f32, far: f32) -> f32 {
  let depth = textureLoad(tex, pixelationClamp(coord, size), 0);

  return (near * far) / max(far - depth * (far - near), 1e-6);
}

/** Zero where nothing was drawn, so callers can tell background from geometry. */
fn pixelationNormal(tex: texture_2d<f32>, coord: vec2i, size: vec2i) -> vec3f {
  let raw = textureLoad(tex, pixelationClamp(coord, size), 0).rgb;
  let len = length(raw);

  if (len > 0.0) {
    return raw / len;
  }

  return vec3f(0.0);
}

/** Crease strength contributed by one neighbour. */
fn pixelationCrease(
  depthTex: texture_depth_2d,
  normalTex: texture_2d<f32>,
  coord: vec2i,
  offset: vec2i,
  size: vec2i,
  distance: f32,
  normal: vec3f,
  near: f32,
  far: f32
) -> f32 {
  let neighborDistance = pixelationDistance(depthTex, coord + offset, size, near, far);
  let neighborNormal = pixelationNormal(normalTex, coord + offset, size);

  // Faces whose normals point closer to the bias direction yield, so a crease
  // is drawn once rather than on both of its sides.
  let bias = dot(normal - neighborNormal, vec3f(1.0));
  let biasIndicator = smoothstep(-0.01, 0.01, bias);

  // Only the nearer of the two pixels draws the crease, with a tolerance that
  // scales with distance so the same geometry creases at any range.
  let depthIndicator = saturate(sign(neighborDistance - distance + distance * 0.0015));

  return (1.0 - dot(normal, neighborNormal)) * depthIndicator * biasIndicator;
}
