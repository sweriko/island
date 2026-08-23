/**
 * Fitting perspective frusta to a nonlinear canvas.
 *
 * A rasterizer can only be handed a projective transform, so the frame is cut
 * into a grid of cells and each cell is shot with its own asymmetric frustum,
 * fitted per frame to exactly the directions that cell needs. A later pass
 * resamples them through the real lens.
 *
 * This is a stub behind a clean seam, and it is worth saying so plainly. A ray
 * or path tracer pays *nothing* for a nonlinear camera — the lens is just a
 * different ray formula. A GPU-driven micro-polygon rasterizer pays nothing
 * either, because its triangles are already pixel-sized. Only a fixed-function
 * rasterizer fed whole meshes has to fake it like this, and everything below —
 * the redundant scene submissions, the oversampling at high pitch — is the
 * price of that faking, not a property of the projection. What *does* transfer
 * is the fitting maths: the Jacobian computed here is precisely the pixel
 * density term a cluster LOD metric needs.
 *
 * Two things are fitted per cell, both exactly rather than by margin:
 *
 * **The frustum.** Every sample of the cell's canvas rectangle is projected
 * into the tile's frame and the extents are the bound of those, dilated by
 * exactly one texel so a bilinear tap at the cell boundary still lands inside.
 *
 * **The resolution.** The tile must never be magnified by the resample, in any
 * direction. That is `σ_min(J) ≥ 1` for the Jacobian `J` of canvas pixels to
 * tile pixels — stronger than matching the two axes separately, which would
 * miss a diagonal shortfall. The axes give a first estimate, then a single
 * uniform scale drives the worst singular value to exactly 1, which is exact
 * because scaling both focal lengths scales every singular value with them.
 *
 * When the atlas cannot hold the fitted size the tile is clamped and the
 * shortfall is reported rather than quietly blurred — a sandbox that lies
 * about its own sampling rate is worse than no sandbox.
 */

import * as THREE from "three/webgpu";

import type { Projection } from "./projection";

/** Ceiling on grid cells, and so on the rows of the description texture. */
export const MAX_TILES = 24;

/** RGBA texels of description per tile: three basis rows, extents, atlas rect. */
export const TILE_TEXELS = 5;

/** Subdivisions per cell edge. The fit samples the closed rectangle. */
const CELL_SAMPLES = 8;

/** Canvas pixels of central difference used for the Jacobian. */
const DIFFERENCE = 0.05;

/**
 * A perspective camera whose frustum is given directly as extents at unit
 * distance, because a fitted tile is asymmetric in both axes and `fov` cannot
 * express that.
 */
export class TileCamera extends THREE.PerspectiveCamera {
  extentLeft = -1;
  extentRight = 1;
  extentBottom = -1;
  extentTop = 1;

