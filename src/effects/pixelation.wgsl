// PSX-era pixelation.
//
// The scene is already rendered small and upscaled with a nearest filter, so
// this pass only has to draw the edges: neighbouring depths give silhouette
// outlines, neighbouring normals give interior creases.
//
// Every tap is an exact texel neighbour, and a nearest-filtered target carries
// no sampler, so the reads are `textureLoad` rather than `textureSample`.

fn pixelation(
  colorTex: texture_2d<f32>,
  depthTex: texture_depth_2d,
  normalTex: texture_2d<f32>,
  uv: vec2f,
  normalEdgeStrength: f32,
  depthEdgeStrength: f32
) -> vec4f {
  let size = vec2i(textureDimensions(colorTex));
  let coord = vec2i(uv * vec2f(size));

  let color = textureLoad(colorTex, pixelationClamp(coord, size), 0);
  let depth = pixelationDepth(depthTex, coord, size);
  let normal = pixelationNormal(normalTex, coord, size);

  let right = vec2i(1, 0);
  let up = vec2i(0, 1);

  // Depth edge: how much nearer the four neighbours are.
  var depthDiff = 0.0;
  depthDiff += saturate(pixelationDepth(depthTex, coord + right, size) - depth);
  depthDiff += saturate(pixelationDepth(depthTex, coord - right, size) - depth);
  depthDiff += saturate(pixelationDepth(depthTex, coord + up, size) - depth);
  depthDiff += saturate(pixelationDepth(depthTex, coord - up, size) - depth);
  let depthEdge = floor(smoothstep(0.01, 0.02, depthDiff) * 2.0) / 2.0;

  // Background pixels carry no normal, so they get no creases.
  var normalEdge = 0.0;
  if (length(normal) > 0.0) {
    var sum = 0.0;
    sum += pixelationCrease(depthTex, normalTex, coord, right, size, depth, normal);
    sum += pixelationCrease(depthTex, normalTex, coord, -right, size, depth, normal);
    sum += pixelationCrease(depthTex, normalTex, coord, up, size, depth, normal);
    sum += pixelationCrease(depthTex, normalTex, coord, -up, size, depth, normal);
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

fn pixelationDepth(tex: texture_depth_2d, coord: vec2i, size: vec2i) -> f32 {
  return textureLoad(tex, pixelationClamp(coord, size), 0);
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
  depth: f32,
  normal: vec3f
) -> f32 {
  let neighborDepth = pixelationDepth(depthTex, coord + offset, size);
  let neighborNormal = pixelationNormal(normalTex, coord + offset, size);

  // Faces whose normals point closer to the bias direction yield, so a crease
  // is drawn once rather than on both of its sides.
  let bias = dot(normal - neighborNormal, vec3f(1.0));
  let biasIndicator = smoothstep(-0.01, 0.01, bias);

  // Only the shallower of the two pixels draws the crease.
  let depthIndicator = saturate(sign((neighborDepth - depth) * 0.25 + 0.0025));

  return (1.0 - dot(normal, neighborNormal)) * depthIndicator * biasIndicator;
}
