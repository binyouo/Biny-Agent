/**
 * 报告类 slash command 的结构化卡片构建。
 *
 * 纯文本报告继续由 statusReport.ts / usage.ts / report.ts 生成给 CLI、Desktop 和 evals，
 * 这里单独产出 TUI 渲染报告卡片所需的结构化数据，两边互不干扰。
 */
import type { AgentSessionInfo } from "../agent/AgentSession.js";
import type { ContextStatus } from "../agent/context/types.js";
import { readReportedCacheRates, readReportedCacheUsage, reportedCacheTokenValue, type UsageSummary } from "../session/metadata.js";
import { formatDuration, type ModelRequestSummary } from "../observability/modelRequests.js";
import type { ExtensionStatus } from "../extensions/report.js";
import type { McpServerStatus } from "../extensions/mcp.js";
import type { SubagentDefinition } from "../extensions/agents.js";
import type { SubagentTaskSnapshot } from "./SubagentTaskManager.js";
import type { SessionGoalRecord } from "./SessionGoalStore.js";
import type { TaskRunWithAttempts } from "./TaskRunStore.js";
import type { AutomationRecord } from "./AutomationScheduler.js";
import type { GraphRecord } from "./GoalGraphStore.js";
import type { RuntimeEventPage } from "./RuntimeAuthority.js";
import type { CapabilityRegistration } from "./CapabilityStore.js";
import { contextComponentLabel, formatCount } from "./statusReport.js";
import type {
  CardValueStyle,
  CommandCardData,
  CommandCardRow,
  CommandCardValue
} from "./commandCard.js";

export function buildStatusCard(
  info: AgentSessionInfo,
  permissionMode: string,
  context: ContextStatus,
  usage: UsageSummary,
  extensions: ExtensionStatus,
  modelRequests: ModelRequestSummary = {
    calls: 0,
    succeeded: 0,
    failed: 0,
    totalAttempts: 0,
    retries: 0,
    totalDurationMs: 0
  }
): CommandCardData {
  const budget = context.budget;
  const contextWindow = budget.contextWindow ?? budget.maxTokens;
  const contextUsed = Math.max(0, budget.usedTokens);
  const contextRemainingPercent = contextWindow > 0
    ? Math.max(0, Math.min(100, Math.round(((contextWindow - contextUsed) / contextWindow) * 100)))
    : 0;
  const inputRemaining = Math.max(0, budget.maxTokens - contextUsed);

  return {
    title: "Status",
    sections: [
      {
        rows: [
          row("Model", info.reasoningLabel ? `${info.modelLabel} (${info.reasoningLabel})` : info.modelLabel),
          detailRow("Provider", info.provider),
          detailRow("Directory", info.workspaceRoot),
          row("Permissions", permissionMode),
          { label: "Session", value: info.sessionId, tone: "dim", detail: true }
        ]
      },
      {
        rows: [
          usageRow(usage),
          cacheHitRow(usage),
          requestRow(modelRequests),
          ...(modelRequests.totalDurationMs > 0
            ? [detailRow("", `provider time ${formatDuration(modelRequests.totalDurationMs)} total`)]
            : [])
        ]
      },
      {
        rows: [
          {
            label: "Context window",
            value: [
              { text: `${String(contextRemainingPercent)}% left`, style: remainingStyle(contextRemainingPercent) },
              ...dimParen([{ tokens: contextUsed }, { text: " used / " }, { tokens: contextWindow }])
            ]
          },
          {
            label: "Input budget",
            detail: true,
            value: [
              { tokens: contextUsed },
              { text: " / " },
              { tokens: budget.maxTokens },
              ...dimParen([{ text: `${formatCount(inputRemaining)} left` }])
            ]
          },
          ...(budget.maxOutputTokens !== undefined
            ? [detailRow("Output limit", `${formatCount(budget.maxOutputTokens)} tokens`)]
            : []),
          detailRow("Auto compacted", budget.autoCompacted ? "yes" : "no"),
          ...contextDetailRows(context)
        ]
      },
      { rows: extensionSummaryRows(extensions) }
    ]
  };
}

