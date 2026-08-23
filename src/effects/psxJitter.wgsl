// PSX-era vertex wobble.
//
// The original hardware transformed vertices in fixed point with no
// sub-pixel precision, so geometry snapped to a coarse screen grid and
// shimmered as the camera moved. Project by hand, snap, then blend back
// toward the exact position so the effect can be dialled down.
//
// The grid is sized by the *viewport*, not the framebuffer. Clip space spans
// the viewport, so a lens that rasterises the frame as several tiles into one
// atlas would otherwise get a grid many times too coarse — and the snap would
// stop being a pixel grid at all.

fn psxJitter(
  projection: mat4x4<f32>,
  view: mat4x4<f32>,
  worldPosition: vec3f,
  viewportSize: vec2f,
  snapPixels: f32,
  strength: f32
) -> vec4f {
  let clip = projection * view * vec4f(worldPosition, 1.0);
  let grid = viewportSize / snapPixels;

  // Clip space to grid cells and back. `w * 2` keeps the perspective divide
  // intact, so the snap happens in screen space rather than clip space.
  let scale = clip.w * 2.0;
  let snapped = round(clip.xy / scale * grid) / grid * scale;

  return vec4f(mix(clip.xy, snapped, strength), clip.z, clip.w);
}
