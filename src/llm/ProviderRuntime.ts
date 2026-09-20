/**
 * Provider 运行时。
 *
 * 每个配置别名对应一个实例，统一持有服务商默认值、鉴权、模型目录和请求准备逻辑。
 * Provider 只负责把配置解析成 Vercel AI SDK 的 LanguageModel；请求协议由 SDK 统一处理。
 */
import type { AgentModel, CacheMarkerPlan } from "../agent/core/types.js";
import { cacheMarkerPlanFor } from "../agent/core/cacheMarkers.js";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { completeThinkingLevelMap, effectiveThinkingSelection, isKimiAlwaysThinkingModel, isKimiK3Model, modelCapabilities, modelReasoningConfig, modelThinkingLevelMap, nativeReasoningEffort, normalizeModelMetadata, reasoningBudgetTokens, thinkingLevelMapForModel } from "../ai/capabilities.js";
import { fetchModelCatalogSnapshot } from "../ai/modelCatalog.js";
import { accessPathThinkingLevelMap, generatedProviderModels, inferThinkingLevelMap, lookupModelMetadata, metadataProviderForEndpoint, type ModelMetadata } from "../ai/modelMetadata.js";
import { providerDefinition } from "../ai/provider.js";
import type { ModelCatalogEntry, ProviderDefinition } from "../ai/types.js";
import type { AgentConfig, ModelAliasConfig, ModelApiBackend, ModelCompatibility, ModelProfile, ProviderConfig, ThinkingLevelMap } from "../config/schema.js";
import { resolveNativePatchProtocol } from "../tools/file/editingMode.js";
import { createVercelLanguageModel } from "./vercelModel.js";
import { resolveProviderRequestRoute } from "./providerRequest.js";
import { openAiCodexHeaders, refreshSubscriptionOAuthTokens } from "./subscriptionAuth.js";
import { AiRegistry } from "./AiRegistry.js";
import { modelCatalogCacheKey, readProviderCatalog, type ModelsStore } from "./ModelsStore.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";
import {
  listProviderEmbeddingModels,
  ProviderEmbeddingRuntime,
  type EmbeddingModelDescriptor,
  type EmbeddingModelRef,
  type EmbeddingModelRuntime
} from "./embedding/index.js";

const oauthRefreshWindowMs = 5 * 60 * 1_000;

export interface ModelSettings {
  applyPatchProtocol?: "openai-structured";
  model: AgentModel;
  /** 主 Agent 与辅助文本调用共用的 Vercel model；显式注入的测试模型可以没有它。 */
  vercelModel?: LanguageModelV4;
  maxRetries?: number;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | AgentConfig["thinking"]["effort"];
  timeoutMs?: number;
  maxOutputTokens?: number;
  contextWindow: number | undefined;
  /** 按协议生成的 prompt 缓存标记计划；隐式缓存或用户关闭时为 undefined。 */
  cacheMarkers?: CacheMarkerPlan;
}

export interface ProviderRuntime {
  readonly id: string;
  readonly definition: ProviderDefinition;
  readonly config: ProviderConfig;
  getModels(): ModelCatalogEntry[];
  resolveModel(model: ModelAliasConfig): ModelAliasConfig;
  restoreModels(models: readonly ModelCatalogEntry[]): void;
  refreshModels(signal?: AbortSignal, force?: boolean): Promise<ModelCatalogEntry[]>;
  isConfigured(model?: ModelAliasConfig): boolean;
  validate(model?: ModelAliasConfig): void;
  createModelSettings(agentConfig: AgentConfig, model: ModelAliasConfig): ModelSettings;
  refreshCredential(signal?: AbortSignal): Promise<ProviderConfig | undefined>;
  listEmbeddingModels(): EmbeddingModelDescriptor[];
  createEmbeddingRuntime(modelId: string): EmbeddingModelRuntime;
}

export class ConfiguredProviderRuntime implements ProviderRuntime {
  readonly definition: ProviderDefinition;
  private readonly baselineModels: ModelCatalogEntry[];
  private liveModels: ModelCatalogEntry[] = [];

  constructor(
    readonly id: string,
    readonly config: ProviderConfig,
    private readonly ai: AiRegistry,
    baselineModels: readonly ModelCatalogEntry[] = [],
    private readonly modelsStore?: ModelsStore,
    private readonly fetcher: typeof globalThis.fetch = createProxyAwareFetch()
  ) {
    this.definition = providerDefinition(config.type, ai.providers);
    // 协议类型不代表套餐：官方订阅/地区端点使用自身快照，避免继承普通 API 的容量和目录。
    const metadataProvider = metadataProviderForEndpoint(config.baseUrl ?? this.definition.baseUrl ?? "");
    const catalog = metadataProvider && metadataProvider !== config.type
      ? generatedProviderModels(metadataProvider)
      : baselineModels;
    this.baselineModels = catalog.map((model) => ({ ...model, provider: id }));
  }

