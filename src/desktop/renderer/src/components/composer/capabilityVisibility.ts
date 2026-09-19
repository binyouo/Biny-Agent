import type { DesktopSkillCatalogEntry, DesktopToolCatalogEntry } from "../../../../protocol.js";

/** 由 Runtime 自动协调的内部工具，不作为当前消息的用户能力单独展示。 */
const HIDDEN_TOOL_NAMES = new Set([
  "read_tool_result",
  "read_skill_resource",
  "skill_search",
  "skill_install",
  "TaskStatus",
  "PlanStart",
  "PlanStatus",
  "PlanUpdate",
  "PlanDraft",
  "save_memory",
  "recall_memory",
  "activity_report",
  "activity_digest",
  "activity_search",
  "activity_sessions"
]);

export function shouldShowToolInCapabilityMenu(tool: Pick<DesktopToolCatalogEntry, "name" | "source">): boolean {
  return tool.source !== "mcp" && !HIDDEN_TOOL_NAMES.has(tool.name);
}

/** Alma 的工具菜单固定顺序；目录返回顺序不能成为用户界面的排序依据。 */
const TOOL_ORDER = [
  "Glob", "Grep", "Read", "Edit", "Write", "NotebookEdit",
  "Bash", "BashOutput", "KillShell",
  "BrowserOpen", "BrowserReadDom", "BrowserClick", "BrowserType", "BrowserPress",
  "WebFetch", "WebSearch",
  "Task", "TodoWrite", "Skill", "ToolSearch"
];
const TOOL_ORDER_INDEX = new Map(TOOL_ORDER.map((name, index) => [name, index]));

/** 对工具目录做稳定排序：先按 Alma 顺序，未内置映射的工具再按名称排序。 */
export function compareCapabilityTools(left: Pick<DesktopToolCatalogEntry, "name">, right: Pick<DesktopToolCatalogEntry, "name">): number {
  const leftIndex = TOOL_ORDER_INDEX.get(left.name);
  const rightIndex = TOOL_ORDER_INDEX.get(right.name);
  if (leftIndex !== undefined || rightIndex !== undefined) {
    return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
  }
  return left.name.localeCompare(right.name);
}

export type SkillCapabilityGroupId = "bundled" | "personal" | "claudeCode" | "codex" | "marketplace" | "project" | "external";

/** Skill 分区顺序与 Alma 对齐；没有条目的分区不会渲染。 */
export const SKILL_CAPABILITY_GROUPS: ReadonlyArray<{ id: SkillCapabilityGroupId; label: string; icon: "folder-open" | "person" | "terminal" | "wand" }> = [
  { id: "bundled", label: "内置技能", icon: "wand" },
  { id: "personal", label: "个人技能", icon: "person" },
  { id: "claudeCode", label: "Claude Code 技能", icon: "terminal" },
  { id: "codex", label: "Codex CLI 技能", icon: "terminal" },
  { id: "marketplace", label: "Marketplace 技能", icon: "wand" },
  { id: "project", label: "项目技能", icon: "folder-open" },
  { id: "external", label: "外部 Agent 技能", icon: "wand" }
];

/** 按 Skill 的实际作用域和来源归类，不用扫描返回顺序猜测分区。 */
export function skillCapabilityGroupId(skill: Pick<DesktopSkillCatalogEntry, "scope" | "source" | "engine">): SkillCapabilityGroupId {
  if (skill.scope === "builtin" || skill.source === "builtin") return "bundled";
  if (skill.scope === "project") return "project";
  if (skill.source === "agents") {
    if (skill.engine === "claude") return "claudeCode";
    if (skill.engine === "codex") return "codex";
    return "external";
  }
  return skill.scope === "global" ? "personal" : "external";
}

/** Skill 名称在分区内稳定升序，名称相同再用 ref/id 消除并列抖动。 */
export function compareCapabilitySkills(left: Pick<DesktopSkillCatalogEntry, "name" | "ref" | "id">, right: Pick<DesktopSkillCatalogEntry, "name" | "ref" | "id">): number {
  return left.name.localeCompare(right.name) || left.ref.localeCompare(right.ref) || left.id.localeCompare(right.id);
}
