import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import Stats from "stats-gl";
import { Pane } from "tweakpane";
import type { FolderApi } from "tweakpane";

import { Lens } from "./lens/lens";
import type { LensMode } from "./lens/projection";
import { loadJolt } from "./physics/jolt";
import { PhysicsWorld } from "./physics/world";
import { Input } from "./player/input";
import { Player } from "./player/player";
import { RENDER_STYLES, type StyleId } from "./styles";
import { GameWorld } from "./world/world";

const MAX_PIXEL_RATIO = 2;

/** A frame longer than this is a stall, not a slow frame; do not integrate it. */
const MAX_FRAME_DELTA = 0.25;

const STYLE_OPTIONS = Object.fromEntries(
  Object.entries(RENDER_STYLES).map(([id, style]) => [style.label, id]),
) as Record<string, StyleId>;

const LENS_OPTIONS: Record<string, LensMode> = {
  "Cylindrical (world axis)": "cylindrical",
  "Rectilinear (baseline)": "rectilinear",
  "Isotropic (head axis)": "isotropic",
};

type CameraMode = "play" | "orbit";

/**
 * A renderer that targets WebGPU and nothing else.
 *
 * `WebGPURenderer` always installs a WebGL 2 fallback backend, which could only
 * ever produce broken output for the raw WGSL in `effects/`. Building the
 * WebGPU backend directly leaves no fallback to reach for, so `init()` rejects
 * when WebGPU is unavailable and the caller can say so plainly. The two
 * properties below are all `WebGPURenderer` adds over the base renderer.
 */
class WebGPUOnlyRenderer extends THREE.Renderer {
  override library = new THREE.StandardNodeLibrary();

  readonly isWebGPURenderer = true;

  constructor(parameters: THREE.WebGPURendererParameters) {
    super(new THREE.WebGPUBackend(parameters), parameters);
  }
}

/** A stats-gl panel that rescales itself to the peak value seen so far. */
function autoScalingPanel(stats: Stats, name: string, fg: string, bg: string) {
  const panel = stats.addPanel(new Stats.Panel(name, fg, bg));
  let peak = 1;

  return (value: number): void => {
    peak = Math.max(peak, value);
    panel.update(value, peak * 1.15, 0);
    panel.updateGraph(value, peak * 1.15);
  };
}

export class App {
  private readonly renderer = new WebGPUOnlyRenderer({
    antialias: true,
    outputBufferType: THREE.HalfFloatType,
    trackTimestamp: true,
  });

  /**
   * The scene camera is a position and an orientation, nothing more. Field of
   * view belongs to the lens now — this camera's own projection matrix is never
   * used to draw anything, only its near and far range, which the tiles share.
   */
  // Far enough for the range at five kilometres. Near is as far out as the
  // character's own radius allows, because the depth buffer's precision is
  // spent almost entirely on the first metre otherwise.
  private readonly camera = new THREE.PerspectiveCamera(72, 1, 0.25, 8000);
  private readonly lens = new Lens();
  private readonly pipeline = new THREE.RenderPipeline(this.renderer);
  private readonly timer = new THREE.Timer();
  private readonly controls: OrbitControls;
  private readonly input: Input;
  private readonly crosshair = buildCrosshair();

  private readonly stats = new Stats({ trackGPU: true });
  private readonly pane: Pane;
  private readonly styleFolders = new Map<StyleId, FolderApi>();
  private readonly reportTriangles: (value: number) => void;
  private readonly reportDrawCalls: (value: number) => void;

  private readonly resizeObserver = new ResizeObserver(() => this.resize());

  // Built by `init()`; the frame loop only starts once all three exist.
  private physics: PhysicsWorld | null = null;
  private world: GameWorld | null = null;
  private player: Player | null = null;

  private hasTimestamps = false;

  private readonly settings = {
    style: "basic" as StyleId,
    camera: "play" as CameraMode,
    pixelRatio: Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
    atlas: 3072,
  };

  /**
   * What the lens is actually doing, in numbers.
   *
   * Two of these decide whether the camera is honest. `Sampling` is the worst
   * ratio of tile density to canvas density anywhere on screen: below 1.00 the
   * atlas could not hold the fit and part of the frame is being magnified, so
   * the picture is softer than the projection says it should be. `Tile cost` is
   * the price of faking a nonlinear camera on a rasterizer, and is exactly the
   * number that goes to zero in a ray-traced or micro-polygon pipeline.
   */
  private readonly readout = {
    trueFov: "—",
    pitch: "—",
    centreZoom: "—",
    yawSwim: "—",
    tiles: "—",
    cost: "—",
    sampling: "—",
  };

