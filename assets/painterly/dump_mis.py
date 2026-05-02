"""Dump MaterialInstance parameter overrides as JSON."""
import json, os, unreal

THIS_DIR = os.path.dirname(os.path.abspath(__file__))

PATHS = [
    "/Game/Painterly/Materials/MaterialInstance/MI_PainterlyShaderBlue",
    "/Game/Painterly/Materials/MaterialInstance/MI_PainterlyShaderBlue-Cube",
    "/Game/Painterly/Materials/MaterialInstance/MI_PainterlyShaderRed",
    "/Game/Painterly/Materials/MaterialInstance/MI_PainterlyShaderYellow",
    "/Game/Painterly/Materials/MaterialInstance/MI_Gray",
    "/Game/Painterly/Materials/MaterialInstance/MI_Cube-Inflate-Outline",
]

def serialize(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if hasattr(v, "r") and hasattr(v, "g") and hasattr(v, "b"):
        try: return {"r": v.r, "g": v.g, "b": v.b, "a": getattr(v, "a", 1.0)}
        except Exception: pass
    if hasattr(v, "get_path_name"):
        try: return {"_ref": v.get_path_name()}
        except Exception: pass
    return repr(v)[:120]

results = {}
for p in PATHS:
    mi = unreal.load_asset(p)
    if mi is None:
        results[p] = {"error": "load failed"}
        continue
    name = p.rsplit("/", 1)[-1]
    parent = None
    try:
        par = mi.get_editor_property("parent")
        if par is not None:
            parent = par.get_path_name()
    except Exception: pass
    scalars = {}
    vectors = {}
    for prop in dir(mi):
        try:
            if prop.startswith("_"): continue
            if callable(getattr(type(mi), prop, None)) and not hasattr(getattr(type(mi), prop, None), "fget"):
                continue
        except Exception:
            continue
    try:
        sp = mi.get_editor_property("scalar_parameter_values") or []
        for s in sp:
            try:
                info = s.get_editor_property("parameter_info")
                pname = info.get_editor_property("name") if info else "?"
                pval = s.get_editor_property("parameter_value")
                scalars[str(pname)] = pval
            except Exception:
                pass
    except Exception:
        pass
    try:
        vp = mi.get_editor_property("vector_parameter_values") or []
        for v in vp:
            try:
                info = v.get_editor_property("parameter_info")
                pname = info.get_editor_property("name") if info else "?"
                pval = v.get_editor_property("parameter_value")
                vectors[str(pname)] = serialize(pval)
            except Exception:
                pass
    except Exception:
        pass
    results[name] = {"parent": parent, "scalar": scalars, "vector": vectors}

out = os.path.join(THIS_DIR, "material_instances.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2)
unreal.log(f"[mi-dump] wrote {out}")
