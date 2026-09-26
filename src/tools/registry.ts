import type { BrowserAutomationEndpoint } from "./browser.js";
/**
 * 工具注册表模块。
 *
 * 内置文件、搜索和命令工具会在这里集中注册，agent loop 通过名称查找并执行工具。注册表也保留
 * 工具来源信息让内置、MCP、skill、plugin 和 subagent 工具复用同一调用路径。
 */
import type { ToolDefinition } from "./definition.js";
import type { SandboxConfig, WebCookiesConfig, WebFetchConfig, WebSearchConfig } from "../config/schema.js";
import type { Tool, ToolContext, ToolSource } from "./types.js";
import { createReadFileTool } from "./file/readFile.js";
import { createWriteFileTool } from "./file/writeFile.js";
import { createEditFileTool } from "./file/editFile.js";
import { createReadToolResultTool } from "./file/readToolResult.js";
import { createListFilesTool } from "./file/listFiles.js";
import { createSearchFilesTool } from "./search/searchFiles.js";
import { createRunCommandTool } from "./shell/runCommand.js";
import { createManagedProcessTools } from "./process/managedProcesses.js";
import { createWebFetchTool } from "./web/fetch.js";
import { createWebSearchTool } from "./web/search.js";
import { createToolSearchTool } from "./toolSearch.js";
import { createBrowserRelayTools } from "./browserRelay.js";
import type { AgentModel } from "../agent/core/types.js";
import type { ManagedProcessService } from "../runtime/ManagedProcessService.js";

export interface RegisteredTool {
  source: ToolSource;
  tool: Tool;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: Tool, source: ToolSource = "builtin"): void {
    // source 只记录注册来源；权限、session 和调度仍由统一 coordinator 处理。
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, { source, tool });
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
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
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
  getToolSearchModel?: () => AgentModel | undefined,
  browser?: BrowserAutomationEndpoint
): ToolRegistry {
  // 这里集中注册内置工具；外部扩展在 CommandRuntime 装配完成后追加到同一 registry。
  const registry = new ToolRegistry();
  for (const tool of createBrowserRelayTools(undefined, context)) registry.register(tool);
  registry.register(createToolSearchTool(() => registry.listEntries(), getToolSearchModel));
  registry.register(createReadFileTool(context));
  registry.register(createReadToolResultTool(context));
  registry.register(createListFilesTool(context));
  registry.register(createSearchFilesTool(context));
  registry.register(createWriteFileTool(context));
  registry.register(createEditFileTool(context));
  registry.register(createRunCommandTool(context, sandboxConfig, {}, managedProcessService));
  if (managedProcessService) {
    for (const tool of createManagedProcessTools(managedProcessService)) registry.register(tool);
  }
  // WebSearch 的实现依赖 Desktop 浏览器；没有执行端时不注册一个调用必然失败的工具。
  if (browser) registry.register(createWebSearchTool(webSearchConfig, webCookiesConfig, browser));
  if (browser || webFetchConfig?.enabled !== false) registry.register(createWebFetchTool(webFetchConfig, webCookiesConfig, { browser, visibleBrowsing: webSearchConfig?.visibleBrowsing }));
  return registry;
}
