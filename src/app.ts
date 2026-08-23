import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import Stats from "stats-gl";
import { Pane } from "tweakpane";
import type { FolderApi } from "tweakpane";

import { loadJolt } from "./physics/jolt";
import { PhysicsWorld } from "./physics/world";
import { Input } from "./player/input";
import { Player } from "./player/player";
import { RENDER_STYLES, type StyleId, type StyleOutput } from "./styles";
import { GameWorld } from "./world/world";

const MAX_PIXEL_RATIO = 2;

/** A frame longer than this is a stall, not a slow frame; do not integrate it. */
const MAX_FRAME_DELTA = 0.25;

const STYLE_OPTIONS = Object.fromEntries(
  Object.entries(RENDER_STYLES).map(([id, style]) => [style.label, id]),
) as Record<string, StyleId>;

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

  // Far enough to see the far shore, near enough that a weapon model will fit
  // in front of the eye later without a separate depth range.
  private readonly camera = new THREE.PerspectiveCamera(72, 1, 0.1, 900);
  private readonly pipeline = new THREE.RenderPipeline(this.renderer);
  private readonly timer = new THREE.Timer();
  private readonly controls: OrbitControls;
  private readonly input: Input;
  private readonly overlay = buildOverlay();

  private readonly stats = new Stats({ trackGPU: true });
  private readonly pane: Pane;
  private readonly styleFolders = new Map<StyleId, FolderApi>();
  private readonly reportTriangles: (value: number) => void;
  private readonly reportDrawCalls: (value: number) => void;

  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  /** Post-processing chains are built the first time their style is picked. */
  private readonly outputs = new Map<StyleId, StyleOutput>();

  // Built by `init()`; the frame loop only starts once all three exist.
  private physics: PhysicsWorld | null = null;
  private world: GameWorld | null = null;
  private player: Player | null = null;

  private activeOutput: StyleOutput | null = null;
  private hasTimestamps = false;

  private readonly settings = {
    style: "basic" as StyleId,
    camera: "play" as CameraMode,
    pixelRatio: Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
  };

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
      this.overlay.root.classList.toggle("overlay--playing", locked);
    };

    this.timer.connect(document);

    this.stats.dom.classList.add("ui-stats");
    this.reportTriangles = autoScalingPanel(this.stats, "TRIS", "#84fff7", "#08262d");
    this.reportDrawCalls = autoScalingPanel(this.stats, "CALLS", "#ffc171", "#34210b");

    const paneHost = document.createElement("div");

    paneHost.className = "ui-pane";
    this.pane = new Pane({ container: paneHost, title: "Controls" });

    this.container.append(this.renderer.domElement, this.overlay.root, this.stats.dom, paneHost);
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

    this.player = new Player(this.physics, this.input, this.camera, this.world.spawn);

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

    for (const output of this.outputs.values()) output.dispose();
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

    for (const [folderId, folder] of this.styleFolders) folder.hidden = folderId !== id;

    let output = this.outputs.get(id) ?? null;

    if (!output && style.createOutput && this.world) {
      output = style.createOutput(this.world.scene, this.camera);
      this.outputs.set(id, output);
    }

    this.activeOutput = output;

    if (output) {
      this.pipeline.outputNode = output.node;
      this.pipeline.needsUpdate = true;
    }
  }

  /**
   * Orbit is an inspection mode, not a second way to play: it exists so the
   * scene can be looked at from outside the player's head while the simulation
   * keeps running underneath.
   */
  private setCameraMode(mode: CameraMode): void {
    const playing = mode === "play";

    this.settings.camera = mode;
    this.controls.enabled = !playing;
    this.input.autoLock = playing;
    this.overlay.prompt.hidden = !playing;

    if (playing) return;

    this.input.exitLock();

    if (this.player) {
      this.controls.target.copy(this.player.eye);
      this.camera.position.copy(this.player.eye).add(ORBIT_OFFSET);
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
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
    movement.addBinding(player.tuning, "fov", { label: "FOV", min: 50, max: 110, step: 1 });
    movement.addButton({ title: "Respawn" }).on("click", () => player.respawn());

    const simulation = this.pane.addFolder({ title: "Physics", expanded: false });

    simulation.addBinding(physics, "rate", {
      label: "Tick rate",
      options: { "60 Hz": 60, "90 Hz": 90, "120 Hz": 120, "144 Hz": 144 },
    });
    simulation.addBinding(physics, "gravity", { label: "Gravity", min: 5, max: 40, step: 0.5 });

    const scene = this.pane.addFolder({ title: "Scene" });

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

  private readonly resize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.renderer.setSize(width, height);
  };

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

    if (this.activeOutput) this.pipeline.render();
    else this.renderer.render(world.scene, this.camera);

    // stats-gl reads `info.render.timestamp`, which only lands once resolved.
    if (this.hasTimestamps) void this.renderer.resolveTimestampsAsync();

    const { drawCalls, triangles } = this.renderer.info.render;

    this.reportTriangles(triangles);
    this.reportDrawCalls(drawCalls);
    this.stats.update();

    this.input.endFrame();
  };
}

const ORBIT_OFFSET = new THREE.Vector3(7, 5, 7);

/**
 * The click-to-play prompt and the crosshair. Both sit over the canvas with
 * pointer events off, so neither can swallow the click that grabs the pointer.
 */
function buildOverlay(): { root: HTMLElement; prompt: HTMLElement } {
  const root = document.createElement("div");

  root.className = "overlay";

  const crosshair = root.appendChild(document.createElement("div"));

  crosshair.className = "overlay__crosshair";

  const prompt = root.appendChild(document.createElement("div"));

  prompt.className = "overlay__prompt";

  const title = prompt.appendChild(document.createElement("strong"));

  title.textContent = "Click to play";

  const keys = prompt.appendChild(document.createElement("span"));

  keys.textContent = "WASD move · Shift sprint · Ctrl crouch · Space jump · R respawn · Esc release";

  return { root, prompt };
}
