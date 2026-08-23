// Colour, resampled through the lens and put behind the air.
//
// The atmosphere lives here rather than in a pass of its own for one reason
// that is worth stating: it needs a *ray*, and this is where rays exist. The
// lens is a function from a pixel to a world direction, and once you have that
// function every distance-aware effect can be written against it directly —
// which is the whole claim the seam is supposed to make good on. A raster
// pipeline usually has to reconstruct a view vector from a matrix inverse and a
// depth buffer; here the camera hands it over.
//
// Single-scattering, exponential atmosphere, analytic along the ray. Optical
// depth through `exp(-h/H)` has a closed form for a straight line, so the march
// everyone writes for this is unnecessary:
//
//     tau = H/dy * (exp(-y0/H) - exp(-y1/H))
//
// Transmittance is per-channel and the inscattered colour is the scattering
// coefficients divided by the extinction, times `1 - T`. That ratio is what
// makes it self-consistent: what the air takes out of the beam is exactly what
// it puts back into the sky, so the haze on a distant ridge and the colour of
// the sky behind it come from one model instead of two guesses that have to be
// matched by hand.
//
// Background pixels get the same treatment with the path run to the horizon, so
// the sky *is* the atmosphere rather than a gradient painted to look like it.

fn lensResolveColor(
  colorTex: texture_2d<f32>,
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
  eye: vec3f,
  sun: vec3f,
  range: vec2f,
  air: vec4f,
  sunTint: vec4f,
  debug: vec2f
) -> vec4f {
  let d = lensDirection(fragCoord, canvas, view, table, shape, camRight, camUp, camForward, verticalTable);
  let hit = lensTile(tiles, d, fragCoord, canvas, table);

  var color = lensBilinear(colorTex, hit.xy).rgb;

  let depth = textureLoad(depthTex, vec2i(floor(hit.xy)), 0);
  let sky = depth >= 0.999999;
  // Nothing was drawn, so the path is the whole atmosphere rather than a
  // distance to a surface. Far is a poor stand-in for infinity but the optical
  // depth has saturated long before it.
  let t = select(lensDistance(depth, hit.z, range), range.y * 12.0, sky);

  let transmittance = lensTransmittance(eye, d, t, air);
  let inscatter = lensInscatter(d, sun, transmittance, air, sunTint);

  color = select(color * transmittance + inscatter, inscatter, sky);

  if (debug.x > 0.5) {
    color = mix(color, lensTint(fract(hit.w * 0.6180339887)), 0.4);
  }

  return vec4f(max(color, vec3f(0.0)), 1.0);
}

/// Rayleigh's wavelength dependence, as a shape. Strength comes from the dial.
const LENS_RAYLEIGH : vec3<f32> = vec3<f32>(0.19, 0.45, 1.0);

/**
 * Air along the ray, analytically.
 *
 * `air` carries the scale height, the Rayleigh strength, the Mie strength and
 * the Mie asymmetry. Heights are clamped at zero so a camera below the
 * waterline does not integrate a column of impossibly dense air.
 */
fn lensTransmittance(eye: vec3f, d: vec3f, t: f32, air: vec4f) -> vec3f {
  let h = air.x;
  let start = exp(-max(eye.y, 0.0) / h);
  var column: f32;

  if (abs(d.y) > 1e-4) {
    column = (h / d.y) * (start - exp(-max(eye.y + t * d.y, 0.0) / h));
  } else {
    column = start * t;
  }

  column = max(column, 0.0);

  return exp(-(LENS_RAYLEIGH * (air.y * column) + vec3f(air.z * column)));
}

/**
 * What the air puts back. Scattering over extinction times `1 - T` is the
 * standard single-scatter approximation, and it is what ties the haze to the
 * sky: both are this expression, at different path lengths.
 */
fn lensInscatter(d: vec3f, sun: vec3f, transmittance: vec3f, air: vec4f, sunTint: vec4f) -> vec3f {
  let mu = dot(d, sun);
  let g = air.w;
  let rayleighPhase = 0.0596831 * (1.0 + mu * mu);
  let miePhase = (1.0 - g * g) / (12.5663706 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));

  let scattered = LENS_RAYLEIGH * (air.y * rayleighPhase) + vec3f(air.z * miePhase);
  let extinction = LENS_RAYLEIGH * air.y + vec3f(air.z);

  return sunTint.rgb * sunTint.w * (scattered / max(extinction, vec3f(1e-9))) * (vec3f(1.0) - transmittance);
}

fn lensTint(hue: f32) -> vec3f {
  return 0.5 + 0.5 * cos(6.28318530718 * (hue + vec3f(0.0, 0.33, 0.67)));
}
