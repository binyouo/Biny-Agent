import { promises as fs } from "node:fs";
import { z } from "zod";
import type { AgentConfig } from "../config/schema.js";
import { vercelAgentLoopContinue } from "../agent/core/vercelAgentLoop.js";
import type { AgentAssistantMessage, AgentTool, AgentUsage } from "../agent/core/types.js";
import type { ModelSettings } from "../llm/modelFactory.js";
import { calculateUsageCost, type ModelUsageObserver } from "../observability/usage.js";
import { SubagentTaskIncompleteError, type SubagentTaskManager } from "../runtime/SubagentTaskManager.js";
import type { SubagentAccessMode } from "../runtime/SubagentTaskManager.js";
import type { TaskVerificationContract } from "../runtime/taskVerification.js";
import { usageSnapshot } from "../session/metadata.js";
import { ToolAccesses } from "../tools/access.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolScheduler } from "../tools/scheduler.js";
import { resolveEditingMode, routeEditingTools, type EditingMode } from "../tools/file/editingMode.js";
import type { ToolContext, ToolExecutionContext } from "../tools/types.js";
import { createToolOperationId, type RunnableToolExecution, type Tool } from "../tools/types.js";
import { isProtectedCredentialPath, redactSecrets } from "../utils/secrets.js";
import { findSubagentDefinition, type SubagentDefinition } from "./agents.js";

const subagentParameters = {
  type: "object" as const,
  properties: {
    task: { type: "string" as const, description: "A focused repository task for the subagent, including implementation and finite validation when needed." },
    agent: { type: "string" as const, description: "Optional named subagent definition to run this task with (see the named subagents list). Omit for the default bounded subagent." },
    constraints: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "User constraints that the worker must preserve. Keep explicit user requirements separate from inferred checks."
    },
    verification: {
      type: "object" as const,
      description: "Use only when this delegated task must not be reported complete until deterministic checks pass.",
      properties: {
        objective: { type: "string" as const },
        context: { type: "string" as const },
        checks: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" as const },
              command: { type: "string" as const },
              cwd: { type: "string" as const },
              timeoutMs: { type: "number" as const },
              definitionPaths: { type: "array" as const, items: { type: "string" as const } }
            },
            required: ["command"],
            additionalProperties: false
          }
        },
        artifactPaths: { type: "array" as const, items: { type: "string" as const } },
        allowedRepairPaths: { type: "array" as const, items: { type: "string" as const } },
        maxAttempts: { type: "number" as const }
      },
      required: ["objective", "checks", "artifactPaths"],
      additionalProperties: false
    }
  },
  required: ["task"],
  additionalProperties: false
};

export const taskVerificationSchema = z.object({
  objective: z.string().trim().min(1),
  context: z.string().trim().min(1).optional(),
  checks: z.array(z.object({
    id: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    definitionPaths: z.array(z.string().trim().min(1)).optional()
  }).strict()).min(1),
  artifactPaths: z.array(z.string().trim().min(1)).min(1),
  allowedRepairPaths: z.array(z.string().trim().min(1)).min(1).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional()
}).strict().transform((value): TaskVerificationContract => ({
  version: 1,
  objective: value.objective,
  context: value.context,
  checks: value.checks.map((check, index) => ({
    id: check.id ?? `check-${String(index + 1)}`,
    command: check.command,
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    definitionPaths: check.definitionPaths ?? []
  })),
  artifactPaths: value.artifactPaths,
  allowedRepairPaths: value.allowedRepairPaths ?? value.artifactPaths,
  maxAttempts: value.maxAttempts ?? 2
}));

const subagentSchema = z.object({
  task: z.string().min(1).max(20_000),
  agent: z.string().trim().min(1).max(64).optional(),
  constraints: z.array(z.string().trim().min(1)).max(100).optional(),
  verification: taskVerificationSchema.optional()
}).strict();

export type SubagentToolInput = z.infer<typeof subagentSchema>;

export interface VerifiedSubagentTaskInput {
  task: string;
  agent?: string;
  constraints?: string[];
  verification: TaskVerificationContract;
}

const safeBuiltinCapabilities = new Set([
  "filesystem.read",
  "filesystem.list",
  "filesystem.search"
]);
const workspaceBuiltinCapabilities = new Set([
  ...safeBuiltinCapabilities,
  "filesystem.write",
  "filesystem.edit",
  "filesystem.delete",
  "filesystem.move",
  "shell.execute"
]);
const maxSubagentReadBytes = 256 * 1024;
const maxSubagentTextChars = 64_000;

