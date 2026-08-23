// PSX-era pixelation.
//
// The lens resolves the scene at a fraction of the canvas, so this pass only
// has to draw the edges while it is upscaled: neighbouring distances give
// silhouette outlines, neighbouring normals give interior creases.
//
// Every comparison is made on *radial distance in metres*, and every threshold
// is a fraction of that distance rather than an absolute. Raw depth-buffer
// values are crushed towards 1 with distance, so an absolute threshold silently
// stops finding edges as soon as the world is larger than the one it was tuned
// in — and a playground whose effects only work at one scale is not a
// playground. The lens hands over metres already linearised, so there is no
// projection to undo here, and nothing in this file knows or cares that the
// camera it is looking through is nonlinear.
//
// Normals arrive in world space. Under a nonlinear camera there is no single
// view basis for them to be relative to — each tile of the underlying raster
// has its own — and world normals have the pleasant side effect that a crease
// keeps the same strength as the head turns.
//
// Every tap is an exact texel neighbour, so the reads are `textureLoad` rather
// than `textureSample`.

fn pixelation(
  colorTex: texture_2d<f32>,
  normalDepthTex: texture_2d<f32>,
  uv: vec2f,
  normalEdgeStrength: f32,
  depthEdgeStrength: f32
) -> vec4f {
  let size = vec2i(textureDimensions(colorTex));
  let coord = vec2i(uv * vec2f(size));

  let color = textureLoad(colorTex, pixelationClamp(coord, size), 0);
  let here = textureLoad(normalDepthTex, pixelationClamp(coord, size), 0);
  let distance = here.w;
  let normal = pixelationNormal(here);

  let right = vec2i(1, 0);
  let up = vec2i(0, 1);

  // Depth edge: how much further away the four neighbours are, relative to how
  // far away this pixel already is. One percent of the distance is an edge
  // whether that distance is one metre or three hundred.
  let inverseDistance = 1.0 / max(distance, 1e-3);
  var depthDiff = 0.0;
  depthDiff += saturate((pixelationDistance(normalDepthTex, coord + right, size) - distance) * inverseDistance);
  depthDiff += saturate((pixelationDistance(normalDepthTex, coord - right, size) - distance) * inverseDistance);
  depthDiff += saturate((pixelationDistance(normalDepthTex, coord + up, size) - distance) * inverseDistance);
  depthDiff += saturate((pixelationDistance(normalDepthTex, coord - up, size) - distance) * inverseDistance);
  let depthEdge = floor(smoothstep(0.012, 0.03, depthDiff) * 2.0) / 2.0;

  // Background pixels carry no normal, so they get no creases.
  var normalEdge = 0.0;
  if (length(normal) > 0.0) {
    var sum = 0.0;
    sum += pixelationCrease(normalDepthTex, coord, right, size, distance, normal);
    sum += pixelationCrease(normalDepthTex, coord, -right, size, distance, normal);
    sum += pixelationCrease(normalDepthTex, coord, up, size, distance, normal);
    sum += pixelationCrease(normalDepthTex, coord, -up, size, distance, normal);
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

/** Radial distance from the eye, in metres, straight out of the lens. */
fn pixelationDistance(tex: texture_2d<f32>, coord: vec2i, size: vec2i) -> f32 {
  return textureLoad(tex, pixelationClamp(coord, size), 0).w;
}

/** Zero where nothing was drawn, so callers can tell background from geometry. */
fn pixelationNormal(texel: vec4f) -> vec3f {
  let len = length(texel.xyz);

  if (len > 0.0) {
    return texel.xyz / len;
  }

  return vec3f(0.0);
}

/** Crease strength contributed by one neighbour. */
fn pixelationCrease(
  normalDepthTex: texture_2d<f32>,
  coord: vec2i,
  offset: vec2i,
  size: vec2i,
  distance: f32,
  normal: vec3f
) -> f32 {
  let neighbor = textureLoad(normalDepthTex, pixelationClamp(coord + offset, size), 0);
  let neighborNormal = pixelationNormal(neighbor);

  // Faces whose normals point closer to the bias direction yield, so a crease
  // is drawn once rather than on both of its sides.
  let bias = dot(normal - neighborNormal, vec3f(1.0));
  let biasIndicator = smoothstep(-0.01, 0.01, bias);

  // Only the nearer of the two pixels draws the crease, with a tolerance that
  // scales with distance so the same geometry creases at any range.
  let depthIndicator = saturate(sign(neighbor.w - distance + distance * 0.0015));

  return (1.0 - dot(normal, neighborNormal)) * depthIndicator * biasIndicator;
}