export function buildUsageCard(summary: UsageSummary): CommandCardData {
  if (!summary.calls) {
    return {
      title: "Usage",
      sections: [{ rows: [row("Usage", "no model calls recorded in this session", "dim")] }]
    };
  }
  const epochRates = Object.entries((readReportedCacheRates(summary) ?? summary).epochCacheHitRates ?? {});
  return {
    title: "Usage",
    sections: [
      {
        rows: [
          row("Calls", String(summary.calls)),
          row("Input tokens", readReportedCacheUsage(summary) ? reportedCacheTokens(summary, "inputTokens") : tokens(summary.inputTokens)),
          row("Output tokens", tokens(summary.outputTokens)),
          ...(summary.reasoningTokens > 0 ? [row("Reasoning tokens", tokens(summary.reasoningTokens))] : []),
          { label: "Total tokens", value: tokens(summary.totalTokens, "bold") }
        ]
      },
      {
        rows: [
          {
            label: "Cache",
            value: [
              { text: "read " },
              ...reportedCacheTokens(summary, "cacheReadTokens"),
              { text: " / write " },
              { tokens: summary.cacheWriteTokens },
              { text: " / miss " },
              { tokens: summary.cacheMissTokens ?? 0 }
            ]
          },
          cacheHitRow(summary),
          ...epochRates.map(([, rate]): CommandCardRow => ({
            label: "Epoch",
            value: { text: rate === null ? "unknown" : `${String(Math.round(rate * 100))}%`, style: "dim" },
            detail: true
          })),
          {
            label: "Cost",
            value: summary.pricingKnown && summary.costUsd !== undefined
              ? { text: `$${summary.costUsd.toFixed(4)}`, style: "success" }
              : { text: "unknown (configure model pricing)", style: "dim" }
          },
          detailRow("Priced calls", `${String(summary.pricedCalls)} priced · ${String(summary.unpricedCalls)} unpriced`)
        ]
      }
    ]
  };
}

export function buildMcpCard(servers: readonly McpServerStatus[]): CommandCardData {
  const rows: CommandCardRow[] = servers.length
    ? servers.map((server): CommandCardRow => {
      if (!server.enabled) return { label: server.name, value: "disabled", tone: "warning" };
      const extras = [
        server.hasResources ? "resources" : "",
        server.promptNames.length ? `${String(server.promptNames.length)} prompts` : "",
        server.instructions ? "instructions" : ""
      ].filter(Boolean);
      const connection = server.connected ? "connected" : server.connecting ? "connecting" : server.authRequired ? "authorization required" : server.lastError ? "failed" : "disconnected";
      const value: CommandCardValue[] = [{
        text: `${server.transport} · ${connection} · ${String(server.toolNames.length)} tools`
      }];
      if (extras.length) value.push({ text: ` · ${extras.join(" · ")}`, style: "muted" });
      return { label: server.name, value, tone: server.connected ? "success" : "warning" };
    })
    : [row("MCP", "no servers configured", "dim")];

  const errors: CommandCardRow[] = [];
  const details: CommandCardRow[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    if (server.lastError) errors.push({ label: server.name, value: { text: `${server.lastError} · /mcp reconnect ${server.name}`, style: "error" } });
    if (server.toolNames.length) {
      details.push({ label: "", value: { text: `tools: ${server.toolNames.join(", ")}`, style: "dim" }, detail: true });
    }
  }
  return { title: "MCP", sections: [{ rows: [...errors, ...rows, ...details] }] };
}

export function buildSkillsCard(
  skills: readonly { name: string }[],
  warnings: readonly string[]
): CommandCardData {
  const names = [...new Set(skills.map((skill) => skill.name))].sort((left, right) => left.localeCompare(right));
  return {
    title: "Skills",
    sections: [{
      rows: [
        row("Skills", names.length ? `${String(names.length)} loaded: ${names.join(", ")}` : "no skills loaded", names.length ? undefined : "dim"),
        ...warnings.map((warning): CommandCardRow => ({ label: "", value: { text: warning, style: "warning" }, detail: true }))
      ]
    }]
  };
}

export function buildPluginsCard(plugins: readonly string[]): CommandCardData {
  return {
    title: "Plugins",
    sections: [{
      rows: [
        row("Plugins", plugins.length ? `${String(plugins.length)} loaded` : "no plugins loaded", plugins.length ? undefined : "dim"),
        ...plugins.map((filePath): CommandCardRow => ({ label: "", value: { text: filePath, style: "dim" }, detail: true }))
      ]
    }]
  };
}

export function buildSubagentTasksCard(tasks: readonly SubagentTaskSnapshot[]): CommandCardData {
  if (!tasks.length) {
    return {
      title: "Subagent",
      sections: [{ rows: [row("Subagent", "no tasks have been submitted in this runtime", "dim")] }]
    };
  }
  const rows: CommandCardRow[] = [];
  for (const task of [...tasks].reverse()) {
    rows.push({
      label: "Task",
      value: `${task.status}${task.agent ? ` · agent ${task.agent}` : ""}`,
      tone: subagentStatusTone(task.status)
    });
    rows.push(row("Objective", task.task));
    rows.push(detailRow("ID", task.taskId));
    rows.push({
      label: "",
      value: { text: `parent ${task.parentRunId} · deadline ${task.deadline}`, style: "dim" },
      detail: true
    });
    if (task.error) rows.push(row("Error", task.error, "error"));
  }
  return { title: "Subagent", sections: [{ rows }] };
}

