/**
 * The camera model: a map from canvas pixels to world directions.
 *
 * Three families live here, all sharing one interface so a frame can be shot
 * through any of them without the rest of the engine noticing.
 *
 * **Rectilinear** is the honest baseline every shooter ships. One frustum, all
 * straight lines straight, and a peripheral magnification of sec²θ that makes
 * anything past ~100° unusable.
 *
 * **Isotropic** is the radial family `θ = atan(s·r)/s` — rectilinear at s = 1,
 * stereographic (conformal) at s = 0.5. No preferred axis, so pitching feels
 * like yawing, at the cost of bowing every straight line including verticals.
 *
 * **Cylindrical** is the interesting one, and the reason this file exists.
 * Screen x is a *constant* multiple of absolute azimuth and screen y a fixed
 * function of absolute elevation:
 *
 *     x = k·az                y = k·F(ε)
 *
 * Neither depends on where the camera is pointed, so the image is a fixed
 * panorama painted around the eye and mouse-look is a window sliding over it.
 * Yaw and pitch are *exact image translations* — nothing on screen deforms when
 * you look around, only when you walk. Meridians are vertical lines, so world
 * verticals stay dead straight at every pitch, and the horizon stays a straight
 * horizontal line.
 *
 * That is the endpoint, and on its own it is too much lens. Linear azimuth is
 * the hardest-bowing member of the family: a colonnade's beams sweep out to the
 * corners and the frame reads as a fisheye. So the azimuth map gets its own
 * dial, `straighten`, which bends it from linear towards tangent — 0 is the
 * rigid endpoint above, 0.5 is exactly the Panini projection, 1 is as straight
 * as the family gets. Because x still depends on azimuth alone, *every* value
 * keeps the verticals and the horizon straight; what it spends is yaw
 * rigidity, and only yaw's. Pitch is untouched at any setting, since y never
 * depends on where you are looking sideways — so the motion that made the
 * earlier world-anchored attempts sickening stays exactly rigid, and the one
 * every wide-angle game already swims under is where the straightening is paid
 * for.
 *
 * `straighten` only reparametrises x, though, and that leaves the frame still
 * reading as a barrel — because a level line running *across* the view sags by
 * `atan(tan e * cos u)`, which is geometry and identical at every value of it.
 * Removing that needs the vertical map to stop answering absolute elevation,
 * which is `upright`. Pitch survives it (both of the map's inputs are
 * pitch-invariant); yaw pays again. Measured on this scene at 110°, in canvas
 * pixels of departure from a rigid slide per 10 degrees turned:
 *
 *     straighten 0    upright 0        0 px    exactly rigid, hard barrel
 *     straighten 0.5  upright 0       51 px    corridors straighten, barrel stays
 *     straighten 0.5  upright 0.66   238 px    no barrel; the shipped default
 *     straighten 1    upright 1      435 px    about what a rectilinear frame does
 *
 * The panorama address in `anchor.wgsl` survives `straighten` exactly — drift
 * measured at 2e-13 px — and survives `upright` to about 2 px, which is a
 * quarter of a stroke at the engraving's default pitch.
 *
 * The vertical map is the one free choice. Parametrise it by
 *
 *     F(ε) = ∫₀^ε secᵅ(t) dt
 *
 * and three things follow. The integral diverges — putting the zenith at
 * infinity, where no finite frame can ever reach it — exactly when α ≥ 1. The
 * unique conformal member, the one where shapes never distort at all, is
 * α = 1, which is the Mercator projection. So the *least*-magnifying map that
 * makes the pole singularity unreachable is also the only distortion-free one:
 * α = 1 is a boundary case, not a tuning choice. α = 0 is equirectangular
 * (pole at finite y, reachable, and it smears when it arrives — this is the
 * failure mode that sinks naive world-anchored projections). α = 2 is the
 * central cylindrical projection, which draws every vertical strip in true
 * rectilinear perspective, so a facade keeps uniform floor heights all the way
 * up.
 *
 * That leaves one unavoidable cost, and it is topological rather than tunable.
 * Yaw-rigidity forces the zenith to be a *line* of length 2πk in the map, while
 * a proper zenith is a *point*, and a line cannot be glued to a point in the
 * plane. Every yaw-rigid projection therefore degenerates overhead: either it
 * smears (α < 1) or it runs to infinity (α ≥ 1). You cannot look straight up.
 * `maxEdgeZoom` is where that cost is priced — it caps the magnification the
 * frame's top and bottom edge may reach, and the pitch limit is *derived* from
 * it rather than being a hard-coded angle, so it survives changes of field of
 * view, aspect ratio and α.
 *
 * `F` has no closed form for general α, so both directions are tabulated once
 * per configuration. At α = 1 the table agrees with the closed form
 * `F = asinh(tan ε)`, `F⁻¹ = atan(sinh y)` to about 1e-9.
 */

