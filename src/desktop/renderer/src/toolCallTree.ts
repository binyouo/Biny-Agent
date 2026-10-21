import type { TimelineTool } from "./sessionTimeline.js";

/** 把脚本内部调用归入其父调用，保留独立调用与各子调用的执行顺序。 */
export function toolCallTree(tools: TimelineTool[]): TimelineTool[] {
  const parents = tools.filter(tool => tool.tool === "run_script" || tool.tool === "exec");
  const parentOf = (tool: TimelineTool): TimelineTool | undefined => parents.find(parent => parent !== tool && (tool.parentToolCallId === parent.id
    || parent.tool === "exec" && tool.id.startsWith(`${parent.id}:nested:`)));
  return tools.filter(tool => !parentOf(tool)).map(tool => {
    if (!parents.includes(tool)) return tool;
    const children = new Map((tool.children ?? []).map(child => [child.id, child]));
    for (const child of tools) if (parentOf(child) === tool) children.set(child.id, child);
    return { ...tool, children: [...children.values()] };
  });
}
