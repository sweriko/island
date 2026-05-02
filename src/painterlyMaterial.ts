// @ts-nocheck
/*
 * Host wrapper around the auto-generated painterly TSL graph.
 *
 * The generator (assets/painterly/generate_tsl.py) emits buildPainterly()
 * which returns the seven UE material output pin nodes (BaseColor,
 * EmissiveColor, OpacityMask, Normal, WorldPositionOffset, Metallic,
 * Roughness). This module:
 *   - loads the brush textures and builds the runtime uniforms,
 *   - runs buildPainterly to get the output nodes,
 *   - assembles a MeshBasicNodeMaterial that mirrors UE's "cel + emissive
 *     specular" composition (visible color = BaseColor + EmissiveColor),
 *   - applies the WorldPositionOffset pin via positionNode (transformed
 *     into object space via modelWorldMatrixInverse so the world-space
 *     offset semantics match UE).
 */

import * as THREE from "three/webgpu";
import {
  float,
  modelWorldMatrixInverse,
  positionLocal,
  uniform,
  vec3,
  vec4,
} from "three/tsl";

// ts-only: the upstream three.js types don't include some node-material
// fields we set below.

import brushStrokesUrl from "../assets/painterly/textures/T_BrushStrokes.web.jpg?url";
import brushStrokesPackedUrl from "../assets/painterly/textures/T_BrushStrokes_Packed.web.jpg?url";
import brushHeightUrl from "../assets/painterly/textures/T_Messy-BrushStrokes_HeightMap.web.jpg?url";
import tilingNoiseUrl from "../assets/painterly/textures/TilingNoise05.web.jpg?url";

import { buildPainterly } from "./painterlyMaterial.generated";

// UE MaterialInstance parameter overrides extracted from MI_PainterlyShader[Blue|Red|Yellow]
// + MI_PainterlyShaderBlue-Cube. Each preset is a partial overlay applied
// on top of M_PainterlyShader's defaults.
export type PainterlyPreset = {
  scalars?: Record<string, number>;
  vectors?: Record<string, { r: number; g: number; b: number }>;
};

export const PAINTERLY_PRESETS: Record<string, PainterlyPreset> = {
  Blue: {
    scalars: {
      ColorCPosition: 0.43, ColorDPosition: 0.71098, ColorRampThreshold: 1.04221,
      NoiseStrength: 4.59619, InnerErosionTiling: 2.0, InnerErosionStrength: 3.11759,
      OuterErosionStrength: -0.51394, PlanarInnerErosionStrength: 1.52443,
      OutlinesGeneralOffset: 4.11445, OutlineWidth: 0.0792, SingleOutlineDifference: 0.53463,
      ShadowStrength: 0.16107,
    },
    vectors: {
      ColorA: { r: 0.62396, g: 0.89627, b: 1.0 },
      ColorB: { r: 0.16522, g: 0.72272, b: 1.0 },
      ColorC: { r: 0.03689, g: 0.22323, b: 0.28744 },
      ColorD: { r: 0.0, g: 0.0319, b: 0.07036 },
      "Step Time": { r: 0.7, g: 0.7, b: 0.0 },
      OutlineDirectionalOffset: { r: -12.56054, g: 1.14359, b: -7.59715 },
      OutlineRotation: { r: 0.0368, g: 0.0288, b: 0.028 },
    },
  },
  "Blue (Cube)": {
    scalars: {
      NoiseStrength: 3.35265, InnerErosionStrength: 4.10858,
      OuterErosionStrength: -2.29252, PlanarOuterErosionStrength: 11.84606,
      PlanarEdgeErosionOutlineMaskStrength: -0.064,
      OutlinesGeneralOffset: 10.73118, OutlineWidth: 0.3112, SingleOutlineDifference: 0.72466,
      ShadowStrength: 0.32833, SpecularEdgeSmooth: 0.0512, SpecularOpacity: 0.3584,
      SpecularStrength: 0.88275,
    },
    vectors: {
      "Step Time": { r: 0.7, g: 0.7, b: 0.0 },
      OutlineDirectionalOffset: { r: 4.86034, g: -15.44767, b: 0.39739 },
      OutlineRotation: { r: 0.0442, g: -0.00498, b: 0.08375 },
    },
  },
  Red: {
    scalars: {
      ColorCPosition: 0.198, ColorDPosition: 0.49498, ColorRampThreshold: 0.67055,
      NoiseStrength: 2.54992, InnerErosionStrength: 2.65669, OuterErosionStrength: 3.40216,
      OutlinesGeneralOffset: 4.88337, OutlineWidth: 0.1072, SingleOutlineDifference: 7.54887,
      ShadowStrength: 0.32207, SpecularEdgeSmooth: 0.0448, SpecularStrength: 0.88195,
    },
    vectors: {
      ColorA: { r: 0.91146, g: 0.76904, b: 0.80826 },
      ColorB: { r: 0.72917, g: 0.42915, b: 0.51177 },
      ColorC: { r: 0.53948, g: 0.16827, b: 0.2705 },
      ColorD: { r: 0.17188, g: 0.02327, b: 0.0642 },
      OutlineDirectionalOffset: { r: 0.0, g: -1.53258, b: -0.95294 },
      OutlineRotation: { r: -0.0064, g: -0.0, b: -0.0104 },
      OutlinesColor: { r: 0.7396, g: 0.61374, b: 0.77604 },
    },
  },
  Yellow: {
    scalars: {
      OutlinesGeneralOffset: 5.06377, OutlineWidth: 0.112,
      SpecularEdgeSmooth: 0.0144, SpecularStrength: 0.92275,
    },
    vectors: {
      ColorA: { r: 0.90625, g: 0.89381, b: 0.79769 },
      ColorB: { r: 0.80729, g: 0.76874, b: 0.47092 },
      ColorC: { r: 0.70833, g: 0.63645, b: 0.08116 },
      ColorD: { r: 0.21354, g: 0.19187, b: 0.02447 },
      OutlinesColor: { r: 0.0, g: 0.0, b: 0.0 },
    },
  },
};