  getModels(): ModelCatalogEntry[] {
    const models = this.mergedCatalog().map((model) => this.normalizeCatalogEntry(model));
    try {
      const filtered = this.definition.filterModels?.(models, {
        configured: this.isConfigured(),
        authMode: this.config.authMode ?? this.definition.authModes[0]
      }) ?? models;
      return [...filtered].map((model) => ({ ...model }));
    } catch {
      // 一个扩展过滤器异常不能让整个模型菜单消失，退回完整目录。
      return models.map((model) => ({ ...model }));
    }
  }

  listEmbeddingModels(): EmbeddingModelDescriptor[] {
    return listProviderEmbeddingModels(this.id, this.config, this.definition);
  }

  createEmbeddingRuntime(modelId: string): EmbeddingModelRuntime {
    return new ProviderEmbeddingRuntime(this.id, this.config, this.definition, modelId, { fetcher: this.fetcher });
  }

  restoreModels(models: readonly ModelCatalogEntry[]): void {
    // `/models` 与旧缓存都属于不可信元数据源。目录只能补充能力和 token 限制，
    // 不能改变请求地址、鉴权头或 API 协议；这些传输字段只接受用户配置和本地注册基线。
    this.liveModels = models.map((model) => liveCatalogMetadata(model, this.id));
  }

  async refreshModels(signal?: AbortSignal, force = false): Promise<ModelCatalogEntry[]> {
    signal?.throwIfAborted();
    const cached = this.modelsStore === undefined
      ? undefined
      : await readProviderCatalog(this.id, this.config, this.modelsStore);
    let models: readonly ModelCatalogEntry[];
    let etag = cached?.etag;
    let lastModified = cached?.lastModified;
    if (this.definition.fetchModels) {
      models = await this.definition.fetchModels({ providerAlias: this.id, config: this.config, signal, fetcher: this.fetcher });
      etag = undefined;
      lastModified = undefined;
    } else {
      const result = await fetchModelCatalogSnapshot(
        { alias: this.id, config: this.config, definition: this.definition },
        signal,
        force ? {} : { etag: cached?.etag, lastModified: cached?.lastModified },
        this.fetcher
      );
      if (result.notModified && !cached) throw new Error(`Provider ${this.id} returned 304 without a stored model catalog.`);
      models = result.notModified ? cached!.models : result.models ?? [];
      etag = result.etag;
      lastModified = result.lastModified;
    }
    // 空目录既可能表示账号确实没有模型，也可能是服务商响应结构发生了变化。两种情况都
    // 不能覆盖上一份已验证目录，否则一次异常响应就会让全部客户端突然失去模型元数据。
    if (models.length === 0) throw new Error(`Provider ${this.id} returned an empty model catalog.`);
    signal?.throwIfAborted();
    this.restoreModels(models);
    const entry = {
      models: this.liveModels.map((model) => this.normalizeCatalogEntry(model)),
      checkedAt: Date.now(),
      etag,
      lastModified
    };
    const cacheKey = modelCatalogCacheKey(this.id, this.config);
    await this.modelsStore?.write(cacheKey, entry).catch(() => undefined);
    // 旧版 CLI/测试可能仍按 provider alias 读取；运行时优先使用上面的隔离键，
    // 这里保留一份无凭据的镜像，避免升级后旧入口突然看不到刚刷新的目录。
    if (cacheKey !== this.id) await this.modelsStore?.write(this.id, entry).catch(() => undefined);
    return this.getModels();
  }

