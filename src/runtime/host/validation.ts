/**
 * Runtime Host 请求输入与错误的纯解析层。
 *
 * 业务 Server 只接收这里返回的已验证值，不直接把 unknown 传给领域服务。
 */
import { randomUUID } from "node:crypto";
import type { AgentAttachment } from "../../agent/AgentSession.js";
import { agentCapabilitySelectionSchema, type AgentCapabilitySelection } from "../../agent/capabilitySelection.js";
import type { AgentRunOutcome, RuntimeRequestIds } from "../InteractiveAgentRuntime.js";
import type { MemoryDurability, MemoryEntryInput, MemoryEntryPatch, MemoryKind, MemoryLineage, MemoryLineageSource, MemoryOriginSelector } from "../../agent/context/memoryTypes.js";
import { thinkingLevelSchema } from "../../config/schema.js";
import type { PermissionAction, PermissionMode, PermissionResult } from "../../permission/PermissionManager.js";
import type { RuntimeRunStatus } from "../RuntimeAuthority.js";
import type { TaskRunStatus } from "../TaskRunStore.js";
import type { TaskRetrySafety } from "../TaskRunStore.js";
import type { AutomationCreateInput } from "../AutomationScheduler.js";
import type { GraphNodeInput } from "../GoalGraphStore.js";
import type { HostResponseFrame } from "./protocol.js";
import type { HostSurface, RuntimeIsolation } from "./types.js";
import type { LocalEmbeddingModelId } from "../../llm/embedding/types.js";
import type { ThinkingSelection } from "../../llm/ModelManager.js";
import { SessionWriterConflictError } from "../SessionLease.js";

export function readMemoryOriginSelector(value: unknown, allowAll: boolean): MemoryOriginSelector {
  if (value === "current_workspace" || value === "user" || value === "other_workspaces" || (allowAll && value === "all")) return value;
  throw new Error("Runtime Host memory selector must be " + (allowAll ? "all, " : "") + "current_workspace, user, or other_workspaces.");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Runtime Host field ${name} must be a non-empty string.`);
  return value;
}

export function readPromptContext(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 30_000) {
    throw new Error("Runtime Host prompt context must be a string of at most 30000 characters.");
  }
  return value;
}

export function readCapabilitySelection(value: unknown): AgentCapabilitySelection | undefined {
  if (value === undefined) return undefined;
  return agentCapabilitySelectionSchema.parse(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readRuntimeIsolation(value: unknown): RuntimeIsolation | undefined {
  if (value === undefined) return undefined;
  if (value === "shared" || value === "worktree") return value;
  throw new Error("Runtime Host isolation must be shared or worktree.");
}

export function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Runtime Host field ${name} must be a safe integer.`);
  return value as number;
}

export function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