export interface SubagentOptions {
  workspaceRoot: string;
  config: AgentConfig;
  /** 不带别名时返回 subagent 默认模型设置；带别名时返回该模型别名的设置。 */
  getModelSettings: (modelAlias?: string) => ModelSettings;
  getAccessMode: () => SubagentAccessMode;
  getParentRunId?: () => string | undefined;
  /** 每次委派时重新读取具名定义，允许会话期间编辑生效。 */
  loadAgentDefinitions?: () => Promise<SubagentDefinition[]>;
  toolRegistry: ToolRegistry;
  onUsage?: ModelUsageObserver;
  runVerifiedTask?: (input: VerifiedSubagentTaskInput, context: ToolExecutionContext) => Promise<unknown>;
  readTaskResult?: (taskRunId: string, context: ToolExecutionContext) => Promise<unknown>;
}

export function createSubagentTool(options: SubagentOptions, taskManager: SubagentTaskManager): Tool<SubagentToolInput, unknown> {
  return {
    name: "Task",
    description: "Launch a focused, bounded worker. Add verification only when the delegated work has explicit deterministic acceptance checks; a normal Worker return then remains a candidate until those checks pass.",
    promptSnippet: "Delegate complex or isolated work to a focused, bounded worker",
    promptGuidelines: [
      "Keep simple one-step requests in the current run; delegate when isolation, specialist focus, or independent execution will help.",
      "Give the worker a concrete goal, relevant constraints, and a finite deliverable; summarize its result to the user when it returns.",
      "Preserve user-specified acceptance conditions exactly. Put them in verification.checks; do not replace them with easier inferred checks.",
      "If a verified task returns needs_approval, report the exact approvalId, command, cwd, and reason. Do not claim completion or approve it yourself."
    ],
    parameters: subagentParameters,
    schema: subagentSchema,
    source: "subagent",
    capability: "subagent.workspace",
    risk: "execute",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.all(),
        display: {
          kind: "generic",
          summary: args.agent ? `Delegate to subagent ${args.agent}` : "Delegate repository task",
          detail: args.task
        },
        description: "Runs a bounded workspace subagent with an explicit local-tool allowlist and restricted validation commands.",
        approvalRule: "Task",
        async execute(context): Promise<unknown> {
          if (args.verification) {
            if (!options.runVerifiedTask) throw new Error("Verified TaskRun execution is unavailable in this runtime.");
            return await options.runVerifiedTask({
              task: args.task,
              agent: args.agent,
              constraints: args.constraints,
              verification: args.verification
            }, context);
          }
          return await taskManager.run(args.task, {
            parentRunId: options.getParentRunId?.() ?? context.toolCallId,
            signal: context.signal,
            accessMode: options.getAccessMode(),
            agent: args.agent
          });
        }
      };
    }
  };
}

export function createTaskStatusTool(options: SubagentOptions): Tool<{ taskRunId: string }, unknown> {
  return {
    name: "TaskStatus",
    description: "Read the durable status and verification evidence for a TaskRun created by this session. This never resumes, retries, approves, or creates work.",
    promptSnippet: "Read a previously delegated verified task result",
    promptGuidelines: [
      "Use TaskStatus when a previous verified Task call returned needs_approval or another non-terminal status.",
      "Report completed only when the returned status is completed and verification evidence is passed."
    ],
    parameters: {
      type: "object",
      properties: { taskRunId: { type: "string", description: "The TaskRun id returned by Task." } },
      required: ["taskRunId"],
      additionalProperties: false
    },
    schema: z.object({ taskRunId: z.string().trim().min(1) }).strict(),
    source: "subagent",
    capability: "subagent.workspace",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "Read verified task status", detail: args.taskRunId },
        description: "Reads persisted TaskRun status and evidence without changing execution state.",
        approvalRule: "TaskStatus",
        async execute(context): Promise<unknown> {
          if (!options.readTaskResult) throw new Error("TaskRun status is unavailable in this runtime.");
          return await options.readTaskResult(args.taskRunId, context);
        }
      };
    }
  };
}