  private readonly extent = new THREE.Vector2();

  constructor(private readonly container: HTMLElement) {
    this.renderer.domElement.className = "app__canvas";
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enabled = false;

    this.input = new Input(this.renderer.domElement);
    this.input.onLockChange = (locked) => {
      this.crosshair.classList.toggle("crosshair--visible", locked);
    };

    this.timer.connect(document);

    this.stats.dom.classList.add("ui-stats");
    this.reportTriangles = autoScalingPanel(this.stats, "TRIS", "#84fff7", "#08262d");
    this.reportDrawCalls = autoScalingPanel(this.stats, "CALLS", "#ffc171", "#34210b");

    const paneHost = document.createElement("div");

    paneHost.className = "ui-pane";
    this.pane = new Pane({ container: paneHost, title: "Controls" });

    this.container.append(this.renderer.domElement, this.crosshair, this.stats.dom, paneHost);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    await this.stats.init(this.renderer);
    this.hasTimestamps = this.renderer.hasFeature("timestamp-query");

    // Physics has to exist before the level does: the terrain's render mesh is
    // read back out of its own collider, so there is nothing to build until
    // Jolt can build the shape.
    const jolt = await loadJolt();

    this.physics = new PhysicsWorld(jolt);
    this.world = new GameWorld(this.physics);

    await this.world.load();
    this.physics.optimize();

    this.player = new Player(
      this.physics,
      this.input,
      this.camera,
      this.lens.projection,
      this.world.spawn,
    );

    this.lens.setAtlasSize(this.settings.atlas);
    this.lens.setSun(this.world.sunDirection.value);

    this.buildPane();
    this.setStyle(this.settings.style);
    this.setCameraMode(this.settings.camera);

    this.resize();
    await this.renderer.compileAsync(this.world.scene, this.camera);

    this.resizeObserver.observe(this.container);
    this.renderer.setAnimationLoop(this.animate);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();

    this.timer.dispose();
    this.controls.dispose();
    this.input.dispose();
    this.pane.dispose();
    this.stats.dispose();

    this.lens.dispose();
    this.pipeline.dispose();

    this.player?.dispose();
    this.world?.dispose();
    // Jolt owns WASM memory that no garbage collector will reclaim, so the
    // simulation must be torn down last and explicitly.
    this.physics?.dispose();

    this.renderer.dispose();
    this.container.replaceChildren();
  }

  private setStyle(id: StyleId): void {
    const style = RENDER_STYLES[id];

    this.settings.style = id;
    this.world?.setVertexNode(style.vertexNode);
    this.lens.requestNormals(style.needsNormalDepth);
    this.lens.setResolutionScale(style.resolutionScale());

    for (const [folderId, folder] of this.styleFolders) folder.hidden = folderId !== id;

    this.pipeline.outputNode = style.createOutput(this.lens.source);
    this.pipeline.needsUpdate = true;
  }

  /**
   * Orbit is an inspection mode, not a second way to play: it exists so the
   * scene can be looked at from outside the player's head while the simulation
   * keeps running underneath. It goes through the same lens, because a camera
   * that only some cameras can use is not a camera.
   */
  private setCameraMode(mode: CameraMode): void {
    const playing = mode === "play";

    this.settings.camera = mode;
    this.controls.enabled = !playing;
    this.input.autoLock = playing;

    if (playing) return;

    this.input.exitLock();

    if (this.player) {
      this.controls.target.copy(this.player.eye);
      this.camera.position.copy(this.player.eye).add(ORBIT_OFFSET);
      this.controls.update();
    }
  }