export function readStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Runtime Host field ${name} must be a string array.`);
  return value;
}

export function readMemoryEntryInput(value: unknown): MemoryEntryInput {
  const record = asRecord(value);
  const importance = record.importance === undefined ? undefined : requiredInteger(record.importance, "entry.importance");
  if (importance !== undefined && (importance < 1 || importance > 5)) {
    throw new Error("Runtime Host memory entry importance must be between 1 and 5.");
  }
  const lineageValues = Array.isArray(record.lineage) ? record.lineage : [record.lineage];
  if (lineageValues.some((item) => item === undefined)) throw new Error("Runtime Host memory entry lineage is required.");
  return {
    audience: readMemoryAudience(record.audience),
    kind: readMemoryKind(record.kind),
    topic: requiredString(record.topic, "entry.topic"),
    title: requiredString(record.title, "entry.title"),
    summary: requiredString(record.summary, "entry.summary"),
    decisions: record.decisions === undefined ? undefined : readStringArray(record.decisions, "entry.decisions"),
    paths: record.paths === undefined ? undefined : readStringArray(record.paths, "entry.paths"),
    keywords: record.keywords === undefined ? undefined : readStringArray(record.keywords, "entry.keywords"),
    importance,
    durability: readMemoryDurability(record.durability),
    expiresAt: optionalString(record.expiresAt),
    lineage: lineageValues.map(readMemoryLineage)
  };
}

export function readMemoryAudience(value: unknown): "workspace" | "universal" {
  if (value === "workspace" || value === "universal") return value;
  throw new Error("Runtime Host memory audience must be workspace or universal.");
}

export function readMemoryEntryPatch(value: unknown): MemoryEntryPatch {
  const record = asRecord(value);
  const importance = record.importance === undefined ? undefined : requiredInteger(record.importance, "patch.importance");
  if (importance !== undefined && (importance < 1 || importance > 5)) {
    throw new Error("Runtime Host memory patch importance must be between 1 and 5.");
  }
  return {
    kind: record.kind === undefined ? undefined : readMemoryKind(record.kind),
    topic: optionalString(record.topic),
    title: optionalString(record.title),
    summary: optionalString(record.summary),
    decisions: record.decisions === undefined ? undefined : readStringArray(record.decisions, "patch.decisions"),
    paths: record.paths === undefined ? undefined : readStringArray(record.paths, "patch.paths"),
    keywords: record.keywords === undefined ? undefined : readStringArray(record.keywords, "patch.keywords"),
    importance,
    durability: readMemoryDurability(record.durability),
    expiresAt: optionalString(record.expiresAt),
    userEvidence: optionalString(record.userEvidence)
  };
}

export function readMemoryDurability(value: unknown): MemoryDurability | undefined {
  if (value === undefined) return undefined;
  if (value === "temporary" || value === "permanent") return value;
  throw new Error("Runtime Host memory durability must be temporary or permanent.");
}

export function readMemoryKind(value: unknown): MemoryKind {
  if (value === "preference" || value === "working_style" || value === "fact" || value === "decision" || value === "workflow" || value === "gotcha") {
    return value;
  }
  throw new Error("Runtime Host memory entry kind is invalid.");
}


export function readLocalEmbeddingModel(value: unknown): LocalEmbeddingModelId {
  if (value === "multilingual-e5-small") return value;
  throw new Error("Runtime Host local embedding model is invalid.");
}

export function readMemoryLineage(value: unknown): MemoryLineage {
  const record = asRecord(value);
  if (typeof record.externalContext !== "boolean") throw new Error("Runtime Host memory lineage externalContext must be boolean.");
  return {
    source: readMemoryLineageSource(record.source),
    externalContext: record.externalContext,
    sessionId: optionalString(record.sessionId),
    turnId: optionalString(record.turnId),
    runId: optionalString(record.runId),
    sourceEntryIds: record.sourceEntryIds === undefined ? undefined : readStringArray(record.sourceEntryIds, "entry.lineage.sourceEntryIds"),
    userEvidence: optionalString(record.userEvidence)
  };
}

export function readMemoryLineageSource(value: unknown): MemoryLineageSource {
  if (value === "explicit" || value === "explicit_edit" || value === "completed_task" || value === "self_reflection" || value === "sleep") {
    return value;
  }
  throw new Error("Runtime Host memory lineage source is invalid.");
}

export function readAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Runtime Host attachments must be an array.");
  return value.map((item) => {
    const record = asRecord(item);
    if (typeof record.name !== "string" || typeof record.mimeType !== "string" || typeof record.data !== "string") {
      throw new Error("Runtime Host attachment is invalid.");
    }
    return {
      name: record.name,
      mimeType: record.mimeType,
      data: record.data,
      path: optionalString(record.path),
      size: Number.isSafeInteger(record.size) ? record.size as number : undefined
    };
  });
}

export function readRequestIds(payload: Record<string, unknown>): RuntimeRequestIds {
  const runId = optionalString(payload.runId);
  const messageId = optionalString(payload.messageId);
  const turnId = optionalString(payload.turnId);
  const parentRunId = optionalString(payload.parentRunId);
  const continuationSource = optionalString(payload.continuationSource);
  const retryOfMessageId = optionalString(payload.retryOfMessageId);
  const replaceUserMessageId = optionalString(payload.replaceUserMessageId);
  return { runId, messageId, turnId, parentRunId, continuationSource, retryOfMessageId, replaceUserMessageId };
}

export function readOptionalRunStatus(value: unknown): RuntimeRunStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "admitted" || value === "running" || value === "completed" || value === "blocked" || value === "incomplete" || value === "cancelled" || value === "aborted" || value === "failed" || value === "unknown") return value;
  throw new Error("Runtime Host run status is invalid.");
}

export function readOptionalTaskStatus(value: unknown): TaskRunStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "queued" || value === "created" || value === "running" || value === "verifying" || value === "completed" || value === "failed" || value === "incomplete" || value === "blocked" || value === "policy_denied" || value === "budget_exhausted" || value === "needs_approval" || value === "aborted" || value === "cancelled") return value;
  throw new Error("Runtime Host TaskRun status is invalid.");
}

export function readTaskRetrySafety(value: unknown): TaskRetrySafety | undefined {
  if (value === undefined) return undefined;
  if (value === "safe" || value === "idempotent" || value === "unsafe" || value === "unknown") return value;
  throw new Error("Runtime Host TaskRun retrySafety is invalid.");
}

export function readCapabilityOwnerType(value: unknown): "host" | "client" {
  if (value === "host" || value === "client") return value;
  throw new Error("Capability owner type must be host or client.");
}

export function readAutomationCreateInput(payload: Record<string, unknown>): AutomationCreateInput {
  const schedule = asRecord(payload.schedule);
  const template = asRecord(payload.executionTemplate);
  const triggerType = payload.triggerType;
  if (triggerType !== "heartbeat" && triggerType !== "cron" && triggerType !== "interval" && triggerType !== "once") {
    throw new Error("Automation trigger type is invalid.");
  }
  assertAllowedKeys(template, ["prompt", "sessionId"], "Automation execution template");
  const intervalMs = schedule.intervalMs;
  if (intervalMs !== undefined && !Number.isSafeInteger(intervalMs)) throw new Error("Automation intervalMs is invalid.");
  const jitterMs = schedule.jitterMs;
  if (jitterMs !== undefined && !Number.isSafeInteger(jitterMs)) throw new Error("Automation jitterMs is invalid.");
  const maxFires = payload.maxFires;
  if (maxFires !== undefined && !Number.isSafeInteger(maxFires)) throw new Error("Automation maxFires is invalid.");
  return {
    automationId: optionalString(payload.automationId),
    name: requiredString(payload.name, "name"),
    triggerType,
    schedule: {
      cron: optionalString(schedule.cron),
      intervalMs: intervalMs as number | undefined,
      at: optionalString(schedule.at),
      jitterMs: jitterMs as number | undefined
    },
    executionTemplate: {
      prompt: requiredString(template.prompt, "executionTemplate.prompt"),
      sessionId: optionalString(template.sessionId)
    },
    maxFires: maxFires as number | undefined,
    expiresAt: optionalString(payload.expiresAt)
  };
}

export function readGraphNodes(value: unknown): GraphNodeInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Graph nodes must be a non-empty array.");
  return value.map((item, index) => {
    const node = asRecord(item);
    const dependencies = node.dependencies;
    if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string"))) {
      throw new Error(`Graph node ${String(index)} dependencies are invalid.`);
    }
    return {
      nodeKey: requiredString(node.nodeKey, `nodes[${String(index)}].nodeKey`),
      prompt: requiredString(node.prompt, `nodes[${String(index)}].prompt`),
      dependencies: dependencies as string[] | undefined,
      intent: node.intent,
      verification: node.verification
    };
  });
}

export function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} contains unsupported field: ${unexpected}.`);
}

