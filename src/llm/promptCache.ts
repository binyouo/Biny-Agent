/**
 * Provider 缓存能力与模型请求形状诊断。
 *
 * 这里不实现客户端 KV cache，也不改变 session 的 canonical 消息。它只负责把不同
 * Provider 的缓存字段和真正发出的请求形状归一化，方便 Agent Runtime 判断前缀变化原因。
 */
import { createHash } from "node:crypto";
import { normalizeToolParameters } from "../tools/schema.js";
import type { AgentMessage, AgentTool } from "../agent/core/types.js";
import type { ModelApiBackend } from "../config/schema.js";

const stableTextHashCache = new Map<string, string>();
const stableTextHashCacheLimit = 16;
const toolIdentityIds = new WeakMap<object, number>();
const toolSchemaCache = new WeakMap<readonly AgentTool[], ToolSchemaCacheEntry>();
const messageShapeCache = new WeakMap<object, unknown>();
const messageProjectionCache = new WeakMap<readonly AgentMessage[], MessageProjectionCacheEntry>();
let nextToolIdentityId = 1;

export type PromptCacheMode = "implicit" | "explicit-key" | "breakpoint" | "unknown";

export interface PromptCacheCapability {
  mode: PromptCacheMode;
  cacheReadFields: string[];
  cacheWriteFields: string[];
  cacheMissFields: string[];
  fullInputIncludesCachedTokens?: boolean;
  supportsPromptCacheKey?: boolean;
}

export interface PromptCacheCapabilityInput {
  provider?: string;
  providerAlias?: string;
  modelId: string;
  reasoningProtocol?: string;
  api?: ModelApiBackend;
}

/**
 * 进程内的 prompt 投影缓存。
 *
 * 这里只缓存不可变工具对象对应的排序/schema/hash 元数据，不缓存用户消息、模型答案或
 * KV tensor。它的价值是让同一组工具在每轮重新组装成新数组时，仍能复用规范化结果；容量
 * 有界且按最近使用淘汰，命中只影响旁路组装性能，不影响请求语义。
 */
export class LocalPromptProjectionCache {
  private readonly maxEntries: number;
  private readonly toolSchemas = new Map<string, ToolSchemaCacheEntry>();
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 64));
  }

  getToolSchema(key: string): ToolSchemaCacheEntry | undefined {
    const entry = this.toolSchemas.get(key);
    if (entry === undefined) {
      this.missCount += 1;
      return undefined;
    }
    this.toolSchemas.delete(key);
    this.toolSchemas.set(key, entry);
    this.hitCount += 1;
    return entry;
  }

  setToolSchema(key: string, entry: ToolSchemaCacheEntry): void {
    this.toolSchemas.delete(key);
    this.toolSchemas.set(key, entry);
    while (this.toolSchemas.size > this.maxEntries) {
      const oldest = this.toolSchemas.keys().next().value;
      if (oldest === undefined) break;
      this.toolSchemas.delete(oldest);
      this.evictionCount += 1;
    }
  }

  stats(): LocalPromptProjectionCacheStats {
    return {
      entries: this.toolSchemas.size,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount
    };
  }

  clear(): void {
    this.toolSchemas.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }
}

export interface LocalPromptProjectionCacheStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
}

const defaultLocalPromptProjectionCache = new LocalPromptProjectionCache();

export type PromptPrefixChangeReason =
  | "initial"
  | "provider_changed"
  | "model_changed"
  | "system_changed"
  | "tool_schema_changed"
  | "unchanged";

export type PromptEpochReason =
  | "initial"
  | "compaction"
  | "rewind"
  | "fork"
  | "provider_changed"
  | "model_changed"
  | "tool_schema_changed";

export interface PromptEpoch {
  epochId: string;
  stablePrefixHash: string;
  provider: string;
  model: string;
  reason: PromptEpochReason;
  createdAt: string;
}

export type PromptRequestShapeChangeReason =
  | PromptPrefixChangeReason
  | "provider_options_changed"
  | "history_projection_changed";

export type PromptShapeStatus = "full" | "skipped_due_to_budget";

/**
 * 诊断预算只约束旁路 hash，不约束真实模型请求。超过预算后，同一 epoch 不再重复扫描长历史，
 * 下一次 epoch 变化时重新测量，避免为了追踪命中率持续增加首 token 延迟。
 */