  isConfigured(model?: ModelAliasConfig): boolean {
    const endpoint = model?.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!endpoint || !isHttpEndpoint(endpoint)) return false;
    if (!(this.config.requiresApiKey ?? this.definition.requiresApiKey)) return true;
    return this.resolveApiKey() !== undefined;
  }

  resolveModel(model: ModelAliasConfig): ModelAliasConfig {
    const endpoint = this.config.baseUrl ?? this.definition.baseUrl;
    // 单模型覆盖端点时，连接原端点的缓存/基线不能跨过去覆盖新路径的限制。
    const usesProviderEndpoint = model.baseUrl === undefined
      || model.baseUrl.replace(/\/+$/u, "") === endpoint?.replace(/\/+$/u, "");
    const catalog = usesProviderEndpoint ? this.mergedCatalog().find((entry) => entry.id === model.model) : undefined;
    const generated = lookupModelMetadata(this.config.type, model.model, model.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl);
    const generatedModel = generated ? metadataToModel(this.id, this.config.type, model.model, generated) : undefined;
    const catalogModel = catalog
      ? catalogEntryToModel(catalog, generated !== undefined || catalog.reasoningEffortsSource === "inferred")
      : undefined;
    const catalogBase = catalogModel && generatedModel
      ? mergeModelMetadata(generatedModel, catalogModel)
      : catalogModel ?? generatedModel;
    // alias 里的能力曾由界面自动保存，不能作为覆盖当前目录的依据。
    // 已知能力以当前目录为准，真正的手动覆盖统一放在 modelProfiles。
    const merged = catalogBase ? mergeModelMetadata(catalogBase, {
      ...model,
      capabilities: mergeCatalogCapabilities(catalogBase.capabilities, model.capabilities),
      supportsTools: catalogBase.capabilities?.tools ?? model.supportsTools
    }) : model;
    // 旧默认配置把完整能力压缩成 off/high/max，并同时保存了两档 reasoning；只修复这
    // 个可识别的旧形状。profile 是用户显式覆盖，后续仍按原样保留，不能被自动补全覆盖。
    const compactReasoning = merged.reasoning?.efforts.length === 2
      && merged.reasoning.efforts[0] === "high"
      && merged.reasoning.efforts[1] === "max"
      && Object.keys(merged.thinkingLevelMap ?? {}).filter((level) => level !== "off").sort().join(",") === "high,max";
    const healed = compactReasoning && merged.thinkingLevelMap
      ? {
        ...merged,
        thinkingLevelMap: completeThinkingLevelMap(merged.thinkingLevelMap, !isKimiAlwaysThinkingModel(merged.model))
      }
      : merged;
    const profile = this.config.modelProfiles?.[model.model];
    const profiled = profile === undefined ? healed : applyModelProfile(healed, profile);
    const accessPathModel = recoverKnownReasoningModel(profiled, generatedModel, profile?.thinkingLevelMap !== undefined || profile?.capabilities?.reasoning === false);
    return normalizeModelMetadata(
      { ...accessPathModel, compatibility: mergeCompatibility(this.config.compatibility, accessPathModel.compatibility) },
      this.definition.modelDefaults
    );
  }

  validate(model?: ModelAliasConfig): void {
    const endpoint = model?.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!endpoint) throw new Error(`No model endpoint configured. Set providers.${this.id}.baseUrl.`);
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error(`Invalid model endpoint for provider ${this.id}: ${endpoint}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Model endpoint for provider ${this.id} must use http:// or https://.`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`Model endpoint for provider ${this.id} must not contain credentials in the URL.`);
    }
    if ((this.config.requiresApiKey ?? this.definition.requiresApiKey) && !this.resolveApiKey()) {
      throw new Error(missingKeyMessage(this.id, this.config.apiKeyEnv, this.definition.apiKeyEnv));
    }
  }

  createModelSettings(agentConfig: AgentConfig, model: ModelAliasConfig): ModelSettings {
    const normalizedModel = this.resolveModel(model);
    this.validate(normalizedModel);
    const apiKey = this.resolveApiKey();
    const baseUrl = normalizedModel.baseUrl ?? this.config.baseUrl ?? this.definition.baseUrl;
    if (!baseUrl) throw new Error(`No model endpoint configured. Set providers.${this.id}.baseUrl.`);
    const route = resolveProviderRequestRoute(normalizedModel, this.config, this.definition);
    const { apiBackend: api, protocol } = route;
    const reasoningProtocol = this.definition.reasoningProtocol
      ?? (protocol === "anthropic" || api === "anthropic_messages"
        ? "anthropic"
        : protocol === "openai-compatible" || api === "responses" ? "openai" : undefined);
    const compatibility = normalizedModel.compatibility;
    const capabilities = modelCapabilities(normalizedModel);
    const selection = effectiveThinkingSelection(normalizedModel, agentConfig.thinking);
    const enabled = selection !== "off";
    const effort = enabled ? selection : undefined;
    const retry = this.config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
    const providerOptions = createProviderOptions(reasoningProtocol, this.config, normalizedModel, api, enabled, effort);
    const headers = {
      ...(this.config.type === "openai-codex" ? openAiCodexHeaders(apiKey) : {}),
      ...this.config.headers,
      ...normalizedModel.headers
    };

    const vercelModel = createVercelLanguageModel({
      providerAlias: this.id,
      providerType: this.config.type,
      authMode: this.config.authMode,
      api,
      modelId: normalizedModel.model,
      supportsReasoning: capabilities.reasoning,
      compatibility,
      baseUrl,
      apiKey,
      headers,
      fetcher: this.fetcher
    });
    const executable: AgentModel = {
      provider: this.config.type,
      providerAlias: this.id,
      modelId: normalizedModel.model,
      runtime: "provider",
      dataResidency: normalizedModel.dataResidency ?? this.config.dataResidency,
      supportsTools: capabilities.tools,
      vercelModel,
      vercelOptions: {
        providerOptions,
        maxOutputTokens: normalizedModel.maxOutputTokens,
        timeoutMs: this.config.timeoutMs,
        maxRetries: Math.max(0, retry.maxAttempts - 1)
      }
    };
    return {
      model: executable,
      applyPatchProtocol: resolveNativePatchProtocol(api, baseUrl, normalizedModel.model, this.config.applyPatchProtocol),
      vercelModel,
      maxRetries: Math.max(0, retry.maxAttempts - 1),
      providerOptions,
      reasoning: selection,
      timeoutMs: this.config.timeoutMs,
      maxOutputTokens: normalizedModel.maxOutputTokens,
      contextWindow: normalizedModel.contextWindow,
      cacheMarkers: agentConfig.chat.cacheMarkers ? cacheMarkerPlanFor(api) : undefined
    };
  }

  async refreshCredential(signal?: AbortSignal): Promise<ProviderConfig | undefined> {
    const oauth = this.config.oauth;
    if (
      this.config.authMode !== "oauth-bearer"
      || !oauth?.refreshToken
      || oauth.expiresAt - Date.now() > oauthRefreshWindowMs
    ) return undefined;
    const extensionHandler = this.ai.credentialHandler(oauth.provider);
    if (extensionHandler) return await extensionHandler(this.config, signal);
    if (oauth.provider !== "claude-code" && oauth.provider !== "openai-codex") {
      throw new Error(`No credential refresh handler registered for ${oauth.provider}.`);
    }
    const refreshed = await refreshSubscriptionOAuthTokens(oauth.provider, {
      accessToken: this.config.apiKey ?? "",
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      accountId: oauth.accountId
    }, signal, this.fetcher);
    return {
      ...this.config,
      apiKey: refreshed.accessToken,
      oauth: {
        provider: oauth.provider,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        accountId: refreshed.accountId
      }
    };
  }

  private resolveApiKey(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    const envName = this.config.apiKeyEnv ?? this.definition.apiKeyEnv;
    return envName ? process.env[envName] : undefined;
  }

  private normalizeCatalogEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
    const generated = lookupModelMetadata(this.config.type, entry.id, this.config.baseUrl ?? this.definition.baseUrl);
    const model = catalogEntryToModel(entry, generated !== undefined || entry.reasoningEffortsSource === "inferred");
    const generatedModel = generated ? metadataToModel(this.id, this.config.type, entry.id, generated) : undefined;
    const metadataModel = generatedModel ? mergeModelMetadata(generatedModel, model) : model;
    // 目录与缓存只保存自动元数据，不能混入用户覆盖后再被当成自动基准。
    const accessPathModel = recoverKnownReasoningModel(metadataModel, generatedModel);
    const normalized = normalizeModelMetadata(accessPathModel, this.definition.modelDefaults);
    const reasoning = modelReasoningConfig(normalized);
    return {
      ...entry,
      id: normalized.model,
      displayName: normalized.displayName ?? normalized.model,
      provider: this.id,
      contextWindow: normalized.contextWindow,
      maxInputTokens: normalized.maxInputTokens,
      maxOutputTokens: normalized.maxOutputTokens,
      limits: normalized.limits,
      capabilities: modelCapabilities(normalized),
      reasoningEfforts: reasoning?.efforts ?? [],
      reasoningEffortsSource: entry.reasoningEffortsSource,
      thinkingLevelMap: modelThinkingLevelMap(normalized),
      apiBackend: normalized.apiBackend,
      baseUrl: normalized.baseUrl,
      headers: normalized.headers,
      compatibility: normalized.compatibility
    };
  }

  private mergedCatalog(): ModelCatalogEntry[] {
    const combined = new Map((this.config.type === "openai-codex" && this.liveModels.length
      ? this.liveModels
      : this.baselineModels).map((model) => [model.id, model]));
    for (const model of this.liveModels) {
      const existing = combined.get(model.id);
      // mergeCatalogMetadata 的 base 参数优先；把实时目录放在 base，确保它覆盖静态
      // models.dev/内置元数据，而本地 transport 字段仍由静态基线保留。
      combined.set(model.id, existing ? mergeCatalogMetadata(model, existing) : model);
    }
    return [...combined.values()];
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRuntime>();

  constructor(
    private readonly config: AgentConfig,
    catalogs: readonly [string, ModelCatalogEntry[]][] = [],
    private readonly ai: AiRegistry = new AiRegistry(),
    modelsStore?: ModelsStore,
    private readonly fetcher: typeof globalThis.fetch = createProxyAwareFetch()
  ) {
    for (const [id, provider] of Object.entries(config.providers)) {
      const registration = ai.providers.get(provider.type);
      this.providers.set(id, new ConfiguredProviderRuntime(id, provider, ai, registration?.models, modelsStore, fetcher));
    }
    for (const [id, models] of catalogs) this.providers.get(id)?.restoreModels(models);
  }

  get(id: string): ProviderRuntime | undefined {
    return this.providers.get(id);
  }

  require(id: string): ProviderRuntime {
    const provider = this.get(id);
    if (!provider) throw new Error(`Unknown provider alias: ${id}`);
    return provider;
  }

  forModel(alias: string): { provider: ProviderRuntime; model: ModelAliasConfig } {
    const model = this.config.models[alias];
    if (!model) throw new Error(`Unknown model alias: ${alias}`);
    const provider = this.require(model.provider);
    return { provider, model: provider.resolveModel(model) };
  }

  createModelSettings(alias = this.config.defaultModel): ModelSettings {
    const { provider, model } = this.forModel(alias);
    return provider.createModelSettings(this.config, model);
  }

  listEmbeddingModels(): EmbeddingModelDescriptor[] {
    return [...this.providers.values()].flatMap((provider) => provider.listEmbeddingModels());
  }

  createEmbeddingRuntime(ref: Extract<EmbeddingModelRef, { kind: "provider" }>): EmbeddingModelRuntime {
    return this.require(ref.provider).createEmbeddingRuntime(ref.model);
  }

  validate(alias = this.config.defaultModel): void {
    const { provider, model } = this.forModel(alias);
    provider.validate(model);
  }

  async refreshModels(id: string, signal?: AbortSignal, force = false): Promise<ModelCatalogEntry[]> {
    return await this.require(id).refreshModels(signal, force);
  }

  catalogsSnapshot(): Array<[string, ModelCatalogEntry[]]> {
    return [...this.providers].flatMap(([id, provider]) => {
      const models = provider.getModels();
      return models.length ? [[id, models] as [string, ModelCatalogEntry[]]] : [];
    });
  }
}

