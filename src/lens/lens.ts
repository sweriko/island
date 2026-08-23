/**
 * The lens: a camera that is a function rather than a matrix.
 *
 * Everything downstream of here consumes two buffers — colour, and world normal
 * with radial distance — that were shot through whatever projection the lens is
 * currently set to. Render styles never see the scene, only these; that seam is
 * what lets the camera be nonlinear without every effect having to know.
 *
 * A frame is two stages:
 *
 * 1. **Tiles.** The canvas is cut into a grid, each cell gets a perspective
 *    frustum fitted to exactly the directions it needs (see `tiles.ts`), and the
 *    scene is rasterised once per cell into a viewport of one shared atlas.
 * 2. **Resolve.** One fullscreen pass walks canvas pixels, evaluates the lens to
 *    get a world direction, finds which tile owns it and samples there.
 *
 * Stage 1 exists only because a fixed-function rasterizer cannot be handed a
 * nonlinear camera. Stage 2 *is* the camera, and it is the part that transfers:
 * it is the same ray-generation function a compute rasterizer or a ray tracer
 * would use directly, with no atlas and no tiles in sight.
 */

import * as THREE from "three/webgpu";
import { mrt, normalWorld, output, screenCoordinate, screenUV, texture, uniform } from "three/tsl";

import { shader } from "../effects/wgsl";
import anchorSource from "./anchor.wgsl?raw";
import commonSource from "./common.wgsl?raw";
import resolveColorSource from "./resolveColor.wgsl?raw";
import resolveDepthSource from "./resolveDepth.wgsl?raw";
import { LENS_MODE_ID, Projection, type LensSettings } from "./projection";
import { MAX_TILES, TILE_TEXELS, TilePlan } from "./tiles";

/** Each entry point carries its own copy of the shared lens maths. */
const withCommon = (entry: string): string => `${entry}
${commonSource}`;

type LensInputs = {
  tiles: THREE.Node;
  verticalTable: THREE.Node;
  fragCoord: THREE.Node;
  canvas: THREE.Node;
  view: THREE.Node;
  table: THREE.Node;
  shape: THREE.Node;
  camRight: THREE.Node;
  camUp: THREE.Node;
  camForward: THREE.Node;
  range: THREE.Node;
};

const resolveColorShader = shader<
  LensInputs & {
    colorTex: THREE.Node;
    depthTex: THREE.Node;
    eye: THREE.Node;
    sun: THREE.Node;
    air: THREE.Node;
    sunTint: THREE.Node;
    debug: THREE.Node;
  },
  "vec4"
>(withCommon(resolveColorSource));

const resolveDepthShader = shader<
  LensInputs & { normalTex: THREE.Node; depthTex: THREE.Node },
  "vec4"
>(withCommon(resolveDepthSource));

const anchorShader = shader<{
  uv: THREE.Node;
  canvas: THREE.Node;
  view: THREE.Node;
  table: THREE.Node;
  shape: THREE.Node;
  verticalTable: THREE.Node;
  weld: THREE.Node;
}, "vec2">(withCommon(anchorSource));

/** What a render style is handed instead of a scene. */
export interface LensSource {
  /**
   * Resampled colour as a bare texture, for styles that walk its texels.
   * Linear and un-tonemapped; the pipeline applies both at the very end.
   */
  readonly color: THREE.Node;
  /** Resampled world normal in `xyz`, radial distance in metres in `w`. */
  readonly normalDepth: THREE.Node;
  /** The same colour, sampled ready to hand straight to the pipeline. */
  readonly present: THREE.Node;
  /**
   * Where each fragment sits on the fixed panorama wrapped around the eye, in
   * canvas pixels. `weld` blends from the fragment's own position (0) to that
   * address (1); see `anchor.wgsl` for why the second one is worth having.
   */
  anchor(weld: THREE.Node): THREE.Node;
}

/**
 * The baseline, deliberately.
 *
 * A sandbox should not default to the thing it is testing. Rectilinear at 95°
 * is what everything else is measured against, and it is what the repo opens on
 * so that the curvilinear work has to earn its place rather than be assumed
 * into it. Switch Projection to cylindrical to run the experiment.
 */
