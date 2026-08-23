// World normal and radial distance, resampled through the lens.
//
// Distance is *radial* — metres from the eye — not the tile's planar depth,
// which is a different quantity in every tile and would step at every seam.
// It is also the depth this camera should have been built on: for rays that fan
// in every direction, a spherical near clip is the only one that treats them
// alike.
//
// Normals are carried in world space. There is no single view basis to be
// relative to here — each tile has its own — and world normals have the useful
// side effect that a crease keeps its strength as the head turns.

fn lensResolveDepth(
  normalTex: texture_2d<f32>,
  depthTex: texture_depth_2d,
  tiles: texture_2d<f32>,
  verticalTable: texture_2d<f32>,
  fragCoord: vec2f,
  canvas: vec4f,
  view: vec4f,
  table: vec4f,
  shape: vec4f,
  camRight: vec3f,
  camUp: vec3f,
  camForward: vec3f,
  range: vec2f
) -> vec4f {
  let d = lensDirection(fragCoord, canvas, view, table, shape, camRight, camUp, camForward, verticalTable);
  let hit = lensTile(tiles, d, fragCoord, canvas, table);

  // Nearest for depth: averaging across a silhouette invents a surface in front
  // of the background and behind the foreground, which is the ghost an edge
  // pass would then outline.
  let depth = textureLoad(depthTex, vec2i(floor(hit.xy)), 0);
  let blended = lensBilinear(normalTex, hit.xy).xyz;
  let magnitude = sqrt(dot(blended, blended));

  // Zero length means nothing was drawn, which the edge pass reads as
  // background. Renormalising it would invent a normal for the sky.
  var normal = vec3f(0.0);
  if (magnitude > 1e-3) {
    normal = blended / magnitude;
  }

  return vec4f(normal, lensDistance(depth, hit.z, range));
}
