// AUTO-GENERATED from the painterly material T3D dumps via
// assets/painterly/generate_tsl.py. Do not edit; regenerate.
// @ts-nocheck

import * as THREE from "three/webgpu";
import {
  abs, add, ceil, clamp, cos, dFdx, dFdy, dot, float, fract, length,
  max, min, mix, mod, normalize, normalLocal, normalWorld,
  positionLocal, positionWorld, pow, saturate, select, sin, smoothstep,
  step, sub, time as timeNode, uniform, uv, vec2, vec3, vec4,
  attribute, modelWorldMatrix, cameraPosition,
  texture as textureNode,
} from "three/tsl";


// ---------- Module-level TSL fragments ----------
// These are node-level constants (not parameter-driven) referenced by the
// auto-translated graph and material function bodies. They sit at module
// scope so MFs defined below can use them too.

const texCoord0 = uv();
const globalTime = timeNode;
const cameraVectorWS = normalize(cameraPosition.sub(positionWorld));
const objectPivotWS = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
// UE's TwoSidedSign returns +1 for front-facing, -1 for back. Three.js
// material.side controls which faces are drawn but TSL doesn't surface
// gl_FrontFacing universally; we use +1 so back-faces (used by the
// outline mesh) get the same shading.
const twoSidedSign = float(1);


// ---------- Helpers used by the auto-generated graph ----------

/**
 * Manages a uniforms object the host owns. P() / PV() return the same
 * uniform node for repeat lookups so multiple UE Parameter expressions
 * with the same name share one runtime uniform.
 */
export function makeParamRegistry(uniformsObj) {
  return {
    P(name, defaultValue) {
      if (!(name in uniformsObj)) {
        uniformsObj[name] = uniform(defaultValue);
      }
      return uniformsObj[name];
    },
    PV(name, r, g, b) {
      if (!(name in uniformsObj)) {
        uniformsObj[name] = uniform(new THREE.Color(r, g, b));
      }
      return uniformsObj[name];
    },
  };
}

/** UE If: chooses between A>B / A==B (within EqualsThreshold) / A<B. */
export function ueIf(a, b, agt, aeq, alt, thresh) {
  const diff = a.sub(b);
  const isEqual = abs(diff).lessThan(thresh);
  const isGreater = diff.greaterThan(thresh);
  return select(isEqual, aeq, select(isGreater, agt, alt));
}

/** Faithful UE Append: works for vec1+vec1->vec2, vec2+vec1->vec3,
 *  vec3+vec1->vec4 (the cases that show up in the painterly graph). */
export function appendVec(a, b) {
  // We can't introspect TSL node dimensions reliably, but the painterly
  // graph only uses two-scalar appends (MF_AnimateUV's final vec2). For any
  // other appearance we fall back to a vec3 packing.
  return vec2(a, b);
}

/** UE RotateAboutAxis: Rodrigues rotation around `axis` (assumed unit) by
 *  `angle` revolutions (1.0 = full turn) about `pivot`. */
export function rotateAboutAxis(position, axis, angle, pivot) {
  const p = position.sub(pivot);
  const a = angle.mul(Math.PI * 2);
  const c = cos(a);
  const s = sin(a);
  const oneMinusC = float(1).sub(c);
  const cross = vec3(
    axis.y.mul(p.z).sub(axis.z.mul(p.y)),
    axis.z.mul(p.x).sub(axis.x.mul(p.z)),
    axis.x.mul(p.y).sub(axis.y.mul(p.x)),
  );
  const dotAP = dot(axis, p);
  const rotated = p.mul(c).add(cross.mul(s)).add(axis.mul(dotAP).mul(oneMinusC));
  return rotated.add(pivot);
}

/** Per-instance custom data accessor. UE samples the active instance's
 *  CustomData[idx]; we back slots 0..3 with one vec4 uniform and 4..7 with
 *  a second so the painterly material's shell layer logic (which reads
 *  index 4 and 5) gets real values. Falls back to `defaultValue` when the
 *  host hasn't seeded the uniform. */
export function perInstanceCustomData(uniforms, index, defaultValue) {
  const idx = index | 0;
  if (idx < 4) {
    const u = uniforms.perInstanceCustomData;
    if (u == null) return float(defaultValue);
    if (idx === 0) return u.x;
    if (idx === 1) return u.y;
    if (idx === 2) return u.z;
    return u.w;
  }
  if (idx < 8) {
    const u = uniforms.perInstanceCustomDataB;
    if (u == null) return float(defaultValue);
    const sub = idx - 4;
    if (sub === 0) return u.x;
    if (sub === 1) return u.y;
    if (sub === 2) return u.z;
    return u.w;
  }
  return float(defaultValue);
}

export function perInstanceRandom(uniforms) {
  return uniforms.perInstanceRandom != null
    ? uniforms.perInstanceRandom
    : float(0);
}

/** Wraps a TextureNode so engine helpers can call `.sample(uv)` on it. */
export function texObject(textureNodeRef) {
  return { sample: (sampleUV) => textureNodeRef.sample(sampleUV) };
}

/** Returns the full vec4 sample at `uvCoords` from a TextureNode. */
export function sampleTexture(textureNodeRef, uvCoords) {
  return textureNodeRef.sample(uvCoords);
}


// ---------- UE engine material function ports ----------

/** AddComponents (Engine_MaterialFunctions02/Math): per-component sums.
 *  UE outputs: [0]=f2.x+f2.y, [1]=f3.dot(1), [2]=f4.dot(1).
 *  Consumers index via OutputIndex on the connection. */
export function engineAddComponents(f2, f3, f4) {
  return [
    f2 != null ? f2.x.add(f2.y) : float(0),
    f3 != null ? f3.x.add(f3.y).add(f3.z) : float(0),
    f4 != null ? f4.x.add(f4.y).add(f4.z).add(f4.w) : float(0),
  ];
}

/** ObjectPivotPoint: world-space pivot of the active model. */
export function engineObjectPivotPoint() {
  return [modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz];
}

