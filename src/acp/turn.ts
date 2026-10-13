import path from "node:path";
import { canonicalPath } from "../permission/pathPolicy.js";
import { randomUUID } from "node:crypto";
import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentSessionEvent, AgentPermissionRequest, AgentPermissionResult, AgentTurnOutcome } from "../agent/types.js";
import { EventQueue } from "../agent/core/EventQueue.js";
import { analyzePermissionRequest } from "../permission/policy.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import type { PermissionManager } from "../permission/PermissionManager.js";
import { AcpClient } from "./client.js";

export async function* runAcpTurn(client: AcpClient, options: {
  content: ContentBlock[];
  model: string;
  signal?: AbortSignal;
  workspaceRoot: string;
  sessionId: string;
  permissionManager?: PermissionManager;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
}): AsyncGenerator<AgentSessionEvent> {
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const prefix = randomUUID();
  const queue = new EventQueue<AgentSessionEvent>();
  const tools = new Map<string, { name: string; finished: boolean }>();
  let output = "";
  let reasoning = false;
  let denied = false;
  let queuedPermissions = 0;
  let permissionQueue: Promise<unknown> = Promise.resolve();
  let uncertain = false;
  const update = ({ update }: SessionNotification): void => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      output += update.content.text;
      queue.push({ type: "assistant.delta", content: update.content.text });
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
      if (!reasoning) { reasoning = true; queue.push({ type: "reasoning.started", phase: "initial" }); }
      queue.push({ type: "reasoning.delta", content: update.content.text });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const toolCallId = `${prefix}:${update.toolCallId}`;
      let tool = tools.get(toolCallId);
      if (!tool) {
        tool = { name: update.title ?? "ACP tool", finished: false };
        tools.set(toolCallId, tool);
        queue.push({ type: "tool.started", toolCallId, tool: tool.name, args: update.rawInput ?? {} });
      }
      if (!tool.finished && (update.status === "completed" || update.status === "failed")) {
        tool.finished = true;
        const result = update.rawOutput ?? update.content ?? update.status;
        queue.push(update.status === "completed"
          ? { type: "tool.completed", toolCallId, tool: tool.name, result }
          : { type: "tool.failed", toolCallId, tool: tool.name, result, error: "外部 Agent 工具未完成。" });
      }
    }
  };
  const permission = async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    if (signal.aborted) return { outcome: { outcome: "cancelled" } };
    const call = request.toolCall;
    const raw = call.rawInput && typeof call.rawInput === "object" ? call.rawInput as Record<string, unknown> : {};
    const paths = [...new Set([
      ...(call.locations ?? []).map((location) => location.path),
      ...(call.content ?? []).flatMap((content) => content.type === "diff" ? [content.path] : []),
      ...[raw.path, raw.file_path, raw.filePath, raw.destinationPath].filter((value): value is string => typeof value === "string")
    ])];
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const base = { sessionId: options.sessionId, projectRoot: options.workspaceRoot };
    const rank = { low: 0, medium: 1, high: 2, critical: 3 };
    const requests = (paths.length ? paths : [undefined]).map((targetPath) => {
      let analyzed = command ? analyzePermissionRequest({ ...base, toolName: "Bash", args: { command } })
        : targetPath && (call.kind === "read" || call.kind === "search" || call.kind === "edit")
          ? analyzePermissionRequest({ ...base, toolName: call.kind === "edit" ? "Write" : "Read", args: { path: targetPath } })
          : { ...base, toolName: "ACP", actionType: call.kind === "read" || call.kind === "search" ? "read" as const
            : call.kind === "edit" ? "write" as const : call.kind === "execute" ? "shell" as const : "unknown" as const, riskLevel: "high" as const };
      if (!command && targetPath && (call.kind === "read" || call.kind === "search" || call.kind === "edit")) {
        const resolved = analyzePermissionRequest({ ...base, toolName: call.kind === "edit" ? "Write" : "Read",
          args: { path: canonicalPath(path.resolve(options.workspaceRoot, targetPath)) } });
        if (rank[resolved.riskLevel] > rank[analyzed.riskLevel]) analyzed = resolved;
      }
      return { ...analyzed, toolName: "ACP", targetPath };
    });
    const strongest = requests.reduce((a, b) => rank[a.riskLevel] >= rank[b.riskLevel] ? a : b);
    const prompt: AgentPermissionRequest = {
      ...strongest, tool: "ACP", toolCallId: `${prefix}:${call.toolCallId}`,
      title: call.title ?? "外部 Agent 请求授权",
      details: JSON.stringify({ input: call.rawInput, content: call.content, paths }),
      requireFullYes: strongest.riskLevel === "critical", canRemember: false
    };
    const evaluate = () => {
      const decisions = requests.map((item) => options.permissionManager?.evaluate(item));
      return decisions.some((item) => item?.decision === "deny") ? "deny"
        : decisions.every((item) => item?.decision === "allow") ? "allow" : "ask";
    };
    const evaluation = evaluate();
    let approved = evaluation === "allow";
    if (evaluation === "ask") {
      if (options.confirmPermission && !signal.aborted) {
        queue.push({ type: "status", status: "waiting_permission" });
        let abort: (() => void) | undefined;
        const cancelled = new Promise<AgentPermissionResult>((resolve) => {
          abort = () => resolve({ approved: false });
          signal.addEventListener("abort", abort, { once: true });
        });
        try {
          const result = await Promise.race([options.confirmPermission(prompt), cancelled]);
          approved = result.approved && result.action !== "deny" && result.action !== "deny_with_reason"
            && (!prompt.requireFullYes || isFullYesConfirmation(result.confirmation ?? ""));
        }
        finally { if (abort) signal.removeEventListener("abort", abort); }
        if (!signal.aborted && queuedPermissions <= 1) queue.push({ type: "status", status: "running" });
      }
    }
    if (signal.aborted) return { outcome: { outcome: "cancelled" } };
    if (evaluate() === "deny") approved = false;
    if (!approved) options.permissionManager?.applyResult(prompt, { approved: false, message: "ACP 授权被拒绝。" });
    const choice = request.options.find((option) => option.kind === (approved ? "allow_once" : "reject_once"));
    if (!approved || !choice) denied = true;
    return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
  };
  yield { type: "status", status: "running" };
  let settled = false;
  let finishReason: string | undefined;
  let failure: unknown;
  const pending = client.prompt({ ...options, onUpdate: update, onPermission: (request) => {
    if (signal.aborted || queuedPermissions >= 16) {
      denied = true;
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    queuedPermissions++;
    const response = permissionQueue.then(() => permission(request)).finally(() => { queuedPermissions--; });
    permissionQueue = response.catch(() => undefined);
    return response;
  } })
    .then((reason) => { finishReason = reason; }, (error: unknown) => { failure = error; })
    .finally(() => { settled = true; uncertain = queuedPermissions > 0 || [...tools.values()].some((tool) => !tool.finished); lifetime.abort(); });
  try {
    while (!settled) {
      for (const event of queue.drain()) yield event;
      if (!settled) await queue.waitForEventOr(pending);
    }
    for (const event of queue.drain()) yield event;
    if (reasoning) yield { type: "reasoning.completed" };
    const cancelled = options.signal?.aborted || finishReason === "cancelled";
    for (const [toolCallId, tool] of tools) if (!tool.finished) {
      yield { type: "tool.failed", toolCallId, tool: tool.name, error: "外部工具结果未确认，未自动重放。", executionStatus: "unknown" };
    }
    const outcome: AgentTurnOutcome = {
      status: cancelled ? "cancelled" : failure ? "failed" : denied ? "blocked" : uncertain ? "incomplete" : finishReason === "end_turn" ? "completed" : "incomplete",
      stopReason: cancelled ? "cancelled" : failure ? failure instanceof Error && failure.name === "TimeoutError" ? "timeout" : "provider_error" : denied ? "blocked" : uncertain ? "missing_terminal_event" : finishReason === "end_turn" ? "model_stop" : finishReason === "refusal" ? "content_filter" : finishReason === "max_turn_requests" ? "step_limit" : "model_length",
      output, steps: 1, finishReason, resumable: false,
      error: failure ? (failure instanceof Error ? failure.message : String(failure)) : undefined,
      blockedReason: denied ? "permission_denied" : undefined
    };
    if (outcome.error) yield { type: "error", message: outcome.error };
    yield { type: "assistant.completed", content: output };
    yield { type: "done", content: output, outcome };
  } finally {
    lifetime.abort();
    if (!settled || failure || uncertain || options.signal?.aborted) await client.close();
  }
}