// Verbatim parameter defaults from M_PainterlyShader.uasset (auto-extracted).
export const PAINTERLY_DEFAULTS = {
  ColorA: new THREE.Color(0.972549, 0.992157, 1.0),
  ColorB: new THREE.Color(0.637597, 0.879623, 1.0),
  ColorC: new THREE.Color(0.174647, 0.450786, 0.545725),
  ColorD: new THREE.Color(0.024158, 0.066626, 0.116971),
  ColorRampThreshold: 0.6369540095329285,
  ColorCPosition: 0.22200000286102295,
  ColorDPosition: 0.5429760217666626,
  SpecularColor: new THREE.Color(1.0, 1.0, 1.0),
  SpecularStrength: 0.8779469728469849,
  SpecularEdgeSmooth: 0.0,
  SpecularOpacity: 0.5,
  StepTime: new THREE.Vector2(1.0, 1.0),
  UVStepSize: new THREE.Vector2(0.5, 0.5),
  NoiseStrength: 3.0,
  OutlinesColor: new THREE.Color(1.0, 1.0, 1.0),
  OutlineWidth: 0.1,
  OutlinesGeneralOffset: 3.0,
  SingleOutlineDifference: 5.0,
  OutlineDirectionalOffset: new THREE.Vector3(5.96e-8, 1.0, 0.5847287178039551),
  InnerErosionStrength: 3.0,
  InnerErosionTiling: 2.0,
  PlanarInnerErosionStrength: 2.0,
  OuterErosionStrength: 1.0,
  OuterErosionTiling: 10.0,
  PlanarOuterErosionStrength: 5.0,
  PlanarEdgeErosionOutlineMaskStrength: 0.05,
  ShadowStrength: 0.2,
};

const textureLoader = new THREE.TextureLoader();
let cachedTextures: {
  brushStrokes: THREE.Texture;
  brushStrokesPacked: THREE.Texture;
  heightMap: THREE.Texture;
  tilingNoise: THREE.Texture;
} | null = null;

