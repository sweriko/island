// The panorama coordinate of a canvas pixel.
//
// This is the payoff of a world-anchored vertical map, and it is a thing no
// ordinary camera can offer. Because the cylindrical lens writes screen y as a
// fixed function of *absolute* elevation and screen x as a fixed function of
// *absolute* azimuth, there is a single metric image plane wrapped around the
// eye that every frame is a window onto. A point of the world has one address
// on it, forever, no matter where the head is pointed.
//
// So an effect indexed by this coordinate instead of by the fragment's own
// position is welded to the world while keeping a *constant size in pixels*.
// Screen-space marks slide off whatever they were drawn on the moment you
// turn; world-space marks stay put but swell and shrink with distance. A
// panorama-space mark does neither. That third option only exists because the
// projection is shift-invariant, and it is the whole reason to accept a lens
// that bows its horizontals.
//
// `weld` blends between the fragment's own position and its panorama address,
// so the difference can be watched rather than argued about. The other two lens
// modes have no metric panorama to anchor to — they simply return the fragment,
// which is itself the demonstration.
//
// One wrinkle: with `upright` above zero the map no longer reads absolute
// elevation, so a pixel's map height is not an address — it moves as you turn.
// The true elevation has to be recovered and put back through the forward map,
// which is why this needs the table at all.
//
// Parameters, packed as elsewhere: canvas is width, height, centre scale k and
// focal; view is yaw, the window centre in map units, isotropic s and mode;
// shape carries the azimuth straightening. No line comments inside the
// parameter list — three re-emits it on one line.

fn lensAnchor(
  uv: vec2f,
  canvas: vec4f,
  view: vec4f,
  table: vec4f,
  shape: vec4f,
  verticalTable: texture_2d<f32>,
  weld: f32
) -> vec2f {
  let frag = uv * canvas.xy;

  if (view.w < 0.5 || view.w > 1.5) {
    return frag;
  }

  let dx = frag.x - canvas.x * 0.5;
  let dy = canvas.y * 0.5 - frag.y;
  let t = dx / canvas.z;

  var u = t;
  if (shape.x > 1e-4) {
    u = atan(shape.x * t) / shape.x;
  }

  // Absolute azimuth is yaw − u. The map height is already the address when the
  // vertical map reads absolute elevation; when it does not, undo the bend and
  // put the real elevation back through the forward map. Both are scaled by k
  // so the address is in canvas pixels, which is what keeps a mark's size fixed.
  let mapped = canvas.z * view.y + dy;
  var height = mapped;

  if (shape.y > 1e-4) {
    let effective = lensInverseMap(verticalTable, mapped / canvas.z, table.x, table.y);
    let real = atan(tan(effective) / (1.0 - shape.y + shape.y / cos(u)));

    height = canvas.z * lensForwardMap(verticalTable, real, shape.z, table.y);
  }

  return mix(frag, vec2f(canvas.z * (view.x - u), height), weld);
}