  private buildPane(): void {
    const world = this.world;
    const physics = this.physics;
    const player = this.player;

    if (!world || !physics || !player) return;

    this.pane
      .addBinding(this.settings, "style", { label: "Style", options: STYLE_OPTIONS })
      .on("change", ({ value }) => this.setStyle(value));
    this.pane
      .addBinding(this.settings, "camera", {
        label: "Camera",
        options: { "First person": "play", "Orbit (inspect)": "orbit" },
      })
      .on("change", ({ value }) => this.setCameraMode(value));

    for (const id of Object.keys(RENDER_STYLES) as StyleId[]) {
      const style = RENDER_STYLES[id];

      if (style.controls.length === 0) continue;

      const folder = this.pane.addFolder({ title: style.label });

      for (const { label, uniform, min, max, step } of style.controls) {
        // Tweakpane drives the TSL uniform's `.value` directly — no mirrored state.
        folder.addBinding(uniform, "value", { label, min, max, step });
      }

      this.styleFolders.set(id, folder);
    }

    this.buildLensPane();

    const movement = this.pane.addFolder({ title: "Player", expanded: false });

    movement.addBinding(player.tuning, "lookSensitivity", {
      label: "Sensitivity",
      min: 0.0004,
      max: 0.006,
      step: 0.0001,
    });
    movement.addBinding(player.tuning, "walkSpeed", { label: "Walk", min: 1, max: 12, step: 0.1 });
    movement.addBinding(player.tuning, "sprintSpeed", {
      label: "Sprint",
      min: 1,
      max: 16,
      step: 0.1,
    });
    movement.addBinding(player.tuning, "jumpHeight", {
      label: "Jump",
      min: 0.2,
      max: 3,
      step: 0.05,
    });
    movement.addBinding(player.tuning, "airAccel", { label: "Air accel", min: 0, max: 40, step: 1 });
    movement.addBinding(player.tuning, "friction", { label: "Friction", min: 0, max: 20, step: 0.5 });
    movement.addButton({ title: "Respawn" }).on("click", () => player.respawn());

    const simulation = this.pane.addFolder({ title: "Physics", expanded: false });

    simulation.addBinding(physics, "rate", {
      label: "Tick rate",
      options: { "60 Hz": 60, "90 Hz": 90, "120 Hz": 120, "144 Hz": 144 },
    });
    simulation.addBinding(physics, "gravity", { label: "Gravity", min: 5, max: 40, step: 0.5 });

    const scene = this.pane.addFolder({ title: "Scene", expanded: false });

    scene.addBinding(this.renderer, "toneMappingExposure", {
      label: "Exposure",
      min: 0.5,
      max: 2,
      step: 0.05,
    });
    scene.addBinding(world.sky, "intensity", { label: "Sky", min: 0, max: 2, step: 0.05 });
    scene.addBinding(world.sun, "intensity", { label: "Sun", min: 0, max: 6, step: 0.1 });
    scene.addBinding(world, "spin", { label: "Spin", min: 0, max: 2, step: 0.01 });
    scene
      .addBinding(this.settings, "pixelRatio", {
        label: "Pixel ratio",
        min: 0.5,
        max: MAX_PIXEL_RATIO,
        step: 0.1,
      })
      .on("change", () => this.resize());
  }

  private buildLensPane(): void {
    const lens = this.lens;
    const reconfigure = (): void => lens.configure();

    const folder = this.pane.addFolder({ title: "Lens" });

    folder
      .addBinding(lens.settings, "mode", { label: "Projection", options: LENS_OPTIONS })
      .on("change", reconfigure);
    folder
      .addBinding(lens.settings, "hfov", { label: "Horizontal FOV", min: 50, max: 170, step: 1 })
      .on("change", reconfigure);
    folder
      .addBinding(lens.settings, "alpha", {
        label: "Vertical map α",
        min: 0,
        max: 2,
        step: 0.05,
      })
      .on("change", reconfigure);
    folder
      .addBinding(lens.settings, "straighten", {
        label: "Straighten",
        min: 0,
        max: 1,
        step: 0.01,
      })
      .on("change", reconfigure);
    folder
      .addBinding(lens.settings, "upright", { label: "Level lines", min: 0, max: 1, step: 0.01 })
      .on("change", reconfigure);
    folder
      .addBinding(lens.settings, "isoS", { label: "Isotropic s", min: 0.2, max: 1, step: 0.01 })
      .on("change", reconfigure);
    folder
      .addBinding(lens.settings, "maxEdgeZoom", {
        label: "Edge zoom cap",
        min: 1.5,
        max: 12,
        step: 0.25,
      })
      .on("change", reconfigure);

    const air = this.pane.addFolder({ title: "Air" });

    air.addBinding(lens.air, "scaleHeight", { label: "Scale height", min: 200, max: 5000, step: 50 });
    air.addBinding(lens.air, "rayleigh", {
      label: "Molecular",
      min: 0,
      max: 0.001,
      step: 0.00001,
    });
    air.addBinding(lens.air, "mie", { label: "Aerosol", min: 0, max: 0.001, step: 0.00001 });
    air.addBinding(lens.air, "mieG", { label: "Forwardness", min: 0, max: 0.95, step: 0.01 });
    air.addBinding(lens, "sunIntensity", { label: "Sun", min: 0, max: 60, step: 0.5 });

    const raster = this.pane.addFolder({ title: "Raster (stub)", expanded: false });

    raster.addBinding(lens.plan, "columns", { label: "Tile columns", min: 1, max: 6, step: 1 });
    raster.addBinding(lens.plan, "rows", { label: "Tile rows", min: 1, max: 4, step: 1 });
    raster.addBinding(lens.plan, "supersample", {
      label: "Supersample",
      min: 1,
      max: 2,
      step: 0.05,
    });
    raster
      .addBinding(this.settings, "atlas", {
        label: "Atlas",
        options: { "2048²": 2048, "3072²": 3072, "4096²": 4096 },
      })
      .on("change", ({ value }) => lens.setAtlasSize(value));
    raster.addBinding(lens, "debugSeams", { label: "Tint tiles" });

    const readouts = this.pane.addFolder({ title: "Readout" });

    readouts.addBinding(this.readout, "trueFov", { label: "True FOV", readonly: true });
    readouts.addBinding(this.readout, "pitch", { label: "Pitch", readonly: true });
    readouts.addBinding(this.readout, "centreZoom", { label: "Centre zoom", readonly: true });
    readouts.addBinding(this.readout, "yawSwim", { label: "Yaw swim", readonly: true });
    readouts.addBinding(this.readout, "tiles", { label: "Tiles", readonly: true });
    readouts.addBinding(this.readout, "cost", { label: "Tile cost", readonly: true });
    readouts.addBinding(this.readout, "sampling", { label: "Sampling", readonly: true });
  }

