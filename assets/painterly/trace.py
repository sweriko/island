"""Trace the upstream graph from a starting expression by recursively
following input properties (A, B, Input, Coordinates, etc.).

Usage: python trace.py <expression_name> [depth]
"""
import json, os, sys

THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def load(name="M_PainterlyShader.parsed.json"):
    with open(os.path.join(THIS_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def get_ref(v):
    if isinstance(v, dict):
        if "$ref" in v:
            return v["$ref"]
        if "Expression" in v:
            return get_ref(v["Expression"])
    return None


# Properties that hold input expression links (these vary by node class).
INPUT_PROPS = {
    "A", "B", "Alpha", "Input", "Coordinates", "Value",
    "AGreaterThanB", "AEqualsB", "ALessThanB", "Threshold",
    "Default", "Shadow", "Position",
    "ColorA", "ColorB", "ColorC", "ColorD",
    "ColorCPosition", "ColorDPosition",
    "Min", "Max", "Exponent", "Base",
    "NormalizedRotationAxis", "PivotPoint", "RotationAngle",
    "Tangent", "Normal", "AdditionalNormal",
    "FunctionInputs",
    "Declaration",
}


def collect_inputs(obj):
    """Return [(label, ref_name)] for all input-like fields."""
    out = []
    for k, v in obj.items():
        if k in ("class", "MaterialExpressionEditorX", "MaterialExpressionEditorY",
                 "MaterialExpressionGuid", "Material", "Function"):
            continue
        if isinstance(v, dict):
            ref = get_ref(v)
            if ref:
                out.append((k, ref))
        elif isinstance(v, list):
            for i, item in enumerate(v):
                if isinstance(item, dict):
                    ref = get_ref(item.get("Input", item))
                    if ref:
                        out.append((f"{k}[{i}]", ref))
        elif isinstance(v, dict) and any(isinstance(x, dict) for x in v.values()):
            for sub_k, sub_v in v.items():
                ref = get_ref(sub_v)
                if ref:
                    out.append((f"{k}.{sub_k}", ref))
    # FunctionInputs as a dict keyed by integer
    fi = obj.get("FunctionInputs")
    if isinstance(fi, dict):
        for idx, item in fi.items():
            if isinstance(item, dict):
                ref = get_ref(item.get("Input", item))
                if ref:
                    out.append((f"FunctionInputs[{idx}]", ref))
    return out


def short_class(cls):
    return cls.replace("MaterialExpression", "")


def display(g, name):
    obj = g.get(name)
    if obj is None:
        return f"{name}<missing>"
    cls = short_class(obj.get("class", ""))
    extras = []
    for f in ("ParameterName", "InputName", "OutputName", "Name"):
        if f in obj and isinstance(obj[f], (str, int, float)):
            extras.append(f"{f}={obj[f]!r}")
    if cls == "Constant":
        extras.append(f"R={obj.get('R', 0)}")
    if cls == "Constant2Vector":
        extras.append(f"({obj.get('R', 0)},{obj.get('G', 0)})")
    if cls == "Constant3Vector":
        c = obj.get("Constant", {})
        extras.append(f"rgb=({c.get('R', 0)},{c.get('G', 0)},{c.get('B', 0)})")
    if cls == "ScalarParameter":
        extras.append(f"default={obj.get('DefaultValue', 0)}")
    if cls == "VectorParameter":
        dv = obj.get("DefaultValue", {})
        extras.append(f"rgba=({dv.get('R',0):.3f},{dv.get('G',0):.3f},{dv.get('B',0):.3f},{dv.get('A',0):.3f})")
    if cls == "TextureSample" or cls == "TextureObject":
        tex = obj.get("Texture")
        if isinstance(tex, dict) and "$ref" in tex:
            extras.append(f"tex={tex['$ref']}")
    if cls == "MaterialFunctionCall":
        mf = obj.get("MaterialFunction")
        if isinstance(mf, dict) and "$ref" in mf:
            extras.append(f"mf={mf['$ref']}")
    if cls == "ComponentMask":
        ch = []
        for c in "RGBA":
            if obj.get(c):
                ch.append(c.lower())
        extras.append(f"mask={''.join(ch) or 'rgba'}")
    if cls == "If":
        extras.append("(A>B/A==B/A<B)")
    if cls == "NamedRerouteDeclaration":
        extras.append(f"name={obj.get('Name', '?')!r}")
    if cls == "NamedRerouteUsage":
        decl = get_ref(obj.get("Declaration", {}))
        extras.append(f"decl={decl}")
    return f"{cls}_{name.rsplit('_', 1)[-1]} [{' '.join(extras)}]"


def trace(g, start, max_depth=4, indent=0, visited=None):
    if visited is None:
        visited = set()
    if start in visited:
        print("  " * indent + f"-> {display(g, start)} (already shown)")
        return
    visited.add(start)
    print("  " * indent + f"- {display(g, start)}")
    if indent >= max_depth:
        return
    obj = g.get(start, {})
    inputs = collect_inputs(obj)
    for label, ref in inputs:
        print("  " * indent + f"  {label}:")
        trace(g, ref, max_depth, indent + 2, visited)


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: trace.py <expression_name> [depth]")
    g = load()
    name = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    trace(g, name, depth)


if __name__ == "__main__":
    main()