/** Executes one already-admitted child task. Concurrency and deadlines belong to SubagentTaskManager. */
export async function runSubagentTask(
  options: SubagentOptions,
  task: string,
  signal?: AbortSignal,
  accessMode: SubagentAccessMode = "read-only",
  agentName?: string
): Promise<string> {
  const settings = options.config.extensions.subagent;
  const definition = await resolveSubagentDefinition(options, agentName);
  const modelSettings = options.getModelSettings(definition?.model);
  const modelAlias = definition?.model ?? settings.model ?? options.config.defaultModel;
  // 具名定义的 tools 只做收窄：始终与全局 allowedTools 求交集，不能放宽安全边界。
  const allowedTools = definition?.tools
    ? settings.allowedTools.filter((toolName) => definition.tools?.includes(toolName))
    : settings.allowedTools;
  return await runNativeSubagentTask(options, task, modelSettings, modelAlias, definition, signal, accessMode, allowedTools);
}

async function runNativeSubagentTask(
  options: SubagentOptions,
  task: string,
  modelSettings: ModelSettings,
  modelAlias: string,
  definition: SubagentDefinition | undefined,
  signal: AbortSignal | undefined,
  accessMode: SubagentAccessMode,
  allowedTools: readonly string[]
): Promise<string> {
  const model = modelSettings.model;
  if (model.supportsTools === false) {
    throw new Error(`Subagent model ${modelAlias} does not support tools.`);
  }
  const scheduler = new ToolScheduler<unknown>({
    maxConcurrency: options.config.agent.maxConcurrentTools,
    maxQueuedTasks: options.config.agent.maxQueuedToolCalls
  });
  const tools = createSubagentTools(options.toolRegistry, allowedTools, {
    accessMode, scheduler,
    editing: { mode: resolveEditingMode(options.config.chat.hashlineEdit, modelSettings.applyPatchProtocol), context: { workspaceRoot: options.workspaceRoot, ignore: options.config.workspace.ignore } }
  });
  const instructions = buildSubagentSystemPrompt(accessMode, definition);
  const usages: AgentUsage[] = [];
  const assistantTexts: string[] = [];
  let lastAssistant: AgentAssistantMessage | undefined;
  let fatalError: string | undefined;
  let stopReason: string | undefined;
  const loop = vercelAgentLoopContinue({
    systemPrompt: instructions,
    messages: [{ role: "user", content: task }],
    tools
  }, {
    model,
    vercelModel: modelSettings.vercelModel,
    maxRetries: modelSettings.maxRetries,
    tools,
    modelOptions: {
      maxOutputTokens: subagentMaxOutputTokens(options.config, modelSettings.maxOutputTokens, modelAlias),
      reasoning: modelSettings.reasoning,
      providerOptions: modelSettings.providerOptions,
      timeoutMs: modelSettings.timeoutMs
    },
    maxSteps: options.config.extensions.subagent.maxSteps,
    shouldStopAfterTurn: async (turn) => {
      lastAssistant = turn.message;
      if (turn.message.usage) usages.push(turn.message.usage);
      if (subagentCostBudgetReached(options.config, usages, modelAlias)) return true;
      return !turn.message.content.some((part) => part.type === "toolCall");
    }
  }, signal);
  for await (const event of loop) {
    if (event.type === "error" && event.fatal) fatalError = event.error;
    if (event.type === "error" && event.reason === "step_limit") stopReason = "step_limit";
    if (event.type === "turn_end") {
      lastAssistant = event.message;
      const text = agentMessageText(event.message);
      if (text) assistantTexts.push(text);
    }
  }
  if (signal?.aborted) throw abortReason(signal);
  if (fatalError) throw new Error(fatalError);
  const usage = usages.length ? sumNativeUsage(usages) : undefined;
  if (usage) {
    await options.onUsage?.(usage, "subagent", modelAlias);
    enforceSubagentCostBudget(options.config, usage, modelAlias);
  }
  if (!lastAssistant) throw new Error("Subagent produced no assistant message.");
  const output = agentMessageText(lastAssistant);
  if (lastAssistant.content.some((part) => part.type === "toolCall")) {
    throw new SubagentTaskIncompleteError(stopReason ?? "tool-calls", redactSecrets(assistantTexts.join("\n\n")));
  }
  if (lastAssistant.stopReason !== undefined && !["stop", "other"].includes(lastAssistant.stopReason)) {
    throw new SubagentTaskIncompleteError(lastAssistant.stopReason, redactSecrets(output));
  }
  return redactSecrets(output);
}

