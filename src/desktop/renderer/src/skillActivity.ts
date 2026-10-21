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
  selection: CapabilitySelectionValue | undefined,
  tools: readonly TimelineTool[],
  labels?: ReadonlyMap<string, string>
): SkillActivity[] {
  const activities = new Map<string, SkillActivity>();
  const nameFor = (value: string): string | undefined => {
    const label = labels?.get(value);
    if (label) return label;
    if (/^[a-f\d]{32}$/iu.test(value)) return undefined;
    return (value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value).trim() || undefined;
  };
  if (Array.isArray(selection)) for (const value of selection) {
    const name = nameFor(value);
    if (name) activities.set(name, { name, status: "selected" });
  }
  for (const value of loaded) {
    const name = nameFor(value);
    if (name) activities.set(name, { name, status: "loaded" });
  }
  const visit = (calls: readonly TimelineTool[]): void => {
    for (const call of calls) {
      if ((call.tool === "Skill" || call.tool === "skill_call") && typeof call.args === "object" && call.args !== null && "skill" in call.args && typeof call.args.skill === "string") {
        const name = nameFor(call.args.skill);
        if (name && activities.get(name)?.status !== "loaded") activities.set(name, {
          name,
          status: call.status === "success" ? "loaded" : call.status,
          error: call.status === "success" ? undefined : call.error ?? (typeof call.result === "string" ? call.result : undefined)
        });
      }
      if (call.children) visit(call.children);
    }
  };
  visit(tools);
  return [...activities.values()];
}
