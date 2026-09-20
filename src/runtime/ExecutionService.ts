/**
 * 普通单次执行入口。
 *
 * `biny run` 与 Chat、Desktop、TUI 共用 InteractiveAgentRuntime / AgentSession。
 * 这里不推断任务类型，也不创建 TaskContract 或 durable attempt。
 */
import type { AgentAttachment, AgentSessionInfo } from "../agent/AgentSession.js";
import type { AgentPermissionRequest, AgentPermissionResult, AgentTurnOutcome } from "../agent/types.js";
import { confirmPermissionRequest } from "../permission/confirm.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import { InteractiveAgentRuntime } from "./InteractiveAgentRuntime.js";

export interface ExecutionOptions {
  input: string;
  signal: AbortSignal;
  attachments?: AgentAttachment[];
  confirmPermission?(request: AgentPermissionRequest): Promise<AgentPermissionResult>;
}

export interface ExecutionResult {
  runId: string;
  session: AgentSessionInfo;
  turn: AgentTurnOutcome;
}

export class ExecutionService {
  private readonly interactive: InteractiveAgentRuntime;

  constructor(private readonly runtime: CommandRuntime) {
    this.interactive = new InteractiveAgentRuntime(runtime);
  }

  static async create(runtime: CommandRuntime): Promise<ExecutionService> {
    return new ExecutionService(runtime);
  }

  async execute(options: ExecutionOptions): Promise<ExecutionResult> {
    const session = this.runtime.agent.getInfo();
    let permissionFailure: unknown;
    const answerPermission = (requestId: string, result: AgentPermissionResult): void => {
      try {
        this.interactive.answerPermission(requestId, result);
      } catch (error) {
        if (!options.signal.aborted) permissionFailure ??= error;
      }
    };
    const unsubscribe = this.interactive.subscribe((update) => {
      if (update.event?.type !== "permission.requested") return;
      const event = update.event;
      void (async () => {
        try {
          const request: AgentPermissionRequest = {
            ...event.request,
            toolName: event.request.tool,
            sessionId: event.sessionId,
            projectRoot: this.runtime.workspaceRoot,
            actionType: permissionActionType(event.request.actionType),
            riskLevel: permissionRiskLevel(event.request.riskLevel)
          };
          const result = options.confirmPermission
            ? await options.confirmPermission(request)
            : await confirmPermissionRequest(request, options.signal);
          answerPermission(event.requestId, result);
        } catch (error) {
          if (options.signal.aborted) return;
          permissionFailure ??= error;
          answerPermission(event.requestId, {
            approved: false,
            action: "deny",
            scope: "once",
            message: errorMessage(error),
            confirmation: undefined
          });
        }
      })();
    });

    try {
      const submitted = this.interactive.submitPrompt(options.input, options.attachments ?? []);
      const abort = (): void => {
        this.interactive.cancelRun(submitted.runId, "cancelled");
      };
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      try {
        const turn = await submitted.completion;
        if (permissionFailure !== undefined) throw permissionFailure;
        return { runId: submitted.runId, session, turn };
      } finally {
        options.signal.removeEventListener("abort", abort);
      }
    } finally {
      unsubscribe();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionActionType(value: string): AgentPermissionRequest["actionType"] {
  if (
    value === "read"
    || value === "write"
    || value === "delete"
    || value === "shell"
    || value === "network"
    || value === "git"
    || value === "install"
  ) return value;
  return "unknown";
}

function permissionRiskLevel(value: string): AgentPermissionRequest["riskLevel"] {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  return "high";
}
