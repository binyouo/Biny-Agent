import type { BrowserAutomationEndpoint } from "./browser.js";
/**
 * 工具注册表模块。
 *
 * 内置文件、搜索和命令工具会在这里集中注册，agent loop 通过名称查找并执行工具。注册表也保留
 * 工具来源信息让内置、MCP、skill、plugin 和 subagent 工具复用同一调用路径。
 */
import type { ToolDefinition } from "./definition.js";
import type { JsonSchema } from "./schema.js";
import type { SandboxConfig, WebCookiesConfig, WebFetchConfig, WebSearchConfig } from "../config/schema.js";
import type { Tool, ToolContext, ToolExposure, ToolNamespace, ToolRisk, ToolSource } from "./types.js";
import { getToolExposure, isToolModelVisible } from "./exposure.js";
import { createReadFileTool } from "./file/readFile.js";
import { createWriteFileTool } from "./file/writeFile.js";
import { createEditFileTool } from "./file/editFile.js";
import { createReadToolResultTool } from "./file/readToolResult.js";
import { createListFilesTool } from "./file/listFiles.js";
import { createSearchFilesTool } from "./search/searchFiles.js";
import { createRunCommandTool } from "./shell/runCommand.js";
import { createBashOutputTool, createKillShellTool } from "./process/managedProcesses.js";
import { createWebFetchTool } from "./web/fetch.js";
import { createWebSearchTool } from "./web/search.js";
import { createToolSearchTool } from "./toolSearch.js";
import { createWidgetReadmeTool, createWidgetRendererTool } from "./widget.js";
import { createBrowserRelayTools } from "./browserRelay.js";
import type { ToolModelCandidate } from "../llm/toolModel.js";
import type { ManagedProcessService } from "../runtime/ManagedProcessService.js";

/** Explicit host-owned read contracts, never inferred from extension metadata. */
export type HostReadQuery = "TaskStatus" | "skill_lookup" | "BashOutput" | "read_skill_resource";
const hostReadQueryContracts: Record<HostReadQuery, { source: ToolSource; capability: string }> = {
  TaskStatus: { source: "subagent", capability: "subagent.workspace" },
  skill_lookup: { source: "skill", capability: "skills" },
  BashOutput: { source: "builtin", capability: "shell.output" },
  read_skill_resource: { source: "skill", capability: "skills" }
};
const hostReadQueryRegistrations = new WeakMap<RegisteredTool, {
  identity: HostReadQuery;
  resolveExecution: Tool["resolveExecution"];
  parameters: Tool["parameters"];
  schema: Tool["schema"];
}>();
const reviewedBuiltinReads = new Set(["Read", "Glob", "Grep", "read_tool_result", "recall_memory", "search_history"]);

/** Shared by discovery and execution. Serialized/tool-supplied hints grant no authority. */
export function isCodeModeReadTool(entry: RegisteredTool): boolean {
  if (reviewedBuiltinReads.has(entry.tool.name)) return entry.source === "builtin";
  const authority = hostReadQueryRegistrations.get(entry);
  if (!authority || entry.tool.name !== authority.identity) return false;
  const contract = hostReadQueryContracts[authority.identity];
  return entry.source === contract.source && entry.tool.risk === "read" && entry.tool.capability === contract.capability
    && entry.tool.resolveExecution === authority.resolveExecution && entry.tool.parameters === authority.parameters
    && entry.tool.schema === authority.schema;
}

export interface RegisteredTool {
  readonly source: ToolSource;
  readonly tool: Tool;
}

