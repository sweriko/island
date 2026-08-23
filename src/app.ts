import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import Stats from "stats-gl";
import { Pane } from "tweakpane";
import type { FolderApi } from "tweakpane";

import { DemoScene } from "./scene";
import { RENDER_STYLES, type StyleId, type StyleOutput } from "./styles";

const MAX_PIXEL_RATIO = 2;

const STYLE_OPTIONS = Object.fromEntries(
  Object.entries(RENDER_STYLES).map(([id, style]) => [style.label, id]),
) as Record<string, StyleId>;

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
  private readonly renderer = new THREE.WebGPURenderer({
    antialias: true,
    outputBufferType: THREE.HalfFloatType,
    trackTimestamp: true,
  });

  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private readonly world = new DemoScene();
  private readonly pipeline = new THREE.RenderPipeline(this.renderer);
  private readonly timer = new THREE.Timer();
  private readonly controls: OrbitControls;

  private readonly stats = new Stats({ trackGPU: true });
  private readonly pane: Pane;
  private readonly styleFolders = new Map<StyleId, FolderApi>();
  private readonly reportTriangles: (value: number) => void;
  private readonly reportDrawCalls: (value: number) => void;

  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  /** Post-processing chains are built the first time their style is picked. */
  private readonly outputs = new Map<StyleId, StyleOutput>();
  private activeOutput: StyleOutput | null = null;
  private hasTimestamps = false;

  private readonly settings = {
    style: "basic" as StyleId,
    pixelRatio: Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
  };

  constructor(private readonly container: HTMLElement) {
    this.renderer.domElement.className = "app__canvas";
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.camera.position.set(3.2, 2.2, 4.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotateSpeed = 1;

    this.timer.connect(document);

    this.stats.dom.classList.add("ui-stats");
    this.reportTriangles = autoScalingPanel(this.stats, "TRIS", "#84fff7", "#08262d");
    this.reportDrawCalls = autoScalingPanel(this.stats, "CALLS", "#ffc171", "#34210b");

    const paneHost = document.createElement("div");
    paneHost.className = "ui-pane";
    this.pane = new Pane({ container: paneHost, title: "Controls" });
    this.buildPane();

    this.container.append(this.renderer.domElement, this.stats.dom, paneHost);
    this.setStyle(this.settings.style);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    await this.stats.init(this.renderer);
    this.hasTimestamps = this.renderer.hasFeature("timestamp-query");

    await this.world.load();

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
    this.pane.dispose();
    this.stats.dispose();

    for (const output of this.outputs.values()) output.dispose();
    this.pipeline.dispose();
    this.world.dispose();
    this.renderer.dispose();

    this.container.replaceChildren();
  }

  private setStyle(id: StyleId): void {
    const style = RENDER_STYLES[id];

    this.settings.style = id;
    this.world.applyStyle(style);

    for (const [folderId, folder] of this.styleFolders) folder.hidden = folderId !== id;

    let output = this.outputs.get(id) ?? null;

    if (!output && style.createOutput) {
      output = style.createOutput(this.world.scene, this.camera);
      this.outputs.set(id, output);
    }

    this.activeOutput = output;

    if (output) {
      this.pipeline.outputNode = output.node;
      this.pipeline.needsUpdate = true;
    }
  }

  private buildPane(): void {
    this.pane
      .addBinding(this.settings, "style", { label: "Style", options: STYLE_OPTIONS })
      .on("change", ({ value }) => this.setStyle(value));
    this.pane.addBinding(this.world, "spin", { label: "Spin", min: 0, max: 2, step: 0.01 });

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

    const scene = this.pane.addFolder({ title: "Scene" });
    scene.addBinding(this.renderer, "toneMappingExposure", {
      label: "Exposure",
      min: 0.5,
      max: 2,
      step: 0.05,
    });
    scene.addBinding(this.world.ambientLight, "intensity", {
      label: "Ambient",
      min: 0,
      max: 2,
      step: 0.05,
    });
    scene.addBinding(this.world.keyLight, "intensity", { label: "Key", min: 0, max: 6, step: 0.1 });
    scene.addBinding(this.controls, "autoRotate", { label: "Orbit" });
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
    const delta = this.timer.update(timestamp).getDelta();

    this.world.update(delta);
    this.controls.update();

    if (this.activeOutput) this.pipeline.render();
    else this.renderer.render(this.world.scene, this.camera);

    // stats-gl reads `info.render.timestamp`, which only lands once resolved.
    if (this.hasTimestamps) void this.renderer.resolveTimestampsAsync();

    const { drawCalls, triangles } = this.renderer.info.render;
    this.reportTriangles(triangles);
    this.reportDrawCalls(drawCalls);
    this.stats.update();
  };
}
