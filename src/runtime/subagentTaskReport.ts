/**
 * 子任务列表的文本报告。
 *
 * 给 slash command 和工具输出用的纯格式化函数，不读取任务状态，快照由调用方提供。
 */
import type { SubagentTaskSnapshot } from "./SubagentTaskManager.js";

export function formatSubagentTaskReport(tasks: readonly SubagentTaskSnapshot[]): string {
  if (!tasks.length) return "No subagent tasks have been submitted in this runtime.";

  // 最近提交的排在最前面；快照本身是按提交顺序追加的，所以这里复制后反转，不改原数组。
  return [...tasks]
    .reverse()
    .map((task) => {
      const details = [
        `  ${singleLine(task.task, 240)}`,
        `  parent ${task.parentRunId}${task.deadline ? ` · deadline ${task.deadline}` : ""}`
      ];
      if (task.error) details.push(`  error ${singleLine(task.error, 240)}`);
      return [`${task.taskId} · ${task.status}${task.agent ? ` · agent ${task.agent}` : ""}`, ...details].join("\n");
    })
    .join("\n\n");
}

/** 压成单行并截断：任务描述可能很长且带换行，直接输出会打乱报告结构。 */
function singleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
