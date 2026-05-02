"""
UE5.6 painterly shader graph dumper.

API quirks discovered in UE 5.6:
  - get_inputs_for_material_expression(material, expression) -> Array[Expression]
  - get_material_expression_input_names(expression)         -> Array[Name]
  - get_material_expression_input_types(expression)         -> Array[int]
  - get_material_expression_node_position(expression)       -> tuple(x, y)
  - get_input_node_output_name_for_material_expression(expression, source_expr)
    -> Name (output pin on `source_expr` feeding into `expression`)
  - The MaterialExpressionInput structs (`a`, `b`, etc.) are protected and
    cannot be read directly via Python; we rely on the Library to expose the
    source expression list instead.

Outputs land in this script's directory:
  M_*.json - main material graphs (class, settings, main_outputs, expressions)
  T_*.png  - exported brush stroke textures
"""

import json
import os
import unreal

THIS_DIR = os.path.dirname(os.path.abspath(__file__))

MATERIAL_PATHS = [
    "/Game/Painterly/Materials/M_PainterlyShader",
    "/Game/Painterly/Materials/M_BasicColor",
]
FUNCTION_PATHS = [
    "/Game/Painterly/Materials/Material-Functions/MF_AnimateUV",
    "/Game/Painterly/Materials/Material-Functions/MF_CurvatureFilter",
    "/Game/Painterly/Materials/Material-Functions/MF_SwitchByInstanceData",
]
TEXTURE_PATHS = [
    "/Game/Painterly/Materials/Textures/T_BrushStrokes",
    "/Game/Painterly/Materials/Textures/T_BrushStrokes_Packed",
    "/Game/Painterly/Materials/Textures/T_Messy-BrushStrokes_HeightMap",
    # UE engine-bundled tiling noise referenced by the painterly material.
    "/Engine/MapTemplates/TilingNoise05",
]

mel = unreal.MaterialEditingLibrary

PROPERTY_CANDIDATES = [
    ("base_color", "MP_BASE_COLOR"),
    ("metallic", "MP_METALLIC"),
    ("specular", "MP_SPECULAR"),
    ("roughness", "MP_ROUGHNESS"),
    ("anisotropy", "MP_ANISOTROPY"),
    ("emissive_color", "MP_EMISSIVE_COLOR"),
    ("opacity", "MP_OPACITY"),
    ("opacity_mask", "MP_OPACITY_MASK"),
    ("normal", "MP_NORMAL"),
    ("tangent", "MP_TANGENT"),
    ("world_position_offset", "MP_WORLD_POSITION_OFFSET"),
    ("subsurface_color", "MP_SUBSURFACE_COLOR"),
    ("ambient_occlusion", "MP_AMBIENT_OCCLUSION"),
    ("refraction", "MP_REFRACTION"),
    ("pixel_depth_offset", "MP_PIXEL_DEPTH_OFFSET"),
]
MATERIAL_PROPERTIES = [
    (slug, getattr(unreal.MaterialProperty, key))
    for slug, key in PROPERTY_CANDIDATES
    if hasattr(unreal.MaterialProperty, key)
]


def safe_name(obj):
    if obj is None:
        return None
    try:
        return obj.get_name()
    except Exception:
        return repr(obj)[:80]


def serialize(value, depth=0):
    if value is None or depth > 6:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value

    for cls_name, fields in [
        ("LinearColor", ("r", "g", "b", "a")),
        ("Color", ("r", "g", "b", "a")),
        ("Vector", ("x", "y", "z")),
        ("Vector2D", ("x", "y")),
        ("Vector4", ("x", "y", "z", "w")),
        ("IntPoint", ("x", "y")),
    ]:
        cls = getattr(unreal, cls_name, None)
        if cls is not None and isinstance(value, cls):
            return {"_t": cls_name, **{f: getattr(value, f) for f in fields}}

    try:
        if isinstance(value, unreal.Rotator):
            return {"_t": "Rotator", "p": value.pitch, "y": value.yaw, "r": value.roll}
    except Exception:
        pass
    try:
        if isinstance(value, unreal.Name):
            return str(value)
    except Exception:
        pass

    if hasattr(value, "get_path_name"):
        try:
            return {"_t": "Ref", "path": value.get_path_name(), "name": safe_name(value)}
        except Exception:
            pass

    try:
        return [serialize(x, depth + 1) for x in iter(value)]
    except TypeError:
        pass

    if hasattr(value, "get_editor_property"):
        return reflect_properties(value, depth + 1)

    return repr(value)[:200]


