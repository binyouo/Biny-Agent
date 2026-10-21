import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart, SharedV4ProviderMetadata, SharedV4FileData } from "@ai-sdk/provider";
import type { AgentModel, AgentMessage, AgentUsage, AgentAssistantMessage, ModelStreamContext, ModelStreamEvent, ModelStreamOptions, ModelRequestContext } from "../../src/agent/core/types.js";

interface FixtureModel extends Omit<AgentModel, "vercelModel"> {
  stream(context: ModelStreamContext, options?: ModelStreamOptions): Promise<AsyncIterable<ModelStreamEvent>> | AsyncIterable<ModelStreamEvent>;
  vercelModel?: LanguageModelV4;
}

/** Test providers speak the same SDK boundary as configured providers. */
export function testModel<T extends FixtureModel>(fixture: T): T & AgentModel {
  return Object.assign(fixture, { vercelModel: fixtureLanguageModel(fixture) });
}

export function fixtureLanguageModel(fixture: FixtureModel): LanguageModelV4 {
  return {
    specificationVersion: "v4", provider: fixture.provider, modelId: fixture.modelId, supportedUrls: {},
    doGenerate: async () => { throw new Error("Fixture expects a streaming request."); },
    doStream: async options => {
      const source = fixtureParts(await startFixture(fixture, options), options)[Symbol.asyncIterator]();
      return { stream: new ReadableStream({
        async pull(controller) {
          try { const next = await source.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
          catch (error) { controller.enqueue({ type: "error", error }); controller.close(); }
        },
        async cancel() { await source.return?.(undefined); }
      }) };
    }
  };
}

function requestContext(options: LanguageModelV4CallOptions): ModelStreamContext {
  const messages: AgentMessage[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content = message.content.map(part => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        return { type: part.mediaType.startsWith("audio/") ? "audio" as const : "image" as const,
          mimeType: part.mediaType, data: fileData(part.data) };
      });
      messages.push({ role: "user", content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content });
    } else if (message.role === "assistant") {
      messages.push({ role: "assistant", content: message.content.flatMap<AgentAssistantMessage["content"][number]>(part => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "reasoning") return [{ type: "reasoning", text: part.text, providerMetadata: part.providerOptions }];
        if (part.type === "tool-call") return [{ type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: typeof part.input === "string" ? JSON.parse(part.input) : part.input }];
        return [];
      }) as Extract<AgentMessage, { role: "assistant" }>["content"] });
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const output = part.output;
        const isError = output.type === "error-text" || output.type === "error-json" || output.type === "execution-denied";
        let content: Extract<AgentMessage, { role: "toolResult" }>["content"];
        if (output.type === "content") content = output.value.map(value => value.type === "text"
          ? { type: "text", text: value.text }
          : { type: "image", mimeType: "mediaType" in value ? value.mediaType : "image/png", data: "data" in value && value.data.type === "data" ? (typeof value.data.data === "string" ? value.data.data : Buffer.from(value.data.data).toString("base64")) : "" });
        else if (output.type === "execution-denied") content = [{ type: "text", text: output.reason ?? "Execution denied" }];
        else content = [{ type: "text", text: typeof output.value === "string" ? output.value : JSON.stringify(output.value) }];
        if ((output.type === "error-text" || output.type === "error-json") && typeof output.value === "string") {
          try { const value = JSON.parse(output.value); if (Array.isArray(value)) content = value; } catch { /* plain error text */ }
        }
        messages.push({ role: "toolResult", toolCallId: part.toolCallId, toolName: part.toolName, content, isError });
      }
    }
  }
  return {
    systemPrompt: options.prompt.filter(message => message.role === "system").map(message => message.content).join("\n") || undefined,
    messages,
    tools: (options.tools ?? []).filter(tool => tool.type === "function").map(tool => ({
      name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema,
      execute: async () => { throw new Error("Provider fixtures cannot execute tools."); }
    })) as ModelStreamContext["tools"]
  };
}