function missingKeyMessage(providerAlias: string, configuredEnv: string | undefined, defaultEnv: string | undefined): string {
  const envName = configuredEnv ?? defaultEnv;
  const credentialHint = process.platform === "darwin"
    ? `macOS Keychain 中的 provider:${providerAlias}:apiKey 或 ${envName ?? "配置的环境变量"}`
    : (envName ?? `providers.${providerAlias}.apiKeyEnv 环境变量`);
  return `No model available. Set ${credentialHint}.`;
}

function mergeCompatibility(provider: ModelCompatibility | undefined, model: ModelCompatibility | undefined): ModelCompatibility | undefined {
  if (!provider && !model) return undefined;
  return { ...provider, ...model };
}

function createProviderOptions(
  reasoningProtocol: ProviderDefinition["reasoningProtocol"],
  provider: ProviderConfig,
  model: ModelAliasConfig,
  api: ModelApiBackend,
  enabled: boolean,
  effort: AgentConfig["thinking"]["effort"] | undefined
): Record<string, unknown> | undefined {
  if (mergeCompatibility(provider.compatibility, model.compatibility)?.supportsReasoning === false) return undefined;
  if (!modelCapabilities(model).reasoning || modelReasoningConfig(model) === undefined) return undefined;
  const nativeEffort = effort === undefined ? undefined : nativeReasoningEffort(model, effort);
  const budgetTokens = effort === undefined ? 4_096 : reasoningBudgetTokens(model, effort);
  if (api === "anthropic_messages" || reasoningProtocol === "anthropic") {
    return { anthropic: { thinking: enabled ? { type: "enabled", budgetTokens } : { type: "disabled" } } };
  }
  if (reasoningProtocol === "deepseek") return { deepseek: { thinking: { type: enabled ? "enabled" : "disabled" }, reasoningEffort: enabled ? nativeEffort : undefined } };
  if (reasoningProtocol === "openai") return { openai: { reasoningEffort: enabled ? nativeEffort : "none" } };
  if (reasoningProtocol === "google") {
    return {
      google: {
        reasoningEffort: enabled ? nativeEffort : "none",
        thinkingBudget: enabled ? budgetTokens : 0,
        includeThoughts: enabled
      }
    };
  }
  if (reasoningProtocol === "alibaba") return { alibaba: { enableThinking: enabled, thinkingBudget: enabled ? budgetTokens : undefined } };
  if (reasoningProtocol === "moonshotai") {
    if (isKimiAlwaysThinkingModel(model.model) && !isKimiK3Model(model.model)) {
      return { moonshotai: { thinking: { type: "enabled" } } };
    }
    if (modelThinkingLevelMap(model).off === undefined) {
      return { moonshotai: { reasoningEffort: enabled ? nativeEffort ?? "high" : "low" } };
    }
    return { moonshotai: { thinking: { type: enabled ? "enabled" : "disabled" } } };
  }
  return undefined;
}

