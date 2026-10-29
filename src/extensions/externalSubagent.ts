import type { AgentSessionEvent } from "../agent/types.js";
import { runSubagentCli } from "./subagentCli.js";
import { randomUUID } from "node:crypto";
import { AcpClient, acpMcpServers } from "../acp/client.js";
import { runAcpTurn } from "../acp/turn.js";
import { PermissionManager } from "../permission/PermissionManager.js";
import { WorkerSession, type WorkerExecution } from "../runtime/WorkerSession.js";
import { SubagentTaskIncompleteError, type SubagentAccessMode } from "../runtime/SubagentTaskManager.js";
import type { SubagentDefinition } from "./agents.js";
import type { PreparedSubagentTask, SubagentOptions } from "./subagent.js";

export async function prepareExternalSubagent(
  options: SubagentOptions, task: string, accessMode: SubagentAccessMode,
  runtime: "codex" | "claude-code" | "acp", definition?: SubagentDefinition, execution?: WorkerExecution, command?: string
): Promise<PreparedSubagentTask> {
  const config = options.config;
  const settings = config.extensions.subagent;
  const permission = options.permissionManager ?? new PermissionManager(config.permission);
  if (permission.getStatus().mode !== "full-access" || accessMode !== "workspace") {
    throw new Error("External subagents require full-access permission and a workspace assignment.");
  }
  if (config.permission.denyPaths.length || config.sandbox.mode !== "off" || !config.sandbox.allowNetwork || definition?.tools) {
    throw new Error("External subagents cannot enforce Biny denyPaths, sandbox or named tool restrictions.");
  }
  if (settings.maxCostUsd !== undefined || settings.maxSteps !== undefined || execution?.sessionGoalId) {
    throw new Error("External subagents cannot enforce Biny step, cost or session goal budgets.");
  }
  if (execution?.resume) throw new Error("External worker recovery is unsupported; the task was not replayed.");
  // A named connection is a complete routing override, not a different provider
  // for the inherited global model. An explicitly paired model must belong to it.
  const namedProvider = definition?.providerAlias;
  if (namedProvider && runtime !== "acp") throw new Error("Named subagent providerAlias requires the ACP runtime.");
  const model = definition?.model ?? (namedProvider ? undefined : settings.model);
  const useCliDefault = runtime === "claude-code";
  const selected = model && Object.hasOwn(config.models, model) ? config.models[model] : undefined;
  if (runtime === "acp" && model && !selected) throw new Error(`Unknown subagent model alias: ${model}`);
  if (runtime === "acp" && namedProvider && selected && selected.provider !== namedProvider) {
    throw new Error("Named subagent model must belong to its selected ACP provider.");
  }
  const providerAlias = namedProvider ?? selected?.provider ?? (runtime === "acp" ? settings.providerAlias : undefined);
  const provider = providerAlias ? config.providers[providerAlias] : undefined;
  if (!model && !useCliDefault && !(runtime === "acp" && providerAlias)) throw new Error("External subagents require an explicit model or ACP provider.");
  if (runtime === "acp" && (provider?.type !== "acp" || !provider.acp || provider.enabled === false)) {
    throw new Error(`Subagent ACP provider ${providerAlias ?? "unknown"} requires an enabled launch configuration.`);
  }
  const launch = runtime === "acp" ? provider!.acp! : undefined;
  const client = launch ? new AcpClient({ launch, cwd: options.workspaceRoot,
    mcpServers: acpMcpServers(config, launch, permission.getStatus().mode), timeoutMs: provider?.timeoutMs }) : undefined;
  const instructions = definition?.prompt ?? "";
  const session = execution ? await WorkerSession.open(execution, task, options.workspaceRoot,
    { runtime, model, launch }, instructions, { provider: runtime, id: runtime === "acp" ? selected?.model ?? "ACP default" : model ?? "CLI default" }) : undefined;
  const recordToolEvent = async (event: AgentSessionEvent) => {
    if (event.type === "tool.started") await session?.recorder.recordAndFlush({ type: "tool_call", tool: event.tool, toolCallId: event.toolCallId, args: event.args });
    else if (event.type === "tool.completed" || event.type === "tool.failed") await session?.recorder.recordAndFlush({ type: "tool_result", tool: event.tool,
      toolCallId: event.toolCallId, result: event.type === "tool.completed" ? event.result : event.result ?? { error: event.error }, executionStatus: event.type === "tool.failed" ? event.executionStatus ?? "failed" : event.executionStatus });
  };
  const controller = new AbortController();
  let started = false;
  let running: Promise<string> | undefined;
  return {
    run(signal) {
      if (started) throw new Error("External worker has already started or closed.");
      started = true;
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let inactivity: ReturnType<typeof setTimeout>;
      const timeout = settings.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new SubagentTaskIncompleteError("timeout", "")), settings.timeoutMs);
      const activity = () => {
        clearTimeout(inactivity);
        inactivity = setTimeout(() => controller.abort(new SubagentTaskIncompleteError("inactivity_timeout", "")), settings.inactivityTimeoutMs);
      };
      activity();
      running = (async () => {
        combined.throwIfAborted();
        const pending = execution?.communication?.pending() ?? [];
        await session?.receiveMessages(pending);
        execution?.communication?.delivered(pending.map((message) => message.id));
        if (execution?.communication && !execution.communication.seal()) throw new Error("External worker inbox could not be closed before launch.");
        await session?.beforeRequest(undefined);
        const content = [{ type: "text" as const, text: [instructions, task, ...pending.map((message) => message.content)].join("\n\n") }];
        let output: string | undefined;
        if (runtime !== "acp") {
          output = await runSubagentCli({ runtime, model, command, prompt: content[0]!.text, cwd: options.workspaceRoot, signal: combined, onActivity: activity, onEvent: recordToolEvent });
          await session?.recorder.recordAndFlush({ type: "assistant_message", content: output });
        } else for await (const event of runAcpTurn(client!, { content, model: selected?.model ?? "default", signal: combined,
          workspaceRoot: options.workspaceRoot, sessionId: session?.sessionId ?? randomUUID(), permissionManager: permission })) {
          activity();
          await recordToolEvent(event);
          if (event.type === "done") {
            await session?.recorder.recordAndFlush({ type: "assistant_message", content: event.content });
            if (event.outcome.status === "failed") throw new Error(event.outcome.error ?? "External worker failed.");
            if (event.outcome.status !== "completed") throw new SubagentTaskIncompleteError(event.outcome.stopReason, event.content);
            output = event.content;
          }
        }
        if (output === undefined) throw new Error("External worker has no terminal result.");
        combined.throwIfAborted();
        await session?.complete(output);
        return output;
      })().catch(async (error: unknown) => {
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        await session?.recorder.recordAndFlush({ type: "error", message: failure instanceof Error ? failure.message : String(failure) });
        throw failure;
      }).finally(() => { clearTimeout(inactivity); clearTimeout(timeout); });
      return running;
    },
    async close() {
      started = true;
      controller.abort(new Error("External worker closed."));
      await client?.close();
      await running?.catch(() => undefined);
      await session?.close();
    }
  };
}
