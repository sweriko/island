import "./style.css";

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { pixelationPass } from "three/addons/tsl/display/PixelationPassNode.js";
import Stats from "stats-gl";
import { cameraProjectionMatrix, cameraViewMatrix, Fn, positionWorld, round, screenSize, uniform, vec2, vec4 } from "three/tsl";
import { Pane } from "tweakpane";

import dudeUrl from "../assets/dude.glb?url";
import {
  PAINTERLY_DEFAULTS,
  PAINTERLY_PRESETS,
  PainterlyMaterialHandle,
  applyPainterlyPreset,
  createPainterlyMaterial,
} from "./painterlyMaterial";

const BACKGROUND_COLOR = 0xffffff;
const PAINTERLY_BACKGROUND_COLOR = 0xf2ead6;
const MAX_PIXEL_RATIO = 2;

type VertexJitterMaterial = THREE.Material & {
  vertexNode?: unknown;
};

type RenderStyle = "basic" | "psx" | "painterly";

const STYLE_OPTIONS: Record<string, RenderStyle> = {
  Basic: "basic",
  PSX: "psx",
  Painterly: "painterly",
};

type PainterlyShellLayer = {
  mesh: THREE.Mesh;
  handle: PainterlyMaterialHandle;
};

type PainterlyMeshBundle = {
  // The original mesh whose material we hijacked. We keep its prior material
  // around so we can restore it when the user leaves painterly mode.
  target: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
  // The painterly material we apply in its place (variant=0 base mesh).
  painterly: PainterlyMaterialHandle;
  // Brush-stroke shells (variant=1, increasing PerInstanceCustomData[4]
  // shell offset). UE's painterly material is designed to render multiple
  // shells per object — each shell uses the rim-eroded color path so the
  // outer rim of each layer carves into the next. Hidden outside painterly
  // mode.
  shells: PainterlyShellLayer[];
  // Inverted-hull outline copy (variant=2). Hidden when not in painterly mode.
  outlineMesh: THREE.Mesh;
  outlinePainterly: PainterlyMaterialHandle;
};

// Number of shell layers per painterly mesh. UE's painterly typically uses
// 4-8 shells; we default to 4. Each shell is offset by an additional unit
// of `SingleOutlineDifference` (drives the outward inflation in the
// per-instance branch of bus_Inflate's Multiply_27).
const PAINTERLY_SHELL_COUNT = 4;