function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}


/**
 * 恢复「其实是推理家族、但目录没给出任何推理信息」的模型的 canonical 档位。
 *
 * 触发条件是目录对该模型完全沉默：既没有声明任何 effort，也没有可用的 thinkingLevelMap。
 * 此时即便目录误标了 `reasoning: false`（OpenCode Zen/Go 和不少自定义 OpenAI 兼容 relay 对托管
 * 模型都这么做），也不能当作「显式不支持」——真正显式的信号是目录列出了具体 efforts，那条路径
 * 不会走到这里。对沉默的目录按模型 ID / 生成快照推断档位；推断不出（未知模型）则原样返回，
 * 维持保守关闭。恢复仅补充「开启档」，不改动「关闭档」，所以不会破坏原有关闭行为。
 */
function recoverKnownReasoningModel(
  model: ModelAliasConfig,
  generatedModel: ModelAliasConfig | undefined,
  hasExplicitThinkingLevelMap = false
): ModelAliasConfig {
  if (hasExplicitThinkingLevelMap) return model;
  const hasThinkingLevels = Object.entries(model.thinkingLevelMap ?? {})
    .some(([level, native]) => level !== "off" && native !== null);
  if (hasThinkingLevels) return model;
  const thinkingLevelMap = inferThinkingLevelMap(model.model, generatedModel?.thinkingLevelMap);
  if (!thinkingLevelMap) return model;
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      reasoning: true,
      reasoningStream: generatedModel?.capabilities?.reasoningStream ?? true,
      reasoningSummary: generatedModel?.capabilities?.reasoningSummary
    },
    thinkingLevelMap
  };
}