SKIP_PROPS = {
    "outer", "outermost", "package", "class", "fname", "name", "path_name",
    "default_object", "world", "typed_outer", "full_name", "asset_user_data",
    "menu_categories", "library_categories", "library_categories_text",
    "user_export_text", "expose_to_library", "menu_categories_text",
    "library_user_data", "library_categories_textproperty",
}

# Properties UE doesn't surface via dir() but are accessible via get_editor_property
# on specific MaterialExpression classes. We probe these explicitly.
EXTRA_PROBE_PROPS = (
    # Parameters
    "parameter_name", "default_value", "group", "sort_priority", "primitive_data_index",
    # Material function call
    "material_function", "function_inputs", "function_outputs",
    # Reroutes
    "declaration", "variable", "variable_name", "node_title_color",
    # Texture
    "texture", "texture_object", "sampler_type", "coordinates", "sampler_source",
    "automatic_view_mip_bias", "const_coordinate", "is_default_meshpaint_texture",
    # Constant
    "constant", "r", "g", "b", "a", "x", "y", "z", "w",
    # Lerp / math
    "const_a", "const_b", "const_alpha", "const_default_value", "const_exponent",
    "const_x", "const_y", "const_z", "const_w", "const_factor",
    # Step / clamp
    "min_default", "max_default", "min", "max",
    # Component mask
    "channels",
    # If
    "equals_threshold", "const_a_equals_b", "const_a_greater_than_b",
    "const_a_less_than_b", "const_b",
    # Power
    "const_exponent",
    # Comment
    "text", "comment_color", "size_x", "size_y", "font_size",
    # Function in/out
    "input_name", "output_name", "input_type", "output_type", "use_preview_value_as_default",
    "preview_value", "preview", "input", "description",
    # ShadowReplace
    "default", "shadow",
    # ScalarParameter limits
    "slider_min", "slider_max",
    # Rotate about axis
    "period",
    # Inflate/Tex sample helpers
    "uv_offset", "is_default_outline_displacement_texture",
)


def probe_extra(obj, depth=0):
    """Try a known set of property names that UE often omits from dir()."""
    extra = {}
    for prop in EXTRA_PROBE_PROPS:
        try:
            v = obj.get_editor_property(prop)
        except Exception:
            continue
        if v is None:
            continue
        try:
            ser = serialize(v, depth + 1)
        except Exception:
            continue
        if ser in (None, [], {}):
            continue
        extra[prop] = ser
    return extra


def reflect_properties(obj, depth=0):
    out = {}
    if hasattr(obj, "get_class"):
        try:
            out["_class"] = obj.get_class().get_name()
        except Exception:
            pass
    for attr in sorted(dir(obj)):
        if attr.startswith("_") or attr in SKIP_PROPS:
            continue
        try:
            member = getattr(type(obj), attr, None)
        except Exception:
            continue
        if member is None or (callable(member) and not hasattr(member, "fget")):
            continue
        try:
            v = obj.get_editor_property(attr)
        except Exception:
            continue
        if v is None:
            continue
        try:
            ser = serialize(v, depth + 1)
        except Exception as exc:
            ser = f"<serialize err: {exc}>"
        if ser in (None, [], {}):
            continue
        out[attr] = ser
    # Layer in extras that don't show up via dir().
    for k, v in probe_extra(obj, depth).items():
        if k not in out:
            out[k] = v
    return out


