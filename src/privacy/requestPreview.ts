import { walkJsonValues, type MaskJsonResult, type MaskJsonSegment } from "./json.js";

interface Leaf { path: string[]; value: string; role?: string }

/** 按请求顺序展开全部字段，保留数字字面量；这里只生成观测视图，不改写出站正文。 */
function leaves(source: string, prefix: string[] = [], inheritedRole?: string): Leaf[] {
  const root: unknown = JSON.parse(source);
  const out: Leaf[] = [];
  walkJsonValues(source, value => value, (value, path, stringValue) => {
    let node = root, role = inheritedRole;
    for (const key of path) {
      if (node && typeof node === "object") {
        const parent = node as Record<string, unknown>;
        if (typeof parent.role === "string") role = parent.role;
        else if (parent.type === "function_call" || parent.type === "function_call_output") role = "tool";
        node = parent[key];
      }
    }
    const fullPath = [...prefix, ...path];
    if (stringValue && !prefix.length && path.at(-1) === "arguments") {
      try { JSON.parse(value); } catch { out.push({ path: fullPath, value, role }); return; }
      for (const leaf of leaves(value, fullPath, role)) out.push(leaf);
    } else out.push({ path: fullPath, value, role });
  });
  return out;
}

export function requestPreview(source: string, result: MaskJsonResult): MaskJsonSegment[] {
  const originals = leaves(source), masked = leaves(result.text);
  const hits = new Map(result.segments.map(group => [group.path, group.segments]));
  return originals.map((leaf, index) => ({
    path: leaf.path.reduce((text, key) => /^\d+$/u.test(key) ? `${text}[${key}]` : /^[a-zA-Z_$][\w$]*$/u.test(key) ? `${text}${text ? "." : ""}${key}` : `${text}[${JSON.stringify(key)}]`, ""),
    role: leaf.role, original: leaf.value, masked: masked[index]!.value,
    segments: hits.get(leaf.path.join(".")) ?? []
  }));
}