export function buildSubagentAgentsCard(definitions: readonly SubagentDefinition[]): CommandCardData {
  if (!definitions.length) {
    return {
      title: "Subagent agents",
      sections: [{ rows: [row("Subagent agents", "no named agents (add markdown definitions under .biny/agents or ~/.config/biny/agents)", "dim")] }]
    };
  }
  const rows: CommandCardRow[] = [];
  for (const definition of definitions) {
    rows.push({
      label: definition.name,
      value: definition.description || "No description"
    });
    rows.push(detailRow("Source", `${definition.scope} · ${definition.path}`));
    if (definition.model) rows.push(detailRow("Model", definition.model));
    if (definition.tools) rows.push(detailRow("Tools", definition.tools.join(", ")));
  }
  return { title: "Subagent agents", sections: [{ rows }] };
}

export function buildTextCard(title: string, content: string): CommandCardData {
  return {
    title,
    sections: [{ rows: content.split(/\r?\n/u).map((value, index) => ({ label: "", value, detail: index >= 4 })) }]
  };
}

export function buildGoalCard(goal: SessionGoalRecord | undefined): CommandCardData {
  return {
    title: "Goal",
    sections: [{ rows: goal ? [
      row("Status", goal.status, goal.status === "completed" ? "success" : goal.status === "active" ? "accent" : "warning"),
      row("Objective", goal.objective),
      detailRow("Usage", goal.usageKnown ? `${goal.tokensUsed} tokens` : "Token usage incomplete"),
      ...(goal.tokenBudget === undefined ? [] : [detailRow("Budget", `${goal.tokenBudget} tokens`)])
    ] : [row("Goal", "No goal set. Use /goal <objective> to start.", "muted")] }]
  };
}

export function buildTasksCard(page: { tasks: TaskRunWithAttempts[]; hasMore: boolean }): CommandCardData {
  const rows = page.tasks.flatMap((task): CommandCardRow[] => {
    const definition = typeof task.task === "object" && task.task !== null ? task.task as Record<string, unknown> : undefined;
    const objective = typeof task.task === "string" ? task.task
      : typeof definition?.prompt === "string" ? definition.prompt
        : typeof definition?.title === "string" ? definition.title : "Task";
    const failure = task.attempts.at(-1)?.failure;
    const message = typeof failure === "object" && failure !== null && "message" in failure ? String(failure.message) : undefined;
    return [row("Status", task.status), row("Objective", objective),
      ...(message ? [row("Error", message, "error")] : []),
      detailRow("ID", task.taskRunId), detailRow("Attempts", String(task.attempts.length))];
  });
  if (!rows.length) rows.push(row("Tasks", "No tasks found.", "muted"));
  if (page.hasMore) rows.push(row("More", "More tasks available; filter with /tasks <status>.", "muted"));
  return { title: "Tasks", sections: [{ rows }] };
}

export function buildAutomationsCard(automations: readonly AutomationRecord[]): CommandCardData {
  const rows = automations.flatMap((automation): CommandCardRow[] => [
    row(automation.name, `${automation.status} · ${automation.triggerType}`),
    ...(automation.nextFireAt ? [row("Next run", automation.nextFireAt)] : []),
    detailRow("ID", automation.automationId), detailRow("Prompt", automation.executionTemplate.prompt),
    detailRow("Runs", `${automation.fireCount} · ${automation.consecutiveFailures} consecutive failures`)
  ]);
  return { title: "Automation", sections: [{ rows: rows.length ? rows : [row("Automation", "No automations configured.", "muted")] }] };
}

export function buildGraphCard(graph: GraphRecord): CommandCardData {
  return { title: "Graph", sections: [{ rows: [
    row("Status", graph.status), row("Progress", `${graph.nodes.filter((node) => node.status === "completed").length}/${graph.nodes.length} nodes completed`),
    ...graph.nodes.map((node) => row(node.nodeKey, node.status)),
    detailRow("ID", graph.graphId), detailRow("Mode", graph.mode)
  ] }] };
}

