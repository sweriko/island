// Lens maths shared by the passes that consume it.
//
// No entry point lives here. Each resolve concatenates this after its own
// entry, which keeps one copy of the projection per shader module — the CPU
// twin in `projection.ts` and this are the only two places the map exists, and
// they have to agree or tile seams open up.

/// Elevation from a map height. Row 0 of the table, sampled uniformly in y.
fn lensInverseMap(tex: texture_2d<f32>, y: f32, yMax: f32, size: f32) -> f32 {
  let t = clamp(abs(y) / yMax, 0.0, 1.0) * (size - 1.0);
  let base = floor(t);
  let i0 = i32(base);
  let i1 = min(i0 + 1, i32(size) - 1);

  return sign(y) * mix(
    textureLoad(tex, vec2i(i0, 0), 0).r,
    textureLoad(tex, vec2i(i1, 0), 0).r,
    t - base
  );
}

/// Map height from an elevation. Row 1, sampled uniformly in elevation.
fn lensForwardMap(tex: texture_2d<f32>, eps: f32, epsMax: f32, size: f32) -> f32 {
  let t = clamp(abs(eps) / epsMax, 0.0, 1.0) * (size - 1.0);
  let base = floor(t);
  let i0 = i32(base);
  let i1 = min(i0 + 1, i32(size) - 1);

  return sign(eps) * mix(
    textureLoad(tex, vec2i(i0, 1), 0).r,
    textureLoad(tex, vec2i(i1, 1), 0).r,
    t - base
  );
}

/// Azimuth offset for a canvas x offset, bent by `straighten`.
fn lensAzimuth(offsetX: f32, k: f32, straighten: f32) -> f32 {
  let t = offsetX / k;

  if (straighten > 1e-4) {
    return atan(straighten * t) / straighten;
  }

  return t;
}

/// Canvas pixel to world direction. The twin of `Projection.direction`.
fn lensDirection(
  fragCoord: vec2f,
  canvas: vec4f,
  view: vec4f,
  table: vec4f,
  shape: vec4f,
  camRight: vec3f,
  camUp: vec3f,
  camForward: vec3f,
  verticalTable: texture_2d<f32>
) -> vec3f {
  let dx = fragCoord.x - canvas.x * 0.5;
  let dy = canvas.y * 0.5 - fragCoord.y;

  // Rectilinear: one honest frustum, straight lines everywhere, sec² in the
  // corners.
  if (view.w < 0.5) {
    return normalize(camForward + camRight * (dx / canvas.w) + camUp * (dy / canvas.w));
  }

  // Cylindrical: x is a fixed function of absolute azimuth, y of absolute
  // elevation, so pitch enters only as the offset of the window and the frame
  // slides over a fixed panorama rather than deforming it.
  if (view.w < 1.5) {
    let u = lensAzimuth(dx, canvas.z, shape.x);
    var eps = lensInverseMap(verticalTable, view.y + dy / canvas.z, table.x, table.y);

    // Undo `upright`, which has the map answering the vertical-plane elevation
    // so that level lines across the view stop sagging.
    if (shape.y > 1e-4) {
      eps = atan(tan(eps) / (1.0 - shape.y + shape.y / cos(u)));
    }

    let ce = cos(eps);
    let along = ce * cos(u);
    let across = ce * sin(u);
    let sy = sin(view.x);
    let cy = cos(view.x);

    return vec3f(along * -sy + across * cy, sin(eps), along * -cy + across * -sy);
  }

  // Isotropic: θ = atan(s·r)/s. No preferred axis, and no straight line
  // survives it, verticals included.
  let sx = dx / canvas.w;
  let sy = dy / canvas.w;
  let r = sqrt(sx * sx + sy * sy);

  if (r < 1e-9) {
    return camForward;
  }

  let theta = atan(view.z * r) / view.z;
  let radial = sin(theta) / r;

  return normalize(camForward * cos(theta) + camRight * (sx * radial) + camUp * (sy * radial));
}

/// Atlas texel for a direction, plus 1/cos to the tile axis and the tile index.
fn lensTile(
  tiles: texture_2d<f32>,
  d: vec3f,
  fragCoord: vec2f,
  canvas: vec4f,
  table: vec4f
) -> vec4f {
  let ix = clamp(floor(fragCoord.x / (canvas.x / table.z)), 0.0, table.z - 1.0);
  let iy = clamp(floor(fragCoord.y / (canvas.y / table.w)), 0.0, table.w - 1.0);
  let index = i32(iy * table.z + ix);

  let basisRight = textureLoad(tiles, vec2i(0, index), 0).xyz;
  let basisUp = textureLoad(tiles, vec2i(1, index), 0).xyz;
  let basisForward = textureLoad(tiles, vec2i(2, index), 0).xyz;
  let extent = textureLoad(tiles, vec2i(3, index), 0);
  let rect = textureLoad(tiles, vec2i(4, index), 0);

  let axial = max(dot(basisForward, d), 1e-6);
  let sx = dot(basisRight, d) / axial;
  let sy = dot(basisUp, d) / axial;

  // The fit dilated each tile by a texel, so this clamp never binds; it is here
  // so a fit that somehow disagreed smears rather than reads its neighbour.
  let tx = clamp((sx - extent.x) * extent.z * rect.z, 1.0, rect.z - 1.0);
  let ty = clamp((extent.y - sy) * extent.w * rect.w, 1.0, rect.w - 1.0);

  return vec4f(rect.x + tx, rect.y + ty, 1.0 / axial, f32(index));
}

/// Bilinear by hand: the atlas holds independent tiles, and a hardware sampler
/// would happily walk across a boundary the fit guaranteed nothing about.
fn lensBilinear(tex: texture_2d<f32>, at: vec2f) -> vec4f {
  let q = at - 0.5;
  let base = floor(q);
  let f = q - base;
  let b = vec2i(base);

  return mix(
    mix(textureLoad(tex, b, 0), textureLoad(tex, b + vec2i(1, 0), 0), f.x),
    mix(textureLoad(tex, b + vec2i(0, 1), 0), textureLoad(tex, b + vec2i(1, 1), 0), f.x),
    f.y
  );
}

/// Radial distance in metres from a tile's own planar depth.
fn lensDistance(depth: f32, invAxial: f32, range: vec2f) -> f32 {
  let planar = (range.x * range.y) / max(range.y - depth * (range.y - range.x), 1e-6);

  return planar * invAxial;
}