import * as THREE from "three/webgpu";

export type LensMode = "rectilinear" | "cylindrical" | "isotropic";

/** Mode as the shader sees it. */
export const LENS_MODE_ID: Record<LensMode, number> = {
  rectilinear: 0,
  cylindrical: 1,
  isotropic: 2,
};

export interface LensSettings {
  mode: LensMode;
  /** Horizontal field of view, degrees. Azimuth span for cylindrical. */
  hfov: number;
  /** Cylindrical vertical exponent: 0 equirectangular, 1 Mercator, 2 central. */
  alpha: number;
  /** Isotropic parameter: 1 rectilinear, 0.5 stereographic. */
  isoS: number;
  /**
   * How much the cylindrical lens straightens its bowed horizontals, by
   * bending the azimuth map from linear towards tangent.
   *
   * 0 keeps `x = k·az`, the only mapping under which yaw is an exact image
   * translation — and the one that bows a lintel hardest. 0.5 is exactly the
   * Panini projection. 1 is a tangent azimuth, which is as straight as this
   * family gets. Verticals and the horizon stay straight at every value,
   * because x still depends on azimuth alone.
   */
  straighten: number;
  /**
   * How much the vertical map answers the *vertical-plane* elevation instead of
   * the absolute one, which is what straightens a horizontal running across the
   * view.
   *
   * With y a function of absolute elevation alone, a level line sags towards
   * the frame edges by `atan(tan e * cos u)` — pure geometry, and the reason a
   * cylindrical frame reads as a barrel however the azimuth is parametrised.
   * `straighten` cannot touch it: reparametrising x leaves the sag at the frame
   * edge exactly where it was. Feeding the map `tan e * (1 - v + v*sec u)`
   * bends it away instead — at 1 a line at constant depth is dead straight,
   * because `tan e * sec u` is its height over depth and does not vary along it.
   *
   * Pitch rigidity survives untouched. Both inputs — absolute elevation, and
   * azimuth relative to yaw — are unchanged by pitching, so a world point's map
   * height is too, and the frame still slides over it without deforming. What
   * this spends is yaw: turning now moves content vertically as well as
   * sideways, and the readout prices both together.
   */
  upright: number;
  /** Largest magnification permitted at the frame's top and bottom edge. */
  maxEdgeZoom: number;
}

/**
 * Table resolution. 4096 float32 entries is exactly 64 rows of WebGPU's 256
 * byte copy alignment, so the lookup uploads without padding.
 */
const TABLE = 4096;

/**
 * Rectilinear and isotropic cameras are attached to the head, so they have no
 * pole to run into; this is the usual "don't let the view invert" stop.
 */
const CAMERA_ATTACHED_PITCH_LIMIT = Math.PI / 2 - 0.008;

const WORLD_UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);

/** Below this the azimuth map is linear; the tangent form would divide by zero. */
const STRAIGHTEN_EPSILON = 1e-4;

/** Grid the yaw-swim readout samples the frame on. */
const SWIM_COLUMNS = 8;
const SWIM_ROWS = 5;

/** secᵅ, the magnification the vertical map applies at elevation ε. */
function verticalDensity(eps: number, alpha: number): number {
  return alpha === 0 ? 1 : Math.cos(eps) ** -alpha;
}

export class Projection {
  mode: LensMode = "cylindrical";
  alpha = 1;
  isoS = 0.72;
  straighten = 0;
  upright = 0;

