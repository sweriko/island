"""Parse a UE T3D dump into a usable Python dict.

T3D format (after object stub block):
  Begin Object Name="X" ExportPath="..."
     PropertyName=Value
     Array(0)=(field=val,...)
  End Object
"""
import json, os, re, sys

THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def split_top(s):
    """Split a comma-separated string while respecting nested () and ""."""
    parts, depth, buf, in_str = [], 0, [], False
    for ch in s:
        if ch == '"':
            in_str = not in_str
            buf.append(ch)
            continue
        if in_str:
            buf.append(ch); continue
        if ch == "(":
            depth += 1; buf.append(ch)
        elif ch == ")":
            depth -= 1; buf.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(buf).strip()); buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf).strip())
    return parts


def parse_value(v):
    v = v.strip()
    if not v:
        return ""
    if v.startswith('"') and v.endswith('"'):
        inner = v[1:-1]
        # An object reference is sometimes serialized as a string-quoted ref:
        #   "/Script/Engine.MaterialExpressionFoo'Material:Foo_0'"
        m = re.match(r"^([\w./]+)'([^']+)'$", inner)
        if m:
            return {"_ref_class": m.group(1), "_ref": m.group(2)}
        return inner
    if v.startswith("(") and v.endswith(")"):
        inner = v[1:-1]
        items = split_top(inner)
        # struct (key=val) or array
        if items and "=" in items[0]:
            d = {}
            for it in items:
                if "=" in it:
                    k, x = it.split("=", 1)
                    d[k.strip()] = parse_value(x)
            return d
        return [parse_value(it) for it in items]
    # Object reference like /Script/Engine.MaterialExpressionAdd'X:Y'
    m = re.match(r"^([\w./]+)'([^']+)'$", v)
    if m:
        return {"_ref_class": m.group(1), "_ref": m.group(2)}
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    try:
        if "." in v or "e" in v.lower():
            return float(v)
        return int(v)
    except ValueError:
        return v


def parse_t3d(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    objects = {}
    # Pattern: Begin Object [Class=X] Name="N" [...]
    # Not all blocks have Class= — the second pass uses just Name="N".
    lines = text.splitlines()
    i = 0
    cur_name = None
    cur_props = None
    while i < len(lines):
        ln = lines[i]
        stripped = ln.strip()
        if stripped.startswith("Begin Object"):
            m = re.search(r'Name="([^"]+)"', stripped)
            cm = re.search(r"Class=(\S+)", stripped)
            if m:
                cur_name = m.group(1)
                if cur_name not in objects:
                    objects[cur_name] = {"_props": {}}
                if cm:
                    cls_path = cm.group(1)
                    cls_name = cls_path.split(".")[-1]
                    objects[cur_name]["_class"] = cls_name
                cur_props = objects[cur_name]["_props"]
        elif stripped.startswith("End Object"):
            cur_name = None
            cur_props = None
        elif cur_props is not None and "=" in stripped:
            key, val = stripped.split("=", 1)
            key = key.strip()
            val = val.strip()
            # Handle multi-line continuations? T3D usually single-line per prop.
            # Some quoted text values may continue but we'll trust one-liners.
            # Index into array properties: Foo(0)=...
            mi = re.match(r"^([A-Za-z_][\w]*)\((\d+)\)$", key)
            if mi:
                key_name, idx = mi.group(1), int(mi.group(2))
                cur_props.setdefault(key_name, {})[idx] = parse_value(val)
            else:
                cur_props[key] = parse_value(val)
        i += 1

    return objects


def short_ref(ref_dict):
    """Map an object-ref dict to just the local name (last segment after :)."""
    if isinstance(ref_dict, dict) and "_ref" in ref_dict:
        s = ref_dict["_ref"]
        if ":" in s:
            return s.rsplit(":", 1)[-1]
        return s.rsplit(".", 1)[-1]
    return ref_dict


def normalize(objs):
    """Return {name: {class, props}} with refs simplified to local names."""
    out = {}
    for name, data in objs.items():
        cls = data.get("_class", "")
        props = data.get("_props", {})

        def fix(v):
            if isinstance(v, dict):
                if "_ref" in v:
                    return {"$ref": short_ref(v)}
                return {k: fix(x) for k, x in v.items()}
            if isinstance(v, list):
                return [fix(x) for x in v]
            return v

        out[name] = {"class": cls, **{k: fix(v) for k, v in props.items()}}
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: parse_t3d.py <file.t3d>")
    path = sys.argv[1]
    objs = parse_t3d(path)
    norm = normalize(objs)
    out_path = path.replace(".t3d", ".parsed.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(norm, f, indent=2)
    print(f"wrote {out_path}  ({len(norm)} objects)")


if __name__ == "__main__":
    main()
