/** 工具与技能菜单的逐项选择状态转换。 */
import type { CapabilitySelectionValue } from "../../../../../agent/capabilitySelection.js";

/**
 * 应用一次分组或服务器的增删操作。
 *
 * 空数组只有在用户明确点击“不使用”时才代表关闭能力；取消刚才选中的
 * 最后一项应回到默认的自动选择，避免一次撤销改变后续回合语义。
 */
export function applyCapabilityNames(value: CapabilitySelectionValue, names: string[], allNames: string[], add: boolean): CapabilitySelectionValue {
  const base = value === "all" ? allNames : value === "auto" || value === "none" ? [] : value;
  const next = new Set(base);
  for (const name of names) {
    if (add) next.add(name);
    else next.delete(name);
  }
  if (next.size === 0 && value !== "none") return "auto";
  return allNames.filter((candidate) => next.has(candidate));
}

export function toggleCapabilityName(value: CapabilitySelectionValue, name: string, allNames: string[]): CapabilitySelectionValue {
  const selected = value === "all" || (Array.isArray(value) && value.includes(name));
  return applyCapabilityNames(value, [name], allNames, !selected);
}
