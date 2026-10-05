import type { DesktopRuntimeMutation, DesktopSlashResult } from "../../../../protocol.js";
import type { SessionGoalRecord } from "../../../../../runtime/SessionGoalStore.js";

export type SessionGoalControl = "session.goal.pause" | "session.goal.resume" | "session.goal.clear" | { operation: "session.goal.set"; objective: string; previousObjective: string };

export function sessionGoalSlashFeedback(result: DesktopSlashResult, isCurrent: boolean): { result?: DesktopSlashResult; notice?: string } {
  if (!isCurrent) return {};
  const goal = result.sessionGoal;
  if (!goal || goal.action === "get") return { result };
  if (goal.action === "clear") return { notice: "已清除目标并退出 Goal 模式。" };
  if (goal.action === "pause") return { notice: "Goal 模式已暂停。" };
  if (goal.status === "active") return { notice: "已进入 Goal 模式，持续推进当前目标。" };
  if (goal.status === "paused") return { notice: "目标已更新，Goal 模式仍暂停。" };
  if (goal.status === "blocked") return { notice: "目标已更新，Goal 正等待处理。" };
  if (goal.status === "budget_limited") return { notice: "目标已更新，Goal 已达到 token 预算。" };
  if (goal.status === "completed") return { notice: "目标已完成。" };
  return { notice: "已设置当前会话目标。" };
}

export async function changeSessionGoal(
  goal: Pick<SessionGoalRecord, "sessionId" | "goalId" | "revision" | "objective">,
  operation: SessionGoalControl,
  mutate: (operation: DesktopRuntimeMutation, payload: Record<string, unknown>) => Promise<void>,
  feedback: { pending(value: boolean): void; error(value?: string): void; report(error: unknown): void },
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;
  const edit = typeof operation === "object" ? operation.objective.trim() : undefined;
  if (edit === "") {
    feedback.error("目标不能为空。");
    return false;
  }
  if (typeof operation === "object") {
    if (edit === operation.previousObjective) { feedback.error(undefined); return true; }
    if (goal.objective !== operation.previousObjective) {
      feedback.error("目标已变化，请取消编辑后重新打开。");
      return false;
    }
  }
  feedback.pending(true);
  feedback.error(undefined);
  try {
    const payload: Record<string, unknown> = { sessionId: goal.sessionId, expected: { goalId: goal.goalId, revision: goal.revision } };
    if (edit !== undefined) payload.objective = edit;
    await mutate(typeof operation === "object" ? operation.operation : operation, payload);
    return !signal.aborted;
  } catch (failure) {
    if (signal.aborted) return false;
    feedback.error(failure instanceof Error ? failure.message : String(failure));
    feedback.report(failure);
    return false;
  } finally {
    if (!signal.aborted) feedback.pending(false);
  }
}
