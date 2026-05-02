"""
Translator: parsed UE5 material graph -> TSL TypeScript.

Walks every MaterialExpression node in the parsed JSON for the main
material and the three project material functions, then emits one TSL
const per node in a single TypeScript module. Faithful node-for-node port
including:
  - Multi-output material functions (UE OutputIndex resolves to result[i]).
  - Per-instance custom data and per-instance random (uniform-backed).
  - Engine built-ins (AddComponents, BlendAngleCorrectedNormals,
    NormalFromHeightmap, ObjectPivotPoint).
  - ShadowReplace -> Default branch (three.js forward render = UE main pass).
  - SkyAtmosphereLightDirection -> the scene's main directional light dir.

Outputs `src/painterlyMaterial.generated.ts`.
"""

import json
import os
import re

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(os.path.dirname(THIS_DIR))


def load(name):
    with open(os.path.join(THIS_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def get_ref(v):
    if isinstance(v, dict):
        if "$ref" in v:
            return v["$ref"]
        if "Expression" in v:
            return get_ref(v["Expression"])
    return None


def get_output_index(slot):
    """UE serialises OutputIndex on the consuming side of a connection.
    Default to 0 when absent."""
    if isinstance(slot, dict):
        if "OutputIndex" in slot:
            try:
                return int(slot["OutputIndex"])
            except Exception:
                pass
    return 0


# ------------------------------------------------------------------
# UE engine material functions referenced via MaterialFunctionCall.
# Each entry maps the asset name to (helper symbol, [output names]).
# ------------------------------------------------------------------
ENGINE_FUNCTIONS = {
    "AddComponents":              ("engineAddComponents",            ["f2", "f3", "f4"]),
    "BlendAngleCorrectedNormals": ("engineBlendAngleCorrectedNormals",["Result"]),
    "NormalFromHeightmap":        ("engineNormalFromHeightmap",      ["Result"]),
    "ObjectPivotPoint":           ("engineObjectPivotPoint",         ["ObjectPivotPoint"]),
}

# Project-local material functions.
PROJECT_FUNCTIONS = {
    "MF_AnimateUV":            ("mfAnimateUV",            None),
    "MF_CurvatureFilter":      ("mfCurvatureFilter",      None),
    "MF_SwitchByInstanceData": ("mfSwitchByInstanceData", None),
}


class Translator:
    """Walks an expression graph, emitting `const X = ...;` TSL statements
    in topological-ish order. Caches every visited expression so shared
    subgraphs (Reroutes, NamedRerouteUsages) only get emitted once."""

    def __init__(self, graph, mf_outputs=None):
        self.graph = graph
        self.cache = {}            # expr name -> emitted TS expression string
        self.statements = []
        self.var_counter = 0
        # mf_outputs[mf_name] = list of FunctionOutput names in slot order;
        # used so MF results can be indexed by Output pin.
        self.mf_outputs = mf_outputs or {}

    def fresh(self, hint="e"):
        v = f"{hint}_{self.var_counter}"
        self.var_counter += 1
        return v

    def emit(self, hint, expr):
        v = self.fresh(hint)
        self.statements.append(f"  const {v} = {expr};")
        return v

    def get_input(self, obj, name, fallback="float(0)", const_field=None):
        """Resolve an input slot. Returns the TSL var (string) representing
        whatever feeds this slot, or a constant fallback / ConstX field."""
        slot = obj.get(name)
        if isinstance(slot, dict):
            ref = slot.get("Expression")
            if isinstance(ref, dict) and "$ref" in ref:
                src = ref["$ref"]
                expr = self.visit(src)
                # Multi-output: pick the right pin from a struct/array result.
                src_obj = self.graph.get(src)
                if src_obj is not None and src_obj.get("class") == "MaterialExpressionMaterialFunctionCall":
                    out_idx = get_output_index(slot)
                    expr = f"{expr}[{out_idx}]"
                # Channel masking — UE's connection-level mask. We only honour
                # it when the consumer asks for a strict subset of channels.
                if slot.get("Mask") == 1:
                    chans = []
                    for k, c in (("MaskR", "x"), ("MaskG", "y"),
                                 ("MaskB", "z"), ("MaskA", "w")):
                        if slot.get(k):
                            chans.append(c)
                    if chans and chans not in (["x", "y", "z"], ["x", "y", "z", "w"]):
                        return f"{expr}.{''.join(chans)}"
                return expr
        if const_field and const_field in obj:
            return f"float({obj[const_field]})"
        return fallback

    def visit(self, name):
        if name in self.cache:
            return self.cache[name]

        obj = self.graph.get(name)
        if obj is None:
            return f"/* missing:{name} */ float(0)"

        cls = obj.get("class", "").replace("MaterialExpression", "")
        method = getattr(self, f"v_{cls}", None)
        if method is None:
            expr = f"/* TODO: {cls} */ float(0)"
            var_name = self.emit(f"todo_{cls}_{name.rsplit('_',1)[-1]}", expr)
        else:
            expr = method(obj, name)
            var_name = self.emit(f"{cls.lower()}_{name.rsplit('_',1)[-1]}", expr)

        self.cache[name] = var_name
        return var_name

    # ---------- Pure math nodes ----------
    def v_Constant(self, obj, name):
        return f"float({obj.get('R', 0)})"

    def v_Constant2Vector(self, obj, name):
        return f"vec2({obj.get('R', 0)}, {obj.get('G', 0)})"

    def v_Constant3Vector(self, obj, name):
        c = obj.get("Constant", {})
        return f"vec3({c.get('R', 0)}, {c.get('G', 0)}, {c.get('B', 0)})"

    def v_ScalarParameter(self, obj, name):
        return f"P({json.dumps(obj.get('ParameterName', name))}, {obj.get('DefaultValue', 0)})"

    def v_VectorParameter(self, obj, name):
        d = obj.get("DefaultValue", {})
        return (
            f"PV({json.dumps(obj.get('ParameterName', name))}, "
            f"{d.get('R', 0)}, {d.get('G', 0)}, {d.get('B', 0)})"
        )

    def v_Multiply(self, obj, name):
        a = self.get_input(obj, "A", const_field="ConstA")
        b = self.get_input(obj, "B", const_field="ConstB")
        return f"({a}).mul({b})"

    def v_Add(self, obj, name):
        a = self.get_input(obj, "A", const_field="ConstA")
        b = self.get_input(obj, "B", const_field="ConstB")
        return f"({a}).add({b})"

    def v_Subtract(self, obj, name):
        a = self.get_input(obj, "A", const_field="ConstA")
        b = self.get_input(obj, "B", const_field="ConstB")
        return f"({a}).sub({b})"

    def v_Divide(self, obj, name):
        a = self.get_input(obj, "A", const_field="ConstA")
        b = self.get_input(obj, "B", const_field="ConstB")
        return f"({a}).div({b})"

    def v_Power(self, obj, name):
        base = self.get_input(obj, "Base", const_field="ConstBase")
        exp = self.get_input(obj, "Exponent", const_field="ConstExponent")
        return f"pow({base}, {exp})"

    def v_DotProduct(self, obj, name):
        return f"dot({self.get_input(obj, 'A')}, {self.get_input(obj, 'B')})"

    def v_LinearInterpolate(self, obj, name):
        a = self.get_input(obj, "A", const_field="ConstA")
        b = self.get_input(obj, "B", const_field="ConstB")
        alpha = self.get_input(obj, "Alpha", const_field="ConstAlpha")
        return f"mix({a}, {b}, {alpha})"

    def v_Saturate(self, obj, name):
        return f"saturate({self.get_input(obj, 'Input')})"

    def v_Clamp(self, obj, name):
        x = self.get_input(obj, "Input")
        mn = self.get_input(obj, "Min", const_field="MinDefault", fallback="float(0)")
        mx = self.get_input(obj, "Max", const_field="MaxDefault", fallback="float(1)")
        return f"clamp({x}, {mn}, {mx})"

    def v_OneMinus(self, obj, name):
        return f"float(1).sub({self.get_input(obj, 'Input')})"

    def v_Abs(self, obj, name):
        return f"abs({self.get_input(obj, 'Input')})"

    def v_Ceil(self, obj, name):
        return f"ceil({self.get_input(obj, 'Input')})"

    def v_Frac(self, obj, name):
        return f"fract({self.get_input(obj, 'Input')})"

    def v_Sine(self, obj, name):
        x = self.get_input(obj, "Input")
        period = obj.get("Period")
        if period and period != 1.0:
            return f"sin(({x}).mul({2 * 3.141592653589793 / period}))"
        return f"sin({x})"

    def v_Fmod(self, obj, name):
        return f"mod({self.get_input(obj, 'A')}, {self.get_input(obj, 'B')})"

    def v_Step(self, obj, name):
        # UE Step(Y, X) -> 1 if X >= Y, 0 otherwise (matches GLSL step).
        y = self.get_input(obj, "Y", const_field="ConstY")
        x = self.get_input(obj, "X", const_field="ConstX")
        return f"step({y}, {x})"

    def v_Normalize(self, obj, name):
        x = self.get_input(obj, "VectorInput",
                           fallback=self.get_input(obj, "Input"))
        return f"normalize({x})"

    def v_AppendVector(self, obj, name):
        a = self.get_input(obj, "A")
        b = self.get_input(obj, "B")
        return f"appendVec({a}, {b})"

    def v_ComponentMask(self, obj, name):
        x = self.get_input(obj, "Input")
        chans = []
        for k, c in (("R", "x"), ("G", "y"), ("B", "z"), ("A", "w")):
            if obj.get(k):
                chans.append(c)
        if not chans:
            return f"({x})"
        if len(chans) == 1:
            return f"({x}).{chans[0]}"
        return f"({x}).{''.join(chans)}"

    def v_If(self, obj, name):
        a = self.get_input(obj, "A")
        b = self.get_input(obj, "B", const_field="ConstB")
        agt = self.get_input(obj, "AGreaterThanB", const_field="ConstAGreaterThanB")
        aeq = self.get_input(obj, "AEqualsB", fallback=agt)
        alt = self.get_input(obj, "ALessThanB")
        thresh = obj.get("EqualsThreshold", 0.00001)
        return f"ueIf({a}, {b}, {agt}, {aeq}, {alt}, {thresh})"

    # ---------- Geometry / engine state ----------
    def v_VertexNormalWS(self, obj, name): return "normalWorld"
    def v_PixelNormalWS(self, obj, name):  return "normalWorld"
    def v_WorldPosition(self, obj, name):  return "positionWorld"
    def v_ObjectPositionWS(self, obj, name): return "objectPivotWS"
    def v_CameraVectorWS(self, obj, name): return "cameraVectorWS"
    def v_TwoSidedSign(self, obj, name):   return "twoSidedSign"
    def v_SkyAtmosphereLightDirection(self, obj, name): return "sunDirection"
    def v_TextureCoordinate(self, obj, name):
        idx = obj.get("CoordinateIndex", 0)
        return f"texCoord{idx}"
    def v_Time(self, obj, name): return "globalTime"

    def v_DDX(self, obj, name): return f"dFdx({self.get_input(obj, 'Value')})"
    def v_DDY(self, obj, name): return f"dFdy({self.get_input(obj, 'Value')})"

    def v_PerInstanceCustomData(self, obj, name):
        idx = obj.get("DataIndex", 0)
        default = obj.get("DefaultValue", 0)
        return f"perInstanceCustomData(uniforms, {idx}, {default})"

    def v_PerInstanceRandom(self, obj, name):
        return "perInstanceRandom(uniforms)"

    def v_RotateAboutAxis(self, obj, name):
        position = self.get_input(obj, "Position")
        axis     = self.get_input(obj, "NormalizedRotationAxis")
        angle    = self.get_input(obj, "RotationAngle")
        pivot    = self.get_input(obj, "PivotPoint")
        return f"rotateAboutAxis({position}, {axis}, {angle}, {pivot})"

    # ---------- Texture sampling ----------
    def v_TextureSample(self, obj, name):
        coords = self.get_input(obj, "Coordinates", fallback="texCoord0")
        return f"sampleTexture({self._texture_ref(obj.get('Texture'))}, {coords})"

    def v_TextureObject(self, obj, name):
        return f"texObject({self._texture_ref(obj.get('Texture'))})"

    def _texture_ref(self, tex):
        if isinstance(tex, dict) and "$ref" in tex:
            n = tex["$ref"].split(".")[-1]
            return f"tex_{re.sub(r'[^A-Za-z0-9_]', '_', n)}"
        return "tex_unknown"

    # ---------- Reroutes / named buses ----------
    def v_Reroute(self, obj, name):
        return self.get_input(obj, "Input")

    def v_NamedRerouteDeclaration(self, obj, name):
        return self.get_input(obj, "Input")

    def v_NamedRerouteUsage(self, obj, name):
        decl = get_ref(obj.get("Declaration", {}))
        if decl is None:
            return "/* unbound usage */ float(0)"
        return self.visit(decl)

    # ---------- Material function calls ----------
    def v_MaterialFunctionCall(self, obj, name):
        mf = obj.get("MaterialFunction", {})
        mf_name = mf.get("$ref", "").split(".")[-1] if isinstance(mf, dict) else ""
        helper = None
        if mf_name in ENGINE_FUNCTIONS:
            helper = ENGINE_FUNCTIONS[mf_name][0]
        elif mf_name in PROJECT_FUNCTIONS:
            helper = PROJECT_FUNCTIONS[mf_name][0]
        if helper is None:
            return f"/* unknown MF: {mf_name} */ [float(0)]"

        # Collect FunctionInputs in order, defaulting unconnected slots to 0.
        fi = obj.get("FunctionInputs", {})
        if isinstance(fi, dict):
            entries = sorted(fi.items(), key=lambda kv: int(kv[0]))
        else:
            entries = list(enumerate(fi or []))
        args = []
        for _, entry in entries:
            # `undefined` means "this UE input was unconnected" — engine
            # helpers detect it and substitute their per-input default.
            arg = "undefined"
            if isinstance(entry, dict):
                src = entry.get("Input")
                if isinstance(src, dict):
                    inner = src.get("Expression")
                    if isinstance(inner, dict) and "$ref" in inner:
                        # Apply OutputIndex on the *input side* too — UE
                        # function inputs can pull from a multi-output node.
                        sub_obj = self.graph.get(inner["$ref"])
                        node_var = self.visit(inner["$ref"])
                        if (sub_obj is not None and sub_obj.get("class")
                                == "MaterialExpressionMaterialFunctionCall"):
                            node_var = f"{node_var}[{get_output_index(src)}]"
                        arg = node_var
            args.append(arg)
        return f"{helper}({', '.join(args)})"

    # ---------- ShadowReplace ----------
    def v_ShadowReplace(self, obj, name):
        # Three.js's forward pass = UE's "Default" branch.
        return self.get_input(obj, "Default")


# ------------------------------------------------------------------
# Material function emission.
# Each MF becomes a TSL function returning an array of outputs (indexed
# by UE's OutputIndex).
# ------------------------------------------------------------------
def emit_material_function(mf_path, ts_name):
    g = load(mf_path)

    fns, fos = [], []
    for nm, obj in g.items():
        if obj.get("class") == "MaterialExpressionFunctionInput":
            fns.append((
                obj.get("SortPriority", 0),
                obj.get("MaterialExpressionEditorY", 0),
                obj.get("InputName", nm), nm,
            ))
        elif obj.get("class") == "MaterialExpressionFunctionOutput":
            fos.append((
                obj.get("SortPriority", 0),
                obj.get("MaterialExpressionEditorY", 0),
                obj.get("OutputName", nm), nm,
            ))
    fns.sort(); fos.sort()

    t = Translator(g)
    for i, (_, _, _, nm) in enumerate(fns):
        t.cache[nm] = f"in_{i}"

    output_exprs = []
    for _, _, _, nm in fos:
        v = t.get_input(g[nm], "A", fallback="float(0)")
        output_exprs.append(v)

    args_decl = ", ".join(f"in_{i}" for i in range(len(fns)))
    arg_doc = ", ".join(
        f"{nm}=in_{i}" for i, (_, _, nm, _) in enumerate(fns)
    )
    output_doc = ", ".join(f"[{i}]={nm}" for i, (_, _, nm, _) in enumerate(fos))

    body = "\n".join(t.statements)
    return (
        f"// {ts_name} ({arg_doc}) -> [{output_doc}]\n"
        f"export function {ts_name}({args_decl}) {{\n"
        f"{body}\n"
        f"  return [\n" +
        "\n".join(f"    {e}," for e in output_exprs) +
        "\n  ];\n"
        f"}}\n"
    )


# ------------------------------------------------------------------
# Main material translation.
# ------------------------------------------------------------------
MAIN_OUTPUT_PROPS = {
    "BaseColor":           "baseColor",
    "Metallic":            "metallic",
    "Specular":            "specular",
    "Roughness":           "roughness",
    "EmissiveColor":       "emissiveColor",
    "Opacity":             "opacity",
    "OpacityMask":         "opacityMask",
    "Normal":              "normal",
    "Tangent":             "tangent",
    "WorldPositionOffset": "worldPositionOffset",
    "AmbientOcclusion":    "ambientOcclusion",
    "Refraction":          "refraction",
}


def emit_main_material():
    g = load("M_PainterlyShader.parsed.json")

    main_props = {}
    for nm, obj in g.items():
        if obj.get("class") == "MaterialEditorOnlyData":
            for ue, ts in MAIN_OUTPUT_PROPS.items():
                slot = obj.get(ue)
                if isinstance(slot, dict):
                    ref = slot.get("Expression")
                    if isinstance(ref, dict) and "$ref" in ref:
                        # Save the slot dict so we keep OutputIndex (when any).
                        main_props[ts] = (ref["$ref"], slot)
            break

    t = Translator(g)

    # Pre-emit named buses with stable variable names so the output is
    # readable and downstream consumers all share one definition.
    bus_decls = {}
    for nm, obj in g.items():
        if obj.get("class") == "MaterialExpressionNamedRerouteDeclaration":
            label = obj.get("Name", nm)
            slug = "bus_" + re.sub(r"[^A-Za-z0-9]+", "_", label).strip("_")
            bus_decls[nm] = slug

    for nm, slug in bus_decls.items():
        obj = g[nm]
        # get_input handles OutputIndex resolution when the source is a
        # MaterialFunctionCall (so a bus that taps into MF output [N] gets
        # `[N]` appended automatically).
        v = t.get_input(obj, "Input", fallback="float(0)")
        t.statements.append(f"  const {slug} = {v};")
        t.cache[nm] = slug

    # Visit each main output. Honour OutputIndex if the output expression
    # is a MaterialFunctionCall.
    output_results = {}
    for ts_name, (expr_name, slot) in main_props.items():
        v = t.visit(expr_name)
        out_obj = g.get(expr_name, {})
        if out_obj.get("class") == "MaterialExpressionMaterialFunctionCall":
            v = f"{v}[{get_output_index(slot)}]"
        output_results[ts_name] = v

    body = "\n".join(t.statements)

    out_lines = ["  return {"]
    for k, v in output_results.items():
        out_lines.append(f"    {k}: {v},")
    out_lines.append("  };")
    return body, "\n".join(out_lines)


# ------------------------------------------------------------------
# Emit the full TS module.
# ------------------------------------------------------------------
HEADER = '''// AUTO-GENERATED from the painterly material T3D dumps via
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

'''


FOOTER = '''

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

'''


def emit():
    chunks = [HEADER]

    chunks.append("// ---------- Project material functions ----------\n")
    chunks.append(emit_material_function("MF_AnimateUV.parsed.json",
                                         "mfAnimateUV"))
    chunks.append(emit_material_function("MF_CurvatureFilter.parsed.json",
                                         "mfCurvatureFilter"))
    chunks.append(emit_material_function("MF_SwitchByInstanceData.parsed.json",
                                         "mfSwitchByInstanceData"))

    body, retstmt = emit_main_material()
    chunks.append(FOOTER)
    chunks.append(body)
    chunks.append("")
    chunks.append(retstmt)
    chunks.append("}")

    return "\n".join(chunks)


def main():
    code = emit()
    out_path = os.path.join(ROOT_DIR, "src", "painterlyMaterial.generated.ts")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(code)
    n_lines = code.count("\n")
    print(f"wrote {out_path}  ({len(code):,} bytes, {n_lines:,} lines)")


if __name__ == "__main__":
    main()
