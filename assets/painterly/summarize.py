"""Summarize a parsed T3D material/function graph."""
import json, sys, os

THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def load(name):
    with open(os.path.join(THIS_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def get_ref(v):
    if isinstance(v, dict) and "$ref" in v:
        return v["$ref"]
    if isinstance(v, dict) and "Expression" in v:
        return get_ref(v["Expression"])
    return None


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "M_PainterlyShader.parsed.json"
    g = load(name)
    print(f"=== {name} ({len(g)} objects) ===")

    # Group by class
    by_class = {}
    for nm, obj in g.items():
        by_class.setdefault(obj.get("class", "?"), []).append(nm)
    print("\nClasses:")
    for cls, names in sorted(by_class.items(), key=lambda x: -len(x[1])):
        print(f"  {cls}: {len(names)}")

    # NamedRerouteDeclarations — list display names
    decls = by_class.get("MaterialExpressionNamedRerouteDeclaration", [])
    print(f"\nDeclarations ({len(decls)}):")
    for nm in decls:
        obj = g[nm]
        print(f"  {nm}: name={obj.get('Name', obj.get('VariableName', '?'))}")

    # NamedRerouteUsages — list which Declaration they point to
    usages = by_class.get("MaterialExpressionNamedRerouteUsage", [])
    print(f"\nUsages ({len(usages)}):")
    for nm in usages:
        obj = g[nm]
        decl = get_ref(obj.get("Declaration", {}))
        print(f"  {nm} -> {decl}")

    # All parameters
    print("\nScalarParameters:")
    for nm in by_class.get("MaterialExpressionScalarParameter", []):
        obj = g[nm]
        print(f"  {obj.get('ParameterName')}: default={obj.get('DefaultValue', 0)}")
    print("\nVectorParameters:")
    for nm in by_class.get("MaterialExpressionVectorParameter", []):
        obj = g[nm]
        dv = obj.get("DefaultValue", {})
        print(f"  {obj.get('ParameterName')}: default={dv}")


if __name__ == "__main__":
    main()