  /**
   * Canvas pixels per radian at the frame centre. Cylindrical only, and it is
   * the scale of *both* axes there, so the middle of the frame is isotropic
   * whatever the azimuth map is doing further out.
   */
  k = 1;
  /** Canvas pixels per unit of the lens plane. Rectilinear and isotropic. */
  focal = 1;

  /** Largest elevation any pixel of the frame may reach. */
  epsMax = 1;
  /** Map coordinate of `epsMax`; the frame's y window never leaves ±this. */
  yMax = 1;
  /** Map coordinate the frame *centre* may reach, i.e. the pitch stop in y. */
  yLimit = 1;
  pitchLimit = CAMERA_ATTACHED_PITCH_LIMIT;

  width = 1;
  height = 1;

  /**
   * Both directions of the vertical map, as the GPU sees them: row 0 is ε
   * sampled uniformly in y over [0, yMax], row 1 is y sampled uniformly in ε
   * over [0, epsMax]. The shader needs both — the inverse to turn a pixel into
   * a ray, and the forward to turn a ray back into its address on the panorama
   * once `upright` has bent the two apart.
   */
  readonly table = new Float32Array(TABLE * 2);

  /**
   * y sampled uniformly in ε over [0, epsMax]. Double precision because it
   * never leaves the CPU — only the inverse is mirrored to the GPU, and only
   * that one has to live in a float32 texture.
   */
  private readonly forwardTable = new Float64Array(TABLE);

  // The head, as the lens sees it. Roll-free by construction: this camera has
  // no roll to give, so the basis is rebuilt from yaw and pitch alone.
  yaw = 0;
  pitch = 0;
  /** The frame's vertical window centre, in map units. Cylindrical only. */
  pitchY = 0;

  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly forward = new THREE.Vector3(0, 0, -1);

  private sinYaw = 0;
  private cosYaw = 1;

  private readonly probe = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private readonly before = new THREE.Vector2();
  private readonly after = new THREE.Vector2();
  private readonly swimScratch = new Float64Array((SWIM_COLUMNS + 1) * (SWIM_ROWS + 1) * 2);

  // `stepPitch` accumulates in map space and hands back the derived angle.
  // Remembering the pair means a held mouse never round-trips through the
  // tables, so the angle cannot drift over a long session.
  private cachedPitch = Number.NaN;
  private cachedY = 0;

  configure(settings: LensSettings, width: number, height: number): void {
    this.mode = settings.mode;
    this.alpha = settings.alpha;
    this.isoS = settings.isoS;
    this.width = width;
    this.height = height;

    const hfov = THREE.MathUtils.degToRad(settings.hfov);
    const s = settings.straighten;

    this.straighten = s;
    this.upright = settings.upright;
    // As s -> 0 this is width/hfov, so the two branches meet without a seam.
    this.k = s > STRAIGHTEN_EPSILON ? ((width / 2) * s) / Math.tan((s * hfov) / 2) : width / hfov;
    this.focal =
      settings.mode === "isotropic"
        ? ((width / 2) * settings.isoS) / Math.tan(settings.isoS * hfov * 0.5)
        : width / 2 / Math.tan(hfov * 0.5);

    this.buildTables(Math.acos(1 / Math.max(settings.maxEdgeZoom, 1.0001)));

    if (settings.mode === "cylindrical") {
      // The window is `height` tall in canvas pixels, so its centre may climb
      // until its edge reaches the magnification cap — and no further.
      this.yLimit = Math.max(this.yMax - height / 2 / this.k, 0);
      this.pitchLimit = this.inverseMap(this.yLimit);
    } else {
      this.yLimit = this.yMax;
      this.pitchLimit = CAMERA_ATTACHED_PITCH_LIMIT;
    }

    this.cachedPitch = Number.NaN;
    this.setView(this.yaw, THREE.MathUtils.clamp(this.pitch, -this.pitchLimit, this.pitchLimit));
  }

  setView(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.pitchY = pitch === this.cachedPitch ? this.cachedY : this.forwardMap(pitch);

    this.sinYaw = Math.sin(yaw);
    this.cosYaw = Math.cos(yaw);

    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);

