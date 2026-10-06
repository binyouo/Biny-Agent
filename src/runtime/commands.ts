/**
 * 交互端共享的 slash command 注册表与运行时命令执行器。
 *
 * 注册表是 Desktop、TUI 的唯一命令声明来源；只涉及界面布局的命令仍由对应前端处理，
 * 会读取或修改 Agent/runtime 状态的命令统一在这里执行。
 */
import { randomUUID } from "node:crypto";
import { formatSubagentAgentList } from "../extensions/report.js";
import { redactSecrets } from "../utils/secrets.js";
import { formatSubagentTaskReport } from "./subagentTaskReport.js";
import { formatStatusReport } from "./statusReport.js";
import {
  buildMcpCard,
  buildPluginsCard,
  buildSkillsCard,
  buildStatusCard,
  buildSubagentAgentsCard,
  buildSubagentTasksCard,
  buildUsageCard
} from "./commandCards.js";
import type { CommandCardData } from "./commandCard.js";
import type { CommandRuntime } from "./CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "./InteractiveAgentRuntime.js";
import type { CommandSurface } from "./commandRegistry.js";
import { isTaskRunTerminal, type TaskRunStatus } from "./TaskRunStore.js";
import type { SessionGoalStatus } from "./SessionGoalStore.js";
import type {
  AgentPersonalizationState,
  ChatPersonalizationOverridePatch
} from "../personalization/index.js";

export interface RuntimeCommandResult {
  command: string;
  title: string;
  content: string;
  /** TUI 渲染报告卡片的结构化数据；CLI / Desktop 忽略，继续用 `content`。 */
  card?: CommandCardData;
  compaction?: { outcome: "compacted" | "unchanged" };
  sessionGoal?: {
    action: "get" | "set" | "pause" | "resume" | "clear";
    status?: SessionGoalStatus;
  };
}

/** Resolve Goal/Graph commands to their RPC operation for Host admission. */
export function runtimeCommandOperation(input: string): string | undefined {
  const { command, args } = parseRuntimeCommand(input);
  if (command === "/goal") {
    const goal = parseGoalCommand(input);
    return goal === undefined ? undefined : `session.goal.${goal.action}`;
  }
  if (command === "/graph") return `graph.${args[0]?.toLowerCase() ?? "inspect"}`;
  return undefined;
}

type GoalCommand =
  | { action: "get" | "pause" | "resume" | "clear" }
  | { action: "set"; objective: string };

function parseGoalCommand(input: string): GoalCommand | undefined {
  const match = /^\/goal(?:\s+([^\s]+)(?:\s+([\s\S]*))?)?$/u.exec(input.trim().replace(/^\/+/, "/"));
  if (!match) return undefined;
  const action = match[1]?.toLowerCase() ?? "show";
  const argument = match[2]?.trim();
  if (action === "set" && argument) return { action, objective: argument };
  if (!argument && (action === "show" || action === "pause" || action === "resume" || action === "clear")) {
    return { action: action === "show" ? "get" : action };
  }
  if (!["show", "set", "pause", "resume", "clear", "get", "cancel"].includes(action)) {
    return { action: "set", objective: input.trim().replace(/^\/+/, "/").slice("/goal".length).trim() };
  }
  return undefined;
}

