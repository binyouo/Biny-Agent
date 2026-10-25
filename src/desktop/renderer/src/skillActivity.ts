import type { CapabilitySelectionValue } from "../../../agent/capabilitySelection.js";
import type { TimelineTool, TimelineToolStatus } from "./sessionTimeline.js";

export interface SkillActivity {
  name: string;
  status: "selected" | "loaded" | TimelineToolStatus;
  error?: string;
}

export const skillActivityLabels: Record<SkillActivity["status"], string> = {
  selected: "已选中", loaded: "已加载", success: "已加载", running: "加载中", waiting: "等待授权",
  failed: "加载失败", denied: "已拒绝", aborted: "已中止", cancelled: "已取消", skipped: "已跳过", unknown: "结果未知"
};

export function skillActivities(
  loaded: readonly string[],
  _selection: CapabilitySelectionValue | undefined,
  _tools: readonly TimelineTool[],
  labels?: ReadonlyMap<string, string>
): SkillActivity[] {
  const activities = new Map<string, SkillActivity>();
  const nameFor = (value: string): string | undefined => {
    const label = labels?.get(value);
    if (label) return label;
    if (/^[a-f\d]{32}$/iu.test(value)) return undefined;
    return (value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value).trim() || undefined;
  };
  for (const value of loaded) {
    const name = nameFor(value);
    if (name) activities.set(name, { name, status: "loaded" });
  }
  return [...activities.values()];
}