function loadAllTextures() {
  if (cachedTextures) return cachedTextures;
  const setup = (url: string) => {
    const t = textureLoader.load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  cachedTextures = {
    brushStrokes: setup(brushStrokesUrl),
    brushStrokesPacked: setup(brushStrokesPackedUrl),
    heightMap: setup(brushHeightUrl),
    tilingNoise: setup(tilingNoiseUrl),
  };
  return cachedTextures;
}

export type PainterlyParams = {
  // PerInstanceCustomData[0] in UE: 0=base mesh, 1=shells/rim variant,
  // 2=outline. The MF_SwitchByInstanceData call gates BaseColor /
  // WorldPositionOffset on this; the auto-translated graph honours that.
  variant?: 0 | 1 | 2;
  // Substitutes for UE's SkyAtmosphereLightDirection. Pass the scene's
  // dominant directional light. The host should call syncLightDir() each
  // frame so the cel ramp & specular highlight track sun motion.
  sun: THREE.DirectionalLight;
  // Optional: per-mesh random scalar driving brushstroke phase, outline
  // directional offset, etc. Defaults to a fresh Math.random() so each
  // material handle reads a different bit of the brush textures.
  randomSeed?: number;
  // Optional: shell layer index (0 = innermost). Used by shell variants
  // (variant=1) to drive the inflate via PerInstanceCustomData[4].
  shellOffset?: number;
};

export type PainterlyMaterialHandle = {
  material: THREE.MeshBasicNodeMaterial;
  uniforms: Record<string, any>;
  setVariant(v: 0 | 1 | 2): void;
  setLight(light: THREE.DirectionalLight): void;
  syncLightDir(): void;
};

export function createPainterlyMaterial(params: PainterlyParams): PainterlyMaterialHandle {
  const textures = loadAllTextures();

  // Uniforms registry that buildPainterly will populate as it walks the
  // ScalarParameter / VectorParameter expressions. We pre-seed the engine-
  // state uniforms (sun, per-instance) so the graph can reference them.
  // PerInstanceCustomData is split across two vec4 uniforms so the graph's
  // up-to-index-7 lookups (DataIndex 4 and 5 are used for shell offsets and
  // additional gates) resolve to real values.
  const seed = params.randomSeed ?? Math.random();
  const shellOffset = params.shellOffset ?? 0;
  const uniforms: Record<string, any> = {
    sunDirection: uniform(new THREE.Vector3(0.6, 0.8, 0.4)),
    perInstanceCustomData: uniform(new THREE.Vector4(0, 0, 0, 0)),
    perInstanceCustomDataB: uniform(new THREE.Vector4(shellOffset, 0, 0, 0)),
    perInstanceRandom: uniform(seed),
  };

  // Run the generated graph. buildPainterly returns one TSL node per UE
  // material output pin.
  const out = buildPainterly(uniforms, textures);

  const material = new THREE.MeshBasicNodeMaterial();

  // UE's main material composes visible color from BaseColor + EmissiveColor
  // (since this material's Specular pin is wired to EmissiveColor in the
  // graph and BaseColor receives the cel-shaded diffuse). MeshBasicNodeMaterial
  // has no light pipeline so we recombine them here.
  //
  // OpacityMask: the UE material is `BLEND_Masked` with no explicit
  // `OpacityMaskClipValue`, which means UE's default of 0.333 applies. The
  // OpacityMask pin is wired to a vec3 (the ShadowReplace passthrough of
  // the cel-ramp / outline lerp). UE auto-coerces vec3 → scalar by taking
  // the R channel, so we do the same. This produces UE's actual rendered
  // behaviour: deep-shadow pixels (ColorC/D ramp bands where R < 0.333)
  // get alpha-clipped, contributing to the broken-edge painterly look.
  const visibleRGB = out.baseColor.add(out.emissiveColor);
  const opacityScalar = out.opacityMask ? out.opacityMask.r : float(1.0);
  material.colorNode = vec4(visibleRGB, opacityScalar);
  material.alphaTest = 0.333;
  material.transparent = false;

  // WorldPositionOffset: UE renders in centimeters by default; three.js
  // scenes here use meters. The bus_Inflate output is therefore ~100×
  // larger than we need, which makes outline meshes spray vertices several
  // metres into space. Scale the offset to convert cm → m so distance
  // parameters (OutlineWidth, OutlinesGeneralOffset, SingleOutlineDifference)
  // read as authored.
  const UE_CM_TO_METERS = 0.01;
  const worldOffsetRaw = out.worldPositionOffset ?? vec3(0, 0, 0);
  const worldOffset = worldOffsetRaw.mul(float(UE_CM_TO_METERS));
  // Transform the world-space offset into local space via the mesh's
  // world-inverse so it can ride alongside positionLocal in the standard
  // vertex transform. For SkinnedMesh, `positionLocal` is the post-skinning
  // position in TSL, so adding our offset gives skinned + offset.
  const localOffset = modelWorldMatrixInverse.mul(vec4(worldOffset, 0)).xyz;
  material.positionNode = positionLocal.add(localOffset);

  const handle: PainterlyMaterialHandle = {
    material,
    uniforms,
    setVariant(v: 0 | 1 | 2) {
      uniforms.perInstanceCustomData.value.x = v;
      // Outline meshes render the back faces of an inflated hull copy.
      material.side = v === 2 ? THREE.BackSide : THREE.FrontSide;
      material.needsUpdate = true;
    },
    setLight(light: THREE.DirectionalLight) {
      params.sun = light;
      handle.syncLightDir();
    },
    syncLightDir() {
      const target = params.sun.target.position;
      const pos = params.sun.position;
      uniforms.sunDirection.value.copy(pos).sub(target).normalize();
    },
  };

  handle.setVariant(params.variant ?? 0);
  handle.syncLightDir();

  return handle;
}

/**
 * Overlay a UE MaterialInstance preset onto an existing painterly handle's
 * uniforms. Only parameters present in the preset are mutated; everything
 * else stays at its current value (matching UE's MaterialInstance "override
 * on top of parent" semantics).
 */
export function applyPainterlyPreset(
  handle: PainterlyMaterialHandle,
  preset: PainterlyPreset,
): void {
  if (preset.scalars) {
    for (const [name, value] of Object.entries(preset.scalars)) {
      const u = handle.uniforms[name];
      if (u !== undefined) u.value = value;
    }
  }
  if (preset.vectors) {
    for (const [name, { r, g, b }] of Object.entries(preset.vectors)) {
      const u = handle.uniforms[name];
      if (u !== undefined && u.value && typeof u.value.setRGB === "function") {
        u.value.setRGB(r, g, b);
      } else if (u !== undefined && u.value) {
        // THREE.Color falls back to direct assignment when setRGB is missing.
        u.value.r = r; u.value.g = g; u.value.b = b;
      }
    }
  }
}