    this.forward.set(-cp * this.sinYaw, sp, -cp * this.cosYaw);
    this.right.set(this.cosYaw, 0, -this.sinYaw);
    this.up.crossVectors(this.right, this.forward).normalize();
  }

  /**
   * Advances pitch by `delta`, measured in the lens's own rigid parameter:
   * radians for the head-attached families, map units for the cylindrical one
   * (where they coincide at the horizon). Yaw needs no such treatment — under
   * every lens here x is linear in azimuth at the frame centre, so a yaw step
   * is a canvas step already.
   */
  stepPitch(pitch: number, delta: number): number {
    if (this.mode !== "cylindrical") {
      return THREE.MathUtils.clamp(pitch + delta, -this.pitchLimit, this.pitchLimit);
    }

    const y = pitch === this.cachedPitch ? this.cachedY : this.forwardMap(pitch);
    const next = THREE.MathUtils.clamp(y + delta, -this.yLimit, this.yLimit);
    const result = this.inverseMap(next);

    this.cachedPitch = result;
    this.cachedY = next;

    return result;
  }

  /** y = F(ε). Odd in ε, so only the positive half is tabulated. */
  forwardMap(eps: number): number {
    const t = (Math.min(Math.abs(eps), this.epsMax) / this.epsMax) * (TABLE - 1);
    const i = Math.min(t | 0, TABLE - 2);
    const table = this.forwardTable;

    return Math.sign(eps) * (table[i]! + (table[i + 1]! - table[i]!) * (t - i));
  }

  /**
   * Canvas x offset → azimuth offset, and back.
   *
   * The same `atan(s·r)/s` shape the isotropic lens uses, applied to azimuth
   * alone. Because x still depends only on azimuth, every meridian is still a
   * vertical line: straightening the horizontals costs none of that.
   */
  azimuthAt(offsetX: number): number {
    const s = this.straighten;
    const t = offsetX / this.k;

    return s > STRAIGHTEN_EPSILON ? Math.atan(s * t) / s : t;
  }

  /**
   * The factor the vertical map applies at azimuth `u`: 1 where it reads
   * absolute elevation, `sec u` where it reads the vertical-plane one.
   */
  uprightScale(u: number): number {
    return this.upright > 0 ? 1 - this.upright + this.upright / Math.cos(u) : 1;
  }

  /** Undoes `uprightScale`, turning a map elevation back into a real one. */
  elevationAt(mapped: number, u: number): number {
    return this.upright > 0 ? Math.atan(Math.tan(mapped) / this.uprightScale(u)) : mapped;
  }

  offsetFor(azimuth: number): number {
    const s = this.straighten;

    return this.k * (s > STRAIGHTEN_EPSILON ? Math.tan(s * azimuth) / s : azimuth);
  }

  /**
   * How far a yaw step departs from a rigid translation, in canvas pixels per
   * ten degrees turned.
   *
   * This is the price of `straighten`, and the reason it is a dial rather than
   * a constant: at 0 it is exactly zero and the image slides without deforming,
   * and it climbs from there. Pitch is unaffected at any setting, since y never
   * depends on yaw — so what is traded away here is the rigidity of the motion
   * nobody complained about, and none of the rigidity of the one they did.
   */
  yawSwim(): number {
    if (this.mode !== "cylindrical") return Number.NaN;

    const step = THREE.MathUtils.degToRad(10);
    const shifts = this.swimScratch;
    const probe = this.probe;
    let meanX = 0;
    let meanY = 0;
    let count = 0;

    for (let iy = 0; iy <= SWIM_ROWS; iy++) {
      for (let ix = 0; ix <= SWIM_COLUMNS; ix++) {
        this.direction((this.width * ix) / SWIM_COLUMNS, (this.height * iy) / SWIM_ROWS, probe);

        const eps = Math.asin(THREE.MathUtils.clamp(probe.y, -1, 1));
        const az = Math.atan2(-probe.x, -probe.z);
        const slot = count * 2;

        this.projectWorld(az, eps, this.yaw, this.before);
        this.projectWorld(az, eps, this.yaw + step, this.after);

        shifts[slot] = this.after.x - this.before.x;
        shifts[slot + 1] = this.after.y - this.before.y;
        meanX += shifts[slot]!;
        meanY += shifts[slot + 1]!;
        count++;
      }
    }

    meanX /= count;
    meanY /= count;

    // The departure from a rigid slide, which is what actually reads as swim —
    // a common offset is just the world going past.
    let worst = 0;

    for (let i = 0; i < count; i++) {
      worst = Math.max(worst, Math.hypot(shifts[i * 2]! - meanX, shifts[i * 2 + 1]! - meanY));
    }

    return worst * 2;
  }

  /** Where a world direction lands, for an arbitrary yaw. */
  private projectWorld(az: number, eps: number, yaw: number, out: THREE.Vector2): void {
    const u = yaw - az;
    const mapped = Math.atan(Math.tan(eps) * this.uprightScale(u));

    out.set(
      this.width * 0.5 + this.offsetFor(u),
      this.height * 0.5 - (this.forwardMap(mapped) - this.pitchY) * this.k,
    );
  }

  /** ε = F⁻¹(y). */
  inverseMap(y: number): number {
    const t = (Math.min(Math.abs(y), this.yMax) / this.yMax) * (TABLE - 1);
    const i = Math.min(t | 0, TABLE - 2);
    const table = this.table;

    return Math.sign(y) * (table[i]! + (table[i + 1]! - table[i]!) * (t - i));
  }

  /**
   * The axis a tile covering `cellCentre` should be built around.
   *
   * A rectilinear frame already *is* a single plane, so every cell of it is an
   * exact crop and sharing the frame's own axis makes each tile a lossless
   * sub-frustum — the fit comes out at one tile pixel per canvas pixel with
   * nothing wasted. A bent lens has no such shared plane, and the best a tile
   * can do is face the cell it serves.
   *
   * This matters for more than tidiness: it is what makes the rectilinear
   * baseline cost and resolve exactly like an untiled render, so an A/B against
   * it compares projections rather than comparing resampling artefacts.
   */
  tileAxis(cellCentre: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.mode === "rectilinear" ? this.forward : cellCentre);
  }

  /**
   * Canvas pixel → world direction. The twin of `lensDirection` in
   * `lookup.wgsl`; the two must agree or tile seams open up, which is exactly
   * what the seam debug view is for.
   */
  direction(px: number, py: number, out: THREE.Vector3): THREE.Vector3 {
    const dx = px - this.width * 0.5;
    const dy = this.height * 0.5 - py;

    if (this.mode === "cylindrical") {
      const u = this.azimuthAt(dx);
      const eps = this.elevationAt(this.inverseMap(this.pitchY + dy / this.k), u);
      const ce = Math.cos(eps);
      const cu = ce * Math.cos(u);
      const su = ce * Math.sin(u);

      // f0 = (-sinYaw, 0, -cosYaw), r0 = (cosYaw, 0, -sinYaw): the yaw-only
      // frame. Pitch enters only through the window offset above, which is the
      // whole point — the ray fan is welded to the world, not to the head.
      return out.set(
        cu * -this.sinYaw + su * this.cosYaw,
        Math.sin(eps),
        cu * -this.cosYaw + su * -this.sinYaw,
      );
    }

    const sx = dx / this.focal;
    const sy = dy / this.focal;

    if (this.mode === "rectilinear") {
      return out
        .copy(this.forward)
        .addScaledVector(this.right, sx)
        .addScaledVector(this.up, sy)
        .normalize();
    }

    const r = Math.hypot(sx, sy);

    if (r < 1e-9) return out.copy(this.forward);

    const theta = Math.atan(this.isoS * r) / this.isoS;
    const radial = Math.sin(theta) / r;

    return out
      .copy(this.forward)
      .multiplyScalar(Math.cos(theta))
      .addScaledVector(this.right, sx * radial)
      .addScaledVector(this.up, sy * radial)
      .normalize();
  }

  /**
   * World direction → canvas pixel, the exact inverse of `direction`. Written
   * for hit-testing and readouts: under a nonlinear lens the reticle is still
   * the frame centre, but anything else on screen needs this to be found.
   */
  canvasFor(direction: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 {
    if (this.mode === "cylindrical") {
      const eps = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
      // Azimuth measured in the yaw-only frame, positive towards screen right.
      const along = direction.x * -this.sinYaw + direction.z * -this.cosYaw;
      const across = direction.x * this.cosYaw + direction.z * -this.sinYaw;
      const u = Math.atan2(across, along);
      const mapped = Math.atan(Math.tan(eps) * this.uprightScale(u));

      return out.set(
        this.width * 0.5 + this.offsetFor(u),
        this.height * 0.5 - (this.forwardMap(mapped) - this.pitchY) * this.k,
      );
    }

    const z = direction.dot(this.forward);
    const x = direction.dot(this.right);
    const y = direction.dot(this.up);

    if (this.mode === "rectilinear") {
      return out.set(this.width * 0.5 + (x / z) * this.focal, this.height * 0.5 - (y / z) * this.focal);
    }

    const theta = Math.acos(THREE.MathUtils.clamp(z, -1, 1));
    const lateral = Math.hypot(x, y);
    const r = lateral < 1e-9 ? 0 : Math.tan(this.isoS * theta) / this.isoS / lateral;

    return out.set(
      this.width * 0.5 + x * r * this.focal,
      this.height * 0.5 - y * r * this.focal,
    );
  }

  /**
   * The frame's true angular span, in degrees.
   *
   * Worth watching while you play: under a cylindrical lens the horizontal
   * azimuth span is fixed but the *arc* it subtends shrinks as `cos ε`, so
   * craning at a tower quietly hands you a telephoto. That is the intrinsic,
   * rigid dolly zoom the whole design is here for.
   */
  frameExtent(out: THREE.Vector2): THREE.Vector2 {
    const half = this.probe;
    const centre = this.centre;

    this.direction(this.width * 0.5, this.height * 0.5, centre);
    this.direction(this.width, this.height * 0.5, half);

    const horizontal = 2 * Math.acos(THREE.MathUtils.clamp(centre.dot(half), -1, 1));

    this.direction(this.width * 0.5, 0, half);

    const top = Math.asin(THREE.MathUtils.clamp(half.y, -1, 1));

    this.direction(this.width * 0.5, this.height, half);

    const bottom = Math.asin(THREE.MathUtils.clamp(half.y, -1, 1));

    return out.set(THREE.MathUtils.radToDeg(horizontal), THREE.MathUtils.radToDeg(top - bottom));
  }

  /** Magnification at the frame centre relative to the horizon. */
  centreZoom(): number {
    return this.mode === "cylindrical" ? 1 / Math.cos(this.pitch) : 1;
  }

  /** Direction of the world's up axis, for the horizon readout. */
  static get worldUp(): THREE.Vector3 {
    return WORLD_UP;
  }

  /**
   * Tabulates F and F⁻¹ over [0, epsMax].
   *
   * Composite Simpson, which at this step size is exact to about 1e-11 — the
   * integrand only reaches sec⁶ at the very top of the range, and h⁵ buries it.
   * The inverse is read off the same samples, so the two directions agree by
   * construction rather than by luck.
   */
  private buildTables(epsMax: number): void {
    const { alpha, forwardTable } = this;
    const h = epsMax / (TABLE - 1);
    let y = 0;

    forwardTable[0] = 0;

    for (let i = 1; i < TABLE; i++) {
      const a = (i - 1) * h;
      const b = i * h;

      y +=
        (h / 6) *
        (verticalDensity(a, alpha) +
          4 * verticalDensity((a + b) * 0.5, alpha) +
          verticalDensity(b, alpha));

      forwardTable[i] = y;
    }

    this.epsMax = epsMax;
    this.yMax = y;

    for (let i = 0; i < TABLE; i++) this.table[TABLE + i] = forwardTable[i]!;

    let cursor = 0;

    for (let j = 0; j < TABLE; j++) {
      const target = (j * y) / (TABLE - 1);

      while (cursor < TABLE - 2 && forwardTable[cursor + 1]! < target) cursor++;

      const y0 = forwardTable[cursor]!;
      const y1 = forwardTable[cursor + 1]!;
      const t = y1 > y0 ? (target - y0) / (y1 - y0) : 0;

      this.table[j] = (cursor + t) * h;
    }
  }
}