def expression_record(mat, expr):
    """Capture class, position, properties, and connected inputs."""
    record = reflect_properties(expr)
    record["_class"] = expr.get_class().get_name()
    record["_name"] = expr.get_name()

    # Direct probe of the editor "name" (for NamedRerouteDeclaration this is
    # the display label like "Normals", "Diffuse", "Inflate", etc.). We pull
    # it explicitly here because it gets filtered out of reflect_properties.
    try:
        nm = expr.get_editor_property("name")
        if nm is not None:
            record["display_name"] = str(nm)
    except Exception:
        pass

    try:
        x, y = mel.get_material_expression_node_position(expr)
        record["_pos"] = {"x": x, "y": y}
    except Exception:
        pass

    try:
        names = list(mel.get_material_expression_input_names(expr) or [])
    except Exception:
        names = []
    try:
        types_ = list(mel.get_material_expression_input_types(expr) or [])
    except Exception:
        types_ = []
    try:
        sources = list(mel.get_inputs_for_material_expression(mat, expr) or [])
    except Exception:
        sources = []

    record["_inputs"] = []
    for i in range(max(len(names), len(sources))):
        entry = {"index": i}
        if i < len(names):
            entry["name"] = str(names[i])
        if i < len(types_):
            entry["type"] = int(types_[i]) if str(types_[i]).isdigit() else str(types_[i])
        src = sources[i] if i < len(sources) else None
        if src is not None:
            entry["expression"] = safe_name(src)
            try:
                out_name = mel.get_input_node_output_name_for_material_expression(expr, src)
                if out_name is not None:
                    entry["output_name"] = str(out_name)
            except Exception:
                pass
        record["_inputs"].append(entry)
    return record


def walk_graph(mat, seeds):
    visited = {}
    stack = [s for s in seeds if s is not None]
    while stack:
        e = stack.pop()
        nm = safe_name(e)
        if nm in visited:
            continue
        try:
            visited[nm] = expression_record(mat, e)
        except Exception as exc:
            visited[nm] = {"_class": "<error>", "_error": str(exc), "_name": nm}
            continue
        try:
            for src in (mel.get_inputs_for_material_expression(mat, e) or []):
                if src is not None:
                    stack.append(src)
        except Exception:
            pass
    return visited


# Every MaterialExpression class name we care about. Used for brute-force
# enumeration via unreal.find_object since UE5.6 doesn't expose the material's
# Expressions list to Python.
EXPR_CLASS_NAMES = [
    "LinearInterpolate", "Multiply", "Add", "Subtract", "Divide",
    "Constant", "Constant2Vector", "Constant3Vector", "Constant4Vector",
    "ScalarParameter", "VectorParameter", "StaticBool", "StaticSwitchParameter",
    "TextureSample", "TextureObject", "TextureCoordinate",
    "TextureSampleParameter2D", "TextureObjectParameter",
    "MaterialFunctionCall", "DotProduct", "CrossProduct", "Normalize",
    "Power", "Abs", "Sign", "Frac", "Floor", "Ceil", "Round",
    "Sine", "Cosine", "Tangent",
    "Clamp", "Saturate", "Step", "If", "Min", "Max", "Lerp",
    "OneMinus", "Negate", "RotateAboutAxis", "Append", "AppendVector",
    "ShadowReplace", "SkyAtmosphereLightDirection", "TwoSidedSign",
    "WorldPosition", "ObjectPositionWS", "ObjectScale", "ObjectBounds",
    "PixelNormalWS", "VertexNormalWS", "VertexInterpolator",
    "CameraVectorWS", "CameraPositionWS", "ViewProperty",
    "PerInstanceCustomData", "PerInstanceRandom", "PerInstanceFadeAmount",
    "ComponentMask", "AppendVector",
    "NamedRerouteDeclaration", "NamedRerouteUsage", "Reroute",
    "Comment", "FunctionInput", "FunctionOutput",
    "Time", "Panner", "Rotator",
    "DDX", "DDY", "Fresnel", "ReflectionVectorWS",
    "TransformPosition", "TransformVector",
    "MakeMaterialAttributes", "BreakMaterialAttributes", "GetMaterialAttributes",
    "LightVector", "ActorPositionWS", "ActorScale",
    "Bumpoffset", "Power", "Distance",
]