export const promptShapeBudgetMs = 5;

export interface PromptShapeDiagnostic {
  provider: string;
  providerAlias?: string;
  modelId: string;
  stablePrefixHash: string;
  requestShapeHash: string;
  stableSystemHash: string;
  systemPromptHash: string;
  toolSchemaHash: string;
  providerOptionsHash: string;
  historyProjectionHash: string;
  epochId: string;
  epoch: PromptEpoch;
  epochReason: PromptEpochReason;
  epochCreatedAt: string;
  prefixChangeReason: PromptPrefixChangeReason;
  requestShapeChangeReason: PromptRequestShapeChangeReason;
}

export interface PromptShapeInput {
  provider: string;
  providerAlias?: string;
  modelId: string;
  stableSystemPrompt: string;
  systemPrompt?: string;
  tools: readonly AgentTool[];
  messages: readonly AgentMessage[];
  providerOptions?: Record<string, unknown>;
  promptEpoch?: number;
  promptEpochReason?: PromptEpochReason;
  promptEpochCreatedAt?: string;
  localPromptCache?: LocalPromptProjectionCache;
}

export function promptCacheCapability(input: PromptCacheCapabilityInput): PromptCacheCapability {
  const identity = [input.provider, input.providerAlias, input.modelId, input.reasoningProtocol]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (input.provider === "openai" && (input.api === "chat_completions" || input.api === "responses")) {
    return {
      mode: "implicit",
      cacheReadFields: ["prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens"],
      cacheWriteFields: ["prompt_tokens_details.cache_write_tokens", "input_tokens_details.cache_write_tokens"],
      cacheMissFields: [],
      fullInputIncludesCachedTokens: true,
      supportsPromptCacheKey: true
    };
  }

  if (input.api === "google_generative_ai" || input.provider === "google-native" || input.provider === "gemini" || input.reasoningProtocol === "google") {
    return {
      mode: "implicit",
      cacheReadFields: ["usageMetadata.total_cached_tokens", "usageMetadata.cachedContentTokenCount"],
      cacheWriteFields: [],
      cacheMissFields: [],
      fullInputIncludesCachedTokens: true,
      supportsPromptCacheKey: false
    };
  }

  if (input.reasoningProtocol === "moonshotai" || /kimi|moonshot/u.test(identity)) {
    return {
      mode: "explicit-key",
      cacheReadFields: ["cached_tokens"],
      cacheWriteFields: [],
      cacheMissFields: ["prompt_cache_miss_tokens"],
      fullInputIncludesCachedTokens: true,
      supportsPromptCacheKey: true
    };
  }

  if (input.reasoningProtocol === "deepseek" || /deepseek/u.test(identity)) {
    return {
      mode: "implicit",
      cacheReadFields: ["prompt_cache_hit_tokens"],
      cacheWriteFields: ["prompt_cache_write_tokens"],
      cacheMissFields: ["prompt_cache_miss_tokens"],
      fullInputIncludesCachedTokens: true,
      supportsPromptCacheKey: false
    };
  }

  if (/glm|zhipu|bigmodel/u.test(identity)) {
    return {
      mode: "implicit",
      cacheReadFields: ["prompt_tokens_details.cached_tokens"],
      cacheWriteFields: ["prompt_tokens_details.cache_write_tokens"],
      cacheMissFields: ["prompt_cache_miss_tokens"],
      fullInputIncludesCachedTokens: true,
      supportsPromptCacheKey: false
    };
  }

  return {
    mode: "unknown",
    cacheReadFields: [],
    cacheWriteFields: [],
    cacheMissFields: [],
    supportsPromptCacheKey: false
  };
}

