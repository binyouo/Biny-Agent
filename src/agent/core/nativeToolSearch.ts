import type { JSONObject } from "@ai-sdk/provider";
import type { AgentMessage, AgentModel, AgentTool, AgentToolResult } from "./types.js";
import { normalizeToolParameters } from "../../tools/schema.js";
import { toolSearchResultNames } from "../../tools/toolSearch.js";

export type LoadedToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONObject;
  strict: false;
}

export function supportsNativeToolSearch(model: AgentModel): boolean {
  return model.vercelModel?.provider.endsWith(".responses") === true
    && /^gpt-(?:5\.[456](?:-|$)|6(?:[.-]|$))/u.test(model.modelId);
}

export function declaredTools(tools: AgentTool[], messages: AgentMessage[], nativeSearch: boolean): AgentTool[] {
  if (!nativeSearch || !tools.some(tool => tool.name === "ToolSearch")) return tools;
  const loaded = new Set(messages.flatMap(loadedToolSchemas).map(tool => tool.name));
  return tools.filter(tool => !loaded.has(tool.name));
}

export function loadedToolSchemas(message: AgentMessage): LoadedToolSchema[] {
  if (message.role !== "toolResult" || message.toolName !== "ToolSearch" || message.isError) return [];
  const details = message.details as { loadedToolSchemas?: LoadedToolSchema[] } | undefined;
  return Array.isArray(details?.loadedToolSchemas) ? details.loadedToolSchemas : [];
}

/** schema 快照随成功发现结果落盘；执行授权仍由当前 coordinator 检查。 */
export function captureToolSearchSchemas(result: AgentToolResult, messages: AgentMessage[], resolve: (names: readonly string[]) => AgentTool[]): void {
  if (result.isError) return;
  const known = new Map(messages.flatMap(loadedToolSchemas).map(schema => [schema.name, JSON.stringify(schema)]));
  const schemas = resolve(toolSearchResultNames(result.details)).filter(tool => !tool.providerTool).map(tool => ({
    type: "function" as const, name: tool.name, description: tool.description,
    parameters: normalizeToolParameters(tool.name, tool.parameters) as unknown as JSONObject, strict: false as const
  })).filter(schema => known.get(schema.name) !== JSON.stringify(schema));
  result.details = { ...result.details as Record<string, unknown>, loadedToolSchemas: schemas };
}
