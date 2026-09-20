/**
 * TUI 类型定义模块。
 *
 * 这里描述界面层使用的消息、工具调用摘要、权限请求、整体状态和权限选择枚举。
 * 这些类型服务于 reducer 与组件渲染，不暴露底层 recorder 或 provider 对象。
 */
import type { ToolInputDisplay } from "../tools/types.js";
import type { CommandCardData } from "../runtime/commandCard.js";
import type { PermissionAction } from "../permission/PermissionManager.js";

export type TuiLaunchMode = "new" | "resume-picker" | "resume-session";

export type TuiStatus = "idle" | "thinking" | "running" | "waiting_permission";

interface TranscriptItemBase {
  id: string;
}

export interface UserTranscriptItem extends TranscriptItemBase {
  kind: "user";
  content: string;
}

export interface AssistantTranscriptItem extends TranscriptItemBase {
  kind: "assistant";
  content: string;
}

export interface ActivityTranscriptItem extends TranscriptItemBase {
  kind: "activity";
  content: string;
}

export interface ReasoningTranscriptItem extends TranscriptItemBase {
  kind: "reasoning";
  content: string;
  /** Wall-clock start while streaming; cleared once committed with durationMs. */
  startedAtMs?: number;
  /** Elapsed thinking time after completion. */
  durationMs?: number;
}

export interface NotificationTranscriptItem extends TranscriptItemBase {
  kind: "notification";
  content: string;
  tone?: "muted" | "success" | "warning";
}

export interface ErrorTranscriptItem extends TranscriptItemBase {
  kind: "error";
  content: string;
}

/** 报告类 slash command 的结构化卡片，内联进对话历史。 */
export interface CardTranscriptItem extends TranscriptItemBase {
  kind: "card";
  /** 触发的命令原文，如 `/status`。 */
  command: string;
  title: string;
  data: CommandCardData;
}

export type ToolTranscriptStatus = "pending" | "running" | "success" | "failed" | "denied" | "skipped" | "cancelled" | "unknown";

export interface ToolTranscriptItem extends TranscriptItemBase {
  kind: "tool";
  toolCallId?: string;
  tool: string;
  description?: string;
  title: string;
  argsSummary: string;
  display?: ToolInputDisplay;
  status: ToolTranscriptStatus;
  startedAtMs?: number;
  progress?: string;
  output?: string;
  details?: string;
  durationMs?: number;
  outputLines?: number;
  exitCode?: number;
  truncated?: boolean;
  operationId?: string;
  recovered?: boolean;
  evidence?: string;
  fileChange?: import("../tools/file/fileChange.js").CommittedFileChange;
}

export type TranscriptItem =
  | UserTranscriptItem
  | ReasoningTranscriptItem
  | AssistantTranscriptItem
  | ActivityTranscriptItem
  | ToolTranscriptItem
  | CardTranscriptItem
  | NotificationTranscriptItem
  | ErrorTranscriptItem;

export type ActiveTranscriptItem = ReasoningTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem;

export interface TranscriptState {
  // committed 只保存已完成单元；active 中的 reasoning/assistant/tool 允许按 id 原地更新。
  committed: TranscriptItem[];
  active: ActiveTranscriptItem[];
}

export interface TuiPermissionRequest {
  canRemember?: boolean;
  // permission 对应 agent loop 发出的单个待确认工具调用。
  tool: string;
  title: string;
  details: string;
  requireFullYes: boolean;
  diff?: string;
  preview?: string;
  actionType: string;
  riskLevel: string;
  targetPath?: string;
  secondaryTargetPath?: string;
  command?: string;
  reason?: string;
  changeSummary?: string;
}

export interface TuiState {
  // TuiState 是 reducer 的完整 UI 状态快照，不直接持有运行时对象。
  cwd: string;
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  sessionId: string;
  sessionFile: string;
  viewingSessionId?: string;
  turnStartedAt?: number;
  lastWorkedMs?: number;
  transcript: TranscriptState;
  permissionDetailsExpanded: boolean;
}

export type PermissionChoice =
  PermissionAction;
