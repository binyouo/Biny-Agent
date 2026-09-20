/**
 * 统一模型注册表。
 *
 * 配置模型是稳定来源，provider `/models` 是可刷新来源。两者在这里合并成同一份模型视图；
 * 注册表只保存模型元数据，不保存 API key，也不会把实时目录自动写回项目配置。
 */
import { completeThinkingLevelMap, effectiveThinkingSelection, isKimiAlwaysThinkingModel, modelCapabilities, modelContextBudget, modelReasoningConfig, modelThinkingLevelMap, thinkingLevelMapForModel } from "../ai/capabilities.js";
import type { ModelCatalogEntry } from "../ai/types.js";
import type {
  AgentConfig,
  ModelAliasConfig,
  ModelApiBackend,
  ModelCompatibility,
  ModelProvider,
  ReasoningEffort,
  ThinkingLevelMap
} from "../config/schema.js";
import { isRemovedModelId } from "../config/schema.js";
import { providerDefinition } from "../ai/provider.js";
import { ProviderRegistry } from "./ProviderRuntime.js";
import type { EmbeddingModelDescriptor } from "./embedding/index.js";

export type ModelSource = "configured" | "catalog";

export interface ModelChoice {
  alias: string;
  displayName: string;
  description?: string;
  provider: string;
  providerType: ModelProvider | string;
  model: string;
  modelKey: string;
  supportsTools?: boolean;
  capabilities?: ReturnType<typeof modelCapabilities>;
  contextWindow?: number;
  /** 上下文窗口未由模型元数据声明时为 true；展示层不得把该数值称为官方窗口。 */
  contextWindowIsFallback?: boolean;
  effectiveContextWindow?: number;
  effectiveContextWindowPercent?: number;
  contextReserveTokens?: number;
  autoCompactTokenLimit?: number;
  /** Provider 声明的输入硬上限；实际可发预算见 `inputBudgetTokens`。 */
  maxInputTokens?: number;
  inputBudgetTokens?: number;
  /** 上下文窗口中为输出和运行时协议预留的 token；供桌面端展示完整占用。 */
  outputReserveTokens?: number;
  reasoningReserveTokens?: number;
  toolSchemaReserveTokens?: number;
  systemPromptReserveTokens?: number;
  protocolSafetyMarginTokens?: number;
  maxOutputTokens?: number;
  limits?: ModelAliasConfig["limits"];
  efforts: ReasoningEffort[];
  defaultThinking: "off" | ReasoningEffort;
  thinkingLevelMap: ThinkingLevelMap;
  apiBackend?: ModelApiBackend;
  baseUrl?: string;
  /** 模型级自定义 Header；设置页的模型选项弹窗用它回显。 */
  headers?: Record<string, string>;
  compatibility?: ModelCompatibility;
  pricing?: ModelAliasConfig["pricing"];
  /** 普通模型选择器可见性；旧 Runtime Host 未返回时按默认策略处理。 */
  showInPicker?: boolean;
  available: boolean;
  source: ModelSource;
}

export interface RegisteredModel {
  alias: string;
  model: ModelAliasConfig;
  providerAlias: string;
  source: ModelSource;
}

export function catalogModelAlias(providerAlias: string, modelId: string): string {
  return `${providerAlias}/${modelId}`;
}

export class ModelRegistry {
  private readonly catalogs = new Map<string, ModelCatalogEntry[]>();

  constructor(
    private readonly config: AgentConfig,
    private readonly providers: ProviderRegistry = new ProviderRegistry(config)
  ) {}

  registerCatalog(providerAlias: string, entries: ModelCatalogEntry[]): void {
    this.catalogs.set(providerAlias, entries.map((entry) => ({ ...entry, provider: providerAlias })));
  }

  catalog(providerAlias: string): ModelCatalogEntry[] {
    return [...(this.catalogs.get(providerAlias) ?? [])];
  }