export const DEFAULT_LENS: LensSettings = {
  mode: "rectilinear",
  hfov: 95,
  alpha: 1,
  isoS: 0.72,
  // Panini's own value. Linear azimuth is exactly rigid under yaw and bows a
  // colonnade hard enough to read as a fisheye; a tangent azimuth straightens
  // it and swims like any wide-angle lens. Half way is where the two stop
  // fighting, and it is not a coincidence that it is the projection a painter
  // arrived at looking at the same problem.
  straighten: 0.5,
  // A level line running across the view sags towards the frame edges by pure
  // geometry when the vertical map reads absolute elevation, and no amount of
  // azimuth straightening touches it — that sag is what reads as a barrel.
  // Two thirds of the way to the vertical-plane elevation removes most of it
  // and still leaves the turn far more rigid than any rectilinear frame.
  upright: 0.66,
  // A 4x cap on the frame edge puts the pitch stop near 64 degrees, which keeps
  // the fit healthy across everything the controller can reach. Raising it buys
  // more sky and costs sampling rate at the top of the travel — which is the
  // real trade this projection makes, exposed rather than hidden.
  maxEdgeZoom: 4,
};

export class Lens {
  readonly settings: LensSettings = { ...DEFAULT_LENS };
  readonly projection = new Projection();
  readonly plan = new TilePlan();

  /** Tints each tile so a mis-fitted seam is impossible to miss. */
  debugSeams = false;

  private atlasSize = 3072;

  /** Resolved buffer size as a fraction of the canvas; a style may shrink it. */
  private resolutionScale = 1;
  private normalsRequired = false;

  private width = 1;
  private height = 1;

  private readonly atlas: THREE.RenderTarget;
  private readonly resolvedColor: THREE.RenderTarget;
  private readonly resolvedNormalDepth: THREE.RenderTarget;

  private readonly inverseTable: THREE.DataTexture;
  private readonly tileTable: THREE.DataTexture;

  private readonly sceneMRT = mrt({ output, normal: normalWorld });

  private readonly canvasUniform = uniform(new THREE.Vector4(1, 1, 1, 1));
  private readonly viewUniform = uniform(new THREE.Vector4());
  private readonly tableUniform = uniform(new THREE.Vector4(1, 1, 1, 1));
  private readonly shapeUniform = uniform(new THREE.Vector4());
  private readonly rightUniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly upUniform = uniform(new THREE.Vector3(0, 1, 0));
  private readonly forwardUniform = uniform(new THREE.Vector3(0, 0, -1));
  private readonly rangeUniform = uniform(new THREE.Vector2(0.1, 900));
  private readonly debugUniform = uniform(new THREE.Vector2());
  private readonly eyeUniform = uniform(new THREE.Vector3());
  private readonly sunUniform = uniform(new THREE.Vector3(0.42, 0.58, 0.7).normalize());
  private readonly airUniform = uniform(new THREE.Vector4());
  private readonly sunTintUniform = uniform(new THREE.Vector4(1, 0.93, 0.84, 18));

  /**
   * The air, as four numbers: the scale height it thins over, how hard it
   * scatters by wavelength, how hard it scatters forwards, and how forwards.
   *
   * These are the whole atmosphere. Haze on a ridge and the colour of the sky
   * behind it come from the same coefficients, so tuning one cannot silently
   * disagree with the other — which is the failure mode of every fog-plus-
   * skybox pairing.
   */
  readonly air = { scaleHeight: 1400, rayleigh: 2.4e-4, mie: 0.9e-4, mieG: 0.76 };
  /** How bright the sun is, before tone mapping. */
  sunIntensity = 18;

  private readonly colorQuad: THREE.QuadMesh;
  private readonly normalQuad: THREE.QuadMesh;
  private readonly resolveMaterials: THREE.NodeMaterial[];

  readonly source: LensSource;

  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  constructor() {
    this.atlas = new THREE.RenderTarget(this.atlasSize, this.atlasSize, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });

    // MRT binds by texture name, so these are the keys `sceneMRT` writes to.
    this.atlas.textures[0]!.name = "output";
    this.atlas.textures[1]!.name = "normal";
    this.atlas.depthTexture = new THREE.DepthTexture(this.atlasSize, this.atlasSize);
    this.atlas.depthTexture.name = "depth";

