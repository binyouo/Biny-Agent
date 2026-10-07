/**
 * 扩展状态汇总与文本报告。
 *
 * `/status`、`/mcp`、`/skills`、`/plugins` 输出的都是这里生成的文本。纯格式化，不去连接
 * MCP、不加载技能，状态由调用方采集后传入。
 */
import type { McpServerStatus } from "./mcp.js";
import type { SkillDefinition } from "./skills.js";
import type { SubagentDefinition } from "./agents.js";
import type { ToolSource } from "../tools/types.js";

export interface ExtensionStatus {
  mcp: McpServerStatus[];
  skills: SkillDefinition[];
  skillWarnings: string[];
  plugins: string[];
  subagent: {
    enabled: boolean;
    maxSteps?: number;
    maxOutputTokens: number;
    maxConcurrentSubagents: number;
    maxPendingSubagents: number;
    timeoutMs?: number;
    model?: string;
    maxCostUsd?: number;
    allowedTools: string[];
    agents: SubagentDefinition[];
  };
  toolScheduling: {
    maxConcurrentTools: number;
    maxQueuedToolCalls: number;
  };
  toolCounts: Record<ToolSource, number>;
}

export type ExtensionSection = "all" | "mcp" | "skills" | "plugins";

export function createToolCounts(entries: Array<{ source: ToolSource }>): Record<ToolSource, number> {
  const counts: Record<ToolSource, number> = {
    builtin: 0,
    mcp: 0,
    skill: 0,
    plugin: 0,
    subagent: 0
  };
  for (const entry of entries) counts[entry.source] += 1;
  return counts;
}

export function formatExtensionReport(status: ExtensionStatus, section: ExtensionSection = "all"): string {
  if (section === "mcp") return formatMcpReport(status.mcp);
  if (section === "skills") return formatSkillReport(status.skills);
  if (section === "plugins") return formatPathReport("Plugins", status.plugins, "No plugins loaded.");

  const counts = status.toolCounts;
  const skillDiagnostics = formatSkillDiagnostics(status.skillWarnings);
  return [
    "Extensions",
    "",
    formatMcpReport(status.mcp),
    "",
    formatSkillReport(status.skills),
    ...(skillDiagnostics ? ["", skillDiagnostics] : []),
    "",
    formatPathReport("Plugins", status.plugins, "No plugins loaded."),
    "",
    "Subagent",
    status.subagent.enabled
      ? [
        `  enabled · Task · ${status.subagent.maxSteps === undefined ? "no step limit" : `up to ${status.subagent.maxSteps} steps`} · ${String(status.subagent.maxOutputTokens)} output tokens`,
        `  concurrency ${String(status.subagent.maxConcurrentSubagents)} · queue cap ${String(status.subagent.maxPendingSubagents)} · ${status.subagent.timeoutMs === undefined ? "no total timeout" : `timeout ${status.subagent.timeoutMs}ms`} · model ${status.subagent.model ?? "current"}`,
        `  cost stop threshold ${status.subagent.maxCostUsd === undefined ? "not set" : `$${status.subagent.maxCostUsd.toFixed(6)}`} · tools ${status.subagent.allowedTools.join(", ")}`,
        ...formatSubagentAgents(status.subagent.agents)
      ].join("\n")
      : "  disabled",
    "",
    "Tools",
    `  scheduling concurrency ${String(status.toolScheduling.maxConcurrentTools)} · queue cap ${String(status.toolScheduling.maxQueuedToolCalls)}`,
    `  builtin ${String(counts.builtin)} · mcp ${String(counts.mcp)} · skill ${String(counts.skill)} · plugin ${String(counts.plugin)} · subagent ${String(counts.subagent)}`
  ].join("\n");
}

function formatMcpReport(servers: McpServerStatus[]): string {
  if (!servers.length) return "MCP\n  No MCP servers configured.";
  const lines = ["MCP"];
  for (const server of servers) {
    if (!server.enabled) {
      lines.push(`  - ${server.name} · disabled`);
      continue;
    }
    const state = server.connected ? "connected" : server.connecting ? "connecting" : "disconnected";
    const extras = [
      server.hasResources ? "resources" : "",
      server.promptNames.length ? `${String(server.promptNames.length)} prompts` : "",
      server.instructions ? "instructions" : ""
    ].filter(Boolean);
    lines.push(`  ${server.connected ? "✓" : "!"} ${server.name} · ${server.transport} · ${state} · ${String(server.toolNames.length)} tools${extras.length ? ` · ${extras.join(" · ")}` : ""}`);
    if (server.lastError) lines.push(`    error: ${server.lastError}`);
    for (const toolName of server.toolNames) lines.push(`    ${toolName}`);
    if (server.promptNames.length) lines.push(`    prompts: ${server.promptNames.join(", ")}`);
  }
  return lines.join("\n");
}

/** /subagent agents 的独立列表输出（CLI 与 TUI 共用）。 */
export function formatSubagentAgentList(definitions: readonly SubagentDefinition[]): string {
  if (!definitions.length) return "No named subagent definitions. Add markdown files (frontmatter: name/description/tools/model) under .biny/agents or ~/.config/biny/agents.";
  return definitions.map((definition) => {
    const extras = [definition.scope, definition.model ? `model ${definition.model}` : "", definition.tools ? `tools ${definition.tools.join("/")}` : ""].filter(Boolean).join(" · ");
    return `${definition.name} · ${extras} · ${definition.path}\n  ${definition.description}`;
  }).join("\n");
}

function formatSubagentAgents(agents: SubagentDefinition[]): string[] {
  if (!agents.length) return ["  named agents: none (add markdown definitions under .biny/agents or ~/.config/biny/agents)"];
  const lines = ["  named agents:"];
  for (const agent of agents) {
    const extras = [agent.scope, agent.model ? `model ${agent.model}` : "", agent.tools ? `tools ${agent.tools.join("/")}` : ""].filter(Boolean).join(" · ");
    lines.push(`    ${agent.name} · ${extras} · ${agent.path}`);
    lines.push(`      ${agent.description}`);
  }
  return lines;
}

function formatSkillReport(skills: SkillDefinition[]): string {
  // 空态只描述成功加载的结果，避免失败路径里的 Skill 名称看起来像已加载项。
  if (!skills.length) return "Skills\n  No skills loaded.";
  const names = [...new Set(skills.map((skill) => skill.name))].sort((left, right) => left.localeCompare(right));
  return ["Skills", `  ${names.join(", ")}`].join("\n");
}

function formatSkillDiagnostics(warnings: string[]): string {
  if (!warnings.length) return "";
  return ["Skill conflicts", ...warnings.map((warning) => `  ${warning}`)].join("\n");
}

function formatPathReport(title: string, paths: string[], empty: string): string {
  return [title, ...(paths.length ? paths.map((filePath) => `  ${filePath}`) : [`  ${empty}`])].join("\n");
}
