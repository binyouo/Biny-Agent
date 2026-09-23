/**
 * 工具基础契约模块。
 *
 * 所有内置工具都实现同一组 `name`、`description` 和 `execute` 字段，并共享当前 workspace root
 * 与 ignore 规则。权限判断、session 记录和 UI 展示不放在工具里，而由调用方统一处理。
 */
import type { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolAccessList } from "./access.js";
import type { FileSnapshot } from "./file/safeFileIo.js";
import type { PreparedFileChange, CommittedFileChange } from "./file/fileChange.js";
import type { JsonObjectSchema } from "./schema.js";

export type ToolSource = "builtin" | "mcp" | "skill" | "plugin" | "subagent";
export type ToolRisk = "read" | "write" | "execute";

/** 工具执行状态与模型消息协议解耦；side_effect_committed 只表示审计证据，不是终态。 */
export type ToolExecutionState =
  | "not_started"
  | "running"
  /** 已通过所有执行前检查，副作用从此刻起可能已经开始。 */
  | "admitted"
  | "side_effect_committed"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "unknown";

export type ToolRetrySafety = "safe" | "idempotent" | "unsafe" | "unknown";
export type ToolExecutionResultStatus = "cancelled" | "succeeded" | "failed" | "unknown";

/** sessionId + toolCallId 的稳定标识，不把调用参数或敏感内容放进审计事件。 */
export function createToolOperationId(sessionId: string, toolCallId: string): string {
  return `op_${createHash("sha256").update(`${sessionId}\0${toolCallId}`).digest("hex")}`;
}

export type ToolUpdateKind = "stdout" | "stderr" | "progress" | "status" | "custom";

export interface ToolUpdate {
  kind: ToolUpdateKind;
  text?: string;
  percent?: number;
  customKind?: string;
  customData?: unknown;
}

export interface ApprovedFileSnapshot {
  path: string;
  snapshot: FileSnapshot | null;
}

export interface ToolExecutionContext {
  /** 当前审批权威的显式路径禁令；命令子进程必须通过系统沙箱执行这些限制。 */
  deniedPaths?: readonly string[];
  toolCallId: string;
  operationId: string;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  signal?: AbortSignal;
  onUpdate?: (update: ToolUpdate) => void;
  onExecutionState?: (state: ToolExecutionState, evidence?: string) => void;
  onFileChangeCommitted?: (change: CommittedFileChange) => Promise<void>;
  approvedFile?: ApprovedFileSnapshot;
}

export type ToolInputDisplay =
  | { kind: "file_io"; operation: "read" | "write" | "update" | "delete" | "move" | "list" | "search" | "grep" | "git"; path?: string; destinationPath?: string; content?: string; before?: string; after?: string; detail?: string }
  | { kind: "command"; command: string; cwd?: string; description?: string; language?: string }
  | { kind: "generic"; summary: string; detail?: unknown };

export interface RunnableToolExecution<TResult = unknown> {
  accesses?: ToolAccessList;
  fileChange?: PreparedFileChange;
  /** 仅用于全部工作就是一次文件变更的工具；局部提交不能证明整个工具成功。 */
  fileChangeIsResult?: boolean;
  display?: ToolInputDisplay;
  description?: string;
  retrySafety?: ToolRetrySafety;
  approvalRule: string;
  execute(context: ToolExecutionContext): Promise<TResult>;
}

export type ToolExecution<TResult = unknown> = RunnableToolExecution<TResult> | { isError: true; result: TResult; errorMessage: string };

export interface Tool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  /** 默认 system prompt 中 Available tools 段使用的一行能力摘要；省略时不在该段重复展示。 */
  promptSnippet?: string;
  /** 仅当该工具在当前模型步骤可用时注入的操作规则。 */
  promptGuidelines?: string[];
  parameters: JsonObjectSchema;
  schema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  source?: ToolSource;
  capability?: string;
  risk?: ToolRisk;
  providerTool?: "openai-apply-patch";
  // resolveExecution 声明本次调用的展示信息、权限规则、资源访问范围和真正执行函数。
  resolveExecution(args: TArgs): ToolExecution<TResult> | Promise<ToolExecution<TResult>>;
}

export interface ToolContext {
  // 所有内置工具都绑定在当前 workspace 内，不能自行选择任意系统路径。
  workspaceRoot: string;
  ignore: string[];
  attachmentRoot?: string;
}