    const resolvedOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    } as const;

    this.resolvedColor = new THREE.RenderTarget(1, 1, resolvedOptions);
    this.resolvedNormalDepth = new THREE.RenderTarget(1, 1, resolvedOptions);

    this.inverseTable = new THREE.DataTexture(
      this.projection.table,
      this.projection.table.length / 2,
      2,
      THREE.RedFormat,
      THREE.FloatType,
    );
    this.inverseTable.minFilter = THREE.NearestFilter;
    this.inverseTable.magFilter = THREE.NearestFilter;
    this.inverseTable.needsUpdate = true;

    this.tileTable = new THREE.DataTexture(
      this.plan.description,
      TILE_TEXELS,
      MAX_TILES,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.tileTable.minFilter = THREE.NearestFilter;
    this.tileTable.magFilter = THREE.NearestFilter;
    this.tileTable.needsUpdate = true;

    const shared = {
      tiles: texture(this.tileTable),
      verticalTable: texture(this.inverseTable),
      fragCoord: screenCoordinate,
      canvas: this.canvasUniform,
      view: this.viewUniform,
      table: this.tableUniform,
      shape: this.shapeUniform,
      camRight: this.rightUniform,
      camUp: this.upUniform,
      camForward: this.forwardUniform,
      range: this.rangeUniform,
    };

    const colorMaterial = new THREE.NodeMaterial();

    colorMaterial.name = "lens-resolve-color";
    colorMaterial.fragmentNode = resolveColorShader({
      ...shared,
      colorTex: texture(this.atlas.textures[0]!),
      depthTex: texture(this.atlas.depthTexture),
      eye: this.eyeUniform,
      sun: this.sunUniform,
      air: this.airUniform,
      sunTint: this.sunTintUniform,
      debug: this.debugUniform,
    });
    colorMaterial.depthTest = false;
    colorMaterial.depthWrite = false;

    const normalMaterial = new THREE.NodeMaterial();

    normalMaterial.name = "lens-resolve-normal-depth";
    normalMaterial.fragmentNode = resolveDepthShader({
      ...shared,
      normalTex: texture(this.atlas.textures[1]!),
      depthTex: texture(this.atlas.depthTexture),
    });
    normalMaterial.depthTest = false;
    normalMaterial.depthWrite = false;

    this.colorQuad = new THREE.QuadMesh(colorMaterial);
    this.normalQuad = new THREE.QuadMesh(normalMaterial);
    this.resolveMaterials = [colorMaterial, normalMaterial];

    this.source = {
      color: texture(this.resolvedColor.texture),
      normalDepth: texture(this.resolvedNormalDepth.texture),
      // Explicitly screen-relative rather than relying on the fullscreen quad's
      // own attribute, so the resolved buffer is read with the same top-left
      // origin the resolve pass wrote it with.
      present: texture(this.resolvedColor.texture, screenUV),
      anchor: (weld) =>
        anchorShader({
          uv: screenUV,
          canvas: this.canvasUniform,
          view: this.viewUniform,
          table: this.tableUniform,
          shape: this.shapeUniform,
          verticalTable: texture(this.inverseTable),
          weld,
        }),
    };
  }

  /** Points the atmosphere at the same sun the scene is lit by. */
  setSun(direction: THREE.Vector3): void {
    this.sunUniform.value.copy(direction).normalize();
  }

  /** Atlas edge in texels. Bigger means fewer tiles get their density clamped. */
  setAtlasSize(size: number): void {
    if (size === this.atlasSize) return;

    this.atlasSize = size;
    this.atlas.setSize(size, size);
    this.plan.setAtlasSize(size);
  }

  get currentAtlasSize(): number {
    return this.atlasSize;
  }

  /**
   * The scene is resolved at this fraction of the canvas. A style that renders
   * deliberately small — the pixelated one — sets it, and the lens then fits
   * its tiles to *that* grid rather than wasting rasterisation on detail the
   * style is about to throw away.
   */
  setResolutionScale(scale: number): void {
    if (scale === this.resolutionScale) return;

    this.resolutionScale = scale;
    this.resize(this.width, this.height);
  }

  /** Styles that read normals or distance must ask, or the pass is skipped. */
  requestNormals(required: boolean): void {
    this.normalsRequired = required;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    const w = Math.max(1, Math.round(this.width * this.resolutionScale));
    const h = Math.max(1, Math.round(this.height * this.resolutionScale));

    this.resolvedColor.setSize(w, h);
    this.resolvedNormalDepth.setSize(w, h);
    this.configure();
  }

  /** Rebuilds the projection for the current settings and resolved size. */
  configure(): void {
    this.plan.setAtlasSize(this.atlasSize);
    this.projection.configure(
      this.settings,
      this.resolvedColor.width,
      this.resolvedColor.height,
    );
    this.inverseTable.needsUpdate = true;
  }

  /**
   * Points the lens, and plans this frame's tiles.
   *
   * Yaw and pitch are read back out of the camera's own forward vector rather
   * than taken from the controller, so an inspection camera flying around on
   * orbit controls goes through the same lens as the player does. Roll is
   * dropped on the way in, because a cylindrical projection has an axis and
   * cannot be rolled — the honest cost of the design, stated where it bites.
   */
  update(camera: THREE.PerspectiveCamera): void {
    camera.getWorldPosition(this.eye);
    camera.getWorldDirection(this.forward);

    const yaw = Math.atan2(-this.forward.x, -this.forward.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(this.forward.y, -1, 1));

    this.setView(yaw, THREE.MathUtils.clamp(pitch, -this.projection.pitchLimit, this.projection.pitchLimit), camera.near, camera.far);
  }

  private setView(yaw: number, pitch: number, near: number, far: number): void {
    const projection = this.projection;

    projection.setView(yaw, pitch);
    this.plan.update(projection, this.eye, near, far);

    this.canvasUniform.value.set(projection.width, projection.height, projection.k, projection.focal);
    this.viewUniform.value.set(yaw, projection.pitchY, projection.isoS, LENS_MODE_ID[projection.mode]);
    this.tableUniform.value.set(
      projection.yMax,
      projection.table.length / 2,
      this.plan.stats.columns,
      this.plan.stats.rows,
    );
    this.shapeUniform.value.set(projection.straighten, projection.upright, projection.epsMax, 0);
    this.rightUniform.value.copy(projection.right);
    this.upUniform.value.copy(projection.up);
    this.forwardUniform.value.copy(projection.forward);
    this.rangeUniform.value.set(near, far);
    this.debugUniform.value.set(this.debugSeams ? 1 : 0, 0);
    this.eyeUniform.value.copy(this.eye);
    this.airUniform.value.set(this.air.scaleHeight, this.air.rayleigh, this.air.mie, this.air.mieG);
    this.sunTintUniform.value.w = this.sunIntensity;
  }

  /**
   * Rasterises every tile, then resolves them through the lens.
   *
   * The atlas is cleared once and each tile then draws into its own viewport
   * with clearing off. Clearing per tile would wipe the whole attachment —
   * WebGPU clears are a load operation on the target, not a viewport rectangle.
   */
  render(renderer: THREE.Renderer, scene: THREE.Scene): void {
    const previousTarget = renderer.getRenderTarget();
    const previousMRT = renderer.getMRT();
    const previousAutoClear = renderer.autoClear;
    const { cameras, description, stats } = this.plan;

    this.tileTable.needsUpdate = true;

    renderer.setRenderTarget(this.atlas);
    this.atlas.viewport.set(0, 0, this.atlasSize, this.atlasSize);
    this.atlas.scissor.set(0, 0, this.atlasSize, this.atlasSize);
    renderer.clear(true, true, false);

    renderer.autoClear = false;
    renderer.setMRT(this.sceneMRT);

    for (let i = 0; i < stats.count; i++) {
      const rect = i * TILE_TEXELS * 4 + 16;

      this.atlas.viewport.set(
        description[rect]!,
        description[rect + 1]!,
        description[rect + 2]!,
        description[rect + 3]!,
      );

      renderer.render(scene, cameras[i]!);
    }

    renderer.setMRT(previousMRT);
    renderer.autoClear = previousAutoClear;

    renderer.setRenderTarget(this.resolvedColor);
    this.colorQuad.render(renderer);

    if (this.normalsRequired) {
      renderer.setRenderTarget(this.resolvedNormalDepth);
      this.normalQuad.render(renderer);
    }

    renderer.setRenderTarget(previousTarget);
  }

  dispose(): void {
    this.atlas.dispose();
    this.atlas.depthTexture?.dispose();
    this.resolvedColor.dispose();
    this.resolvedNormalDepth.dispose();
    this.inverseTable.dispose();
    this.tileTable.dispose();
    for (const material of this.resolveMaterials) material.dispose();
  }
}
