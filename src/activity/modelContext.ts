/** 模型可见的活动派生材料：保持来源标记并在策略撤回后排除派生内容。 */
import type { MemoryEntry } from "../agent/context/memoryTypes.js";
import { redactSecrets } from "../utils/secrets.js";

export const activityDerivedMarker = "<!-- biny-activity-derived -->";

export function isActivityMemory(entry: MemoryEntry): boolean {
  return Boolean(entry.activitySource || entry.activitySessionId);
}

export function dailyNoteForModel(content: string, allowActivity: boolean): string {
  const hasActivity = /^## 活动记录\s*$/mu.test(content);
  const sections = content.split(/(?=^## )/mu).filter((section) => {
    if (allowActivity) return true;
    if (section.includes(activityDerivedMarker) || /^## 活动记录\s*$/mu.test(section)) return false;
    // 旧日结没有来源标记；混合派生节不能被当成纯聊天回忆。
    return !hasActivity || !/^## (每日总结|自我反思)\s*$/mu.test(section);
  });
  return redactSecrets(sections.join("").replace(/<!--[\s\S]*?-->/gu, "")).trim();
}