export interface ToolCatalogDefinition extends ToolDefinition {
  outputSchema?: JsonSchema;
  source: ToolSource;
  risk?: ToolRisk;
  exposure: ToolExposure;
  namespace?: ToolNamespace;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: Tool, source: ToolSource = "builtin"): void {
    // source 只记录注册来源；权限、session 和调度仍由统一 coordinator 处理。
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, Object.freeze({ source, tool }));
  }

  /** Host assembly only. Plugin/MCP/user registration never calls this route. */
  registerHostReadQuery(tool: Tool, identity: HostReadQuery): void {
    const contract = hostReadQueryContracts[identity];
    if (!Object.hasOwn(hostReadQueryContracts, identity) || tool.name !== identity || tool.risk !== "read" || tool.capability !== contract.capability) {
      throw new Error(`Invalid host read-query contract: ${identity}`);
    }
    this.register(tool, contract.source);
    hostReadQueryRegistrations.set(this.tools.get(tool.name)!, {
      identity, resolveExecution: tool.resolveExecution, parameters: tool.parameters, schema: tool.schema
    });
  }

  registerBuiltinTool(tool: Tool): void {
    this.register(tool, "builtin");
  }

  registerUserTool(tool: Tool): void {
    this.register(tool, "skill");
  }

  registerMcpTool(tool: Tool): void {
    this.register(tool, "mcp");
  }

  registerPluginTool(tool: Tool): void {
    this.register(tool, "plugin");
  }

  registerSubagentTool(tool: Tool): void {
    this.register(tool, "subagent");
  }

  /** MCP tools/list_changed 之类的动态刷新需要先移除旧注册；对进行中的调用无影响。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get<TArgs = unknown, TResult = unknown>(name: string): Tool<TArgs, TResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return entry.tool as Tool<TArgs, TResult>;
  }

  list(): Tool[] {
    return [...this.tools.values()].map((entry) => entry.tool);
  }

  listDefinitions(): ToolDefinition[] {
    return this.list().filter(isToolModelVisible).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  listCatalogDefinitions(): ToolCatalogDefinition[] {
    return this.listEntries().map(({ source, tool }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      outputSchema: tool.outputSchema,
      source,
      risk: tool.risk,
      exposure: getToolExposure(tool),
      namespace: tool.namespace
    }));
  }

  listEntries(): RegisteredTool[] {
    return [...this.tools.values()];
  }
}

export function createToolRegistry(
  context: ToolContext,
  webSearchConfig?: WebSearchConfig,
  managedProcessService?: ManagedProcessService,
  webFetchConfig?: WebFetchConfig,
  sandboxConfig?: SandboxConfig,
  webCookiesConfig?: WebCookiesConfig,
  getToolSearchModels?: () => readonly ToolModelCandidate[],
  browser?: BrowserAutomationEndpoint
): ToolRegistry {
  // 这里集中注册内置工具；外部扩展在 CommandRuntime 装配完成后追加到同一 registry。
  const registry = new ToolRegistry();
  for (const tool of createBrowserRelayTools(undefined, context)) registry.register(tool);
  registry.register(createToolSearchTool(() => registry.listEntries(), getToolSearchModels));
  registry.register(createWidgetReadmeTool());
  registry.register(createWidgetRendererTool());
  registry.register(createReadFileTool(context));
  registry.register(createReadToolResultTool(context));
  registry.register(createListFilesTool(context));
  registry.register(createSearchFilesTool(context));
  registry.register(createWriteFileTool(context));
  registry.register(createEditFileTool(context));
  registry.register(createRunCommandTool(context, sandboxConfig, {}, managedProcessService));
  if (managedProcessService) {
    registry.registerHostReadQuery(createBashOutputTool(managedProcessService), "BashOutput");
    registry.register(createKillShellTool(managedProcessService));
  }
  // WebSearch 的实现依赖 Desktop 浏览器；没有执行端时不注册一个调用必然失败的工具。
  if (browser) registry.register(createWebSearchTool(webSearchConfig, webCookiesConfig, browser));
  if (browser || webFetchConfig?.enabled !== false) registry.register(createWebFetchTool(webFetchConfig, webCookiesConfig, { browser, visibleBrowsing: webSearchConfig?.visibleBrowsing }));
  return registry;
}