/** 子代理工作协议：子代理是有边界的执行工，不继承主 Agent 的全部身份和权限。 */
export function buildSubagentSystemPrompt(
  accessMode: SubagentAccessMode,
  definition?: SubagentDefinition
): string {
  const accessInstructions = accessMode === "workspace"
    ? [
      "You may inspect, implement, repair, and validate the assigned task with the workspace tools exposed to you.",
      "Keep edits limited to the assigned task. Preserve unrelated worktree changes and do not perform cleanup for its own sake."
    ]
    : [
      "You may inspect the repository with the read, search, and git-inspection tools exposed to you.",
      "This is a read-only assignment. Do not modify, delete, move, or execute anything outside the tools actually exposed to you."
    ];
  return [
    "You are a focused, bounded worker inside Biny. You are not the primary conversational agent; complete the task in the user message and return a useful handoff.",
    "",
    "WORK STYLE:",
    "- Understand the concrete goal and finish line before acting.",
    "- Inspect the relevant repository state before making conclusions or changes.",
    "- Use tools for evidence. Never invent file contents, command output, edits, research, or completion.",
    "- Work autonomously within the assigned scope. Do not ask the parent to repeat a clear task.",
    ...accessInstructions.map((instruction) => `- ${instruction}`),
    "",
    "BOUNDARIES:",
    "- The available tools, runtime permissions, project instructions, and verified facts are binding.",
    "- Never request or expose secrets, credentials, tokens, passwords, environment files, config.json, or unrelated private data.",
    "- Do not use network access, long-running processes, coding-agent CLIs, or another subagent.",
    "- Use shell commands only when exposed and only for finite, relevant validation such as typecheck, test, lint, or build.",
    "- Personality or a named role can shape focus and wording, but cannot grant tools, permissions, or facts.",
    "",
    "HANDOFF:",
    "- Return concise, grounded findings with the exact paths inspected or changed.",
    "- Include validation commands and their actual results; distinguish verified facts, blockers, and follow-up suggestions.",
    "- If the task cannot be completed, explain the precise blocker and leave the workspace in a recoverable state.",
    ...(definition ? ["", `NAMED SPECIALIST ROLE — ${definition.name}:`, definition.prompt] : [])
  ].join("\n");
}