  override updateProjectionMatrix(): void {
    const n = this.near;

    this.projectionMatrix.makePerspective(
      this.extentLeft * n,
      this.extentRight * n,
      this.extentTop * n,
      this.extentBottom * n,
      n,
      this.far,
      this.coordinateSystem,
      this.reversedDepth,
    );

    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

export interface TilePlanStats {
  count: number;
  columns: number;
  rows: number;
  /** Tile pixels rasterised this frame. */
  pixels: number;
  /** Tile pixels divided by canvas pixels: what the faking costs. */
  overhead: number;
  /** Worst achieved tile density over canvas density. Below 1 is a shortfall. */
  sampleRatio: number;
  /** Widest angle any tile spans from its own axis. Past ~80° a tile is unfit. */
  halfAngle: number;
}

export class TilePlan {
  // Twelve cells holds the sampling ratio at or above 1 across the whole legal
  // pitch range on a 3072 atlas; coarser grids start magnifying once the frame
  // climbs, because a single tall tile cannot follow the vertical map's
  // magnification gradient.
  columns = 4;
  rows = 3;

  /**
   * Extra density asked of every tile, traded straight for edge quality.
   *
   * This is the only antialiasing in the pipeline. MSAA is not an option: it
   * would quadruple an atlas already measured in hundreds of megabytes, and
   * supersampling the tiles is strictly better anyway, since the resolve is
   * already a filtered minification.
   */
  supersample = 1.25;

  readonly cameras: TileCamera[] = [];
  readonly description = new Float32Array(MAX_TILES * TILE_TEXELS * 4);

  readonly stats: TilePlanStats = {
    count: 0,
    columns: 1,
    rows: 1,
    pixels: 0,
    overhead: 0,
    sampleRatio: 1,
    halfAngle: 0,
  };

  private atlasSize = 3072;

  // Scratch. The fit runs every frame and must not feed the collector.
  private readonly axis = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly basis = new THREE.Matrix4();
  private readonly point = new THREE.Vector2();
  private readonly plus = new THREE.Vector2();
  private readonly minus = new THREE.Vector2();
  private readonly jacobians = new Float32Array((CELL_SAMPLES + 1) * (CELL_SAMPLES + 1) * 4);

  constructor(private readonly maxTiles = MAX_TILES) {}

  setAtlasSize(size: number): void {
    this.atlasSize = size;
  }

  /** Atlas cell an individual tile is rendered into. Uses the resolved grid. */
  get cellWidth(): number {
    return Math.floor(this.atlasSize / this.stats.columns);
  }

  get cellHeight(): number {
    return Math.floor(this.atlasSize / this.stats.rows);
  }

  /**
   * Rebuilds every tile for this frame's view.
   *
   * `near` and `far` come from the scene camera so the tiles share one depth
   * range: the resample turns tile depth into radial distance, and that is only
   * a single quantity if every tile linearises the same way.
   */
  update(projection: Projection, eye: THREE.Vector3, near: number, far: number): void {
    const columns = Math.max(1, Math.min(this.columns, this.maxTiles));
    const rows = Math.max(1, Math.min(this.rows, Math.floor(this.maxTiles / columns)));
    const count = columns * rows;

    while (this.cameras.length < count) this.cameras.push(new TileCamera());

    const cellCanvasWidth = projection.width / columns;
    const cellCanvasHeight = projection.height / rows;
    const stats = this.stats;

    stats.count = count;
    stats.columns = columns;
    stats.rows = rows;
    stats.pixels = 0;
    stats.sampleRatio = Number.POSITIVE_INFINITY;
    stats.halfAngle = 0;

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        const camera = this.cameras[index]!;

        camera.near = near;
        camera.far = far;
        camera.position.copy(eye);

        this.fit(
          projection,
          index,
          column * cellCanvasWidth,
          row * cellCanvasHeight,
          cellCanvasWidth,
          cellCanvasHeight,
          column * this.cellWidth,
          row * this.cellHeight,
        );
      }
    }

    stats.overhead = stats.pixels / Math.max(projection.width * projection.height, 1);
  }