def enumerate_all_expressions(mat, max_index=200):
    """Brute-force find every expression by name pattern."""
    found = {}
    for short in EXPR_CLASS_NAMES:
        cls_name = f"MaterialExpression{short}"
        for idx in range(max_index):
            expr = unreal.find_object(mat, f"{cls_name}_{idx}")
            if expr is None:
                continue
            nm = expr.get_name()
            if nm not in found:
                found[nm] = expr
    return found


def collect_parameters(mat):
    """Default values for every parameter on the material."""
    params = {"scalar": {}, "vector": {}, "texture": {}, "static_switch": {}}
    try:
        for nm in (mel.get_scalar_parameter_names(mat) or []):
            v = mel.get_material_default_scalar_parameter_value(mat, nm)
            params["scalar"][str(nm)] = v
    except Exception:
        pass
    try:
        for nm in (mel.get_vector_parameter_names(mat) or []):
            v = mel.get_material_default_vector_parameter_value(mat, nm)
            params["vector"][str(nm)] = serialize(v)
    except Exception:
        pass
    try:
        for nm in (mel.get_texture_parameter_names(mat) or []):
            v = mel.get_material_default_texture_parameter_value(mat, nm)
            params["texture"][str(nm)] = serialize(v)
    except Exception:
        pass
    try:
        for nm in (mel.get_static_switch_parameter_names(mat) or []):
            v = mel.get_material_default_static_switch_parameter_value(mat, nm)
            params["static_switch"][str(nm)] = bool(v)
    except Exception:
        pass
    return params


def dump_material(path):
    mat = unreal.load_asset(path)
    if mat is None:
        return {"path": path, "error": "load failed"}

    main_outputs = {}
    seeds = []
    for slug, prop in MATERIAL_PROPERTIES:
        try:
            node = mel.get_material_property_input_node(mat, prop)
        except Exception:
            node = None
        if node is None:
            continue
        try:
            out_name = mel.get_material_property_input_node_output_name(mat, prop)
        except Exception:
            out_name = None
        main_outputs[slug] = {
            "expression": safe_name(node),
            "output_name": str(out_name) if out_name is not None else None,
        }
        seeds.append(node)

    # Walk reachable graph from main outputs, then top up with every other
    # expression (Declarations and dangling subgraphs) via brute-force enum.
    expressions = walk_graph(mat, seeds)
    all_exprs = enumerate_all_expressions(mat)
    for nm, expr in all_exprs.items():
        if nm in expressions:
            continue
        try:
            expressions[nm] = expression_record(mat, expr)
        except Exception as exc:
            expressions[nm] = {"_class": "<error>", "_error": str(exc), "_name": nm}
    # Walk inputs from every newly added node to capture deeper subgraphs.
    queue = [unreal.find_object(mat, nm) for nm in expressions]
    queue = [e for e in queue if e is not None]
    for e in queue:
        try:
            for src in (mel.get_inputs_for_material_expression(mat, e) or []):
                if src is None:
                    continue
                snm = safe_name(src)
                if snm in expressions:
                    continue
                try:
                    expressions[snm] = expression_record(mat, src)
                except Exception:
                    pass
        except Exception:
            pass

    settings = {}
    for prop in ("blend_mode", "shading_model", "two_sided", "material_domain",
                 "translucency_lighting_mode", "dither_opacity_mask",
                 "use_material_attributes", "is_blendable", "fully_rough",
                 "max_world_position_offset_displacement"):
        try:
            v = mat.get_editor_property(prop)
            ser = serialize(v)
            if ser not in (None, [], {}):
                settings[prop] = ser
        except Exception:
            pass

    return {
        "path": path,
        "class": mat.get_class().get_name(),
        "settings": settings,
        "parameters": collect_parameters(mat),
        "main_outputs": main_outputs,
        "expressions": expressions,
    }