export interface NormalizedRequestIds {
  runId: string;
  messageId: string;
  turnId: string;
  parentRunId?: string;
  continuationSource?: string;
  retryOfMessageId?: string;
  replaceUserMessageId?: string;
}

export function normalizeRequestIds(ids: RuntimeRequestIds | undefined): NormalizedRequestIds {
  return {
    runId: ids?.runId ?? randomUUID(),
    messageId: ids?.messageId ?? randomUUID(),
    turnId: ids?.turnId ?? randomUUID(),
    parentRunId: ids?.parentRunId,
    continuationSource: ids?.continuationSource,
    retryOfMessageId: ids?.retryOfMessageId,
    replaceUserMessageId: ids?.replaceUserMessageId
  };
}

export function readPermissionMode(value: unknown): PermissionMode {
  if (value === "ask" || value === "read-only" || value === "auto" || value === "full-access") return value;
  throw new Error("Runtime Host permission mode is invalid.");
}

export function readPermissionResult(value: unknown): PermissionResult {
  const record = asRecord(value);
  if (typeof record.approved !== "boolean") throw new Error("Runtime Host permission result is invalid.");
  const action = readPermissionAction(record.action);
  if (action !== undefined && (action === "allow_once" || action === "allow_always") !== record.approved) {
    throw new Error("Runtime Host permission action does not match approved.");
  }
  const message = optionalString(record.message);
  if (action === "deny_with_reason" && !message?.trim()) throw new Error("Runtime Host denial reason is required.");
  return {
    approved: record.approved,
    action,
    scope: record.scope as PermissionResult["scope"],
    nextMode: record.nextMode as PermissionResult["nextMode"],
    message,
    confirmation: optionalString(record.confirmation)
  };
}

