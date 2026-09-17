/** Composer 菜单共享的标签，不包含 React 状态。 */
import type { ThinkingSelection } from "../../../../../llm/modelThinking.js";

export function thinkingLabel(value: ThinkingSelection): string {
  if (value === "xhigh") return "XHigh";
  return value[0]?.toUpperCase() + value.slice(1);
}