function fileData(data: SharedV4FileData): string {
  if (data.type === "url") return String(data.url);
  if (data.type === "data") return typeof data.data === "string" ? data.data : Buffer.from(data.data).toString("base64");
  throw new Error(`Fixture does not support ${data.type} file data.`);
}

async function* fixtureParts(source: AsyncIterable<ModelStreamEvent>, options: LanguageModelV4CallOptions): AsyncGenerator<LanguageModelV4StreamPart> {
  yield { type: "stream-start", warnings: [] };
  let textStarted = false;
  const reasoningIds = new Set<string>();
  for await (const event of source) {
    options.abortSignal?.throwIfAborted();
    if (event.type === "text-delta") {
      if (!textStarted) { textStarted = true; yield { type: "text-start", id: "text" }; }
      yield { type: "text-delta", id: "text", delta: event.text };
    } else if (event.type === "reasoning-start" || event.type === "reasoning-delta") {
      if (!reasoningIds.has(event.id)) { reasoningIds.add(event.id); yield { type: "reasoning-start", id: event.id, providerMetadata: event.providerMetadata as SharedV4ProviderMetadata | undefined }; }
      if (event.type === "reasoning-delta") yield { type: "reasoning-delta", id: event.id, delta: event.text, providerMetadata: event.providerMetadata as SharedV4ProviderMetadata | undefined };
    } else if (event.type === "reasoning-end") {
      reasoningIds.delete(event.id); yield { ...event, providerMetadata: event.providerMetadata as SharedV4ProviderMetadata | undefined };
    } else if (event.type === "tool-input-start" || event.type === "tool-input-delta") yield event;
    else if (event.type === "tool-call") yield { type: "tool-call", toolCallId: event.id, toolName: event.name, input: JSON.stringify(event.arguments) };
    else if (event.type === "finish") yield { type: "finish", usage: { ...toVercelUsage(event.usage), raw: event.usage?.cacheMissTokens === undefined ? undefined : { prompt_cache_miss_tokens: event.usage.cacheMissTokens } }, finishReason: toVercelFinishReason(event.reason) };
    else if (event.type === "error") throw event.error;
  }
  if (textStarted) yield { type: "text-end", id: "text" };
  for (const id of reasoningIds) yield { type: "reasoning-end", id };
}

async function startFixture(fixture: FixtureModel, options: LanguageModelV4CallOptions): Promise<AsyncIterable<ModelStreamEvent>> {
  const reasoning = options.reasoning === "none" ? "off" : options.reasoning === "provider-default" ? undefined : options.reasoning;
  return await fixture.stream(requestContext(options), {
    signal: options.abortSignal, maxOutputTokens: options.maxOutputTokens, temperature: options.temperature,
    reasoning: reasoning as ModelStreamOptions["reasoning"], providerOptions: options.providerOptions,
    requestContext: { sessionId: options.headers?.["x-session-id"], operation: options.headers?.["x-biny-operation"] as ModelRequestContext["operation"] }
  });
}

function toVercelUsage(usage: AgentUsage | undefined): {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
  outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined };
} {
  const inputTokens = usage?.inputTokens;
  const cacheRead = usage?.cacheReadTokens;
  const cacheWrite = usage?.cacheWriteTokens;
  const outputTokens = usage?.outputTokens;
  const reasoningTokens = usage?.reasoningTokens;
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens === undefined ? undefined : Math.max(0, inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
      cacheRead,
      cacheWrite
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens === undefined ? undefined : Math.max(0, outputTokens - (reasoningTokens ?? 0)),
      reasoning: reasoningTokens
    }
  };
}

function toVercelFinishReason(reason: AgentAssistantMessage["stopReason"] | undefined): {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  raw: string | undefined;
} {
  const unified = reason === "stop" ? "stop"
    : reason === "length" ? "length"
      : reason === "tool-calls" ? "tool-calls"
        : reason === "error" ? "error"
          : "other";
  return { unified, raw: reason };
}