function applyModelProfile(model: ModelAliasConfig, profile: ModelProfile): ModelAliasConfig {
  const thinkingLevelMap = profile.thinkingLevelMap;
  const hasEnabledThinkingLevel = thinkingLevelMap !== undefined
    && Object.entries(thinkingLevelMap).some(([level, native]) => level !== "off" && native !== null);
  const disablesThinking = thinkingLevelMap !== undefined
    && !hasEnabledThinkingLevel;
  return mergeModelMetadata(model, {
    provider: model.provider,
    model: model.model,
    contextWindow: profile.contextWindow,
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,
    thinkingLevelMap,
    // profile 是最低层目录和旧 alias 之后的最终用户声明；有可用档位时必须解除
    // 低优先级来源的 reasoning:false，否则 map 虽然保存了，实际请求仍永远不会带思考参数。
    capabilities: {
      ...profile.capabilities,
      reasoning: profile.capabilities?.reasoning ?? (thinkingLevelMap === undefined ? undefined : !disablesThinking),
      reasoningStream: disablesThinking ? false : profile.capabilities?.reasoningStream,
      reasoningSummary: disablesThinking ? false : profile.capabilities?.reasoningSummary
    }
  });
}

function catalogEntryToModel(entry: ModelCatalogEntry, preferGeneratedReasoning = false): ModelAliasConfig {
  const thinkingLevelMap = preferGeneratedReasoning && entry.reasoningEffortsSource === "inferred"
    ? undefined
    : entry.thinkingLevelMap
      ? completeThinkingLevelMap(entry.thinkingLevelMap, !isKimiAlwaysThinkingModel(entry.id))
      : entry.reasoningEfforts.length ? thinkingLevelMapForModel(entry.id, true, entry.reasoningEfforts) : undefined;
  return {
    provider: entry.provider,
    model: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    capabilities: entry.capabilities,
    contextWindow: entry.contextWindow,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    limits: entry.limits,
    apiBackend: entry.apiBackend,
    baseUrl: entry.baseUrl,
    headers: entry.headers,
    compatibility: entry.compatibility,
    thinkingLevelMap,
    pricing: entry.pricing
  };
}