/** BlendAngleCorrectedNormals (UE engine MF) — Reoriented Normal Mapping. */
export function engineBlendAngleCorrectedNormals(base, additional) {
  if (base == null) base = vec3(0, 0, 1);
  if (additional == null) additional = vec3(0, 0, 1);
  const t = base.add(vec3(0, 0, 1));
  const u = additional.mul(vec3(-1, -1, 1));
  const blended = normalize(t.mul(dot(t, u)).sub(u.mul(t.z)));
  return [blended];
}

/** NormalFromHeightmap (UE engine MF). UE FunctionInputs order:
 *    0 = Height Map (texObject)
 *    1 = Normal Map Intensity (scalar)
 *    2 = Height Map UV Offset (vec2)
 *    3 = Coordinates (vec2)
 *    4 = Height Map Channel Selector (vec4 mask)
 *  Unconnected slots arrive as `undefined`. */
export function engineNormalFromHeightmap(heightTextureObject, intensity, uvOffset, coordinates, channelSelector) {
  const epsilon = float(1.0 / 1024.0);
  const intens = intensity != null ? intensity : float(0.05);
  const baseUV = coordinates != null ? coordinates : uv();
  const offset = uvOffset != null ? uvOffset : vec2(0, 0);
  const sampleUV = baseUV.add(offset);
  // Channel selector is RGBA mask — defaults to .R only (matches UE default).
  const selectChan = (sample) => {
    if (channelSelector == null) return sample.r;
    return sample.r.mul(channelSelector.x)
      .add(sample.g.mul(channelSelector.y))
      .add(sample.b.mul(channelSelector.z))
      .add(sample.a.mul(channelSelector.w));
  };
  const h  = selectChan(heightTextureObject.sample(sampleUV));
  const hX = selectChan(heightTextureObject.sample(sampleUV.add(vec2(epsilon, 0))));
  const hY = selectChan(heightTextureObject.sample(sampleUV.add(vec2(0, epsilon))));
  const dx = h.sub(hX);
  const dy = h.sub(hY);
  return [normalize(vec3(dx, dy, max(intens, float(0.001))))];
}


// ---------- Project material functions ----------

// mfAnimateUV (Step Time=in_0, Step Size=in_1, Tiling=in_2) -> [[0]=MaterialExpressionFunctionOutput_0]
export function mfAnimateUV(in_0, in_1, in_2) {
  const texturecoordinate_1_0 = texCoord0;
  const componentmask_6_1 = (texturecoordinate_1_0).x;
  const multiply_2_2 = (componentmask_6_1).mul(in_2);
  const time_0_3 = globalTime;
  const componentmask_0_4 = (in_0).x;
  const fmod_0_5 = mod(time_0_3, componentmask_0_4);
  const subtract_0_6 = (time_0_3).sub(fmod_0_5);
  const componentmask_2_7 = (in_1).x;
  const multiply_0_8 = (subtract_0_6).mul(componentmask_2_7);
  const add_0_9 = (multiply_2_2).add(multiply_0_8);
  const componentmask_7_10 = (texturecoordinate_1_0).y;
  const multiply_3_11 = (componentmask_7_10).mul(in_2);
  const componentmask_1_12 = (in_0).y;
  const fmod_1_13 = mod(time_0_3, componentmask_1_12);
  const subtract_1_14 = (time_0_3).sub(fmod_1_13);
  const componentmask_3_15 = (in_1).y;
  const multiply_1_16 = (subtract_1_14).mul(componentmask_3_15);
  const add_1_17 = (multiply_3_11).add(multiply_1_16);
  const appendvector_0_18 = appendVec(add_0_9, add_1_17);
  return [
    appendvector_0_18,
  ];
}

// mfCurvatureFilter (Input Normal=in_0) -> [[0]=MaterialExpressionFunctionOutput_0]
export function mfCurvatureFilter(in_0) {
  const ddy_0_0 = dFdy(in_0);
  const abs_0_1 = abs(ddy_0_0);
  const ddx_0_2 = dFdx(in_0);
  const abs_1_3 = abs(ddx_0_2);
  const add_0_4 = (abs_0_1).add(abs_1_3);
  const materialfunctioncall_0_5 = engineAddComponents(add_0_4, undefined, undefined);
  const subtract_0_6 = (materialfunctioncall_0_5[0]).sub(float(2e-06));
  const ceil_0_7 = ceil(subtract_0_6);
  return [
    ceil_0_7,
  ];
}

// mfSwitchByInstanceData (PerInstanceCustomData=in_0) -> [[0]=Base_vs_Rim, [1]=Combined_vs_Outline]
export function mfSwitchByInstanceData(in_0) {
  const constant_0_0 = float(0.5);
  const constant_1_1 = float(1.0);
  const constant_2_2 = float(0);
  const if_0_3 = ueIf(in_0, constant_0_0, constant_1_1, constant_2_2, constant_2_2, 1e-05);
  const reroute_0_4 = in_0;
  const constant_3_5 = float(1.5);
  const constant_5_6 = float(1.0);
  const constant_6_7 = float(0);
  const if_1_8 = ueIf(reroute_0_4, constant_3_5, constant_5_6, constant_6_7, constant_6_7, 1e-05);
  return [
    if_0_3,
    if_1_8,
  ];
}



// ---------- Main painterly material graph ----------

/**
 * Build the full painterly material graph. Parameter uniforms are written
 * onto the supplied `uniforms` object; the host can mutate them at runtime
 * (live tweakpane) or snapshot them.
 *
 * @param uniforms - mutable map of `name -> TSL uniform node`. Populated by
 *   ScalarParameter / VectorParameter expressions; should also be pre-seeded
 *   with `sunDirection`, `perInstanceCustomData`, `perInstanceRandom`.
 * @param resources - { brushStrokes, brushStrokesPacked, heightMap }, all
 *   THREE.Texture instances.
 * @returns map of UE-side material output pin nodes ready to feed into a
 *   MeshNodeMaterial / MeshBasicNodeMaterial.
 */