export function computePromptShapeDiagnostic(
  input: PromptShapeInput,
  previous: PromptShapeDiagnostic | undefined
): PromptShapeDiagnostic {
  const stableSystemHash = stableTextHash(input.stableSystemPrompt);
  const systemPromptHash = stableTextHash(input.systemPrompt ?? "");
  const toolSchemaHash = canonicalToolSchemaHash(input.tools, input.localPromptCache);
  const providerOptionsHash = stableHash(input.providerOptions ?? {});
  const historyProjectionHash = messageProjectionHash(input.messages);
  const stablePrefixHash = stableHash({
    provider: input.provider,
    providerAlias: input.providerAlias,
    modelId: input.modelId,
    stableSystemHash,
    toolSchemaHash
  });
  const requestShapeHash = stableHash({
    provider: input.provider,
    providerAlias: input.providerAlias,
    modelId: input.modelId,
    systemPromptHash,
    toolSchemaHash,
    historyProjectionHash,
    providerOptionsHash
  });
  const prefixChangeReason = prefixReason(input, stableSystemHash, toolSchemaHash, previous);
  const requestShapeChangeReason = requestReason(
    prefixChangeReason,
    providerOptionsHash,
    historyProjectionHash,
    previous
  );
  const promptEpoch = input.promptEpoch ?? 0;
  const epochReason = input.promptEpochReason
    ?? previous?.epochReason
    ?? epochReasonFromPrefixChange(prefixChangeReason);
  const epochCreatedAt = input.promptEpochCreatedAt
    ?? previous?.epochCreatedAt
    ?? new Date().toISOString();
  const epochId = `${String(promptEpoch)}-${stablePrefixHash.slice(0, 16)}`;

  return {
    provider: input.provider,
    providerAlias: input.providerAlias,
    modelId: input.modelId,
    stablePrefixHash,
    requestShapeHash,
    stableSystemHash,
    systemPromptHash,
    toolSchemaHash,
    providerOptionsHash,
    historyProjectionHash,
    epochId,
    epoch: {
      epochId,
      stablePrefixHash,
      provider: input.provider,
      model: input.modelId,
      reason: epochReason,
      createdAt: epochCreatedAt
    },
    epochReason,
    epochCreatedAt,
    prefixChangeReason,
    requestShapeChangeReason
  };
}

export function canonicalToolSchemas(
  tools: readonly AgentTool[],
  localPromptCache = defaultLocalPromptProjectionCache
): unknown[] {
  return getToolSchemaCache(tools, localPromptCache).schemas;
}

export function canonicalToolSchemaHash(
  tools: readonly AgentTool[],
  localPromptCache = defaultLocalPromptProjectionCache
): string {
  return getToolSchemaCache(tools, localPromptCache).hash;
}

/** Provider 请求中的工具数组也必须与 hash 使用同一排序，避免无语义的顺序变化破坏前缀。 */
export function stableAgentTools(
  tools: readonly AgentTool[],
  localPromptCache = defaultLocalPromptProjectionCache
): AgentTool[] {
  return getToolSchemaCache(tools, localPromptCache).sorted;
}