function metadataToModel(provider: string, providerType: string, modelId: string, metadata: ModelMetadata): ModelAliasConfig {
  const thinkingLevelMap = accessPathThinkingLevelMap(providerType, modelId)
    ?? (metadata.thinkingLevelMap
    ? completeThinkingLevelMap(metadata.thinkingLevelMap, !isKimiAlwaysThinkingModel(modelId))
    : metadata.reasoningEfforts.length ? thinkingLevelMapForModel(modelId, true, metadata.reasoningEfforts) : undefined);
  return {
    provider,
    model: modelId,
    displayName: metadata.displayName,
    description: metadata.description,
    capabilities: metadata.capabilities,
    contextWindow: metadata.contextWindow,
    maxInputTokens: metadata.maxInputTokens,
    maxOutputTokens: metadata.maxOutputTokens,
    thinkingLevelMap,
    pricing: metadata.pricing
  };
}

function liveCatalogMetadata(entry: ModelCatalogEntry, provider: string): ModelCatalogEntry {
  return {
    id: entry.id,
    displayName: entry.displayName,
    provider,
    description: entry.description,
    showInPicker: entry.showInPicker,
    contextWindow: entry.contextWindow,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    limits: entry.limits ? { ...entry.limits } : undefined,
    capabilities: { ...entry.capabilities },
    reasoningEfforts: [...entry.reasoningEfforts],
    reasoningEffortsSource: entry.reasoningEffortsSource,
    thinkingLevelMap: entry.thinkingLevelMap ? { ...entry.thinkingLevelMap } : undefined,
    apiBackend: undefined,
    baseUrl: undefined,
    headers: undefined,
    compatibility: undefined,
    pricing: entry.pricing ? { ...entry.pricing } : undefined
  };
}

function mergeCatalogMetadata(base: ModelCatalogEntry, overlay: ModelCatalogEntry): ModelCatalogEntry {
  const useBaseReasoning = base.reasoningEffortsSource !== undefined || base.reasoningEfforts.length > 0;
  return {
    ...overlay,
    ...base,
    displayName: base.displayName || overlay.displayName,
    description: base.description ?? overlay.description,
    contextWindow: base.contextWindow ?? overlay.contextWindow,
    maxInputTokens: base.maxInputTokens ?? overlay.maxInputTokens,
    maxOutputTokens: base.maxOutputTokens ?? overlay.maxOutputTokens,
    limits: mergeCatalogLimits(base.limits, overlay.limits),
    capabilities: mergeCatalogCapabilities(base.capabilities, overlay.capabilities),
    reasoningEfforts: useBaseReasoning ? base.reasoningEfforts : overlay.reasoningEfforts,
    reasoningEffortsSource: useBaseReasoning ? base.reasoningEffortsSource : overlay.reasoningEffortsSource,
    thinkingLevelMap: base.thinkingLevelMap ?? overlay.thinkingLevelMap,
    apiBackend: base.apiBackend ?? overlay.apiBackend,
    baseUrl: base.baseUrl ?? overlay.baseUrl,
    headers: mergeHeaders(base.headers, overlay.headers),
    compatibility: mergeCompatibility(overlay.compatibility, base.compatibility),
    pricing: mergePricing(base.pricing, overlay.pricing)
  };
}

function mergeModelMetadata(base: ModelAliasConfig, override: ModelAliasConfig): ModelAliasConfig {
  const thinkingLevelMap = override.thinkingLevelMap
    ?? (override.reasoning ? reasoningConfigThinkingLevelMap(override.reasoning, base.thinkingLevelMap) : base.thinkingLevelMap);
  return {
    ...base,
    ...override,
    displayName: override.displayName ?? base.displayName,
    description: override.description ?? base.description,
    supportsTools: override.supportsTools ?? base.supportsTools,
    capabilities: mergeUserCapabilities(base.capabilities, override.capabilities),
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxInputTokens: override.maxInputTokens ?? base.maxInputTokens,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    limits: mergeUserLimits(base.limits, override.limits),
    thinkingLevelMap,
    reasoning: override.reasoning ?? base.reasoning,
    apiBackend: override.apiBackend ?? base.apiBackend,
    baseUrl: override.baseUrl ?? base.baseUrl,
    headers: mergeHeaders(override.headers, base.headers),
    compatibility: mergeCompatibility(base.compatibility, override.compatibility),
    pricing: override.pricing ?? base.pricing
  };
}