  catalogsSnapshot(): Array<[string, ModelCatalogEntry[]]> {
    return [...this.catalogs.entries()].map(([alias, entries]) => [alias, [...entries]]);
  }

  listModels(): ModelChoice[] {
    const choices: ModelChoice[] = [];
    const configuredKeys = new Set<string>();
    const aliases = [
      ...Object.keys(this.config.models).filter((alias) => alias === this.config.defaultModel),
      ...Object.keys(this.config.models).filter((alias) => alias !== this.config.defaultModel)
    ];

    for (const alias of aliases) {
      const model = this.config.models[alias];
      if (!model) continue;
      const normalized = this.providers.get(model.provider)?.resolveModel(model) ?? model;
      if (configuredKeys.has(modelKey(normalized.provider, normalized.model))) continue;
      configuredKeys.add(modelKey(normalized.provider, normalized.model));
      choices.push(this.toChoice(alias, normalized, "configured", true));
    }

    for (const [providerAlias, entries] of this.catalogs) {
      for (const entry of entries) {
        if (configuredKeys.has(modelKey(providerAlias, entry.id))) continue;
        const alias = catalogModelAlias(providerAlias, entry.id);
        choices.push(this.toChoice(
          alias,
          catalogEntryToModel(entry),
          "catalog",
          entry.showInPicker ?? !isRemovedModelId(entry.id)
        ));
      }
    }
    return choices;
  }

  listAvailableModels(): ModelChoice[] {
    return this.listModels().filter((choice) => choice.available);
  }

  /** Embedding 目录独立于聊天模型 picker，只包含 provider 显式声明的 wire/model。 */
  listEmbeddingModels(): EmbeddingModelDescriptor[] {
    return this.providers.listEmbeddingModels();
  }

  isAvailable(resolved: RegisteredModel): boolean {
    return this.providers.get(resolved.providerAlias)?.isConfigured(resolved.model) ?? false;
  }

  resolve(aliasOrReference: string): RegisteredModel | undefined {
    const configured = this.config.models[aliasOrReference];
    if (configured) {
      const provider = this.providers.get(configured.provider);
      return { alias: aliasOrReference, model: provider?.resolveModel(configured) ?? configured, providerAlias: configured.provider, source: "configured" };
    }

    const exactAlias = this.config.models[aliasOrReference.toLowerCase()];
    if (exactAlias) {
      const provider = this.providers.get(exactAlias.provider);
      return { alias: aliasOrReference.toLowerCase(), model: provider?.resolveModel(exactAlias) ?? exactAlias, providerAlias: exactAlias.provider, source: "configured" };
    }

    const slash = aliasOrReference.indexOf("/");
    if (slash > 0) {
      const providerAlias = aliasOrReference.slice(0, slash);
      const modelId = aliasOrReference.slice(slash + 1);
      const configuredEntry = Object.entries(this.config.models).find(([, model]) => (
        model.provider === providerAlias && model.model === modelId
      ));
      if (configuredEntry) {
        const provider = this.providers.get(providerAlias);
        return { alias: configuredEntry[0], model: provider?.resolveModel(configuredEntry[1]) ?? configuredEntry[1], providerAlias, source: "configured" };
      }
      const catalogEntry = this.catalogs.get(providerAlias)?.find((entry) => entry.id === modelId);
      if (catalogEntry) {
        const provider = this.providers.get(providerAlias);
        const model = catalogEntryToModel(catalogEntry);
        return {
          alias: catalogModelAlias(providerAlias, modelId),
          model: provider?.resolveModel(model) ?? model,
          providerAlias,
          source: "catalog"
        };
      }
    }

    for (const [providerAlias, entries] of this.catalogs) {
      const entry = entries.find((candidate) => catalogModelAlias(providerAlias, candidate.id) === aliasOrReference);
      if (entry) {
        const provider = this.providers.get(providerAlias);
        const model = catalogEntryToModel(entry);
        return { alias: catalogModelAlias(providerAlias, entry.id), model: provider?.resolveModel(model) ?? model, providerAlias, source: "catalog" };
      }
    }
    return undefined;
  }

