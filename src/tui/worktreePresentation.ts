/**
 * TUI 的 worktree 展示边界。
 *
 * Runtime Host 返回的记录包含路径、分支和 base commit，但这些是诊断数据；普通 TUI
 * 只把生命周期、安全状态和可执行动作投影出来。脏、冲突、孤儿和缺失状态没有清理动作。
 */
import type { WorktreeStatusView } from "../runtime/host/worktree.js";

export type TuiWorktreeTone = "neutral" | "positive" | "warning" | "danger";
export type TuiWorktreeAction = "merge" | "remove-branch" | "remove-worktree";

export interface TuiWorktreeView {
  label: string;
  detail: string;
  tone: TuiWorktreeTone;
  actions: readonly TuiWorktreeAction[];
}

export function tuiWorktreeView(status: WorktreeStatusView): TuiWorktreeView {
  if (!status.exists) {
    return {
      label: "worktree missing",
      detail: "Registration kept; Biny did not delete anything automatically.",
      tone: "warning",
      actions: []
    };
  }
  if (status.dirty) {
    return {
      label: "uncommitted changes",
      detail: "Kept. Commit or resolve the worktree manually before merging or cleaning.",
      tone: "warning",
      actions: []
    };
  }
  if (status.status === "conflicted") {
    return {
      label: "merge conflict",
      detail: "Kept. Resolve the merge manually; no destructive action is offered here.",
      tone: "danger",
      actions: []
    };
  }
  if (status.status === "orphaned") {
    return {
      label: "needs manual recovery",
      detail: "Safety could not be proven, so Biny will not delete this worktree.",
      tone: "warning",
      actions: []
    };
  }
  if (status.status === "kept") {
    return {
      label: "kept",
      detail: "Previous cleanup was not safe to perform; user changes remain.",
      tone: "warning",
      actions: []
    };
  }
  if (status.mergedIntoBase) {
    return {
      label: "merged",
      detail: "Changes are in the project base; the isolated environment can be cleaned.",
      tone: "positive",
      actions: ["remove-branch"]
    };
  }
  return {
    label: "ready to merge",
    detail: "The worktree is clean. Merge it into the project base or remove it and keep its branch.",
    tone: "neutral",
    actions: ["merge", "remove-worktree"]
  };
}

export function tuiWorktreeActionLabel(action: TuiWorktreeAction): string {
  if (action === "merge") return "merge and clean";
  if (action === "remove-branch") return "clean merged worktree and branch";
  return "remove worktree, keep branch";
}

export function tuiWorktreeActionDescription(action: TuiWorktreeAction): string {
  if (action === "merge") return "Merge into the project base, then remove the isolated environment.";
  if (action === "remove-branch") return "Remove only the already-merged worktree and its branch.";
  return "Remove the clean worktree; keep its unmerged Git branch for manual recovery.";
}

/** worktree 错误可能带绝对路径；普通 TUI 只显示安全结论，不把诊断路径带进弹层。 */
export function formatTuiWorktreeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("uncommitted") || message.includes("未提交")) {
    return "隔离工作树有未提交改动，已保留；请先手动处理后再试。";
  }
  if (message.includes("unmerged") || message.includes("未合并")) {
    return "隔离工作树有未合并提交，已保留；请先合并，或选择保留分支的清理方式。";
  }
  if (message.includes("conflict") || message.includes("冲突") || message.includes("merge")) {
    return "隔离工作树合并未完成，已保留；请手动处理冲突后再试。";
  }
  if (message.includes("unavailable") || message.includes("not a git repository") || message.includes("detached")) {
    return "当前项目不能使用 Git worktree 隔离；普通共享 session 仍可继续使用。";
  }
  return "隔离工作树操作未完成，已保留；请刷新状态后重试。";
}