class BoilerplateApp {
  private readonly container: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private readonly renderer = new THREE.WebGPURenderer({
    alpha: false,
    antialias: true,
    outputBufferType: THREE.HalfFloatType,
    trackTimestamp: true,
  });
  private readonly pixelSize = uniform(3);
  private readonly normalEdgeStrength = uniform(0.3);
  private readonly depthEdgeStrength = uniform(0.4);
  private readonly vertexJitterStrength = uniform(0.5);
  private readonly vertexSnapPixelSize = uniform(4);
  private readonly psxVertexJitterNode = Fn(() => {
    const clipPosition = cameraProjectionMatrix.mul(cameraViewMatrix).mul(positionWorld);
    const snapGrid = screenSize.xy.div(this.vertexSnapPixelSize);
    const screenPosition = clipPosition.xy.div(clipPosition.w.mul(2)).mul(snapGrid);
    const snappedPosition = vec2(round(screenPosition.x), round(screenPosition.y)).div(snapGrid).mul(clipPosition.w.mul(2));

    return vec4(this.vertexJitterStrength.mix(clipPosition.xy, snappedPosition), clipPosition.zw);
  })();
  private readonly renderPipeline: THREE.RenderPipeline;
  private readonly controls: OrbitControls;
  private readonly timer = new THREE.Timer();
  private readonly paneHost: HTMLDivElement;
  private readonly pane: Pane;
  private readonly stats = new Stats({ trackGPU: true });
  private readonly ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  private readonly trackedMaterials = new Set<THREE.Material>();
  private readonly trackedGeometries = new Set<THREE.BufferGeometry>();
  private readonly psxJitterMaterials = new Set<THREE.Material>();
  private readonly cube: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly grid: THREE.GridHelper;
  private dude?: THREE.Group;
  private dudeMixer?: THREE.AnimationMixer;
  private readonly painterlyBundles: PainterlyMeshBundle[] = [];
  private readonly painterlyParams = {
    colorA: `#${PAINTERLY_DEFAULTS.ColorA.getHexString()}`,
    colorB: `#${PAINTERLY_DEFAULTS.ColorB.getHexString()}`,
    colorC: `#${PAINTERLY_DEFAULTS.ColorC.getHexString()}`,
    colorD: `#${PAINTERLY_DEFAULTS.ColorD.getHexString()}`,
    rampThreshold: PAINTERLY_DEFAULTS.ColorRampThreshold,
    cPosition: PAINTERLY_DEFAULTS.ColorCPosition,
    dPosition: PAINTERLY_DEFAULTS.ColorDPosition,
    specularStrength: PAINTERLY_DEFAULTS.SpecularStrength,
    specularEdgeSmooth: PAINTERLY_DEFAULTS.SpecularEdgeSmooth,
    specularOpacity: PAINTERLY_DEFAULTS.SpecularOpacity,
    outlineColor: `#${PAINTERLY_DEFAULTS.OutlinesColor.getHexString()}`,
    outlineWidth: PAINTERLY_DEFAULTS.OutlineWidth,
    noiseStrength: PAINTERLY_DEFAULTS.NoiseStrength,
    stepTimeX: PAINTERLY_DEFAULTS.StepTime.x,
    stepTimeY: PAINTERLY_DEFAULTS.StepTime.y,
    stepSizeX: PAINTERLY_DEFAULTS.UVStepSize.x,
    stepSizeY: PAINTERLY_DEFAULTS.UVStepSize.y,
    innerErosion: PAINTERLY_DEFAULTS.InnerErosionStrength,
    outerErosion: PAINTERLY_DEFAULTS.OuterErosionStrength,
    shadowStrength: PAINTERLY_DEFAULTS.ShadowStrength,
  };
  private readonly triPanel: InstanceType<typeof Stats.Panel>;
  private readonly drawCallPanel: InstanceType<typeof Stats.Panel>;
  private timestampQueriesSupported = false;
  private maxTriangles = 1;
  private maxDrawCalls = 1;
  private readonly params = {
    ambient: 0.7,
    autoRotate: false,
    dpr: Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
    exposure: 1,
    key: 1.6,
    normalEdges: 0.3,
    depthEdges: 0.4,
    pixelSize: 3,
    rotationSpeed: 0.65,
    style: "basic" as RenderStyle,
    vertexJitter: 0.5,
    vertexSnapPixelSize: 4,
  };

  private psxFolder!: ReturnType<Pane["addFolder"]>;
  private painterlyFolder!: ReturnType<Pane["addFolder"]>;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderPipeline = new THREE.RenderPipeline(
      this.renderer,
      pixelationPass(this.scene, this.camera, this.pixelSize, this.normalEdgeStrength, this.depthEdgeStrength),
    );

    this.paneHost = document.createElement("div");
    this.paneHost.className = "ui-pane";
    this.pane = new Pane({
      container: this.paneHost,
      title: "Controls",
    });
    this.stats.dom.classList.add("ui-stats");
    this.triPanel = this.stats.addPanel(new Stats.Panel("TRIS", "#84fff7", "#08262d"));
    this.drawCallPanel = this.stats.addPanel(new Stats.Panel("CALLS", "#ffc171", "#34210b"));

    this.renderer.domElement.className = "app__canvas";
    this.container.append(this.renderer.domElement, this.stats.dom, this.paneHost);

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.params.exposure;