def dump_function_via_call_sites(func_path, all_material_data):
    """For MaterialFunctions, use their referenced MaterialExpressionFunctionCall
    sites in the main material to introspect the function.

    UE5.6 doesn't expose function expression iteration via Python, but each
    FunctionCall expression has `function_inputs` listing each named input slot
    with the source expression that feeds it — which gives us the input/output
    interface and which expressions the caller wires through it. The function's
    own internal graph isn't reachable headless, so we record the interface
    only and the caller will need to consult the .uasset binary or rebuild it.
    """
    func = unreal.load_asset(func_path)
    info = {
        "path": func_path,
        "class": func.get_class().get_name() if func else "<missing>",
        "interface": reflect_properties(func) if func else {},
        "callers": [],
    }
    try:
        info["num_expressions"] = mel.get_num_material_expressions_in_function(func)
    except Exception:
        pass
    # Find every MaterialExpressionMaterialFunctionCall in the dumped main
    # materials that references this function.
    for mat_data in all_material_data:
        for nm, rec in (mat_data.get("expressions") or {}).items():
            if rec.get("_class") != "MaterialExpressionMaterialFunctionCall":
                continue
            mf_ref = rec.get("material_function") or {}
            if isinstance(mf_ref, dict) and mf_ref.get("path", "").startswith(func_path):
                info["callers"].append({
                    "material": mat_data["path"],
                    "expression": nm,
                    "inputs": rec.get("_inputs", []),
                })
    return info


def export_texture(path):
    tex = unreal.load_asset(path)
    if tex is None:
        return f"load failed: {path}"
    name = path.rsplit("/", 1)[-1]
    out_path = os.path.join(THIS_DIR, name + ".png")
    task = unreal.AssetExportTask()
    task.object = tex
    task.filename = out_path
    task.automated = True
    task.replace_identical = True
    task.prompt = False
    task.exporter = unreal.TextureExporterPNG()
    unreal.Exporter.run_asset_export_task(task)
    return f"exported {out_path}"


def export_t3d(asset_path):
    """Dump complete graph as T3D text — captures every property including
    protected ones (Declaration links, GUIDs, all input structs)."""
    asset = unreal.load_asset(asset_path)
    if asset is None:
        return f"load failed: {asset_path}"
    name = asset_path.rsplit("/", 1)[-1]
    out_path = os.path.join(THIS_DIR, name + ".t3d")
    task = unreal.AssetExportTask()
    task.object = asset
    task.filename = out_path
    task.automated = True
    task.replace_identical = True
    task.prompt = False
    task.exporter = unreal.ObjectExporterT3D()
    unreal.Exporter.run_asset_export_task(task)
    sz = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    return f"t3d {name}.t3d ({sz} bytes)"


def main():
    unreal.log(f"[painterly dump] writing to: {THIS_DIR}")
    mat_data = []
    for path in MATERIAL_PATHS:
        data = dump_material(path)
        mat_data.append(data)
        name = path.rsplit("/", 1)[-1]
        with open(os.path.join(THIS_DIR, name + ".json"), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)
        n = len(data.get("expressions") or {})
        unreal.log(f"  wrote {name}.json  ({n} expressions reached)")

    for path in FUNCTION_PATHS:
        data = dump_function_via_call_sites(path, mat_data)
        name = path.rsplit("/", 1)[-1]
        with open(os.path.join(THIS_DIR, name + ".json"), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)
        unreal.log(f"  wrote {name}.json (callers={len(data.get('callers', []))})")

    # Full T3D dumps (the authoritative source — has every property including
    # protected Reroute Declaration links, GUIDs, and connection metadata).
    unreal.log("[painterly dump] T3D exports:")
    for path in MATERIAL_PATHS + FUNCTION_PATHS:
        unreal.log("  " + export_t3d(path))

    for path in TEXTURE_PATHS:
        unreal.log("  " + export_texture(path))

    unreal.log("[painterly dump] done.")


main()
