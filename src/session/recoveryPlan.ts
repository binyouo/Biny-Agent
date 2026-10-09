/**
 * 中断回合恢复决策。
 *
 * Session JSONL 和 TurnStore 只提供事实；本模块把这些事实归一化成唯一的继续计划。
 * AgentSession 只能执行计划，不能再自行推断工具副作用、用户输入边界或剩余步数。
 */
import { assertRetryWindow } from "./retryCommit.js";
import { sameRuntimeHighWater, validateRuntimeEventRecord } from "./runtimeEvent.js";
import { resolveRetryScope } from "./retryOrigin.js";
import type { BlockedReason } from "../agent/types.js";
import type { SessionEvent } from "./recorder.js";
import type { SessionReplay } from "./replay.js";
import type { InterruptedTurn } from "./turnStore.js";

export type ContinuationPlan =
  | { action: "continue"; remainingSteps: number }
  | { action: "finished" }
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
  "events" | "recoveredToolResults" | "retrySourceEvents"
>;

/**
 * Renewed preparation cannot substitute a different canonical user for a
 * proved native admission. Unknown/legacy evidence retains the existing
 * recovery checks; this does not reconstruct edit ancestry or compare text.
 */
export function admissionRecoveryInputConflict(
  turn: InterruptedTurn,
  events: readonly SessionEvent[],
  recoveredUserMessageId: string | undefined
): { admittedUserMessageId: string; recoveredUserMessageId: string } | undefined {
  if (turn.retryOrigin || turn.systemPrompt !== undefined || turn.completedSteps !== 0 || turn.terminal
    || !recoveredUserMessageId) return undefined;
  const highWater = turn.runtimeHighWater;
  const owner = turn.turnId;
  if (!owner || !highWater) return undefined;
  const witnesses = events.flatMap((event, index) => sameRuntimeHighWater(event.runtime, highWater) ? [index] : []);
  if (witnesses.length !== 1) return undefined;
  const users = events.slice(0, witnesses[0]! + 1).filter((event): event is Extract<SessionEvent, { type: "user_message" }> =>
    event.type === "user_message" && !event.auditOnly && event.runtime?.turnId === owner);
  if (users.length !== 1) return undefined;
  const admitted = users[0]!;
  const id = admitted.messageId;
  if (!id || admitted.importSource !== undefined || !admitted.runtime?.runId || !validateRuntimeEventRecord(admitted.runtime)) return undefined;
  // High-water may belong to unrelated background work. Use the user's own
  // run, and do not turn conflicting ownership or duplicate IDs into proof.
  if (events.some(event => event.runtime?.runId === admitted.runtime!.runId && event.runtime?.turnId !== owner)
    || events.filter(event => (event.type === "agent_message" || event.type === "user_message" && !event.auditOnly)
      && event.messageId === id).length !== 1) return undefined;
  // Checkpoint fields can lag durable execution. Same-turn canonical delivery
  // or execution after this input leaves the admission-only phase; keep the
  // existing continuation/unsafe-tool decisions rather than reclassifying it.
  if (events.some(event => event.importSource === undefined && event.runtime?.turnId === owner
    && Boolean(event.runtime.runId) && validateRuntimeEventRecord(event.runtime)
    && event.runtime.eventSeq > admitted.runtime!.eventSeq
    && (event.type === "agent_message" || event.type === "tool_execution"
      || (event.type === "user_message" || event.type === "tool_call" || event.type === "tool_result") && !event.auditOnly
      || event.type === "model_request" && event.metrics.requestContext?.operation === "agent"))) return undefined;
  return id === recoveredUserMessageId ? undefined
    : { admittedUserMessageId: id, recoveredUserMessageId };
}

