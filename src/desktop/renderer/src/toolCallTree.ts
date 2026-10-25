import type { TimelineTool } from "./sessionTimeline.js";

/** 把脚本内部调用归入其父调用，保留独立调用与各子调用的执行顺序。 */
export function toolCallTree(tools: TimelineTool[]): TimelineTool[] {
  const parents = tools.filter(tool => tool.tool === "run_script" || tool.tool === "exec");
  const byId = new Map<string, TimelineTool[]>();
  const execById = new Map<string, TimelineTool[]>();
  const order = new Map<TimelineTool, number>();
  for (const [index, parent] of parents.entries()) {
    order.set(parent, index);
    const matches = byId.get(parent.id) ?? [];
    matches.push(parent);
    byId.set(parent.id, matches);
    if (parent.tool === "exec") {
      const executions = execById.get(parent.id) ?? [];
      executions.push(parent);
      execById.set(parent.id, executions);
    }
  }
  const roots: TimelineTool[] = [];
  const childrenByParent = new Map<TimelineTool, TimelineTool[]>();
  for (const tool of tools) {
    const parentId = tool.parentToolCallId;
    let parent = parentId === undefined ? undefined : byId.get(parentId)?.find(candidate => candidate !== tool);
    // 旧 exec 子调用由 ID 前缀定位；与显式父 ID 冲突时仍采用最早出现的父调用。
    for (let index = tool.id.indexOf(":nested:"); index >= 0; index = tool.id.indexOf(":nested:", index + 1)) {
      const candidate = execById.get(tool.id.slice(0, index))?.find(value => value !== tool);
      if (candidate && (!parent || order.get(candidate)! < order.get(parent)!)) parent = candidate;
    }
    if (!parent) roots.push(tool);
    else {
      const children = childrenByParent.get(parent) ?? [];
      children.push(tool);
      childrenByParent.set(parent, children);
    }
  }
  return roots.map(tool => {
    if (!order.has(tool)) return tool;
    const children = new Map((tool.children ?? []).map(child => [child.id, child]));
    for (const child of childrenByParent.get(tool) ?? []) children.set(child.id, child);
    return { ...tool, children: [...children.values()] };
  });
}
