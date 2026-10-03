import type { Tool, ToolExposure } from "./types.js";

export function getToolExposure(tool: Pick<Tool, "exposure">): ToolExposure {
  return tool.exposure ?? "direct";
}

/** 仅判断已选工具能否声明给模型；未选工具仍由能力预选和发现流程控制。 */
export function isToolModelVisible(tool: Pick<Tool, "exposure">): boolean {
  const exposure = getToolExposure(tool);
  return exposure !== "hidden" && exposure !== "codemode";
}

/** 暴露资格与执行准入独立，返回 true 后仍须校验工具来源、风险、权限与预算。 */
export function isToolScriptCallable(tool: Pick<Tool, "exposure">, selected: boolean): boolean {
  switch (getToolExposure(tool)) {
    case "direct": return selected;
    case "codemode":
    case "deferred": return true;
    case "model-only":
    case "hidden": return false;
  }
}