export function buildGraphEventsCard(page: RuntimeEventPage): CommandCardData {
  return { title: "Graph events", sections: [{ rows: [
    ...page.events.map((event) => row(event.eventType, event.createdAt)),
    ...(page.events.length ? [] : [row("Events", "No events found.", "muted")]),
    ...(page.hasMore ? [row("More", `Continue with --cursor ${page.nextCursor}`)] : [])
  ] }] };
}

export function buildCapabilitiesCard(capabilities: readonly CapabilityRegistration[]): CommandCardData {
  const rows = capabilities.flatMap((capability): CommandCardRow[] => [
    row(capability.capabilityName, `${capability.status} · ${capability.ownerType}`),
    detailRow("ID", capability.registrationId), detailRow("Owner", capability.ownerId)
  ]);
  return { title: "Capabilities", sections: [{ rows: rows.length ? rows : [row("Capabilities", "No capabilities registered.", "muted")] }] };
}

// ---------------------------------------------------------------- 行构建

function row(label: string, value: string | CommandCardValue | CommandCardValue[], tone?: Exclude<CardValueStyle, "bold">): CommandCardRow {
  return { label, value, tone };
}

function detailRow(label: string, value: string, tone?: Exclude<CardValueStyle, "bold">): CommandCardRow {
  return { label, value: tone === undefined ? value : { text: value, style: tone }, detail: true };
}

function tokens(count: number, style?: CardValueStyle): CommandCardValue {
  return style === undefined ? { tokens: count } : { tokens: count, style };
}

function reportedCacheTokens(summary: UsageSummary, field: "inputTokens" | "cacheReadTokens"): CommandCardValue[] {
  const projection = readReportedCacheUsage(summary);
  if (!projection) return [tokens(summary[field])];
  const value = reportedCacheTokenValue(projection[field]);
  if (value === undefined) return [{ text: "unknown" }];
  const complete = field === "inputTokens" ? projection.inputTokensComplete : projection.cacheReadTokensComplete;
  return [tokens(value), ...(complete === true ? [] : [{ text: complete === false ? " (partial)" : " (completeness unknown)" }])];
}

/** 把一组片段整体包进 dim 括号：`(A input + B output)`。 */
function dimParen(segments: CommandCardValue[]): CommandCardValue[] {
  const dimmed = segments.map((segment): CommandCardValue => {
    if (typeof segment === "string") return { text: segment, style: "dim" };
    return "tokens" in segment ? { ...segment, style: segment.style ?? "dim" } : { ...segment, style: segment.style ?? "dim" };
  });
  return [{ text: " (", style: "dim" }, ...dimmed, { text: ")", style: "dim" }];
}

function usageRow(usage: UsageSummary): CommandCardRow {
  if (!usage.calls) return row("Token usage", "no model calls recorded", "dim");
  return {
    label: "Token usage",
    value: [
      tokens(usage.totalTokens, "bold"),
      { text: " total " },
      ...dimParen([
        ...reportedCacheTokens(usage, "inputTokens"),
        { text: " input + " },
        tokens(usage.outputTokens),
        ...(usage.reasoningTokens > 0
          ? [{ text: "; " }, tokens(usage.reasoningTokens), { text: " reasoning" }]
          : [])
      ])
    ]
  };
}

function cacheHitRow(usage: UsageSummary): CommandCardRow {
  const rates = readReportedCacheRates(usage) ?? usage;
  return row("Cache hit", `latest ${cacheRate(rates.latestCacheHitRate)} · session ${cacheRate(rates.sessionCacheHitRate)}`);
}

function cacheRate(value: number | undefined): string {
  return value === undefined ? "unknown" : `${String(Math.round(Math.max(0, Math.min(1, value)) * 100))}%`;
}

function requestRow(modelRequests: ModelRequestSummary): CommandCardRow {
  const parts = [`${String(modelRequests.calls)} calls`];
  if (modelRequests.failed > 0) parts.push(`${String(modelRequests.failed)} failed`);
  if (modelRequests.retries > 0) parts.push(`${String(modelRequests.retries)} retried`);
  return row("Requests", parts.join(" · "));
}

function remainingStyle(percentLeft: number): "error" | "warning" | undefined {
  if (percentLeft < 10) return "error";
  if (percentLeft < 30) return "warning";
  return undefined;
}