export function buildPainterly(uniforms, resources) {
  const reg = makeParamRegistry(uniforms);
  const P = reg.P;
  const PV = reg.PV;

  // texCoord0, globalTime, cameraVectorWS, objectPivotWS, twoSidedSign are
  // module-scope constants (defined above). The sun direction is the only
  // engine-state node that depends on the host's uniforms object.
  const sunDirection = uniforms.sunDirection;

  // Texture references — TSL TextureNodes wrapping the host's THREE.Textures.
  const tex_T_BrushStrokes = textureNode(resources.brushStrokes);
  const tex_T_BrushStrokes_Packed = textureNode(resources.brushStrokesPacked);
  const tex_T_Messy_BrushStrokes_HeightMap = textureNode(resources.heightMap);
  // /Engine/MapTemplates/TilingNoise05 — UE engine-bundled tiling noise.
  const tex_TilingNoise05 = textureNode(resources.tilingNoise);


  const textureobject_0_0 = texObject(tex_T_BrushStrokes);
  const constant_2_1 = float(0.3);
  const materialfunctioncall_12_2 = engineNormalFromHeightmap(textureobject_0_0, constant_2_1, undefined, undefined, undefined);
  const bus_Normals = materialfunctioncall_12_2[0];
  const worldposition_3_3 = positionWorld;
  const objectpositionws_3_4 = objectPivotWS;
  const subtract_14_5 = (worldposition_3_3).sub(objectpositionws_3_4);
  const normalize_4_6 = normalize(subtract_14_5);
  const scalarparameter_12_7 = P("OuterErosionStrength", 1.0);
  const scalarparameter_8_8 = P("OutlinesGeneralOffset", 3.0);
  const perinstancecustomdata_4_9 = perInstanceCustomData(uniforms, 0, 0);
  const materialfunctioncall_8_10 = mfSwitchByInstanceData(perinstancecustomdata_4_9);
  const linearinterpolate_3_11 = mix(scalarparameter_12_7, scalarparameter_8_8, materialfunctioncall_8_10[1]);
  const multiply_15_12 = (normalize_4_6).mul(linearinterpolate_3_11);
  const perinstancerandom_1_13 = perInstanceRandom(uniforms);
  const multiply_18_14 = (perinstancerandom_1_13).mul(float(10000.0));
  const frac_0_15 = fract(multiply_18_14);
  const add_5_16 = (frac_0_15).add(float(1.25));
  const multiply_16_17 = (multiply_15_12).mul(add_5_16);
  const multiply_17_18 = (multiply_16_17).mul(float(0.8));
  const subtract_1_19 = (frac_0_15).sub(float(0.5));
  const vectorparameter_0_20 = PV("OutlineDirectionalOffset", 0.0, 1.0, 0.584729);
  const scalarparameter_10_21 = P("SingleOutlineDifference", 5.0);
  const multiply_49_22 = (vectorparameter_0_20).mul(scalarparameter_10_21);
  const worldposition_5_23 = positionWorld;
  const constant3vector_2_24 = vec3(1.0, 0.0, 0.0);
  const vectorparameter_12_25 = PV("OutlineRotation", 0.0, 0.0, 0.0);
  const materialfunctioncall_1_26 = engineObjectPivotPoint();
  const rotateaboutaxis_1_27 = rotateAboutAxis(worldposition_5_23, constant3vector_2_24, vectorparameter_12_25.x, materialfunctioncall_1_26[0]);
  const reroute_12_28 = rotateaboutaxis_1_27;
  const reroute_30_29 = worldposition_5_23;
  const constant3vector_4_30 = vec3(0.0, 1.0, 0.0);
  const vectorparameter_13_31 = PV("OutlineRotation", 0.0, 0.0, 0.0);
  const reroute_4_32 = materialfunctioncall_1_26[0];
  const reroute_9_33 = reroute_4_32;
  const rotateaboutaxis_2_34 = rotateAboutAxis(reroute_30_29, constant3vector_4_30, vectorparameter_13_31.y, reroute_9_33);
  const add_16_35 = (reroute_12_28).add(rotateaboutaxis_2_34);
  const reroute_31_36 = worldposition_5_23;
  const reroute_32_37 = reroute_31_36;
  const constant3vector_5_38 = vec3(0.0, 0.0, 1.0);
  const vectorparameter_14_39 = PV("OutlineRotation", 0.0, 0.0, 0.0);
  const reroute_11_40 = reroute_9_33;
  const rotateaboutaxis_3_41 = rotateAboutAxis(reroute_32_37, constant3vector_5_38, vectorparameter_14_39.z, reroute_11_40);
  const add_19_42 = (add_16_35).add(rotateaboutaxis_3_41);
  const add_14_43 = (multiply_49_22).add(add_19_42);
  const multiply_20_44 = (subtract_1_19).mul(add_14_43);
  const add_6_45 = (multiply_17_18).add(multiply_20_44);
  const bus_Inflate = add_6_45;
  const vectorparameter_17_46 = PV("Step Time", 1.0, 1.0, 0.0);
  const vectorparameter_18_47 = PV("UV Step Size", 0.5, 0.5, 0.0);
  const constant_24_48 = float(1.0);
  const materialfunctioncall_21_49 = mfAnimateUV(vectorparameter_17_46, vectorparameter_18_47, constant_24_48);
  const namedreroutedeclaration_7_50 = materialfunctioncall_21_49[0];
  const namedrerouteusage_14_51 = namedreroutedeclaration_7_50;
  const texturesample_11_52 = sampleTexture(tex_T_Messy_BrushStrokes_HeightMap, namedrerouteusage_14_51);
  const skyatmospherelightdirection_3_53 = sunDirection;
  const worldposition_7_54 = positionWorld;
  const objectpositionws_6_55 = objectPivotWS;
  const subtract_19_56 = (worldposition_7_54).sub(objectpositionws_6_55);
  const normalize_8_57 = normalize(subtract_19_56);
  const dotproduct_7_58 = dot(skyatmospherelightdirection_3_53, normalize_8_57);
  const power_8_59 = pow(dotproduct_7_58, float(5.0));
  const multiply_31_60 = (texturesample_11_52).mul(power_8_59);
  const saturate_5_61 = saturate(multiply_31_60);
  const scalarparameter_5_62 = P("ShadowStrength", 0.2);
  const add_11_63 = (saturate_5_61).add(scalarparameter_5_62);
  const perinstancecustomdata_6_64 = perInstanceCustomData(uniforms, 0, 0);
  const materialfunctioncall_25_65 = mfSwitchByInstanceData(perinstancecustomdata_6_64);
  const perinstancecustomdata_11_66 = perInstanceCustomData(uniforms, 1, 0);
  const constant_8_67 = float(2.0);
  const constant_9_68 = float(0);
  const if_2_69 = ueIf(perinstancecustomdata_11_66, float(0), constant_8_67, constant_9_68, constant_9_68, 1e-05);
  const reroute_23_70 = if_2_69;
  const constant_11_71 = float(1.0);
  const constant_10_72 = float(0);
  const if_3_73 = ueIf(materialfunctioncall_25_65[0], reroute_23_70, constant_11_71, constant_10_72, constant_11_71, 1e-05);
  const linearinterpolate_13_74 = mix(add_11_63, float(0.0), if_3_73);
  const bus_Shadows = linearinterpolate_13_74;
  const cameravectorws_6_75 = cameraVectorWS;
  const worldposition_1_76 = positionWorld;
  const objectpositionws_2_77 = objectPivotWS;
  const subtract_12_78 = (worldposition_1_76).sub(objectpositionws_2_77);
  const normalize_3_79 = normalize(subtract_12_78);
  const dotproduct_6_80 = dot(cameravectorws_6_75, normalize_3_79);
  const power_16_81 = pow(dotproduct_6_80, float(0.5));
  const oneminus_14_82 = float(1).sub(power_16_81);
  const texturecoordinate_2_83 = texCoord0;
  const componentmask_9_84 = (texturecoordinate_2_83).y;
  const constant_15_85 = float(0.5);
  const multiply_36_86 = (componentmask_9_84).mul(constant_15_85);
  const sine_4_87 = sin(multiply_36_86);
  const oneminus_12_88 = float(1).sub(sine_4_87);
  const scalarparameter_23_89 = P("PlanarEdgeErosionOutlineMaskStrength", 0.05);
  const power_14_90 = pow(oneminus_12_88, scalarparameter_23_89);
  const constant_14_91 = float(0.01);
  const subtract_10_92 = (power_14_90).sub(constant_14_91);
  const componentmask_8_93 = (texturecoordinate_2_83).x;
  const multiply_37_94 = (componentmask_8_93).mul(constant_15_85);
  const sine_5_95 = sin(multiply_37_94);
  const oneminus_13_96 = float(1).sub(sine_5_95);
  const power_15_97 = pow(oneminus_13_96, scalarparameter_23_89);
  const subtract_11_98 = (power_15_97).sub(constant_14_91);
  const linearinterpolate_19_99 = mix(subtract_10_92, subtract_11_98, float(0));
  const linearinterpolate_20_100 = mix(float(0), oneminus_14_82, linearinterpolate_19_99);
  const abs_5_101 = abs(linearinterpolate_20_100);
  const multiply_38_102 = (abs_5_101).mul(float(0.5));
  const saturate_4_103 = saturate(multiply_38_102);
  const multiply_39_104 = (saturate_4_103).mul(float(3.0));
  const saturate_9_105 = saturate(multiply_39_104);
  const power_17_106 = pow(saturate_9_105, float(1.5));
  const perinstancerandom_2_107 = perInstanceRandom(uniforms);
  const add_12_108 = (perinstancerandom_2_107).add(float(0.5));
  const multiply_46_109 = (float(0.5)).mul(add_12_108);
  const step_5_110 = step(power_17_106, multiply_46_109);
  const oneminus_15_111 = float(1).sub(step_5_110);
  const reroute_28_112 = oneminus_15_111;
  const cameravectorws_2_113 = cameraVectorWS;
  const vertexnormalws_3_114 = normalWorld;
  const dotproduct_3_115 = dot(cameravectorws_2_113, vertexnormalws_3_114);
  const abs_2_116 = abs(dotproduct_3_115);
  const multiply_11_117 = (abs_2_116).mul(float(0.5));
  const saturate_11_118 = saturate(multiply_11_117);
  const multiply_12_119 = (saturate_11_118).mul(float(4.5));
  const saturate_12_120 = saturate(multiply_12_119);
  const power_3_121 = pow(saturate_12_120, float(1.5));
  const scalarparameter_7_122 = P("OutlineWidth", 0.1);
  const perinstancecustomdata_5_123 = perInstanceCustomData(uniforms, 0, 0);
  const materialfunctioncall_9_124 = mfSwitchByInstanceData(perinstancecustomdata_5_123);
  const linearinterpolate_4_125 = mix(float(1.0), scalarparameter_7_122, materialfunctioncall_9_124[1]);
  const perinstancerandom_0_126 = perInstanceRandom(uniforms);
  const add_3_127 = (perinstancerandom_0_126).add(float(0.5));
  const multiply_13_128 = (linearinterpolate_4_125).mul(add_3_127);
  const step_2_129 = step(power_3_121, multiply_13_128);
  const materialfunctioncall_3_130 = mfCurvatureFilter(vertexnormalws_3_114);
  const multiply_14_131 = (step_2_129).mul(materialfunctioncall_3_130[0]);
  const vertexnormalws_11_132 = normalWorld;
  const materialfunctioncall_16_133 = mfCurvatureFilter(vertexnormalws_11_132);
  const linearinterpolate_26_134 = mix(reroute_28_112, multiply_14_131, materialfunctioncall_16_133[0]);
  const namedreroutedeclaration_3_135 = linearinterpolate_26_134;
  const namedrerouteusage_7_136 = namedreroutedeclaration_3_135;
  const cameravectorws_3_137 = cameraVectorWS;
  const reroute_27_138 = cameravectorws_3_137;
  const componentmask_7_139 = (reroute_27_138).xz;
  const scalarparameter_16_140 = P("OuterErosionTiling", 10.0);
  const multiply_33_141 = (componentmask_7_139).mul(scalarparameter_16_140);
  const texturesample_2_142 = sampleTexture(tex_T_BrushStrokes_Packed, multiply_33_141);
  const worldposition_0_143 = positionWorld;
  const objectpositionws_1_144 = objectPivotWS;
  const subtract_9_145 = (worldposition_0_143).sub(objectpositionws_1_144);
  const normalize_2_146 = normalize(subtract_9_145);
  const dotproduct_4_147 = dot(cameravectorws_3_137, normalize_2_146);
  const power_12_148 = pow(dotproduct_4_147, float(0.1));
  const oneminus_8_149 = float(1).sub(power_12_148);
  const texturecoordinate_1_150 = texCoord0;
  const componentmask_6_151 = (texturecoordinate_1_150).y;
  const constant_12_152 = float(0.5);
  const multiply_29_153 = (componentmask_6_151).mul(constant_12_152);
  const sine_2_154 = sin(multiply_29_153);
  const oneminus_6_155 = float(1).sub(sine_2_154);
  const scalarparameter_19_156 = P("PlanarOuterErosionStrength", 5.0);
  const power_10_157 = pow(oneminus_6_155, scalarparameter_19_156);
  const constant_13_158 = float(0.2);
  const subtract_7_159 = (power_10_157).sub(constant_13_158);
  const componentmask_5_160 = (texturecoordinate_1_150).x;
  const multiply_30_161 = (componentmask_5_160).mul(constant_12_152);
  const sine_3_162 = sin(multiply_30_161);
  const oneminus_7_163 = float(1).sub(sine_3_162);
  const power_11_164 = pow(oneminus_7_163, scalarparameter_19_156);
  const subtract_8_165 = (power_11_164).sub(constant_13_158);
  const linearinterpolate_14_166 = mix(subtract_7_159, subtract_8_165, float(0));
  const linearinterpolate_15_167 = mix(float(0), oneminus_8_149, linearinterpolate_14_166);
  const abs_4_168 = abs(linearinterpolate_15_167);
  const add_9_169 = (abs_4_168).add(float(0.1));
  const multiply_32_170 = (add_9_169).mul(float(1.5));
  const saturate_2_171 = saturate(multiply_32_170);
  const power_13_172 = pow(saturate_2_171, float(1.0));
  const oneminus_16_173 = float(1).sub(power_13_172);
  const multiply_35_174 = (texturesample_2_142.w).mul(oneminus_16_173);
  const step_4_175 = step(multiply_35_174, float(0.2));
  const saturate_3_176 = saturate(step_4_175);
  const oneminus_17_177 = float(1).sub(saturate_3_176);
  const cameravectorws_4_178 = cameraVectorWS;
  const componentmask_2_179 = (cameravectorws_4_178).xz;
  const scalarparameter_17_180 = P("OuterErosionTiling", 10.0);
  const multiply_24_181 = (componentmask_2_179).mul(scalarparameter_17_180);
  const texturesample_3_182 = sampleTexture(tex_T_BrushStrokes_Packed, multiply_24_181);
  const vertexnormalws_5_183 = normalWorld;
  const dotproduct_5_184 = dot(cameravectorws_4_178, vertexnormalws_5_183);
  const abs_1_185 = abs(dotproduct_5_184);
  const add_8_186 = (abs_1_185).add(float(0.1));
  const multiply_23_187 = (add_8_186).mul(float(1.5));
  const saturate_15_188 = saturate(multiply_23_187);
  const power_5_189 = pow(saturate_15_188, float(1.0));
  const multiply_25_190 = (texturesample_3_182.w).mul(power_5_189);
  const step_3_191 = step(multiply_25_190, float(0.2));
  const saturate_16_192 = saturate(step_3_191);
  const oneminus_5_193 = float(1).sub(saturate_16_192);
  const vertexnormalws_10_194 = normalWorld;
  const materialfunctioncall_15_195 = mfCurvatureFilter(vertexnormalws_10_194);
  const linearinterpolate_25_196 = mix(oneminus_17_177, oneminus_5_193, materialfunctioncall_15_195[0]);
  const subtract_5_197 = (namedrerouteusage_7_136).sub(linearinterpolate_25_196);
  const saturate_17_198 = saturate(subtract_5_197);
  const linearinterpolate_11_199 = mix(float(1.0), float(0.0), saturate_17_198);
  const twosidedsign_1_200 = twoSidedSign;
  const oneminus_4_201 = float(1).sub(twosidedsign_1_200);
  const multiply_22_202 = (linearinterpolate_11_199).mul(oneminus_4_201);
  const bus_Outer_Eroded_Rim = multiply_22_202;
  const bus_EdgeErosionOutlineMask = linearinterpolate_26_134;
  const texturecoordinate_3_203 = texCoord0;
  const componentmask_11_204 = (texturecoordinate_3_203).y;
  const constant_18_205 = float(0.5);
  const multiply_47_206 = (componentmask_11_204).mul(constant_18_205);
  const sine_6_207 = sin(multiply_47_206);
  const oneminus_11_208 = float(1).sub(sine_6_207);
  const constant_19_209 = float(20.0);
  const power_18_210 = pow(oneminus_11_208, constant_19_209);
  const constant_17_211 = float(0.01);
  const subtract_15_212 = (power_18_210).sub(constant_17_211);
  const componentmask_10_213 = (texturecoordinate_3_203).x;
  const multiply_48_214 = (componentmask_10_213).mul(constant_18_205);
  const sine_7_215 = sin(multiply_48_214);
  const oneminus_18_216 = float(1).sub(sine_7_215);
  const power_19_217 = pow(oneminus_18_216, constant_19_209);
  const subtract_16_218 = (power_19_217).sub(constant_17_211);
  const linearinterpolate_22_219 = mix(subtract_15_212, subtract_16_218, float(0));
  const scalarparameter_20_220 = P("OutlineWidth", 0.1);
  const perinstancerandom_3_221 = perInstanceRandom(uniforms);
  const add_13_222 = (perinstancerandom_3_221).add(float(0.5));
  const multiply_50_223 = (scalarparameter_20_220).mul(add_13_222);
  const step_6_224 = step(linearinterpolate_22_219, multiply_50_223);
  const oneminus_19_225 = float(1).sub(step_6_224);
  const reroute_29_226 = multiply_14_131;
  const vertexnormalws_12_227 = normalWorld;
  const materialfunctioncall_17_228 = mfCurvatureFilter(vertexnormalws_12_227);
  const linearinterpolate_27_229 = mix(oneminus_19_225, reroute_29_226, materialfunctioncall_17_228[0]);
  const bus_Outlines = linearinterpolate_27_229;
  const vectorparameter_10_230 = PV("SpecularColor", 1.0, 1.0, 1.0);
  const scalarparameter_30_231 = P("SpecularOpacity", 0.5);
  const skyatmospherelightdirection_4_232 = sunDirection;
  const cameravectorws_11_233 = cameraVectorWS;
  const add_18_234 = (skyatmospherelightdirection_4_232).add(cameravectorws_11_233);
  const normalize_6_235 = normalize(add_18_234);
  const textureobject_2_236 = texObject(tex_TilingNoise05);
  const scalarparameter_15_237 = P("NoiseStrength", 3.0);
  const namedrerouteusage_3_238 = namedreroutedeclaration_7_50;
  const materialfunctioncall_22_239 = engineNormalFromHeightmap(textureobject_2_236, scalarparameter_15_237, undefined, namedrerouteusage_3_238, undefined);
  const worldposition_13_240 = positionWorld;
  const objectpositionws_12_241 = objectPivotWS;
  const subtract_26_242 = (worldposition_13_240).sub(objectpositionws_12_241);
  const normalize_16_243 = normalize(subtract_26_242);
  const vertexnormalws_14_244 = normalWorld;
  const reroute_3_245 = vertexnormalws_14_244;
  const materialfunctioncall_27_246 = mfCurvatureFilter(vertexnormalws_14_244);
  const linearinterpolate_29_247 = mix(normalize_16_243, reroute_3_245, materialfunctioncall_27_246[0]);
  const materialfunctioncall_23_248 = engineBlendAngleCorrectedNormals(materialfunctioncall_22_239[0], linearinterpolate_29_247);
  const dotproduct_13_249 = dot(normalize_6_235, materialfunctioncall_23_248[0]);
  const scalarparameter_28_250 = P("SpecularStrength", 0.877947);
  const subtract_24_251 = (dotproduct_13_249).sub(scalarparameter_28_250);
  const scalarparameter_29_252 = P("SpecularEdgeSmooth", 0);
  const divide_6_253 = (subtract_24_251).div(scalarparameter_29_252);
  const multiply_54_254 = (scalarparameter_30_231).mul(divide_6_253);
  const saturate_10_255 = saturate(multiply_54_254);
  const multiply_56_256 = (vectorparameter_10_230).mul(saturate_10_255);
  const bus_Specular = multiply_56_256;
  const vectorparameter_7_257 = PV("ColorD", 0.024158, 0.066626, 0.116971);
  const vectorparameter_9_258 = PV("ColorB", 0.637597, 0.879623, 1.0);
  const namedrerouteusage_4_259 = namedreroutedeclaration_7_50;
  const constant_23_260 = float(3.0);
  const multiply_45_261 = (namedrerouteusage_4_259).mul(constant_23_260);
  const constant2vector_10_262 = vec2(2.0, 1.0);
  const multiply_44_263 = (multiply_45_261).mul(constant2vector_10_262.xy);
  const texturesample_18_264 = sampleTexture(tex_T_Messy_BrushStrokes_HeightMap, multiply_44_263);
  const step_9_265 = step(texturesample_18_264, float(0.01));
  const skyatmospherelightdirection_0_266 = sunDirection;
  const textureobject_1_267 = texObject(tex_TilingNoise05);
  const scalarparameter_21_268 = P("NoiseStrength", 3.0);
  const materialfunctioncall_19_269 = engineNormalFromHeightmap(textureobject_1_267, scalarparameter_21_268, undefined, namedreroutedeclaration_7_50, undefined);
  const worldposition_10_270 = positionWorld;
  const objectpositionws_9_271 = objectPivotWS;
  const subtract_22_272 = (worldposition_10_270).sub(objectpositionws_9_271);
  const normalize_11_273 = normalize(subtract_22_272);
  const vertexnormalws_0_274 = normalWorld;
  const reroute_1_275 = vertexnormalws_0_274;
  const materialfunctioncall_13_276 = mfCurvatureFilter(vertexnormalws_0_274);
  const linearinterpolate_23_277 = mix(normalize_11_273, reroute_1_275, materialfunctioncall_13_276[0]);
  const materialfunctioncall_20_278 = engineBlendAngleCorrectedNormals(materialfunctioncall_19_269[0], linearinterpolate_23_277);
  const dotproduct_0_279 = dot(skyatmospherelightdirection_0_266, materialfunctioncall_20_278[0]);
  const scalarparameter_2_280 = P("ColorRampThreshold", 0.636954);
  const subtract_0_281 = (dotproduct_0_279).sub(scalarparameter_2_280);
  const multiply_0_282 = (subtract_0_281).mul(float(-1.0));
  const reroute_15_283 = multiply_0_282;
  const reroute_16_284 = reroute_15_283;
  const scalarparameter_3_285 = P("ColorDPosition", 0.542976);
  const constant_0_286 = float(0);
  const constant_1_287 = float(1.0);
  const if_0_288 = ueIf(reroute_16_284, scalarparameter_3_285, constant_0_286, constant_0_286, constant_1_287, 1e-05);
  const reroute_18_289 = if_0_288;
  const linearinterpolate_18_290 = mix(step_9_265, float(0), reroute_18_289);
  const linearinterpolate_0_291 = mix(vectorparameter_7_257, vectorparameter_9_258, linearinterpolate_18_290);
  const reroute_22_292 = linearinterpolate_0_291;
  const reroute_21_293 = reroute_22_292;
  const vectorparameter_6_294 = PV("ColorC", 0.174647, 0.450786, 0.545725);
  const namedrerouteusage_8_295 = namedreroutedeclaration_7_50;
  const constant_21_296 = float(1.0);
  const multiply_41_297 = (namedrerouteusage_8_295).mul(constant_21_296);
  const constant2vector_8_298 = vec2(1.0, 1.0);
  const multiply_40_299 = (multiply_41_297).mul(constant2vector_8_298.xy);
  const texturesample_16_300 = sampleTexture(tex_T_Messy_BrushStrokes_HeightMap, multiply_40_299);
  const step_7_301 = step(texturesample_16_300, float(0.1));
  const reroute_0_302 = multiply_0_282;
  const reroute_17_303 = reroute_0_302;
  const scalarparameter_4_304 = P("ColorCPosition", 0.222);
  const reroute_2_305 = constant_0_286;
  const if_1_306 = ueIf(reroute_17_303, scalarparameter_4_304, if_0_288, if_0_288, reroute_2_305, 1e-05);
  const reroute_7_307 = if_1_306;
  const linearinterpolate_16_308 = mix(step_7_301, float(0), reroute_7_307);
  const linearinterpolate_1_309 = mix(reroute_21_293, vectorparameter_6_294, linearinterpolate_16_308);
  const reroute_19_310 = linearinterpolate_1_309;
  const reroute_20_311 = reroute_19_310;
  const vectorparameter_8_312 = PV("ColorA", 0.972549, 0.992157, 1.0);
  const namedrerouteusage_9_313 = namedreroutedeclaration_7_50;
  const constant_22_314 = float(1.8);
  const multiply_43_315 = (namedrerouteusage_9_313).mul(constant_22_314);
  const constant2vector_9_316 = vec2(1.0, 1.0);
  const multiply_42_317 = (multiply_43_315).mul(constant2vector_9_316.xy);
  const texturesample_17_318 = sampleTexture(tex_T_Messy_BrushStrokes_HeightMap, multiply_42_317);
  const step_8_319 = step(texturesample_17_318, float(0.01));
  const ceil_0_320 = ceil(subtract_0_281);
  const reroute_5_321 = ceil_0_320;
  const reroute_6_322 = reroute_5_321;
  const linearinterpolate_17_323 = mix(step_8_319, float(0), reroute_6_322);
  const linearinterpolate_2_324 = mix(reroute_20_311, vectorparameter_8_312, linearinterpolate_17_323);
  const bus_Diffuse = linearinterpolate_2_324;
  const bus_AnimatedUV = materialfunctioncall_21_49[0];
  const namedrerouteusage_10_325 = bus_Diffuse;
  const vectorparameter_3_326 = PV("OutlinesColor", 1.0, 1.0, 1.0);
  const perinstancecustomdata_3_327 = perInstanceCustomData(uniforms, 0, 0);
  const materialfunctioncall_7_328 = mfSwitchByInstanceData(perinstancecustomdata_3_327);
  const linearinterpolate_12_329 = mix(namedrerouteusage_10_325, vectorparameter_3_326, materialfunctioncall_7_328[1]);
  const constant_3_330 = float(0);
  const constant_4_331 = float(1.0);
  const namedrerouteusage_5_332 = bus_Specular;
  const cameravectorws_1_333 = cameraVectorWS;
  const worldposition_2_334 = positionWorld;
  const objectpositionws_0_335 = objectPivotWS;
  const subtract_6_336 = (worldposition_2_334).sub(objectpositionws_0_335);
  const normalize_1_337 = normalize(subtract_6_336);
  const dotproduct_2_338 = dot(cameravectorws_1_333, normalize_1_337);
  const power_6_339 = pow(dotproduct_2_338, float(1.0));
  const oneminus_9_340 = float(1).sub(power_6_339);
  const texturecoordinate_0_341 = texCoord0;
  const componentmask_4_342 = (texturecoordinate_0_341).y;
  const constant_6_343 = float(0.5);
  const multiply_19_344 = (componentmask_4_342).mul(constant_6_343);
  const sine_0_345 = sin(multiply_19_344);
  const oneminus_1_346 = float(1).sub(sine_0_345);
  const scalarparameter_9_347 = P("PlanarInnerErosionStrength", 2.0);
  const power_2_348 = pow(oneminus_1_346, scalarparameter_9_347);
  const constant_5_349 = float(0.01);
  const subtract_3_350 = (power_2_348).sub(constant_5_349);
  const componentmask_3_351 = (texturecoordinate_0_341).x;
  const multiply_26_352 = (componentmask_3_351).mul(constant_6_343);
  const sine_1_353 = sin(multiply_26_352);
  const oneminus_3_354 = float(1).sub(sine_1_353);
  const power_4_355 = pow(oneminus_3_354, scalarparameter_9_347);
  const subtract_4_356 = (power_4_355).sub(constant_5_349);
  const linearinterpolate_8_357 = mix(subtract_3_350, subtract_4_356, float(0));
  const linearinterpolate_9_358 = mix(float(0), oneminus_9_340, linearinterpolate_8_357);
  const abs_3_359 = abs(linearinterpolate_9_358);
  const add_2_360 = (abs_3_359).add(float(0));
  const multiply_8_361 = (add_2_360).mul(float(0.5));
  const saturate_0_362 = saturate(multiply_8_361);
  const scalarparameter_1_363 = P("InnerErosionStrength", 3.0);
  const power_1_364 = pow(saturate_0_362, scalarparameter_1_363);
  const reroute_26_365 = cameravectorws_1_333;
  const componentmask_1_366 = (reroute_26_365).xz;
  const scalarparameter_0_367 = P("InnerErosionTiling", 2.0);
  const multiply_6_368 = (componentmask_1_366).mul(scalarparameter_0_367);
  const texturesample_1_369 = sampleTexture(tex_T_BrushStrokes_Packed, multiply_6_368);
  const multiply_10_370 = (texturesample_1_369.w).mul(float(0.25));
  const add_7_371 = (multiply_10_370).add(float(0.25));
  const multiply_9_372 = (power_1_364).mul(add_7_371);
  const step_1_373 = step(multiply_9_372, float(0.1));
  const saturate_1_374 = saturate(step_1_373);
  const cameravectorws_0_375 = cameraVectorWS;
  const vertexnormalws_1_376 = normalWorld;
  const reroute_25_377 = vertexnormalws_1_376;
  const dotproduct_1_378 = dot(cameravectorws_0_375, reroute_25_377);
  const abs_0_379 = abs(dotproduct_1_378);
  const add_0_380 = (abs_0_379).add(float(0));
  const multiply_2_381 = (add_0_380).mul(float(0.5));
  const saturate_7_382 = saturate(multiply_2_381);
  const scalarparameter_13_383 = P("InnerErosionStrength", 3.0);
  const power_0_384 = pow(saturate_7_382, scalarparameter_13_383);
  const componentmask_0_385 = (cameravectorws_0_375).xz;
  const scalarparameter_6_386 = P("InnerErosionTiling", 2.0);
  const perinstancecustomdata_7_387 = perInstanceCustomData(uniforms, 1, 0);
  const add_4_388 = (scalarparameter_6_386).add(perinstancecustomdata_7_387);
  const multiply_1_389 = (componentmask_0_385).mul(add_4_388);
  const texturesample_0_390 = sampleTexture(tex_T_BrushStrokes_Packed, multiply_1_389);
  const multiply_4_391 = (texturesample_0_390.w).mul(float(0.25));
  const add_1_392 = (multiply_4_391).add(float(0.25));
  const multiply_3_393 = (power_0_384).mul(add_1_392);
  const step_0_394 = step(multiply_3_393, float(0.1));
  const materialfunctioncall_2_395 = mfCurvatureFilter(vertexnormalws_1_376);
  const multiply_5_396 = (step_0_394).mul(materialfunctioncall_2_395[0]);
  const oneminus_0_397 = float(1).sub(multiply_5_396);
  const vertexnormalws_9_398 = normalWorld;
  const materialfunctioncall_14_399 = mfCurvatureFilter(vertexnormalws_9_398);
  const linearinterpolate_24_400 = mix(saturate_1_374, oneminus_0_397, materialfunctioncall_14_399[0]);
  const reroute_8_401 = linearinterpolate_24_400;
  const vectorparameter_4_402 = PV("Step Time", 1.0, 1.0, 0.0);
  const vectorparameter_5_403 = PV("UV Step Size", 0.5, 0.5, 0.0);
  const perinstancecustomdata_15_404 = perInstanceCustomData(uniforms, 1, 0);
  const materialfunctioncall_11_405 = mfAnimateUV(vectorparameter_4_402, vectorparameter_5_403, perinstancecustomdata_15_404);
  const texturesample_5_406 = sampleTexture(tex_T_BrushStrokes, materialfunctioncall_11_405[0]);
  const perinstancecustomdata_16_407 = perInstanceCustomData(uniforms, 2, 0);
  const divide_0_408 = (perinstancecustomdata_16_407).div(float(10.0));
  const power_9_409 = pow(divide_0_408, float(0));
  const multiply_34_410 = (texturesample_5_406.x).mul(power_9_409);
  const cameravectorws_5_411 = cameraVectorWS;
  const pixelnormalws_1_412 = normalWorld;
  const dotproduct_8_413 = dot(cameravectorws_5_411, pixelnormalws_1_412);
  const power_7_414 = pow(dotproduct_8_413, float(0));
  const perinstancecustomdata_18_415 = perInstanceCustomData(uniforms, 3, 0);
  const subtract_2_416 = (perinstancecustomdata_18_415).sub(float(0));
  const add_20_417 = (power_7_414).add(subtract_2_416);
  const add_21_418 = (multiply_34_410).add(add_20_417);
  const divide_1_419 = (add_21_418).div(float(0));
  const clamp_0_420 = clamp(divide_1_419, float(0), float(1));
  const oneminus_10_421 = float(1).sub(clamp_0_420);
  const multiply_7_422 = (oneminus_10_421).mul(linearinterpolate_24_400);
  const reroute_24_423 = multiply_7_422;
  const perinstancecustomdata_10_424 = perInstanceCustomData(uniforms, 5, 0);
  const linearinterpolate_5_425 = mix(reroute_8_401, reroute_24_423, perinstancecustomdata_10_424);
  const namedrerouteusage_2_426 = bus_Outer_Eroded_Rim;
  const perinstancecustomdata_1_427 = perInstanceCustomData(uniforms, 0, 0);
  const materialfunctioncall_5_428 = mfSwitchByInstanceData(perinstancecustomdata_1_427);
  const linearinterpolate_7_429 = mix(linearinterpolate_5_425, namedrerouteusage_2_426, materialfunctioncall_5_428[0]);
  const namedrerouteusage_0_430 = bus_Outlines;
  const perinstancecustomdata_2_431 = perInstanceCustomData(uniforms, 0, 0);
  const materialfunctioncall_6_432 = mfSwitchByInstanceData(perinstancecustomdata_2_431);
  const linearinterpolate_10_433 = mix(linearinterpolate_7_429, namedrerouteusage_0_430, materialfunctioncall_6_432[1]);
  const shadowreplace_1_434 = linearinterpolate_10_433;
  const namedrerouteusage_16_435 = bus_Normals;
  const worldposition_4_436 = positionWorld;
  const objectpositionws_4_437 = objectPivotWS;
  const subtract_13_438 = (worldposition_4_436).sub(objectpositionws_4_437);
  const normalize_5_439 = normalize(subtract_13_438);
  const perinstancecustomdata_9_440 = perInstanceCustomData(uniforms, 4, 0);
  const multiply_27_441 = (normalize_5_439).mul(perinstancecustomdata_9_440);
  const namedrerouteusage_1_442 = bus_Inflate;
  const perinstancecustomdata_0_443 = perInstanceCustomData(uniforms, 0, 0);
  const materialfunctioncall_4_444 = mfSwitchByInstanceData(perinstancecustomdata_0_443);
  const linearinterpolate_6_445 = mix(multiply_27_441, namedrerouteusage_1_442, materialfunctioncall_4_444[0]);

  return {
    baseColor: linearinterpolate_12_329,
    metallic: constant_3_330,
    roughness: constant_4_331,
    emissiveColor: namedrerouteusage_5_332,
    opacityMask: shadowreplace_1_434,
    normal: namedrerouteusage_16_435,
    worldPositionOffset: linearinterpolate_6_445,
  };
}