function readPermissionAction(value: unknown): PermissionAction | undefined {
  if (value === undefined) return undefined;
  if (value === "allow_once" || value === "allow_always" || value === "deny" || value === "deny_with_reason") return value;
  throw new Error("Runtime Host permission action is invalid.");
}

export function readThinking(value: unknown): ThinkingSelection | undefined {
  if (value === undefined) return undefined;
  const parsed = thinkingLevelSchema.safeParse(value);
  if (!parsed.success) throw new Error("Runtime Host thinking selection is invalid.");
  return parsed.data;
}

export function readSurface(value: unknown): HostSurface {
  if (isSurface(value)) return value;
  throw new Error("Runtime Host surface is invalid.");
}

export function isSurface(value: unknown): value is HostSurface {
  return value === "desktop" || value === "tui" || value === "cli";
}

export function publicError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function publicErrorCode(error: unknown): string | undefined {
  if (error instanceof SessionWriterConflictError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && [
    "host_draining",
    "runtime_capacity_exceeded",
    "runtime_concurrency_exceeded",
    "resource_baseline_pending",
    "worktree_unavailable",
    "worktree_dirty",
    "worktree_merge_conflict",
    "worktree_unmerged"
  ].includes(error.code)) return error.code;
  return undefined;
}

export function publicErrorData(error: unknown): unknown {
  if (!(error instanceof SessionWriterConflictError)) return undefined;
  return {
    sessionId: error.sessionId,
    ownerPid: error.ownerPid,
    ownerSurface: error.ownerSurface
  };
}

export function errorFromHostFrame(frame: HostResponseFrame): Error {
  if (frame.errorCode === "session_writer_conflict") {
    const data = asRecord(frame.errorData);
    return new SessionWriterConflictError(
      typeof data.sessionId === "string" ? data.sessionId : "unknown",
      typeof data.ownerPid === "number" ? data.ownerPid : undefined,
      typeof data.ownerSurface === "string" ? data.ownerSurface : undefined,
      frame.error ?? "Session is already open in another application."
    );
  }
  const error = new Error(frame.error ?? "Runtime Host request failed.");
  if (frame.errorCode !== undefined) Object.assign(error, { code: frame.errorCode });
  return error;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isTransientHostError(error: unknown): boolean {
  const message = asError(error).message;
  return message.includes("connection closed")
    || message.includes("disconnected")
    || message.includes("registration is not available")
    || message.includes("did not become ready");
}

export function isRuntimeRevisionConflict(error: unknown): boolean {
  return asError(error).message.startsWith("Runtime Host revision conflict:");
}

export function readRecoveryStopReason(value: unknown): AgentRunOutcome["stopReason"] {
  if (
    value === "model_stop"
    || value === "step_limit"
    || value === "hard_step_limit"
    || value === "tool_call_limit"
    || value === "repeated_action_limit"
    || value === "timeout"
    || value === "model_length"
    || value === "content_filter"
    || value === "provider_error"
    || value === "blocked"
    || value === "cancelled"
    || value === "aborted"
    || value === "budget_exhausted"
  ) return value;
  return "provider_error";
}