function extensionSummaryRows(extensions: ExtensionStatus): CommandCardRow[] {
  const mcpEnabled = extensions.mcp.filter((server) => server.enabled);
  const mcpConnected = mcpEnabled.filter((server) => server.connected);
  const mcpText = mcpEnabled.length
    ? `${String(mcpEnabled.length)} servers${mcpConnected.length !== mcpEnabled.length ? ` (${String(mcpConnected.length)} connected)` : ""}`
    : "no servers configured";
  return [
    row("MCP", mcpText, mcpEnabled.length ? undefined : "dim"),
    row("Skills", extensions.skills.length ? `${String(extensions.skills.length)} loaded` : "none", extensions.skills.length ? undefined : "dim"),
    row("Plugins", extensions.plugins.length ? `${String(extensions.plugins.length)} loaded` : "none", extensions.plugins.length ? undefined : "dim"),
    row("Subagent", extensions.subagent.enabled ? `enabled · ${extensions.subagent.maxSteps === undefined ? "no step limit" : `up to ${extensions.subagent.maxSteps} steps`}` : "disabled", extensions.subagent.enabled ? undefined : "dim"),
    ...extensions.skillWarnings.map((warning): CommandCardRow => ({
      label: "Skill warning",
      value: { text: warning, style: "warning" },
      detail: true
    }))
  ];
}

function contextDetailRows(context: ContextStatus): CommandCardRow[] {
  const budget = context.budget;
  const rows: CommandCardRow[] = [];
  const inputMeasurement = formatInputMeasurement(budget.estimatedTokens, budget.providerInputTokens);
  if (inputMeasurement) rows.push(detailRow("Input measurement", inputMeasurement));
  const reserves = [
    budget.outputReserveTokens === undefined ? "" : `output ${formatCount(budget.outputReserveTokens)}`,
    budget.reasoningReserveTokens === undefined ? "" : `reasoning ${formatCount(budget.reasoningReserveTokens)}`,
    budget.toolSchemaReserveTokens === undefined ? "" : `tools ${formatCount(budget.toolSchemaReserveTokens)}`,
    budget.systemPromptReserveTokens === undefined ? "" : `system ${formatCount(budget.systemPromptReserveTokens)}`
  ].filter(Boolean).join(", ");
  if (reserves) rows.push(detailRow("Context reserves", reserves));
  rows.push(detailRow(
    "Compaction",
    context.compaction.summaryPresent ? `active; ${String(context.compaction.compactedMessages)} messages compacted` : "not active"
  ));
  rows.push(detailRow(
    "Instructions",
    `${String(context.loadedInstructions.length)} loaded; ${formatCount(context.instructionBytes)}/${formatCount(context.instructionCapBytes)} bytes`
  ));
  rows.push(detailRow("Repo map", `${String(context.repoMapEntries)} entries${context.repoMapDirty ? " (dirty)" : ""}`));
  rows.push(detailRow(
    "Memory",
    context.memoryEnabled
      ? context.memoryOverviewChars
        ? `enabled; overview ${formatCount(context.memoryOverviewChars)} chars injected, entries recalled on demand`
        : "enabled (no memory overview this turn)"
      : "disabled (stored data retained)"
  ));
  const composition = budget.components?.filter((component) => component.requestedTokens > 0) ?? [];
  for (const component of composition) {
    rows.push(detailRow(
      contextComponentLabel(component.id),
      `${formatCount(component.usedTokens)}/${formatCount(component.requestedTokens)} tokens (${component.disposition})`
    ));
  }
  if (context.activePaths.length) rows.push(detailRow("Active paths", context.activePaths.join(", ")));
  if (budget.omitted.length) rows.push(detailRow("Omitted", budget.omitted.join(", ")));
  return rows;
}

function formatInputMeasurement(estimatedTokens: number | undefined, providerInputTokens: number | undefined): string | undefined {
  if (estimatedTokens === undefined && providerInputTokens === undefined) return undefined;
  if (estimatedTokens === undefined) return `provider ${formatCount(providerInputTokens ?? 0)} tokens`;
  if (providerInputTokens === undefined) return `estimated ${formatCount(estimatedTokens)} tokens`;
  const delta = Math.round(providerInputTokens - estimatedTokens);
  const signedDelta = delta > 0 ? `+${formatCount(delta)}` : delta < 0 ? `-${formatCount(Math.abs(delta))}` : "0";
  return `estimated ${formatCount(estimatedTokens)}; provider ${formatCount(providerInputTokens)}; delta ${signedDelta}`;
}

function subagentStatusTone(status: string): CommandCardRow["tone"] {
  if (status === "completed") return "success";
  if (status === "failed" || status === "policy_denied" || status === "budget_exhausted" || status === "aborted") return "error";
  if (status === "running" || status === "verifying" || status === "queued" || status === "created" || status === "blocked" || status === "needs_approval") return "accent";
  if (status === "incomplete" || status === "cancelled") return "warning";
  return undefined;
}