function parseGraphEventOptions(args: string[]): { afterSequence?: number; limit?: number } {
  const options: { afterSequence?: number; limit?: number } = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const field = flag === "--cursor" ? "afterSequence" : flag === "--limit" ? "limit" : undefined;
    if (field === undefined || options[field] !== undefined) throw new Error("Usage: /graph events <id> [--cursor <cursor>] [--limit <count>]");
    const value = args[index + 1];
    const parsed = Number(value);
    if (value === undefined || !/^\d+$/u.test(value) || !Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a non-negative safe integer.`);
    options[field] = parsed;
  }
  return options;
}

function parseRuntimeCommand(input: string): { command: string; args: string[] } {
  const [command = "", ...args] = input.trim().replace(/^\/+/, "/").split(/\s+/);
  return { command, args };
}

/**
 * 执行不依赖具体界面布局的命令。返回 undefined 表示该命令应由前端本地处理。
 */
export async function executeRuntimeCommand(
  runtime: InteractiveRuntimeHandle,
  services: CommandRuntime,
  input: string,
  source: CommandSurface
): Promise<RuntimeCommandResult | undefined> {
  const { command, args } = parseRuntimeCommand(input);
  if (command === "/status") {
    const snapshot = runtime.getSnapshot();
    const info = snapshot.info;
    const context = await services.agent.contextStatus();
    const usage = services.agent.usageSummary();
    const extensions = services.extensionStatus();
    const modelRequests = typeof services.agent.modelRequestSummary === "function" ? services.agent.modelRequestSummary() : undefined;
    return {
      ...result(command, "Status", formatStatusReport(
        info,
        snapshot.permissionMode,
        context,
        usage,
        services.extensionReport(),
        modelRequests
      )),
      card: buildStatusCard(info, snapshot.permissionMode, context, usage, extensions, modelRequests)
    };
  }
  if (command === "/usage") {
    const summary = services.agent.usageSummary();
    return { ...result(command, "Usage", services.agent.usageReport()), card: buildUsageCard(summary) };
  }
  if (command === "/tasks") {
    const page = services.taskRuns.list({ status: args[0] === undefined ? undefined : readTaskStatus(args[0]) });
    return result(command, "Tasks", JSON.stringify(page, null, 2));
  }
  if (command === "/automation") {
    const action = args[0]?.toLowerCase();
    if (!action || action === "list") return result(command, "Automation", JSON.stringify(services.automationStore.list(), null, 2));
    const automationId = args[1]?.trim();
    if (!automationId) throw new Error("Usage: /automation list | pause <id> | resume <id> | run <id> | delete <id>");
    if (action === "pause") return result(command, "Automation", JSON.stringify(services.automationStore.pause(automationId), null, 2));
    if (action === "resume") return result(command, "Automation", JSON.stringify(services.automationStore.resume(automationId), null, 2));
    if (action === "delete") {
      services.automationStore.delete(automationId);
      return result(command, "Automation", `Deleted ${automationId}.`);
    }
    if (action === "run") throw new Error("Use `biny automation run` or the Desktop automation action to execute a fire.");
    throw new Error("Usage: /automation list | pause <id> | resume <id> | run <id> | delete <id>");
  }
  if (command === "/goal") {
    const goal = parseGoalCommand(input);
    if (!goal) throw new Error("Usage: /goal [<objective> | show | set <objective> | pause | resume | clear]");
    const sessionId = runtime.getSnapshot().info.sessionId;
    const current = services.sessionGoals.get(sessionId);
    const expected = current === undefined ? undefined : { goalId: current.goalId, revision: current.revision };
    if (goal.action === "clear") {
      services.sessionGoals.clear(sessionId, expected);
      if (current?.status === "active") runtime.cancelCurrentRun("paused");
      return { ...result(command, "当前目标", "已清除当前会话目标。"), sessionGoal: { action: "clear" } };
    }
    const record = goal.action === "get" ? current
      : goal.action === "set" ? services.sessionGoals.set(sessionId, goal.objective, { expected })
        : goal.action === "pause" ? services.sessionGoals.pause(sessionId, expected)
          : services.sessionGoals.resume(sessionId, expected);
    if (goal.action === "pause" && current?.status === "active") runtime.cancelCurrentRun("paused");
    return {
      ...result(command, "当前目标", record === undefined ? "当前会话没有目标。使用 /goal <目标> 开始。" : JSON.stringify(record, null, 2)),
      sessionGoal: { action: goal.action, status: record?.status }
    };
  }
  if (command === "/graph") {
    const action = args[0]?.toLowerCase() ?? "inspect";
    const graphId = action === "inspect" || action === "events" ? args[1] ?? args[0] : args[1];
    if (!graphId) throw new Error("Usage: /graph inspect <id> | start <id> | pause <id> | resume <id> | cancel <id> | events <id> [--cursor <cursor>] [--limit <count>]");
    if (action === "inspect") return result(command, "Graph", JSON.stringify(services.graphs.inspectGraph(graphId), null, 2));
    if (action === "events") {
      if (!args[1]) throw new Error("Usage: /graph events <id> [--cursor <cursor>] [--limit <count>]");
      return result(command, "Graph events", JSON.stringify(services.graphs.listGraphEvents(graphId, parseGraphEventOptions(args.slice(2))), null, 2));
    }
    if (action === "start") {
      const graph = services.graphs.startGraph(graphId);
      services.graphs.createWake(graph.graphId, "graph_started");
      return result(command, "Graph", JSON.stringify(graph, null, 2));
    }
    if (action === "pause") return result(command, "Graph", JSON.stringify(services.graphs.pauseGraph(graphId), null, 2));
    if (action === "resume") {
      const graph = services.graphs.resumeGraph(graphId);
      services.graphs.createWake(graph.graphId, "graph_resumed");
      return result(command, "Graph", JSON.stringify(graph, null, 2));
    }
    if (action === "cancel") return result(command, "Graph", JSON.stringify(await cancelRuntimeGraph(runtime, services, graphId), null, 2));
    throw new Error("Usage: /graph inspect <id> | start <id> | pause <id> | resume <id> | cancel <id> | events <id> [--cursor <cursor>] [--limit <count>]");
  }
  if (command === "/capabilities") {
    return result(command, "Capabilities", JSON.stringify(services.capabilities.list(), null, 2));
  }
  if (command === "/mcp") {
    if (args[0]?.toLowerCase() !== "reconnect") {
      return {
        ...result(command, "MCP", services.extensionReport("mcp").replace(/^MCP\n/, "")),
        card: buildMcpCard(services.extensionStatus().mcp)
      };
    }
    const serverName = args[1]?.trim();
    if (!serverName || args.length !== 2) throw new Error("Usage: /mcp reconnect <server>");
    const status = await runtime.runExclusiveOperation(
      "mcp",
      async () => await services.mcp.reconnectServer(serverName)
    );
    return result(
      command,
      "MCP",
      status.connected
        ? `Reconnected ${serverName} (${String(status.toolNames.length)} tools).`
        : `Reconnect failed for ${serverName}: ${status.lastError ?? "unknown error"}`
    );
  }
  if (command === "/skills") {
    const extensions = services.extensionStatus();
    return {
      ...result(command, "[Skills]", services.extensionReport("skills").replace(/^Skills\n/, "")),
      card: buildSkillsCard(extensions.skills, extensions.skillWarnings)
    };
  }
  if (command === "/plugins") {
    return {
      ...result(command, "Plugins", services.extensionReport("plugins").replace(/^Plugins\n/, "")),
      card: buildPluginsCard(services.extensionStatus().plugins)
    };
  }
  if (command === "/memories") {
    const patch = memoryPolicyPatch(args[0]);
    if (!patch) return result(command, "Memories", formatPersonalizationState(await services.agent.getPersonalizationState()));
    const state = await services.agent.getPersonalizationState();
    if (!state.catalogRevision) throw new Error("Chat personalization revision is unavailable.");
    const updated = await runtime.runExclusiveOperation(
      "personalization",
      async () => await services.agent.updateChatPersonalization(patch, state.catalogRevision)
    );
    return result(command, "Memories", `${formatPersonalizationState(updated)}\n\nChanges apply from the next root turn.`);
  }
  if (command === "/memory") {
    return result(
      command,
      "Memory",
      await runtime.runExclusiveOperation("memory", async () => await services.agent.runMemoryCommand(args))
    );
  }
  if (command === "/soul") {
    const action = args[0]?.toLowerCase();
    const execute = async (): Promise<string> => await services.agent.runSoulCommand(args);
    const content = action === "set" || action === "append-trait" || action === "reset" || action === "delete"
      ? await runtime.runExclusiveOperation("soul", execute)
      : await execute();
    return result(command, "Soul", content);
  }
  if (command === "/subagent") return await executeSubagentCommand(runtime, services, command, args, source);
  if (command === "/inspect") {
    const task = input.trim().slice("/inspect".length).trim();
    if (!task) throw new Error("检查内容不能为空。");
    return result(command, "检查结果", await runForegroundSubagent(runtime, services, task, true));
  }
  if (command === "/review") {
    const task = args.join(" ").trim()
      || "Review the current git changes for correctness, regressions, missing tests, and concrete risks. Return concise findings with exact file paths and line numbers.";
    return result(command, "Code Review", await runForegroundSubagent(runtime, services, task) || "No review findings.");
  }
  if (command === "/compact") {
    const before = (await services.agent.contextStatus()).compaction;
    const compactedMessages = before.compactedMessages;
    const lastCompactedAt = before.lastCompactedAt;
    const content = await runtime.compactConversation(args.join(" ").trim() || undefined);
    const after = (await services.agent.contextStatus()).compaction;
    return {
      ...result(command, "Compact", content),
      compaction: {
        outcome: after.compactedMessages !== compactedMessages || after.lastCompactedAt !== lastCompactedAt
          ? "compacted" : "unchanged"
      }
    };
  }
  if (command === "/undo") {
    const checkpointStore = services.checkpoints;
    const checkpoints = checkpointStore ? await checkpointStore.list() : [];
    if (!checkpoints.length) {
      return result(command, "Undo", "No checkpoints yet. Biny snapshots the workspace before its first edit of a turn (git repositories only).");
    }
    if (args[0] === "list") {
      return result(command, "Checkpoints", checkpoints.map((entry) => `${entry.id}  ${entry.createdAt}  ${entry.label}`).join("\n"));
    }
    if (!checkpointStore) {
      throw new Error("Checkpoints need a git repository; this workspace is not one.");
    }
    const summary = await runtime.runExclusiveOperation(
      "checkpoint",
      async () => await checkpointStore.restore(args[0] ?? "latest")
    );
    const moved = summary.movedAside.length
      ? `\nMoved ${String(summary.movedAside.length)} file(s) created since then to ${summary.trashDirectory ?? "the undo trash"}:\n${summary.movedAside.join("\n")}`
      : "";
    return result(command, "Undo", `Restored ${String(summary.restoredFiles)} file(s) from checkpoint ${summary.checkpoint.id} (${summary.checkpoint.label}).${moved}`);
  }
  return undefined;
}

function memoryPolicyPatch(action: string | undefined): ChatPersonalizationOverridePatch | undefined {
  if (action === undefined) return undefined;
  if (action === "inherit") return { useMemories: "inherit", contributeMemories: "inherit" };
  if (action === "both") return { useMemories: true, contributeMemories: true };
  if (action === "use") return { useMemories: true, contributeMemories: false };
  if (action === "contribute") return { useMemories: false, contributeMemories: true };
  if (action === "off") return { useMemories: false, contributeMemories: false };
  throw new Error("Usage: /memories [inherit|both|use|contribute|off]");
}

function formatPersonalizationState(state: AgentPersonalizationState): string {
  return [
    `Use memories: ${state.resolved.useMemories ? "yes" : "no"} (override: ${String(state.override.useMemories)})`,
    `Contribute memories: ${state.resolved.contributeMemories ? "yes" : "no"} (override: ${String(state.override.contributeMemories)})`
  ].join("\n");
}

async function executeSubagentCommand(
  runtime: InteractiveRuntimeHandle,
  services: CommandRuntime,
  command: string,
  args: string[],
  source: CommandSurface
): Promise<RuntimeCommandResult> {
  const action = args[0]?.toLowerCase();
  // Inspector 这类结构化入口用分隔符声明“后续全是任务文本”，不能再把首词解释成控制动作。
  if (action === "--") {
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error("Usage: /subagent -- <read-only task>");
    return result(command, "Subagent", await runForegroundSubagent(runtime, services, task) || "Subagent returned no text.");
  }
  if (action === "agents") {
    const definitions = await services.listSubagentAgents();
    return {
      ...result(command, "Subagent", formatSubagentAgentList(definitions)),
      card: buildSubagentAgentsCard(definitions)
    };
  }
  if (action === "status") {
    const snapshots = services.subagents?.listSnapshots() ?? [];
    return {
      ...result(command, "Subagent", formatSubagentTaskReport(snapshots)),
      card: buildSubagentTasksCard(snapshots)
    };
  }
  if (action === "cancel") {
    const taskId = args[1]?.trim();
    if (!taskId) throw new Error("Usage: /subagent cancel <task-id>");
    const cancelled = services.subagents?.cancelTask(taskId, `Cancelled from the ${source}.`) ?? false;
    return result(command, "Subagent", cancelled
      ? `Cancelled subagent task ${taskId}.`
      : `No active subagent task found for ${taskId}.`);
  }
  if (action === "start") {
    const task = args.slice(1).join(" ").trim();
    if (!task) throw new Error("Usage: /subagent start <read-only task>");
    const submitted = runtime.startBackgroundOperation(
      "subagent",
      (signal) => services.startSubagentTask(task, { signal })
    );
    void submitted.completion.catch(() => undefined);
    return result(command, "Subagent", `Started subagent task ${submitted.taskId}. Use /subagent status or /subagent cancel ${submitted.taskId}.`);
  }
  const task = args.join(" ").trim();
  if (!task) {
    return result(command, "Subagent", "Usage: /subagent <read-only task> | start <read-only task> | status | cancel <task-id> | agents");
  }
  return result(command, "Subagent", await runForegroundSubagent(runtime, services, task) || "Subagent returned no text.");
}

/**
 * 取消 Graph 的编排入口：先落 durable 终态，再取消仍在运行的子代理任务、AgentRun
 * 和 TaskRun。Host 的 graph.cancel 操作与 /graph cancel 命令都走这里，避免绕过编排。
 */
export async function cancelRuntimeGraph(
  runtime: InteractiveRuntimeHandle,
  services: CommandRuntime,
  graphId: string
): Promise<unknown> {
  const graph = services.graphs.inspectGraph(graphId);
  const activeRuns = graph.nodes
    .filter((node) => node.status === "running" && node.taskRunId !== undefined)
    .map((node) => {
      const task = services.taskRuns.get(node.taskRunId!);
      return {
        taskRunId: node.taskRunId!,
        runId: task?.attempts.at(-1)?.runId
      };
    });
  const result = services.graphs.cancelGraph(graphId);
  for (const active of activeRuns) {
    services.subagents?.cancelTask(active.taskRunId, "Graph cancelled.");
    if (active.runId !== undefined) runtime.cancelRun(active.runId, "cancelled");
    try {
      const task = services.taskRuns.get(active.taskRunId);
      if (task && !isTaskRunTerminal(task.status)) services.taskRuns.transition(active.taskRunId, "cancelled");
    } catch {
      // Graph cancellation is already durable; a late task snapshot must not undo it.
    }
  }
  return result;
}

async function runForegroundSubagent(
  runtime: InteractiveRuntimeHandle,
  services: CommandRuntime,
  task: string,
  readOnly = false
): Promise<string> {
  try {
    return await runtime.runExclusiveOperation(
      "subagent",
      async (signal) => await services.startSubagentTask(task, { taskId: randomUUID(), signal, accessMode: readOnly ? "read-only" : undefined }).completion
    );
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(redactSecrets(String(error)));
    const publicMessage = redactSecrets(error.message);
    if (publicMessage === error.message) throw error;
    try {
      Object.defineProperty(error, "message", { value: publicMessage, configurable: true });
    } catch {
      const publicError = new Error(publicMessage);
      publicError.name = error.name;
      throw publicError;
    }
    throw error;
  }
}

function result(command: string, title: string, content: string): RuntimeCommandResult {
  return { command, title, content };
}

function readTaskStatus(value: string): TaskRunStatus {
  if (value === "queued" || value === "created" || value === "running" || value === "verifying" || value === "completed" || value === "failed" || value === "incomplete" || value === "blocked" || value === "policy_denied" || value === "budget_exhausted" || value === "needs_approval" || value === "aborted" || value === "cancelled") return value;
  throw new Error(`Unknown TaskRun status: ${value}`);
}