function reasoningConfigThinkingLevelMap(
  reasoning: NonNullable<ModelAliasConfig["reasoning"]>,
  base: ThinkingLevelMap | undefined
): ThinkingLevelMap {
  return {
    ...(base?.off !== undefined ? { off: base.off } : {}),
    ...Object.fromEntries(reasoning.efforts.map((effort) => [effort, reasoning.mapping?.[effort] ?? effort]))
  };
}

function mergePricing(
  base: ModelCatalogEntry["pricing"],
  overlay: ModelCatalogEntry["pricing"]
): ModelCatalogEntry["pricing"] {
  if (!base && !overlay) return undefined;
  return {
    inputPerMillionTokens: base?.inputPerMillionTokens ?? overlay?.inputPerMillionTokens,
    outputPerMillionTokens: base?.outputPerMillionTokens ?? overlay?.outputPerMillionTokens,
    cacheReadPerMillionTokens: base?.cacheReadPerMillionTokens ?? overlay?.cacheReadPerMillionTokens,
    cacheWritePerMillionTokens: base?.cacheWritePerMillionTokens ?? overlay?.cacheWritePerMillionTokens
  };
}

function mergeCatalogCapabilities(
  base: ModelAliasConfig["capabilities"],
  override: ModelAliasConfig["capabilities"]
): NonNullable<ModelAliasConfig["capabilities"]> {
  return {
    tools: base?.tools ?? override?.tools,
    parallelToolCalls: base?.parallelToolCalls ?? override?.parallelToolCalls,
    reasoning: base?.reasoning ?? override?.reasoning,
    reasoningStream: base?.reasoningStream ?? override?.reasoningStream,
    reasoningSummary: base?.reasoningSummary ?? override?.reasoningSummary,
    vision: base?.vision ?? override?.vision,
    audio: base?.audio ?? override?.audio,
    streaming: base?.streaming ?? override?.streaming
  };
}

function mergeUserCapabilities(
  base: ModelAliasConfig["capabilities"],
  override: ModelAliasConfig["capabilities"]
): NonNullable<ModelAliasConfig["capabilities"]> {
  return {
    tools: override?.tools ?? base?.tools,
    parallelToolCalls: override?.parallelToolCalls ?? base?.parallelToolCalls,
    reasoning: override?.reasoning ?? base?.reasoning,
    reasoningStream: override?.reasoningStream ?? base?.reasoningStream,
    reasoningSummary: override?.reasoningSummary ?? base?.reasoningSummary,
    vision: override?.vision ?? base?.vision,
    audio: override?.audio ?? base?.audio,
    streaming: override?.streaming ?? base?.streaming
  };
}

function mergeHeaders(
  base: Record<string, string> | undefined,
  overlay: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!base && !overlay) return undefined;
  return { ...overlay, ...base };
}

function mergeCatalogLimits(
  base: ModelCatalogEntry["limits"],
  overlay: ModelCatalogEntry["limits"]
): ModelCatalogEntry["limits"] {
  if (!base && !overlay) return undefined;
  return {
    maxInputTokens: base?.maxInputTokens ?? overlay?.maxInputTokens,
    reasoningReserveTokens: base?.reasoningReserveTokens ?? overlay?.reasoningReserveTokens,
    toolSchemaReserveTokens: base?.toolSchemaReserveTokens ?? overlay?.toolSchemaReserveTokens,
    systemPromptReserveTokens: base?.systemPromptReserveTokens ?? overlay?.systemPromptReserveTokens,
    protocolSafetyMarginTokens: base?.protocolSafetyMarginTokens ?? overlay?.protocolSafetyMarginTokens
  };
}

function mergeUserLimits(
  base: ModelCatalogEntry["limits"],
  override: ModelCatalogEntry["limits"]
): ModelCatalogEntry["limits"] {
  if (!base && !override) return undefined;
  return {
    maxInputTokens: override?.maxInputTokens ?? base?.maxInputTokens,
    reasoningReserveTokens: override?.reasoningReserveTokens ?? base?.reasoningReserveTokens,
    toolSchemaReserveTokens: override?.toolSchemaReserveTokens ?? base?.toolSchemaReserveTokens,
    systemPromptReserveTokens: override?.systemPromptReserveTokens ?? base?.systemPromptReserveTokens,
    protocolSafetyMarginTokens: override?.protocolSafetyMarginTokens ?? base?.protocolSafetyMarginTokens
  };
}