function getToolSchemaCache(
  tools: readonly AgentTool[],
  localPromptCache: LocalPromptProjectionCache
): ToolSchemaCacheEntry {
  const fingerprint = toolFingerprint(tools);
  const cached = toolSchemaCache.get(tools);
  if (cached?.fingerprint === fingerprint) return cached;
  const sharedKey = toolSetFingerprint(tools);
  const shared = localPromptCache.getToolSchema(sharedKey);
  if (shared !== undefined) {
    const entry = { ...shared, fingerprint };
    toolSchemaCache.set(tools, entry);
    return entry;
  }
  const sorted = tools.map((tool) => ({
    ...tool,
    parameters: normalizeToolParameters(tool.name, tool.parameters)
  })).sort((left, right) => {
    const nameOrder = stableCompare(left.name, right.name);
    if (nameOrder !== 0) return nameOrder;
    return stableCompare(stableStringify({
      name: left.name,
      description: left.description,
      parameters: left.parameters
    }), stableStringify({
      name: right.name,
      description: right.description,
      parameters: right.parameters
    }));
  });
  const schemas = sorted.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  const entry: ToolSchemaCacheEntry = {
    fingerprint,
    sorted,
    schemas,
    hash: stableHash(schemas)
  };
  toolSchemaCache.set(tools, entry);
  localPromptCache.setToolSchema(sharedKey, entry);
  return entry;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function prefixReason(
  input: PromptShapeInput,
  stableSystemHash: string,
  toolSchemaHash: string,
  previous: PromptShapeDiagnostic | undefined
): PromptPrefixChangeReason {
  if (!previous) return "initial";
  if (input.provider !== previous.provider || input.providerAlias !== previous.providerAlias) return "provider_changed";
  if (input.modelId !== previous.modelId) return "model_changed";
  if (previous.stableSystemHash !== stableSystemHash) return "system_changed";
  if (previous.toolSchemaHash !== toolSchemaHash) return "tool_schema_changed";
  return "unchanged";
}

function requestReason(
  prefixChangeReason: PromptPrefixChangeReason,
  providerOptionsHash: string,
  historyProjectionHash: string,
  previous: PromptShapeDiagnostic | undefined
): PromptRequestShapeChangeReason {
  if (!previous) return "initial";
  if (prefixChangeReason !== "unchanged") return prefixChangeReason;
  if (previous.providerOptionsHash !== providerOptionsHash) return "provider_options_changed";
  if (previous.historyProjectionHash !== historyProjectionHash) return "history_projection_changed";
  return "unchanged";
}

function epochReasonFromPrefixChange(reason: PromptPrefixChangeReason): PromptEpochReason {
  if (reason === "provider_changed") return "provider_changed";
  if (reason === "model_changed") return "model_changed";
  if (reason === "tool_schema_changed") return "tool_schema_changed";
  if (reason === "system_changed") return "rewind";
  return "initial";
}

function messageShape(message: AgentMessage): unknown {
  const cached = messageShapeCache.get(message);
  if (cached !== undefined) return cached;
  const shape = createMessageShape(message);
  messageShapeCache.set(message, shape);
  return shape;
}

function createMessageShape(message: AgentMessage): unknown {
  if (message.role === "user") return { role: message.role, content: message.content };
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (part.type === "text" || part.type === "reasoning") return { type: part.type, text: part.text };
        return { type: part.type, id: part.id, name: part.name, arguments: part.arguments };
      })
    };
  }
  return {
    role: message.role,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError
  };
}

function messageProjectionHash(messages: readonly AgentMessage[]): string {
  const cached = messageProjectionCache.get(messages);
  if (
    cached !== undefined
    && cached.length <= messages.length
    && (cached.length === 0 || cached.lastMessage === messages[cached.length - 1])
  ) {
    const openHash = cached.openHash.copy();
    for (let index = cached.length; index < messages.length; index += 1) {
      if (index > 0) openHash.update(",");
      openHash.update(stableStringify(messageShape(messages[index]!)));
    }
    const next = {
      length: messages.length,
      lastMessage: messages.at(-1),
      openHash
    };
    messageProjectionCache.set(messages, next);
    return openHash.copy().update("]").digest("hex");
  }

  const openHash = createHash("sha256").update("[");
  for (const [index, message] of messages.entries()) {
    if (index > 0) openHash.update(",");
    openHash.update(stableStringify(messageShape(message)));
  }
  messageProjectionCache.set(messages, {
    length: messages.length,
    lastMessage: messages.at(-1),
    openHash
  });
  return openHash.copy().update("]").digest("hex");
}

function toolFingerprint(tools: readonly AgentTool[]): string {
  return tools.map((tool) => String(toolIdentityId(tool))).join(",");
}

function toolSetFingerprint(tools: readonly AgentTool[]): string {
  return tools.map((tool) => toolIdentityId(tool)).sort((left, right) => left - right).join(",");
}

function toolIdentityId(tool: AgentTool): number {
  const object = tool as object;
  const existing = toolIdentityIds.get(object);
  if (existing !== undefined) return existing;
  const id = nextToolIdentityId;
  nextToolIdentityId += 1;
  toolIdentityIds.set(object, id);
  return id;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function stableTextHash(value: string): string {
  const cached = stableTextHashCache.get(value);
  if (cached !== undefined) return cached;
  const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (value.length <= 256 * 1024) {
    stableTextHashCache.set(value, hash);
    if (stableTextHashCache.size > stableTextHashCacheLimit) {
      const oldest = stableTextHashCache.keys().next().value;
      if (oldest !== undefined) stableTextHashCache.delete(oldest);
    }
  }
  return hash;
}

function stableCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

interface ToolSchemaCacheEntry {
  fingerprint: string;
  sorted: AgentTool[];
  schemas: unknown[];
  hash: string;
}

interface MessageProjectionCacheEntry {
  length: number;
  lastMessage: AgentMessage | undefined;
  openHash: ReturnType<typeof createHash>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])])
  );
}