  private toChoice(alias: string, model: ModelAliasConfig, source: ModelSource, showInPicker: boolean): ModelChoice {
    const provider = this.config.providers[model.provider];
    const providerRuntime = this.providers.get(model.provider);
    const normalized = providerRuntime?.resolveModel(model) ?? model;
    const capabilities = modelCapabilities(normalized);
    const reasoning = modelReasoningConfig(normalized);
    const thinkingLevelMap = modelThinkingLevelMap(normalized);
    // 动态目录缺少窗口时也继续展示；modelContextBudget 会给出可执行的保守预算并保留
    // fallback 标记，避免把推导出的 32K 误称为模型官方元数据。
    const contextBudget = modelContextBudget(normalized, this.config.context.maxInputTokens, alias, {
      reasoning: effectiveThinkingSelection(normalized, this.config.thinking)
    });
    return {
      alias,
      displayName: normalized.displayName ?? normalized.model,
      description: normalized.description,
      provider: normalized.provider,
      providerType: provider?.type ?? model.provider,
      model: normalized.model,
      modelKey: modelKey(normalized.provider, normalized.model),
      supportsTools: capabilities.tools,
      capabilities,
      contextWindow: contextBudget?.contextWindow,
      contextWindowIsFallback: contextBudget?.contextWindowIsFallback,
      effectiveContextWindow: contextBudget?.effectiveContextWindow,
      effectiveContextWindowPercent: contextBudget?.effectiveContextWindowPercent,
      contextReserveTokens: contextBudget?.contextReserveTokens,
      autoCompactTokenLimit: contextBudget?.autoCompactTokenLimit,
      maxInputTokens: normalized.maxInputTokens ?? normalized.limits?.maxInputTokens,
      inputBudgetTokens: contextBudget?.maxInputTokens,
      outputReserveTokens: contextBudget?.outputReserveTokens,
      reasoningReserveTokens: contextBudget?.reasoningReserveTokens,
      toolSchemaReserveTokens: contextBudget?.toolSchemaReserveTokens,
      systemPromptReserveTokens: contextBudget?.systemPromptReserveTokens,
      protocolSafetyMarginTokens: contextBudget?.protocolSafetyMarginTokens,
      maxOutputTokens: normalized.maxOutputTokens,
      limits: normalized.limits,
      efforts: [...(reasoning?.efforts ?? [])],
      defaultThinking: reasoning?.defaultEffort ?? "off",
      thinkingLevelMap,
      apiBackend: normalized.apiBackend,
      baseUrl: normalized.baseUrl ?? provider?.baseUrl ?? providerRuntime?.definition.baseUrl ?? (provider ? providerDefinition(provider.type).baseUrl : undefined),
      headers: normalized.headers,
      compatibility: normalized.compatibility ?? provider?.compatibility,
      pricing: normalized.pricing,
      showInPicker: provider?.modelProfiles?.[model.model]?.showInPicker ?? showInPicker,
      available: providerRuntime?.isConfigured(normalized) ?? false,
      source
    };
  }
}

export function modelKey(providerAlias: string, modelId: string): string {
  return `${providerAlias}\u0000${modelId}`;
}

export function hasUsableModelConfiguration(config: AgentConfig, alias: string, modelOverride?: ModelAliasConfig): boolean {
  const model = modelOverride ?? config.models[alias];
  if (!model) return false;
  return new ProviderRegistry(config).get(model.provider)?.isConfigured(model) ?? false;
}

function catalogEntryToModel(entry: ModelCatalogEntry): ModelAliasConfig {
  const levelMap = entry.reasoningEffortsSource === "inferred"
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
    thinkingLevelMap: levelMap,
    pricing: entry.pricing
  };
}
