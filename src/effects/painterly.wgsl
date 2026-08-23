// Engraved tone: flat ink densities and crosshatch, drawn in panorama space.
//
// The marks matter less than where they live. Every coordinate here comes from
// `lensAnchor`, so the hatch is pinned to the world and keeps a constant size
// in pixels at the same time — a column keeps its own strokes as you turn your
// head, and they neither swim across it nor swell as you walk towards it. Wind
// `Weld` down to zero and the same shader becomes an ordinary screen-space
// filter, which crawls exactly the way every stylised renderer's does. That
// comparison is the point of the file.
//
// Tone is quantised before it is hatched, because a plate is inked at a few
// densities rather than a continuum, and because flat areas are what make the
// strokes read as marks rather than as noise. Two details matter and both were
// wrong the first time. The buffer is linear and unbounded here, so luminance
// is folded through `1 - exp(-l)` to approximate the tone that will actually be
// displayed after tone mapping — thresholds against a linear value fire far too
// eagerly. And the quantiser returns the *centre* of each band rather than its
// floor, because a floor sends the darkest band to zero and crushes every
// shadow in the frame to solid black.

fn painterly(
  colorTex: texture_2d<f32>,
  uv: vec2f,
  anchor: vec2f,
  spacing: f32,
  strength: f32,
  levels: f32,
  grain: f32
) -> vec4f {
  let size = vec2i(textureDimensions(colorTex));
  let coord = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - vec2i(1));

  var color = textureLoad(colorTex, coord, 0).rgb;

  let luminance = max(dot(color, vec3f(0.2126, 0.7152, 0.0722)), 0.0);
  let tone = painterlyDisplayTone(luminance);
  let stepped = (floor(tone * levels) + 0.5) / levels;

  // Rescale rather than replace, so the hue survives the tone quantisation.
  color = color * (stepped / max(tone, 1e-4));

  // A slow wobble off the same address keeps the rulings from looking machined
  // without letting them drift relative to the world.
  let jitter = painterlyNoise(anchor * 0.011) - 0.5;

  // Four plates at engraving angles. The pitches are deliberately not simple
  // ratios of one another, or the layers beat together into a dot screen
  // instead of reading as crossing rulings.
  //
  // The thresholds sit well below mid grey on purpose. Ink everywhere is a
  // screen door, not an engraving: the top two tone bands must come out as bare
  // paper, the next as a single ruling, and only the darkest as a crossing.
  var ink = 0.0;
  ink += painterlyHatch(anchor, 0.30, spacing * 1.00, stepped, 0.52, jitter);
  ink += painterlyHatch(anchor, 1.91, spacing * 1.27, stepped, 0.31, jitter);
  ink += painterlyHatch(anchor, 2.55, spacing * 0.83, stepped, 0.18, jitter);
  ink += painterlyHatch(anchor, 1.14, spacing * 1.61, stepped, 0.08, jitter);
  ink = clamp(ink, 0.0, 1.0) * strength;

  // Ink is dark and slightly warm, never black: a plate leaves paper showing
  // through even at its densest, and a crushed shadow is not a mark.
  color = mix(color, color * 0.16 + vec3f(0.012, 0.011, 0.014), ink);
  color = color * (1.0 + (painterlyNoise(anchor * 0.8) - 0.5) * grain);

  return vec4f(max(color, vec3f(0.0)), 1.0);
}

/**
 * One ruling. It exists only where the tone has fallen past this layer's
 * threshold, and thickens the further past it goes, which is how an engraver
 * gets a continuous ramp out of a fixed set of plates.
 */
fn painterlyHatch(
  p: vec2f,
  angle: f32,
  spacing: f32,
  tone: f32,
  threshold: f32,
  jitter: f32
) -> f32 {
  if (tone >= threshold) {
    return 0.0;
  }

  let direction = vec2f(cos(angle), sin(angle));
  let phase = dot(p, direction) / max(spacing, 1.0) + jitter * 0.35;
  let wave = abs(fract(phase) - 0.5) * 2.0;
  let depth = clamp((threshold - tone) / max(threshold, 1e-3), 0.0, 1.0);
  let width = 0.06 + 0.30 * depth;

  return 1.0 - smoothstep(width * 0.35, width, wave);
}

/**
 * Luminance as it will actually be seen.
 *
 * The buffer this reads is linear and unbounded — the pipeline tone maps at the
 * very end — so a threshold applied to it fires on tones that will be displayed
 * far brighter than they look here. This is the same filmic curve the renderer
 * finishes with, so the plate is inked against the picture rather than against
 * the intermediate. It assumes the scene's exposure is 1; turning exposure up
 * lifts the image without lifting the ink, which shows up as a frame that
 * quietly loses its darkest plate.
 */
fn painterlyDisplayTone(luminance: f32) -> f32 {
  let x = luminance;

  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

fn painterlyHash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);

  return fract((r.x + r.y) * r.x);
}

fn painterlyNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(painterlyHash(cell), painterlyHash(cell + vec2f(1.0, 0.0)), w.x),
    mix(painterlyHash(cell + vec2f(0.0, 1.0)), painterlyHash(cell + vec2f(1.0, 1.0)), w.x),
    w.y
  );
}