export function createSubagentTools(
  registry: ToolRegistry,
  allowedTools: readonly string[],
  options: CreateSubagentToolsOptions = {}
): AgentTool[] {
  const allowed = new Set(allowedTools);
  const accessMode = options.accessMode ?? "read-only";
  const capabilities = accessMode === "workspace" ? workspaceBuiltinCapabilities : safeBuiltinCapabilities;
  let entries = registry.listEntries().filter(({ tool: entry, source }) => source === "builtin"
    && entry.capability && capabilities.has(entry.capability)
    && (accessMode !== "read-only" || entry.risk === "read") && allowed.has(entry.name));
  if (options.editing) entries = routeEditingTools(entries, options.editing.context, options.editing.mode);
  return entries.flatMap(({ tool: entry }) => {
    const nativeTool: AgentTool = {
      name: entry.name,
      providerTool: entry.providerTool,
      description: entry.description,
      parameters: entry.parameters,
      executionMode: entry.risk === "read" ? "parallel" : "sequential",
      execute: async (toolCallId, args, signal) => {
        const parsed = entry.schema.parse(args);
        assertSafeToolInput(entry.name, parsed, accessMode);
        const resolved = await entry.resolveExecution(parsed);
        if ("isError" in resolved) {
          return { content: [{ type: "text", text: stringifySubagentValue(resolved.result) }], details: resolved.result, isError: true };
        }
        try {
          const result = await executeNativeSubagentTool(entry.name, resolved, toolCallId, signal, options.scheduler);
          const sanitized = sanitizeToolResult(entry.name, result);
          return { content: [{ type: "text", text: stringifySubagentValue(sanitized) }], details: sanitized };
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      }
    };
    return [nativeTool];
  });
}

async function executeNativeSubagentTool(
  toolName: string,
  execution: RunnableToolExecution,
  toolCallId: string,
  signal: AbortSignal | undefined,
  scheduler?: ToolScheduler<unknown>
): Promise<unknown> {
  const execute = async (): Promise<unknown> => {
    if (toolName === "Read") {
      const filePath = execution.accesses?.find((access) => access.kind === "file")?.path;
      if (filePath) {
        const stat = await fs.stat(filePath);
        if (stat.size > maxSubagentReadBytes) {
          throw new Error(`Subagent Read limit exceeded (${String(stat.size)} bytes; max ${String(maxSubagentReadBytes)}). Use search instead.`);
        }
      }
    }
    return await execution.execute({ toolCallId, operationId: createToolOperationId("subagent", toolCallId), signal });
  };
  return scheduler
    ? await scheduler.schedule({ accesses: execution.accesses ?? ToolAccesses.all(), signal, start: execute })
    : await execute();
}

function sumNativeUsage(usages: readonly AgentUsage[]): AgentUsage {
  return {
    inputTokens: sumUsageField(usages, "inputTokens"),
    outputTokens: sumUsageField(usages, "outputTokens"),
    totalTokens: sumUsageField(usages, "totalTokens"),
    reasoningTokens: sumUsageField(usages, "reasoningTokens"),
    cacheReadTokens: sumUsageField(usages, "cacheReadTokens"),
    cacheWriteTokens: sumUsageField(usages, "cacheWriteTokens")
  };
}

function sumUsageField(usages: readonly AgentUsage[], field: keyof AgentUsage): number | undefined {
  const values = usages.map((usage) => usage[field]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

function agentMessageText(message: AgentAssistantMessage): string {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function stringifySubagentValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

async function resolveSubagentDefinition(options: SubagentOptions, agentName?: string): Promise<SubagentDefinition | undefined> {
  if (!agentName) return undefined;
  const definitions = await options.loadAgentDefinitions?.() ?? [];
  const definition = findSubagentDefinition(definitions, agentName);
  if (!definition) {
    const known = definitions.map((entry) => entry.name).join(", ") || "none";
    throw new Error(`Unknown named subagent: ${agentName}. Available definitions: ${known}.`);
  }
  return definition;
}

export interface CreateSubagentToolsOptions {
  editing?: { mode: EditingMode; context: ToolContext };
  accessMode?: SubagentAccessMode;
  scheduler?: ToolScheduler<unknown>;
}

export function createReadOnlyTools(registry: ToolRegistry, allowedTools: readonly string[]): AgentTool[] {
  return createSubagentTools(registry, allowedTools, { accessMode: "read-only" });
}

export function enforceSubagentCostBudget(config: AgentConfig, usage: AgentUsage, modelAlias?: string): void {
  const budget = config.extensions.subagent.maxCostUsd;
  if (budget === undefined) return;
  const alias = modelAlias ?? subagentModelAlias(config);
  const cost = calculateUsageCost(usageSnapshot(usage), config.models[alias]?.pricing);
  if (!cost.known || cost.costUsd === undefined) {
    throw new Error(`Cannot enforce the subagent cost stop threshold for ${alias}: model pricing is incomplete.`);
  }
  if (cost.costUsd > budget) {
    throw new Error(`Subagent cost $${cost.costUsd.toFixed(6)} exceeded the configured $${budget.toFixed(6)} stop threshold.`);
  }
}

export function subagentCostBudgetReached(config: AgentConfig, usages: readonly AgentUsage[], modelAlias?: string): boolean {
  const budget = config.extensions.subagent.maxCostUsd;
  if (budget === undefined) return false;
  const alias = modelAlias ?? subagentModelAlias(config);
  const pricing = config.models[alias]?.pricing;
  let totalCostUsd = 0;
  for (const usage of usages) {
    const cost = calculateUsageCost(usageSnapshot(usage), pricing);
    if (!cost.known || cost.costUsd === undefined) {
      throw new Error(`Cannot enforce the subagent cost stop threshold for ${alias}: model pricing is incomplete.`);
    }
    totalCostUsd += cost.costUsd;
  }
  return totalCostUsd >= budget;
}

export function subagentMaxOutputTokens(config: AgentConfig, modelMaxOutputTokens?: number, modelAlias?: string): number {
  const settings = config.extensions.subagent;
  const configuredLimit = Math.min(settings.maxOutputTokens, modelMaxOutputTokens ?? settings.maxOutputTokens);
  if (settings.maxCostUsd === undefined) return configuredLimit;
  const outputPrice = config.models[modelAlias ?? subagentModelAlias(config)]?.pricing?.outputPerMillionTokens;
  if (outputPrice === undefined) throw new Error("Cannot derive the subagent output limit from the cost stop threshold: model output pricing is incomplete.");
  if (outputPrice === 0) return configuredLimit;
  const budgetTokenLimit = Math.max(1, Math.floor((settings.maxCostUsd * 1_000_000) / outputPrice));
  return Math.min(configuredLimit, budgetTokenLimit);
}

export function isSensitiveSubagentPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (isProtectedCredentialPath(normalized)) return true;
  return normalized.split("/").some((segment) => {
    const lower = segment.toLowerCase().replace(/^"|"$/g, "");
    return lower === ".biny" || lower === ".agent" || lower === ".ssh" || lower === ".npmrc" || lower === ".netrc" || lower.startsWith(".env");
  });
}

function assertSafeToolInput(toolName: string, input: unknown, accessMode: SubagentAccessMode): void {
  if (!isRecord(input)) return;
  if (toolName === "apply_patch" && isRecord(input.operation)) {
    assertSafeToolInput("Edit", input.operation, accessMode);
  }
  if (typeof input.path === "string" && isSensitiveSubagentPath(input.path)) {
    throw new Error(`Subagent access denied for protected path: ${input.path}`);
  }
  if (toolName === "Bash") {
    if (accessMode !== "workspace") throw new Error("Subagent command execution is not available in read-only mode.");
    if (input.background === true) throw new Error("Subagent Bash only permits finite foreground validation commands.");
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!isAllowedSubagentValidationCommand(command)) {
      throw new Error("Subagent Bash only permits finite build, test, lint, and typecheck commands without shell operators.");
    }
  }
}

export function isAllowedSubagentValidationCommand(command: string): boolean {
  // The command is passed to a shell. Only horizontal ASCII whitespace is
  // accepted so a newline cannot smuggle a second command past this allowlist.
  if (!command || !/^[\w@%+.,:/=\- \t]+$/u.test(command)) return false;
  const words = command.trim().split(/[ \t]+/u);
  const executable = words[0] ?? "";
  const firstArgument = words[1] ?? "";
  const secondArgument = words[2] ?? "";
  if (["pnpm", "npm", "yarn", "bun"].includes(executable)) {
    if (["test", "build", "lint", "typecheck", "check"].includes(firstArgument)) return true;
    if (firstArgument === "run" && ["test", "build", "lint", "typecheck", "check"].includes(secondArgument)) return true;
    return executable === "pnpm" && firstArgument === "exec" && ["tsc", "eslint", "vitest", "jest"].includes(secondArgument);
  }
  if (["mvn", "./mvnw"].includes(executable)) return ["test", "verify", "package"].includes(firstArgument);
  if (["gradle", "./gradlew"].includes(executable)) return ["test", "check", "build"].includes(firstArgument);
  if (executable === "cargo") return ["test", "check", "build", "clippy"].includes(firstArgument);
  if (executable === "go") return firstArgument === "test";
  if (["pytest", "py.test"].includes(executable)) return true;
  if (["python", "python3"].includes(executable)) return firstArgument === "-m" && secondArgument === "pytest";
  if (executable === "dotnet") return ["test", "build"].includes(firstArgument);
  if (executable === "make") return ["test", "check", "build", "lint"].includes(firstArgument);
  return false;
}

function sanitizeToolResult(toolName: string, result: unknown): unknown {
  if (toolName === "Glob" && isRecord(result) && Array.isArray(result.files)) {
    return { ...result, files: result.files.filter((file): file is string => typeof file === "string" && !isSensitiveSubagentPath(file)) };
  }
  if (toolName === "Grep" && isRecord(result) && Array.isArray(result.matches)) {
    return {
      ...result,
      matches: result.matches
        .filter((match) => !isRecord(match) || typeof match.path !== "string" || !isSensitiveSubagentPath(match.path))
        .map(redactUnknown)
    };
  }
  return redactUnknown(result);
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return redacted.length <= maxSubagentTextChars
      ? redacted
      : `${redacted.slice(0, maxSubagentTextChars)}\n[truncated by subagent tool limit]`;
  }
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subagentModelAlias(config: AgentConfig): string {
  return config.extensions.subagent.model ?? config.defaultModel;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Subagent task was cancelled.");
}