export function resolveContinuationPlan(
  turn: InterruptedTurn,
  replay: RecoveryEvidence,
  turnLimit: number
): ContinuationPlan {
  const turnId = turn.turnId ?? turn.runtimeHighWater?.turnId;
  const retry = turn.retryOrigin ? resolveRetryScope(replay.retrySourceEvents ?? replay.events, turn.retryOrigin, turn) : undefined;
  if (turn.retryOrigin) assertRetryWindow(replay.retrySourceEvents ?? replay.events, turn.retryOrigin, turn.retryWindow);
  if (retry && retry.status !== "active") return { action: "finished" };
  // 终态已提交但断点尚未删除时也可能崩溃；正式日志必须压过陈旧断点。
  if (turnId && replay.events.some((event) => event.type === "turn_status"
    && event.runtime?.turnId === turnId
    && (event.status === "completed" || event.status === "cancelled" && event.stopReason !== "paused"))) {
    return { action: "finished" };
  }
  // 新根输入已经落盘就代表用户切换了任务；即使替换断点失败，也不能复活旧任务。
  const latestInput = [...replay.events].reverse().find((event) => event.type === "user_message" && event.runtime?.turnId);
  if (!retry && turnId && latestInput?.runtime?.turnId && latestInput.runtime.turnId !== turnId) return { action: "finished" };
  if (!turnId) {
    const pausedIndex = lastPausedIndex(replay.events);
    if (pausedIndex >= 0 && replay.events.slice(pausedIndex + 1).some((event) => event.type === "user_message")) {
      return { action: "finished" };
    }
  }
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
  if (retry && retry.final?.messageId === retry.cursor && !turn.terminal && !turn.retryCommit) {
    return { action: "block", blockedReason: "environment_unavailable",
      message: "Retry stopped between an intermediate reply and queued-message delivery; its final outcome is not recorded.",
      requiredAction: "Inspect the saved reply and undelivered messages, then explicitly start a new turn. No tool operation has been rerun." };
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

/** 暂停属于当前断点，且暂停后没有新的根输入或完成终态，才允许从历史开启新回合。 */
export function pausedTurnAvailable(turn: InterruptedTurn, replay: Pick<SessionReplay, "events">): boolean {
  const turnId = turn.turnId ?? turn.runtimeHighWater?.turnId;
  if (turn.retryOrigin && resolveRetryScope("retrySourceEvents" in replay && Array.isArray(replay.retrySourceEvents) ? replay.retrySourceEvents : replay.events, turn.retryOrigin, turn).status !== "active") return false;
  const pausedIndex = lastPausedIndex(replay.events, turnId);
  if (pausedIndex < 0) return false;
  return !replay.events.slice(pausedIndex + 1).some((event) => event.type === "user_message"
    || event.type === "turn_status" && (event.status === "completed" || event.status === "cancelled" && event.stopReason !== "paused")
      && (turnId === undefined || event.runtime?.turnId === undefined || event.runtime.turnId === turnId));
}

function lastPausedIndex(events: readonly SessionEvent[], turnId?: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn_status" && event.stopReason === "paused"
      && (turnId === undefined || event.runtime?.turnId === undefined || event.runtime.turnId === turnId)) return index;
  }
  return -1;
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

export const pausedTurnMarker = `<turn_paused>
The previous turn was paused before completion. Running processes may still be active in the background. If tools or commands were cancelled, they may have partially executed.
</turn_paused>`;

/** Native control context for the two explicit paused-new-task boundaries. */
export function witnessedPausedFollowupMarker(events: readonly SessionEvent[], turn: InterruptedTurn, admitted: boolean): string {
  const witness = events.findIndex(event => sameRuntimeHighWater(event.runtime, turn.runtimeHighWater));
  if (!turn.turnId || witness < 0) throw new Error("Paused followup checkpoint has no exact runtime witness.");
  let boundary = events.length;
  let owner = turn.turnId;
  if (admitted) {
    const admissions = events.flatMap((event, index) => event.type === "user_message" && event.auditOnly
      && event.metadata?.turnTrigger === "resume_interrupted_task" && event.runtime?.turnId === turn.turnId ? [{ event, index }] : []);
    const admission = admissions[0];
    if (turn.retryOrigin || turn.retryWindow || turn.retryCommit || turn.terminal || turn.prompt !== "" || turn.completedSteps !== 0
      || admissions.length !== 1 || !admission || admission.index > witness || admission.event.importSource !== undefined
      || admission.event.content !== "" || !admission.event.runtime?.runId) throw new Error("Invalid native paused-followup admission checkpoint.");
    boundary = admission.index;
    const preceding = events.slice(0, boundary).filter(event => event.type === "turn_status" && event.stopReason === "paused").at(-1);
    if (preceding?.type !== "turn_status" || !preceding.runtime?.turnId) throw new Error("Admitted followup has no preceding native pause.");
    owner = preceding.runtime.turnId;
    if (events.slice(boundary + 1).some(event => event.type !== "message_metadata" && event.type !== "model_request" && event.type !== "error"
      && !(event.type === "turn_status" && event.status === "failed" && event.runtime?.turnId === turn.turnId))) {
      throw new Error("Admitted paused followup already advanced beyond its initial boundary.");
    }
  } else {
    if (!turn.retryOrigin || resolveRetryScope(events, turn.retryOrigin, turn).status !== "active") throw new Error("Paused retry followup was superseded.");
    assertRetryWindow(events, turn.retryOrigin, turn.retryWindow);
    if (!pausedTurnAvailable(turn, { events: [...events] })) throw new Error("Retry is no longer paused.");
  }
  let pausedIndex = -1;
  for (let index = boundary - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn_status" && event.stopReason === "paused" && event.runtime?.turnId === owner) { pausedIndex = index; break; }
  }
  const terminal = events[pausedIndex];
  if (!admitted && witness > pausedIndex) throw new Error("Paused checkpoint witness is newer than its pause.");
  if (terminal?.type !== "turn_status" || terminal.status !== "cancelled" || terminal.importSource !== undefined
    || !terminal.runtime?.runId) throw new Error("Paused followup has no native paused terminal.");
  if (events.slice(pausedIndex + 1, boundary).some(event => event.type === "user_message" || event.type === "agent_message"
    || event.type === "message_version_selected" || event.type === "turn_status" && (event.status === "completed"
      || event.status === "cancelled" && event.stopReason !== "paused"))) throw new Error("Paused followup has newer task or version intent.");
  let markerIndex = -1;
  for (let index = pausedIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "turn_interrupted" && event.reason === "paused" && event.runtime?.turnId === owner
      && event.runtime.runId === terminal.runtime.runId) { markerIndex = index; break; }
  }
  const marker = events[markerIndex];
  if (marker?.type !== "turn_interrupted" || marker.importSource !== undefined || marker.content !== pausedTurnMarker) {
    throw new Error("Paused followup has no exact native control marker.");
  }
  if (events.slice(markerIndex + 1, pausedIndex).some(event => event.type !== "message_metadata"
    && event.type !== "model_request" && event.type !== "error")) throw new Error("Pause marker chronology contains later execution.");
  return marker.content;
}
