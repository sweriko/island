import "./style.css";

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { pixelationPass } from "three/addons/tsl/display/PixelationPassNode.js";
import Stats from "stats-gl";
import { cameraProjectionMatrix, cameraViewMatrix, Fn, positionWorld, round, screenSize, uniform, vec2, vec4 } from "three/tsl";
import { Pane } from "tweakpane";

import dudeUrl from "../assets/dude.glb?url";

const BACKGROUND_COLOR = 0xffffff;
const MAX_PIXEL_RATIO = 2;

type VertexJitterMaterial = THREE.Material & {
  vertexNode?: unknown;
};

type RenderStyle = "basic" | "psx";

const STYLE_OPTIONS: Record<string, RenderStyle> = {
  Basic: "basic",
  PSX: "psx",
};

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

    for (const material of this.psxJitterMaterials) {
      (material as VertexJitterMaterial).vertexNode = useJitter ? this.psxVertexJitterNode : null;
      material.needsUpdate = true;
    }

    this.psxFolder.hidden = !useJitter;
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