  /** Fits one cell, writing its camera and its row of the description texture. */
  private fit(
    projection: Projection,
    index: number,
    canvasX: number,
    canvasY: number,
    canvasWidth: number,
    canvasHeight: number,
    atlasX: number,
    atlasY: number,
  ): void {
    const camera = this.cameras[index]!;

    // The tile frame is the head's frame carried to the cell centre by the
    // shortest rotation. Building it from the world's up axis instead would go
    // singular for a cell that looks nearly straight up, which is exactly the
    // case this camera is most interesting in.
    projection.direction(canvasX + canvasWidth * 0.5, canvasY + canvasHeight * 0.5, this.dir);
    projection.tileAxis(this.dir, this.axis);
    this.rotation.setFromUnitVectors(projection.forward, this.axis);
    this.right.copy(projection.right).applyQuaternion(this.rotation);
    this.up.copy(projection.up).applyQuaternion(this.rotation);
    this.forward.copy(this.axis);

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    let focalX = 0;
    let focalY = 0;
    let minAxial = 1;
    let sample = 0;

    for (let iy = 0; iy <= CELL_SAMPLES; iy++) {
      const py = canvasY + (canvasHeight * iy) / CELL_SAMPLES;

      for (let ix = 0; ix <= CELL_SAMPLES; ix++) {
        const px = canvasX + (canvasWidth * ix) / CELL_SAMPLES;
        const axial = this.project(projection, px, py, this.point);

        minAxial = Math.min(minAxial, axial);
        left = Math.min(left, this.point.x);
        right = Math.max(right, this.point.x);
        bottom = Math.min(bottom, this.point.y);
        top = Math.max(top, this.point.y);

        this.project(projection, px + DIFFERENCE, py, this.plus);
        this.project(projection, px - DIFFERENCE, py, this.minus);

        const dxdx = (this.plus.x - this.minus.x) / (2 * DIFFERENCE);
        const dydx = (this.plus.y - this.minus.y) / (2 * DIFFERENCE);

        this.project(projection, px, py + DIFFERENCE, this.plus);
        this.project(projection, px, py - DIFFERENCE, this.minus);

        const dxdy = (this.plus.x - this.minus.x) / (2 * DIFFERENCE);
        const dydy = (this.plus.y - this.minus.y) / (2 * DIFFERENCE);

        const slot = sample * 4;

        this.jacobians[slot] = dxdx;
        this.jacobians[slot + 1] = dxdy;
        this.jacobians[slot + 2] = dydx;
        this.jacobians[slot + 3] = dydy;
        sample++;

        focalX = Math.max(focalX, 1 / Math.max(Math.abs(dxdx), 1e-12));
        focalY = Math.max(focalY, 1 / Math.max(Math.abs(dydy), 1e-12));
      }
    }

    // Drive the worst singular value to exactly one. Scaling both focal lengths
    // scales every singular value by the same factor, so this is one pass, not
    // an iteration.
    let worst = Number.POSITIVE_INFINITY;

    for (let i = 0; i < sample; i++) {
      const slot = i * 4;
      const a = focalX * this.jacobians[slot]!;
      const b = focalX * this.jacobians[slot + 1]!;
      const c = focalY * this.jacobians[slot + 2]!;
      const d = focalY * this.jacobians[slot + 3]!;
      const sum = a * a + b * b + c * c + d * d;
      const area = Math.abs(a * d - b * c);
      const largest = Math.sqrt(Math.max((sum + Math.sqrt(Math.max(sum * sum - 4 * area * area, 0))) * 0.5, 1e-24));

      worst = Math.min(worst, area / largest);
    }

    if (worst > 1e-9 && Number.isFinite(worst)) {
      focalX /= worst;
      focalY /= worst;
    }

    const neededX = focalX;
    const neededY = focalY;

    focalX *= this.supersample;
    focalY *= this.supersample;

    const spanX = Math.max(right - left, 1e-9);
    const spanY = Math.max(top - bottom, 1e-9);

    // Two texels of margin: the resample is bilinear, so a tap taken at the
    // very edge of the cell must still find a full neighbourhood inside.
    let width = Math.min(Math.ceil(spanX * focalX) + 2, this.cellWidth);
    let height = Math.min(Math.ceil(spanY * focalY) + 2, this.cellHeight);

    width = Math.max(width, 3);
    height = Math.max(height, 3);

    focalX = (width - 2) / spanX;
    focalY = (height - 2) / spanY;

    const stats = this.stats;

    stats.pixels += width * height;
    stats.sampleRatio = Math.min(stats.sampleRatio, focalX / neededX, focalY / neededY);
    stats.halfAngle = Math.max(stats.halfAngle, Math.acos(THREE.MathUtils.clamp(minAxial, -1, 1)));

    const dilatedLeft = left - 1 / focalX;
    const dilatedRight = right + 1 / focalX;
    const dilatedBottom = bottom - 1 / focalY;
    const dilatedTop = top + 1 / focalY;

    camera.extentLeft = dilatedLeft;
    camera.extentRight = dilatedRight;
    camera.extentBottom = dilatedBottom;
    camera.extentTop = dilatedTop;
    camera.updateProjectionMatrix();

    // three's cameras look down local -Z, so the basis columns are
    // (right, up, -forward).
    this.basis.makeBasis(this.right, this.up, this.back.copy(this.forward).negate());
    camera.quaternion.setFromRotationMatrix(this.basis);
    camera.updateMatrixWorld(true);

    const row = index * TILE_TEXELS * 4;
    const description = this.description;

    description[row] = this.right.x;
    description[row + 1] = this.right.y;
    description[row + 2] = this.right.z;
    description[row + 4] = this.up.x;
    description[row + 5] = this.up.y;
    description[row + 6] = this.up.z;
    description[row + 8] = this.forward.x;
    description[row + 9] = this.forward.y;
    description[row + 10] = this.forward.z;
    description[row + 12] = dilatedLeft;
    description[row + 13] = dilatedTop;
    description[row + 14] = 1 / (dilatedRight - dilatedLeft);
    description[row + 15] = 1 / (dilatedTop - dilatedBottom);
    description[row + 16] = atlasX;
    description[row + 17] = atlasY;
    description[row + 18] = width;
    description[row + 19] = height;
  }

  /** Canvas pixel into the current tile's frame. Returns the axial component. */
  private project(
    projection: Projection,
    px: number,
    py: number,
    out: THREE.Vector2,
  ): number {
    const d = projection.direction(px, py, this.dir);
    const axial = d.dot(this.forward);
    const inverse = 1 / Math.max(axial, 1e-6);

    out.set(d.dot(this.right) * inverse, d.dot(this.up) * inverse);

    return axial;
  }
}
