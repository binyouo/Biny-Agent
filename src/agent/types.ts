/** AgentSession 对外发布的规范化运行事件。 */
import type { AgentConfig } from "../config/schema.js";
import type { AgentModel } from "./core/types.js";
import type { SessionRecorder } from "../session/recorder.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutionResultStatus, ToolInputDisplay, ToolUpdate } from "../tools/types.js";
import type { PermissionManager, PermissionPrompt, PermissionResult } from "../permission/PermissionManager.js";
import type { SessionUsage } from "../session/metadata.js";
import type { ContextStatus } from "./context/types.js";
import type { ContextMemory } from "./context/ContextMemory.js";
import type { CapabilityStore } from "../runtime/CapabilityStore.js";

// Preserve Agent-facing event names while the shared permission contract lives in permission/.
export type AgentPermissionRequest = PermissionPrompt;
export type AgentPermissionResult = PermissionResult;

export type AgentTurnStatus = "completed" | "incomplete" | "blocked" | "cancelled" | "failed" | "aborted";

export type BlockedReason =
  | "missing_user_input"
  | "waiting_for_approval"
  | "permission_denied"
  | "missing_dependency"
  | "environment_unavailable"
  | "external_service_failure"
  | "unsafe_action_required";

/** AgentSession 的终止原因；正常回合直接使用模型自然停止结果。 */
export type AgentTurnStopReason =
  | "model_stop"
  | "step_limit"
  | "hard_step_limit"
  | "tool_call_limit"
  | "repeated_action_limit"
  | "timeout"
  | "model_length"
  | "content_filter"
  | "provider_error"
  | "missing_terminal_event"
  | "blocked"
  | "cancelled"
  | "aborted"
  | "budget_exhausted";

/** 一个统一模型/工具回合的结构化终态。 */
export interface AgentTurnOutcome {
  status: AgentTurnStatus;
  stopReason: AgentTurnStopReason;
  finishReason?: string;
  steps: number;
  output: string;
  usage?: SessionUsage;
  error?: string;
  resumable?: boolean;
  blockedReason?: string;
  requiredAction?: string;
  affectedTodoIds?: string[];
  /** 模型在回复末尾写的一句结果摘要；宿主剥块后用作后台系统通知正文。 */
  notification?: string;
}

export type AgentSessionUpdate =
  | { type: "preparation.updated"; stage: import("./context/types.js").PreparationStage }
  | { type: "context.updated"; context: ContextStatus }
  | { type: "message.user"; messageId: string; content: string; delivery: "steer" | "queue" }
  | { type: "context.retrying"; reason: "context_overflow"; attempt: number; compactedMessages: number }
  | { type: "assistant.delta"; content: string }
  | { type: "assistant.completed"; content: string; notification?: string }
  | { type: "reasoning.started"; phase: "initial" | "continuing" }
  | { type: "reasoning.delta"; content: string }
  | { type: "reasoning.completed" }
  | AgentToolEvent;

export type AgentToolEvent =
  | { type: "tool.started"; toolCallId: string; tool: string; args: unknown; description?: string; display?: ToolInputDisplay; operationId?: string }
  | { type: "tool.progress"; toolCallId: string; tool: string; update: ToolUpdate }
  | { type: "tool.change_committed"; toolCallId: string; tool: string; operationId: string; change: import("../tools/file/fileChange.js").CommittedFileChange }
  | { type: "tool.completed"; toolCallId: string; tool: string; result: unknown; durationMs?: number; executionStatus?: ToolExecutionResultStatus; recovered?: boolean; operationId?: string; evidence?: string }
  | { type: "tool.failed"; toolCallId: string; tool: string; error: string; result?: unknown; durationMs?: number; executionStatus?: ToolExecutionResultStatus; recovered?: boolean; operationId?: string; evidence?: string };

/** Provider 原始分片在 Session 内归一化，宿主不需要理解 provider wire 协议。 */
export type AgentSessionEvent =
  | { type: "status"; status: AgentStatus }
  | AgentSessionUpdate
  | { type: "error"; message: string; recorded?: boolean; fatal?: boolean }
  | { type: "done"; content: string; usage?: SessionUsage; outcome: AgentTurnOutcome };

export interface AgentRuntimeContext {
  /** 宿主控制的只读规划模式，工具搜索和恢复也必须遵守。 */
  planning?: boolean;
  // Agent loop 的所有外部依赖都由 runtime 注入，方便 CLI 和 TUI 复用同一套执行逻辑。
  workspaceRoot: string;
  config: AgentConfig;
  model?: AgentModel;
  recorder: SessionRecorder;
  contextMemory?: ContextMemory;
  toolRegistry: ToolRegistry;
  permissionManager?: PermissionManager;
  confirmPermission?: (request: AgentPermissionRequest) => Promise<AgentPermissionResult>;
  /** 回合内首次改动工作区前建快照；未提供或抛错时工具照常执行。 */
  createCheckpoint?: (label: string) => Promise<unknown>;
  quarantineExternalTool?: (tool: string, toolCallId: string, settlement: Promise<unknown>) => void;
  abortSignal?: AbortSignal;
  /** Host-owned MCP/Plugin invocation 的统一 authority envelope。 */
  capabilities?: CapabilityStore;
  runId?: string;
  turnId?: string;
}

export type AgentStatus =
  | "thinking"
  | "running"
  | "waiting_permission"
  | "completed"
  | "incomplete"
  | "blocked"
  | "cancelled"
  | "aborted"
  | "error";
