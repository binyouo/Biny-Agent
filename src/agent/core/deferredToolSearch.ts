import type { ModelMessage } from "ai";
import { stableHash } from "../../llm/promptCache.js";
import { toolSearchResultNames, toolSearchToolName } from "../../tools/toolSearch.js";
import { normalizeToolParameters } from "../../tools/schema.js";
import type { AgentMessage, AgentModel, AgentTool, AgentToolResult, AgentToolResultMessage } from "./types.js";
import { isRecord } from "./vercelAgentUtils.js";

export function usesChatCompletions(model: AgentModel): boolean {
  const provider = model.vercelModel?.provider;
  return model.providerAlias ? provider === `${model.providerAlias}.chat` : provider?.endsWith(".chat") === true;
}

function definition(tool: AgentTool) {
  return { name: tool.name, description: tool.description, parameters: normalizeToolParameters(tool.name, tool.parameters) };
}

function reviewEntries(message: AgentMessage): Array<[string, string]> {
  if (message.role !== "toolResult" || message.toolName !== toolSearchToolName || message.isError || !isRecord(message.details)) return [];
  if (!Array.isArray(message.details.reviewedTools)) return [];
  return message.details.reviewedTools.flatMap(entry => isRecord(entry) && typeof entry.name === "string" && typeof entry.digest === "string"
    ? [[entry.name, entry.digest] as [string, string]] : []);
}

export function reviewedToolDigests(messages: readonly AgentMessage[]): Map<string, string> {
  return new Map(messages.flatMap(reviewEntries));
}

export function discoveryProtocol(model: AgentModel) {
  if (model.wireProtocol === "anthropic" && /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4-[5-9]|5(?:-[0-9]+)?)(?:-|$)/u.test(model.modelId)) return "anthropic";
  if (model.wireProtocol === "gemini") return "gemini";
  if (model.wireProtocol === "chat" || (!model.wireProtocol && usesChatCompletions(model))) return "chat";
  return undefined;
}

export function deferredArguments(input: Record<string, unknown>, json: boolean): Record<string, unknown> | undefined {
  if (!json) return isRecord(input.arguments) ? input.arguments : undefined;
  if (typeof input.argumentsJson !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(input.argumentsJson);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function anthropicToolReferenceResult(message: AgentToolResultMessage, declarations: ReadonlyMap<string, string>): ModelMessage | undefined {
  const references = reviewEntries(message).filter(([name, digest]) => declarations.get(name) === digest);
  if (!references.length) return undefined;
  return { role: "tool", content: [{ type: "tool-result", toolName: message.toolName, toolCallId: message.toolCallId,
    output: { type: "content", value: references.map(([toolName]) => ({
      type: "custom", providerOptions: { anthropic: { type: "tool-reference", toolName } }
    })) }
  }] };
}

/** 搜索结果携带定义；执行器只接收本步骤准入的工具，并在实际调用时复核历史定义。 */
export function deferredDiscoveryTools(
  tools: AgentTool[], eagerNames: ReadonlySet<string> | undefined, history: () => readonly AgentMessage[],
  resolve: (names: readonly string[]) => AgentTool[], protocol: "chat" | "gemini" | "anthropic", catalog?: AgentTool[]
): AgentTool[] {
  const search = tools.find(tool => tool.name === toolSearchToolName);
  if (!search) return tools;
  const eager = (tool: AgentTool) => (protocol === "anthropic" || tool.name !== "ToolCall") && (!eagerNames || eagerNames.has(tool.name));
  const searchWithDefinitions: AgentTool = {
    ...search, description: protocol === "anthropic" ? search.description : search.description + " Use ToolCall for tools listed in deferredTools.",
    execute: async (...args): Promise<AgentToolResult> => {
      const result = await search.execute(...args);
      if (result.isError) return result;
      const names = toolSearchResultNames(result.details);
      if (!names.length) return result;
      const deferredTools = resolve(names).filter(tool => !eager(tool)).map(definition);
      if (!deferredTools.length) return result;
      const original = result.details as Record<string, unknown>;
      const reviewedTools = deferredTools.map(schema => ({ name: schema.name, digest: stableHash(schema) }));
      return { ...result, details: { ...original, reviewedTools }, content: protocol === "anthropic" ? result.content : [{ type: "text", text: JSON.stringify({ ...original, deferredTools }) }] };
    }
  };
  if (catalog) {
    const admitted = new Map(tools.map(tool => [tool.name, tool]));
    return catalog.map(tool => {
      if (tool.name === toolSearchToolName) return searchWithDefinitions;
      if (eager(tool)) return tool;
      const digest = stableHash(definition(tool));
      const target = admitted.get(tool.name);
      return { ...tool, anthropicDeferredDigest: digest, promptSnippet: target?.promptSnippet, promptGuidelines: target?.promptGuidelines,
        execute: async (...args) => {
          if (!target || reviewedToolDigests(history()).get(tool.name) !== digest) throw new Error("Search for the current tool definition with ToolSearch before calling it.");
          return target.execute(...args);
        } };
    });
  }
  const deferredTarget = (name: string) => tools.find(tool => tool.name === name && !eager(tool));
  const dispatcher: AgentTool = {
    name: "ToolCall", deferredTarget,
    description: "Call a deferred tool using its exact name and arguments from the latest ToolSearch result. Call already declared tools directly.",
    parameters: protocol === "gemini"
      ? { type: "object", properties: { name: { type: "string" }, argumentsJson: { type: "string", description: "JSON object containing the target tool arguments." } }, required: ["name", "argumentsJson"] }
      : { type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["name", "arguments"], additionalProperties: false },
    execute: async (id, input, signal, onUpdate) => {
      const target = typeof input.name === "string" ? deferredTarget(input.name) : undefined;
      if (!target || reviewedToolDigests(history()).get(target.name) !== stableHash(definition(target))) {
        throw new Error("Tool unavailable or its definition has changed. Search for the tool with ToolSearch before calling it.");
      }
      const args = deferredArguments(input, protocol === "gemini");
      if (!args) throw new Error("ToolCall requires a JSON object containing the target arguments.");
      return target.execute(id, args, signal, onUpdate);
    }
  };
  return [...tools.filter(tool => eager(tool) && tool !== search), searchWithDefinitions, dispatcher];
}
