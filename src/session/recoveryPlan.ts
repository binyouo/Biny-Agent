/**
 * 中断回合恢复决策。
 *
 * Session JSONL 和 TurnStore 只提供事实；本模块把这些事实归一化成唯一的继续计划。
 * AgentSession 只能执行计划，不能再自行推断工具副作用、用户输入边界或剩余步数。
 */
import type { BlockedReason } from "../agent/types.js";
import type { SessionEvent } from "./recorder.js";
import type { SessionReplay } from "./replay.js";
import type { InterruptedTurn } from "./turnStore.js";

export type ContinuationPlan =
  | { action: "continue"; remainingSteps: number }
  | {
    action: "block";
    message: string;
    blockedReason: BlockedReason;
    requiredAction: string;
  }
  | { action: "require-user-input"; message: string }
  | { action: "exhausted"; message: string };

type RecoveryEvidence = Pick<
  SessionReplay,
  "events" | "recoveredToolResults"
>;

export function resolveContinuationPlan(
  turn: InterruptedTurn,
  replay: RecoveryEvidence,
  turnLimit: number
): ContinuationPlan {
  const turnId = turn.turnId ?? turn.runtimeHighWater?.turnId;
  const operationTurnIds = toolOperationTurnIds(replay.events);
  const unsafeTools = new Set<string>();

  for (const operation of unknownToolOperations(replay)) {
    const operationTurnId = operation.toolCallId
      ? operationTurnIds.get(operation.toolCallId)
      : undefined;
    // 旧事件没有 turnId 时无法证明副作用属于别的任务，必须保守阻塞。
    if (!turnId || !operationTurnId || operationTurnId === turnId) unsafeTools.add(operation.tool);
  }

  if (unsafeTools.size > 0) {
    return {
      action: "block",
      message: `${[...unsafeTools].join("、")} 可能产生了未确认的副作用，恢复已阻塞。`,
      blockedReason: "unsafe_action_required",
      requiredAction: "Inspect the session facts and workspace, then start a new turn after resolving the unknown tool operation."
    };
  }
  if (
    turn.terminal?.status === "blocked"
    && (turn.terminal.blockedReason === "missing_user_input"
      || turn.terminal.blockedReason === "unsafe_action_required")
  ) {
    return {
      action: "require-user-input",
      message: turn.terminal.requiredAction
        ? `This blocked turn requires a new user message: ${turn.terminal.requiredAction}`
        : "This blocked turn requires a new user message before it can continue."
    };
  }
  const remainingSteps = turnLimit - turn.completedSteps;
  if (remainingSteps < 1) {
    return {
      action: "exhausted",
      message: `The interrupted turn already reached its ${String(turnLimit)}-step limit. Send a new user message to start another turn.`
    };
  }
  return { action: "continue", remainingSteps };
}

function toolOperationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    const turnId = event.runtime?.turnId;
    if (!turnId) continue;
    if ((event.type === "tool_call" || event.type === "tool_execution") && event.toolCallId) {
      result.set(event.toolCallId, turnId);
      continue;
    }
    if (event.type !== "agent_message" || event.message.role !== "assistant") continue;
    for (const part of event.message.content) {
      if (part.type === "toolCall") result.set(part.id, turnId);
    }
  }
  return result;
}

function unknownToolOperations(replay: RecoveryEvidence): Array<{ tool: string; toolCallId?: string }> {
  const operations = new Map<string, { tool: string; toolCallId?: string }>();
  for (const [index, event] of [...replay.events, ...replay.recoveredToolResults].entries()) {
    if (event.type !== "tool_result" || event.executionStatus !== "unknown") continue;
    // 旧 session 可能没有 operationId，仍要用 toolCallId 或事件位置稳定去重并保守阻塞。
    const key = event.operationId ?? event.toolCallId ?? `legacy-tool-result-${String(index)}`;
    operations.set(key, {
      tool: event.tool,
      toolCallId: event.toolCallId
    });
  }
  return [...operations.values()];
}