  private readonly resize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.renderer.setSize(width, height);

    // The lens works in drawing-buffer pixels, which is what the resolve pass
    // and the tile fit are both measured in.
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());

    this.lens.resize(buffer.x, buffer.y);
  };

  private updateReadout(): void {
    const { projection, plan } = this.lens;
    const stats = plan.stats;

    projection.frameExtent(this.extent);

    this.readout.trueFov = `${this.extent.x.toFixed(0)}° × ${this.extent.y.toFixed(0)}°`;
    this.readout.pitch = `${THREE.MathUtils.radToDeg(projection.pitch).toFixed(1)}° / ${THREE.MathUtils.radToDeg(projection.pitchLimit).toFixed(0)}°`;
    this.readout.centreZoom = `${projection.centreZoom().toFixed(2)}×`;

    const swim = projection.yawSwim();

    this.readout.yawSwim = Number.isNaN(swim) ? "—" : `${swim.toFixed(1)} px / 10°`;
    this.readout.tiles = `${stats.columns}×${stats.rows}, ${THREE.MathUtils.radToDeg(stats.halfAngle).toFixed(0)}° half`;
    this.readout.cost = `${(stats.pixels / 1e6).toFixed(2)} Mpx, ${stats.overhead.toFixed(2)}×`;
    this.readout.sampling =
      stats.sampleRatio >= 0.999
        ? `${stats.sampleRatio.toFixed(2)}× ok`
        : `${stats.sampleRatio.toFixed(2)}× SHORT`;
  }

  private readonly animate = (timestamp?: number): void => {
    const { physics, world, player } = this;

    if (!physics || !world || !player) return;

    const delta = Math.min(this.timer.update(timestamp).getDelta(), MAX_FRAME_DELTA);
    const playing = this.settings.camera === "play" && this.input.isLocked;

    // Aim first: the tick below steers with the yaw the player is holding
    // *now*, so turning and moving cannot disagree by a frame.
    player.frameUpdate(playing);

    physics.step(
      delta,
      (tickDelta) => player.tick(tickDelta, playing),
      () => world.course.captureState(),
    );

    world.update(delta);
    world.sync(physics.alpha);

    const firstPerson = this.settings.camera === "play";

    player.applyCamera(physics.alpha, delta, firstPerson);
    if (!firstPerson) this.controls.update();

    world.focusShadows(firstPerson ? player.eye : this.controls.target);
    world.beginFrame();

    this.lens.setResolutionScale(RENDER_STYLES[this.settings.style].resolutionScale());
    this.lens.update(this.camera);
    this.lens.render(this.renderer, world.scene);
    this.pipeline.render();

    // stats-gl reads `info.render.timestamp`, which only lands once resolved.
    if (this.hasTimestamps) void this.renderer.resolveTimestampsAsync();

    const { drawCalls, triangles } = this.renderer.info.render;

    this.reportTriangles(triangles);
    this.reportDrawCalls(drawCalls);
    this.stats.update();
    this.updateReadout();

    this.input.endFrame();
  };
}

const ORBIT_OFFSET = new THREE.Vector3(7, 5, 7);

/**
 * The crosshair, shown only while the pointer is locked. It sits over the
 * canvas with pointer events off so it cannot swallow the click that grabs the
 * pointer in the first place.
 */
function buildCrosshair(): HTMLElement {
  const element = document.createElement("div");

  element.className = "crosshair";

  return element;
}