    this.camera.position.set(3.2, 2.2, 4.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = true;
    this.controls.autoRotate = this.params.autoRotate;
    this.controls.autoRotateSpeed = 1;
    this.controls.target.set(0, 0, 0);

    this.timer.connect(document);

    this.cube = new THREE.Mesh(
      this.trackGeometry(new THREE.BoxGeometry(1, 1, 1)),
      this.trackMaterial(
        this.withVertexJitter(
          new THREE.MeshStandardMaterial({
            color: 0xff6c43,
            metalness: 0.08,
            roughness: 0.58,
          }),
        ),
      ),
    );
    this.cube.position.y = 0.5;

    this.ground = new THREE.Mesh(
      this.trackGeometry(new THREE.PlaneGeometry(10, 10)),
      this.trackMaterial(
        new THREE.MeshStandardMaterial({
          color: 0xeeeeee,
          metalness: 0,
          roughness: 0.95,
        }),
      ),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.501;

    this.grid = new THREE.GridHelper(10, 10, 0x000000, 0x000000);
    this.grid.position.y = -0.5;
    this.trackedGeometries.add(this.grid.geometry);
    if (Array.isArray(this.grid.material)) {
      for (const material of this.grid.material) {
        this.trackedMaterials.add(material);
      }
    } else {
      this.trackedMaterials.add(this.grid.material);
    }

    this.setupScene();
    this.setupPane();
    this.applyStyle(this.params.style);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    await this.stats.init(this.renderer);
    this.timestampQueriesSupported = this.renderer.hasFeature("timestamp-query");

    await this.loadDude();
    this.attachPainterlyToMesh(this.cube);

    this.handleResize();
    await this.renderer.compileAsync(this.scene, this.camera);

    this.renderFrame();
    this.flushRenderTimestamps();
    this.updatePerformancePanels();
    this.stats.update();

    window.addEventListener("resize", this.handleResize, { passive: true });
    this.renderer.setAnimationLoop(this.animate);
  }

  dispose(): void {
    window.removeEventListener("resize", this.handleResize);
    this.renderer.setAnimationLoop(null);

    this.timer.dispose();
    this.controls.dispose();
    this.pane.dispose();
    this.stats.dispose();
    this.renderPipeline.dispose();

    for (const bundle of this.painterlyBundles) {
      bundle.painterly.material.dispose();
      bundle.outlinePainterly.material.dispose();
      bundle.outlineMesh.removeFromParent();
      for (const shell of bundle.shells) {
        shell.handle.material.dispose();
        shell.mesh.removeFromParent();
      }
    }

    for (const geometry of this.trackedGeometries) {
      geometry.dispose();
    }

    for (const material of this.trackedMaterials) {
      material.dispose();
    }

    this.renderer.dispose();
    this.container.replaceChildren();
  }

  showFatalError(error: unknown): void {
    this.renderer.setAnimationLoop(null);

    const errorCard = document.createElement("section");
    errorCard.className = "error-card";

    const title = document.createElement("span");
    title.className = "error-card__title";
    title.textContent = "Renderer initialization failed";

    const description = document.createElement("p");
    description.className = "error-card__meta";
    description.textContent = error instanceof Error ? error.message : "Unknown initialization error.";

    errorCard.append(title, description);

    this.container.replaceChildren(errorCard);
  }

  private setupScene(): void {
    this.scene.background = new THREE.Color(BACKGROUND_COLOR);

    this.keyLight.position.set(3, 4, 2);

    this.scene.add(this.ambientLight, this.keyLight, this.ground, this.grid, this.cube);
  }

  private setupPane(): void {
    this.pane.addBinding(this.params, "style", {
      label: "Style",
      options: STYLE_OPTIONS,
    }).on("change", ({ value }) => {
      this.applyStyle(value);
    });
    this.pane.addBinding(this.params, "rotationSpeed", {
      label: "Spin",
      min: 0,
      max: 2,
      step: 0.01,
    });

    this.psxFolder = this.pane.addFolder({ title: "PSX" });
    this.psxFolder.addBinding(this.params, "pixelSize", {
      label: "Pixel size",
      min: 1,
      max: 16,
      step: 1,
    }).on("change", ({ value }) => {
      this.pixelSize.value = value;
    });
    this.psxFolder.addBinding(this.params, "normalEdges", {
      label: "Normal edges",
      min: 0,
      max: 2,
      step: 0.05,
    }).on("change", ({ value }) => {
      this.normalEdgeStrength.value = value;
    });
    this.psxFolder.addBinding(this.params, "depthEdges", {
      label: "Depth edges",
      min: 0,
      max: 1,
      step: 0.05,
    }).on("change", ({ value }) => {
      this.depthEdgeStrength.value = value;
    });
    this.psxFolder.addBinding(this.params, "vertexJitter", {
      label: "Vertex jitter",
      min: 0,
      max: 1,
      step: 0.05,
    }).on("change", ({ value }) => {
      this.vertexJitterStrength.value = value;
    });
    this.psxFolder.addBinding(this.params, "vertexSnapPixelSize", {
      label: "Vertex snap",
      min: 1,
      max: 24,
      step: 1,
    }).on("change", ({ value }) => {
      this.vertexSnapPixelSize.value = value;
    });

    this.painterlyFolder = this.pane.addFolder({ title: "Painterly" });
    const presetFolder = this.painterlyFolder.addFolder({ title: "MI presets" });
    for (const presetName of Object.keys(PAINTERLY_PRESETS)) {
      presetFolder.addButton({ title: presetName }).on("click", () => {
        const preset = PAINTERLY_PRESETS[presetName];
        this.forEachPainterlyHandle((h) => applyPainterlyPreset(h, preset));
        this.pane.refresh();
      });
    }
    presetFolder.addButton({ title: "Reset to defaults" }).on("click", () => {
      // Re-apply the verbatim M_PainterlyShader defaults to every handle.
      this.forEachPainterlyHandle((h) => applyPainterlyPreset(h, {
        scalars: {
          ColorRampThreshold: PAINTERLY_DEFAULTS.ColorRampThreshold,
          ColorCPosition: PAINTERLY_DEFAULTS.ColorCPosition,
          ColorDPosition: PAINTERLY_DEFAULTS.ColorDPosition,
          NoiseStrength: PAINTERLY_DEFAULTS.NoiseStrength,
          InnerErosionTiling: PAINTERLY_DEFAULTS.InnerErosionTiling,
          InnerErosionStrength: PAINTERLY_DEFAULTS.InnerErosionStrength,
          OuterErosionStrength: PAINTERLY_DEFAULTS.OuterErosionStrength,
          OuterErosionTiling: PAINTERLY_DEFAULTS.OuterErosionTiling,
          PlanarInnerErosionStrength: PAINTERLY_DEFAULTS.PlanarInnerErosionStrength,
          PlanarOuterErosionStrength: PAINTERLY_DEFAULTS.PlanarOuterErosionStrength,
          PlanarEdgeErosionOutlineMaskStrength: PAINTERLY_DEFAULTS.PlanarEdgeErosionOutlineMaskStrength,
          OutlinesGeneralOffset: PAINTERLY_DEFAULTS.OutlinesGeneralOffset,
          OutlineWidth: PAINTERLY_DEFAULTS.OutlineWidth,
          SingleOutlineDifference: PAINTERLY_DEFAULTS.SingleOutlineDifference,
          ShadowStrength: PAINTERLY_DEFAULTS.ShadowStrength,
          SpecularStrength: PAINTERLY_DEFAULTS.SpecularStrength,
          SpecularEdgeSmooth: PAINTERLY_DEFAULTS.SpecularEdgeSmooth,
          SpecularOpacity: PAINTERLY_DEFAULTS.SpecularOpacity,
        },
        vectors: {
          ColorA: { r: PAINTERLY_DEFAULTS.ColorA.r, g: PAINTERLY_DEFAULTS.ColorA.g, b: PAINTERLY_DEFAULTS.ColorA.b },
          ColorB: { r: PAINTERLY_DEFAULTS.ColorB.r, g: PAINTERLY_DEFAULTS.ColorB.g, b: PAINTERLY_DEFAULTS.ColorB.b },
          ColorC: { r: PAINTERLY_DEFAULTS.ColorC.r, g: PAINTERLY_DEFAULTS.ColorC.g, b: PAINTERLY_DEFAULTS.ColorC.b },
          ColorD: { r: PAINTERLY_DEFAULTS.ColorD.r, g: PAINTERLY_DEFAULTS.ColorD.g, b: PAINTERLY_DEFAULTS.ColorD.b },
          OutlinesColor: { r: PAINTERLY_DEFAULTS.OutlinesColor.r, g: PAINTERLY_DEFAULTS.OutlinesColor.g, b: PAINTERLY_DEFAULTS.OutlinesColor.b },
          "Step Time": { r: PAINTERLY_DEFAULTS.StepTime.x, g: PAINTERLY_DEFAULTS.StepTime.y, b: 0 },
          "UV Step Size": { r: PAINTERLY_DEFAULTS.UVStepSize.x, g: PAINTERLY_DEFAULTS.UVStepSize.y, b: 0 },
        },
      }));
    });
    // Bindings address uniforms by their UE parameter names, populated by
    // the auto-generated buildPainterly() the first time it runs. The
    // forEachPainterly helper takes a callback that mutates each material
    // handle's uniforms (cube + dude submeshes + their outline copies).
    const colorFolder = this.painterlyFolder.addFolder({ title: "Cel ramp" });
    colorFolder.addBinding(this.painterlyParams, "colorA", { label: "ColorA (lit)" })
      .on("change", ({ value }) => this.forEachPainterly((u) => u.ColorA?.value.set(value)));
    colorFolder.addBinding(this.painterlyParams, "colorB", { label: "ColorB" })
      .on("change", ({ value }) => this.forEachPainterly((u) => u.ColorB?.value.set(value)));
    colorFolder.addBinding(this.painterlyParams, "colorC", { label: "ColorC" })
      .on("change", ({ value }) => this.forEachPainterly((u) => u.ColorC?.value.set(value)));
    colorFolder.addBinding(this.painterlyParams, "colorD", { label: "ColorD (dark)" })
      .on("change", ({ value }) => this.forEachPainterly((u) => u.ColorD?.value.set(value)));
    colorFolder.addBinding(this.painterlyParams, "rampThreshold", {
      label: "ColorRampThreshold", min: 0, max: 1, step: 0.01,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.ColorRampThreshold) u.ColorRampThreshold.value = value; }));
    colorFolder.addBinding(this.painterlyParams, "cPosition", {
      label: "ColorCPosition", min: 0, max: 1, step: 0.01,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.ColorCPosition) u.ColorCPosition.value = value; }));
    colorFolder.addBinding(this.painterlyParams, "dPosition", {
      label: "ColorDPosition", min: 0, max: 1, step: 0.01,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.ColorDPosition) u.ColorDPosition.value = value; }));

    const specFolder = this.painterlyFolder.addFolder({ title: "Specular" });
    specFolder.addBinding(this.painterlyParams, "specularStrength", {
      label: "SpecularStrength", min: 0, max: 1, step: 0.005,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.SpecularStrength) u.SpecularStrength.value = value; }));
    specFolder.addBinding(this.painterlyParams, "specularEdgeSmooth", {
      label: "SpecularEdgeSmooth", min: 0, max: 0.5, step: 0.005,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.SpecularEdgeSmooth) u.SpecularEdgeSmooth.value = value; }));
    specFolder.addBinding(this.painterlyParams, "specularOpacity", {
      label: "SpecularOpacity", min: 0, max: 2, step: 0.01,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.SpecularOpacity) u.SpecularOpacity.value = value; }));

    const brushFolder = this.painterlyFolder.addFolder({ title: "Brush / animated UV" });
    brushFolder.addBinding(this.painterlyParams, "noiseStrength", {
      label: "NoiseStrength", min: 0, max: 10, step: 0.1,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.NoiseStrength) u.NoiseStrength.value = value; }));
    brushFolder.addBinding(this.painterlyParams, "stepTimeX", {
      label: "StepTime.X", min: 0.05, max: 4, step: 0.05,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u["Step Time"]) u["Step Time"].value.r = value; }));
    brushFolder.addBinding(this.painterlyParams, "stepTimeY", {
      label: "StepTime.Y", min: 0.05, max: 4, step: 0.05,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u["Step Time"]) u["Step Time"].value.g = value; }));
    brushFolder.addBinding(this.painterlyParams, "stepSizeX", {
      label: "UVStepSize.X", min: 0, max: 2, step: 0.01,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u["UV Step Size"]) u["UV Step Size"].value.r = value; }));
    brushFolder.addBinding(this.painterlyParams, "stepSizeY", {
      label: "UVStepSize.Y", min: 0, max: 2, step: 0.01,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u["UV Step Size"]) u["UV Step Size"].value.g = value; }));

    const erosionFolder = this.painterlyFolder.addFolder({ title: "Rim erosion / shadow" });
    erosionFolder.addBinding(this.painterlyParams, "innerErosion", {
      label: "InnerErosionStrength", min: 0, max: 6, step: 0.05,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.InnerErosionStrength) u.InnerErosionStrength.value = value; }));
    erosionFolder.addBinding(this.painterlyParams, "outerErosion", {
      label: "OuterErosionStrength", min: 0, max: 6, step: 0.05,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.OuterErosionStrength) u.OuterErosionStrength.value = value; }));
    erosionFolder.addBinding(this.painterlyParams, "shadowStrength", {
      label: "ShadowStrength", min: 0, max: 1, step: 0.01,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.ShadowStrength) u.ShadowStrength.value = value; }));

    const outlineFolder = this.painterlyFolder.addFolder({ title: "Outline" });
    outlineFolder.addBinding(this.painterlyParams, "outlineColor", { label: "OutlinesColor" })
      .on("change", ({ value }) => this.forEachPainterly((u) => u.OutlinesColor?.value.set(value)));
    outlineFolder.addBinding(this.painterlyParams, "outlineWidth", {
      label: "OutlineWidth", min: 0, max: 0.3, step: 0.005,
    }).on("change", ({ value }) => this.forEachPainterly((u) => { if (u.OutlineWidth) u.OutlineWidth.value = value; }));

    this.pane.addBinding(this.params, "exposure", {
      min: 0.5,
      max: 2,
      step: 0.05,
    }).on("change", ({ value }) => {
      this.renderer.toneMappingExposure = value;
    });
    this.pane.addBinding(this.params, "ambient", {
      min: 0,
      max: 2,
      step: 0.05,
    }).on("change", ({ value }) => {
      this.ambientLight.intensity = value;
    });
    this.pane.addBinding(this.params, "key", {
      min: 0,
      max: 6,
      step: 0.1,
    }).on("change", ({ value }) => {
      this.keyLight.intensity = value;
    });
    this.pane.addBinding(this.params, "autoRotate", {
      label: "Camera",
    }).on("change", ({ value }) => {
      this.controls.autoRotate = value;
    });
    this.pane.addBinding(this.params, "dpr", {
      min: 0.5,
      max: MAX_PIXEL_RATIO,
      step: 0.1,
    }).on("change", () => {
      this.handleResize();
    });
  }

  private forEachPainterly(
    fn: (uniforms: PainterlyMaterialHandle["uniforms"]) => void,
  ): void {
    for (const bundle of this.painterlyBundles) {
      fn(bundle.painterly.uniforms);
      fn(bundle.outlinePainterly.uniforms);
      for (const shell of bundle.shells) fn(shell.handle.uniforms);
    }
  }

  private forEachPainterlyHandle(
    fn: (handle: PainterlyMaterialHandle) => void,
  ): void {
    for (const bundle of this.painterlyBundles) {
      fn(bundle.painterly);
      fn(bundle.outlinePainterly);
      for (const shell of bundle.shells) fn(shell.handle);
    }
  }

  private readonly handleResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.params.dpr));
    this.renderer.setSize(width, height);
  };

  private readonly animate = (timestamp?: number): void => {
    this.timer.update(timestamp);

    const delta = this.timer.getDelta();
    const rotationStep = delta * this.params.rotationSpeed;

    this.cube.rotation.x += rotationStep * 0.45;
    this.cube.rotation.y += rotationStep;

    if (this.dude) {
      this.dude.rotation.y += rotationStep * 0.35;
    }
    this.dudeMixer?.update(delta);

    this.controls.update();

    // Painterly's cel/specular needs the world-space sun direction every
    // frame in case the key light moves. The shell + outline copies share
    // a parent with their source so they pick up animated transforms via
    // hierarchy, but the source's own local transform (cube spin, glTF
    // node transforms) needs to be mirrored each frame.
    if (this.params.style === "painterly") {
      for (const bundle of this.painterlyBundles) {
        bundle.painterly.syncLightDir();
        bundle.outlinePainterly.syncLightDir();
        const syncTransform = (m: THREE.Object3D) => {
          m.position.copy(bundle.target.position);
          m.quaternion.copy(bundle.target.quaternion);
          m.scale.copy(bundle.target.scale);
        };
        syncTransform(bundle.outlineMesh);
        for (const shell of bundle.shells) {
          shell.handle.syncLightDir();
          syncTransform(shell.mesh);
        }
      }
    }

    this.renderFrame();
    this.flushRenderTimestamps();
    this.updatePerformancePanels();
    this.stats.update();
  };

  private flushRenderTimestamps(): void {
    if (!this.timestampQueriesSupported) {
      return;
    }

    void this.renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
  }

  private updatePerformancePanels(): void {
    const { drawCalls, triangles } = this.renderer.info.render;

    this.maxTriangles = Math.max(this.maxTriangles, triangles, 1);
    this.maxDrawCalls = Math.max(this.maxDrawCalls, drawCalls, 1);

    this.triPanel.update(triangles, this.maxTriangles * 1.15, 0);
    this.triPanel.updateGraph(triangles, this.maxTriangles * 1.15);

    this.drawCallPanel.update(drawCalls, this.maxDrawCalls * 1.15, 0);
    this.drawCallPanel.updateGraph(drawCalls, this.maxDrawCalls * 1.15);
  }

  private trackGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.trackedGeometries.add(geometry);
    return geometry;
  }

  private trackMaterial<T extends THREE.Material>(material: T): T {
    this.trackedMaterials.add(material);
    return material;
  }

  private withVertexJitter<T extends THREE.Material>(material: T): T {
    this.psxJitterMaterials.add(material);
    return material;
  }

  /**
   * Builds a painterly bundle for a mesh: a primary painterly material that
   * hijacks the mesh's material when in painterly mode, plus an inverted-hull
   * outline copy that gets parented next to it. Both stay hidden / unused in
   * other modes and the original material is restored on style switch.
   *
   * SkinnedMesh inputs get a SkinnedMesh outline that shares the same
   * skeleton + bind matrix so the outline deforms in lockstep with bones —
   * this matches UE's blueprint-driven outline meshes that copy the source
   * skeleton.
   */
  private attachPainterlyToMesh(mesh: THREE.Mesh): void {
    const sun = this.keyLight;
    // The base mesh and outline copy share a seed so the outline silhouette
    // tracks the same brush phase as the body. Each shell gets its own
    // seed so the layered brushstroke patterns differ between layers,
    // matching UE's per-ISM-instance behaviour.
    const baseSeed = Math.random();

    const painterly = createPainterlyMaterial({ sun, variant: 0, randomSeed: baseSeed });
    const outlinePainterly = createPainterlyMaterial({ sun, variant: 2, randomSeed: baseSeed });

    const cloneMeshShape = (material: THREE.Material): THREE.Mesh => {
      let copy: THREE.Mesh;
      if (mesh instanceof THREE.SkinnedMesh) {
        const sk = new THREE.SkinnedMesh(mesh.geometry, material);
        sk.bind(mesh.skeleton, mesh.bindMatrix);
        sk.bindMode = mesh.bindMode;
        copy = sk;
      } else {
        copy = new THREE.Mesh(mesh.geometry, material);
      }
      copy.position.copy(mesh.position);
      copy.quaternion.copy(mesh.quaternion);
      copy.scale.copy(mesh.scale);
      copy.visible = false;
      (mesh.parent ?? this.scene).add(copy);
      return copy;
    };

    // Outline mesh (variant=2, inverted hull rendered with BackSide).
    const outlineMesh = cloneMeshShape(outlinePainterly.material);
    outlineMesh.renderOrder = -1;

    // Shell mesh layers (variant=1). Each shell gets:
    //   - a fresh randomSeed so the brushstroke noise / outline directional
    //     offset / shell jitter all differ between layers (UE assigns a
    //     unique PerInstanceRandom to every ISM instance)
    //   - a progressively larger PerInstanceCustomData[4] which drives
    //     bus_Inflate's per-instance branch
    //     (Multiply_27 = normalize(positionWorld - pivot) * customdata[4])
    //   Treating customdata[4] as UE centimetres, the values 0.5..2.0 produce
    //   5mm..2cm shell offsets at our 1m mesh scale.
    const shells: PainterlyShellLayer[] = [];
    for (let i = 0; i < PAINTERLY_SHELL_COUNT; i++) {
      const shellOffset = ((i + 1) / PAINTERLY_SHELL_COUNT) * 2.0;
      const handle = createPainterlyMaterial({
        sun, variant: 1, randomSeed: Math.random(), shellOffset,
      });
      const shellMesh = cloneMeshShape(handle.material);
      // Outermost shells render last so they paint over inner shells.
      shellMesh.renderOrder = i;
      shells.push({ mesh: shellMesh, handle });
    }

    this.painterlyBundles.push({
      target: mesh,
      originalMaterial: mesh.material,
      painterly,
      shells,
      outlineMesh,
      outlinePainterly,
    });
  }

  private async loadDude(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(dudeUrl);
    const dude = gltf.scene;
    dude.position.set(1.5, 0, 0);
    dude.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(dude);
    dude.position.y += -0.5 - bbox.min.y;

    dude.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }
      this.trackedGeometries.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        this.trackedMaterials.add(material);
        this.psxJitterMaterials.add(material);
      }
      // Each skinned/regular mesh inside the dude gets its own painterly
      // bundle so the cel ramp follows the rig per submesh.
      this.attachPainterlyToMesh(object);
    });

    this.scene.add(dude);
    this.dude = dude;
    this.applyStyle(this.params.style);

    if (gltf.animations.length > 0) {
      this.dudeMixer = new THREE.AnimationMixer(dude);
      this.dudeMixer.clipAction(gltf.animations[0]).play();
    }
  }

  private applyStyle(style: RenderStyle): void {
    this.params.style = style;
    const useJitter = style === "psx";
    const usePainterly = style === "painterly";

    for (const material of this.psxJitterMaterials) {
      (material as VertexJitterMaterial).vertexNode = useJitter ? this.psxVertexJitterNode : null;
      material.needsUpdate = true;
    }

    this.psxFolder.hidden = !useJitter;
    this.painterlyFolder.hidden = !usePainterly;

    // Painterly mode dresses the scene like a canvas: warm off-white background,
    // softer floor, no helper grid.
    const bgColor = usePainterly ? PAINTERLY_BACKGROUND_COLOR : BACKGROUND_COLOR;
    (this.scene.background as THREE.Color).setHex(bgColor);
    this.ground.material.color.setHex(usePainterly ? 0xe6dcc1 : 0xeeeeee);
    this.ground.material.needsUpdate = true;
    this.grid.visible = !usePainterly;

    // Swap each painterly mesh between its painterly material + outline +
    // shells, and its original PBR material.
    for (const bundle of this.painterlyBundles) {
      if (usePainterly) {
        bundle.target.material = bundle.painterly.material;
      } else {
        bundle.target.material = bundle.originalMaterial;
      }
      bundle.outlineMesh.visible = usePainterly;
      for (const shell of bundle.shells) shell.mesh.visible = usePainterly;
    }
  }

  private renderFrame(): void {
    if (this.params.style === "psx") {
      this.renderPipeline.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

const appElement = document.querySelector<HTMLElement>("#app");

if (!appElement) {
  throw new Error("App root #app was not found.");
}

const app = new BoilerplateApp(appElement);

app.init().catch((error) => {
  console.error(error);
  app.showFatalError(error);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    app.dispose();
  });
}
