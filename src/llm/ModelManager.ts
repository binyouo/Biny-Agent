import { createFileConfigStore, updateConfig, type AgentConfigStore } from "../config/store.js";
import {
  configSchema,
  type AgentConfig,
  type ModelAliasConfig,
  type ModelPricing
} from "../config/schema.js";
import {
  resolveModelConfig
} from "./modelConfig.js";
import { effectiveThinkingSelection, modelCapabilities, modelContextBudget, modelReasoningConfig, modelThinkingLevelMap } from "../ai/capabilities.js";
import type { ModelCatalogEntry } from "../ai/types.js";
import {
  hasUsableModelConfiguration as hasUsableRegisteredModel,
  type ModelChoice
} from "./ModelRegistry.js";
import type { AgentModel } from "../agent/core/types.js";
import { ModelRuntime } from "./ModelRuntime.js";
import type { ModelSettings, ProviderCredentialPersistence } from "./ProviderRuntime.js";
import { createProviderCredentialPersistence } from "./modelFactory.js";
import { AiRegistry } from "./AiRegistry.js";
import { FileModelsStore, modelCatalogCacheKey, restoreProviderCatalogs, type ModelsStore } from "./ModelsStore.js";
import type { ThinkingSelection } from "./modelThinking.js";

export { modelThinkingSelections, type ThinkingSelection } from "./modelThinking.js";
export type { ModelChoice } from "./ModelRegistry.js";

export interface ModelRuntimeInfo {
  modelAlias: string;
  provider: string;
  modelLabel: string;
  reasoningLabel: string;
  thinking: ThinkingSelection;
  contextWindow?: number;
  /** 上下文窗口未由模型元数据声明时为 true。 */
  contextWindowIsFallback?: boolean;
  effectiveContextWindow?: number;
  effectiveContextWindowPercent?: number;
  contextReserveTokens?: number;
  autoCompactTokenLimit?: number;
  maxInputTokens?: number;
  pricing?: ModelPricing;
}

/** Keeps one validated native Biny model while the selected provider changes. */
export class ModelManager {
  private activeSettings: ModelSettings;
  private runtime: ModelRuntime;
  private observedConfigRevision: number | undefined;
  private readonly providerCredentials: ProviderCredentialPersistence;

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AgentConfig,
    private readonly configStore: AgentConfigStore = createFileConfigStore(workspaceRoot),
    private readonly ai: AiRegistry = new AiRegistry(),
    private readonly modelsStore?: ModelsStore,
    catalogs: readonly [string, ModelCatalogEntry[]][] = []
  ) {
    this.providerCredentials = createProviderCredentialPersistence(configStore, workspaceRoot);
    this.runtime = new ModelRuntime(config, catalogs, ai, modelsStore, undefined, this.providerCredentials);
    this.activeSettings = this.runtime.createModelSettings();
    this.observedConfigRevision = configStore.revision?.();
  }

  static async create(
    workspaceRoot: string,
    config: AgentConfig,
    configStore: AgentConfigStore = createFileConfigStore(workspaceRoot),
    ai: AiRegistry = new AiRegistry(),
    modelsStore: ModelsStore = new FileModelsStore()
  ): Promise<ModelManager> {
    const catalogs = await restoreProviderCatalogs(Object.keys(config.providers), modelsStore, config.providers);
    return new ModelManager(workspaceRoot, config, configStore, ai, modelsStore, catalogs);
  }

  listModels(): ModelChoice[] {
    return this.runtime.listModels();
  }

  getInfo(): ModelRuntimeInfo {
    return modelRuntimeInfoFromRuntime(this.config, this.runtime);
  }

  getModel(): AgentModel {
    return this.activeSettings.model;
  }

  getModelSettings(): ModelSettings {
    return this.activeSettings;
  }

  getCapabilities(): ReturnType<typeof modelCapabilities> {
    return modelCapabilities(this.runtime.resolve(this.config.defaultModel).model);
  }

  getContextBudget(): ReturnType<typeof modelContextBudget> {
    const resolved = this.runtime.resolve(this.config.defaultModel);
    const thinking = effectiveThinkingSelection(resolved.model, this.config.thinking);
    return modelContextBudget(
      resolved.model,
      this.config.context.maxInputTokens,
      resolved.alias,
      { reasoning: thinking }
    );
  }

  /**
   * AgentSession 在回合入口重读配置；同回合后续步骤传 reloadConfig=false，
   * 只校验当前 Provider 并在 OAuth 临近过期时续期，不切换回合的模型选择。
   */
  async preparePrompt(signal?: AbortSignal, reloadConfig = true): Promise<void> {
    signal?.throwIfAborted();
    const revision = this.configStore.revision?.();
    if (reloadConfig && revision !== undefined && revision !== this.observedConfigRevision) {
      await this.refreshFromDisk();
    }

    const providerAlias = resolveModelConfig(this.config).providerAlias;
    const provider = this.config.providers[providerAlias];
    if (provider?.authMode === "oauth-bearer") {
      const latest = await this.providerCredentials.read?.(providerAlias, provider, signal);
      if (latest && (latest.apiKey !== provider.apiKey || latest.oauth?.refreshToken !== provider.oauth?.refreshToken
        || latest.oauth?.expiresAt !== provider.oauth?.expiresAt)) {
        const observedRevision = this.observedConfigRevision;
        await this.applyConfig({ ...this.config, providers: { ...this.config.providers, [providerAlias]: latest } });
        // 凭据更新不代表已读取并准入其它客户端保存的后续模型选择。
        this.observedConfigRevision = observedRevision;
      }
    }

    const refreshed = await this.runtime.refreshActiveCredential(signal);
    if (refreshed) {
      const effective = await updateConfig(this.configStore, this.workspaceRoot, (persisted) => configSchema.parse({
        ...persisted,
        providers: {
          ...persisted.providers,
          [providerAlias]: refreshed
        }
      }));
      // 凭据续期不能将运行中保存的新模型选择带进当前回合。
      const observedRevision = this.observedConfigRevision;
      await this.applyConfig(reloadConfig ? effective : {
        ...this.config,
        providers: { ...this.config.providers, [providerAlias]: effective.providers[providerAlias]! }
      });
      if (!reloadConfig) this.observedConfigRevision = observedRevision;
    }

    this.runtime.validate();
  }

  async refreshModelCatalog(providerAlias = resolveModelConfig(this.config).providerAlias): Promise<ModelCatalogEntry[]> {
    return await this.runtime.refreshModels(providerAlias);
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const effective = await saveModelSelection(this.workspaceRoot, this.configStore, alias, thinking, this.runtime.catalogsSnapshot(), this.ai, this.modelsStore);
    // 项目覆盖的 defaultModel/thinking 仍然优先；保存后重新读取有效配置，避免内存状态
    // 短暂显示一个实际上被项目覆盖遮住的模型。
    await this.applyConfig(effective);
    return this.getInfo();
  }

  async refreshFromDisk(): Promise<ModelRuntimeInfo> {
    const nextConfig = await this.configStore.load(this.workspaceRoot);
    await this.applyConfig(nextConfig);
    return this.getInfo();
  }

  private async applyConfig(nextConfig: AgentConfig): Promise<void> {
    const nextRevision = this.configStore.revision?.();
    // 别名不代表同一个目录来源；端点/服务商变更后不能把旧连接的窗口和能力带入新连接。
    // 凭据轮换和模型选择不改变来源，继续复用实时目录，避免旧磁盘缓存覆盖当前事实。
    const changedProviders = Object.keys(nextConfig.providers).filter((alias) => {
      const previous = this.config.providers[alias];
      const next = nextConfig.providers[alias]!;
      return !previous || previous.type !== next.type
        || modelCatalogCacheKey(alias, previous) !== modelCatalogCacheKey(alias, next);
    });
    const changed = new Set(changedProviders);
    const catalogs = this.runtime.catalogsSnapshot().filter(([alias]) => nextConfig.providers[alias] && !changed.has(alias));
    // 内置默认端点的持久键只有 alias，不能证明目录属于变更后的服务商/端点。
    // 已知来源变更时保守使用新 Provider 基线；不迁移或清理原缓存。
    const restorableProviders = changedProviders.filter((alias) => !this.config.providers[alias]
      || modelCatalogCacheKey(alias, nextConfig.providers[alias]!) !== alias);
    if (this.modelsStore && restorableProviders.length) {
      catalogs.push(...await restoreProviderCatalogs(restorableProviders, this.modelsStore, nextConfig.providers));
    }
    const nextRuntime = new ModelRuntime(nextConfig, catalogs, this.ai, this.modelsStore, undefined, this.providerCredentials);
    const nextSettings = nextRuntime.createModelSettings();
    // 自动模式在磁盘中省略 toolModel，仍需清除上一回合的显式选择。
    Object.assign(this.config, nextConfig, { toolModel: nextConfig.toolModel });
    this.runtime = nextRuntime;
    this.activeSettings = nextSettings;
    this.observedConfigRevision = nextRevision;
  }
}

/** 只验证并保存选择，不修改驻留 Agent 的当前回合配置。 */
export async function saveModelSelection(
  workspaceRoot: string,
  configStore: AgentConfigStore,
  alias: string,
  thinking?: ThinkingSelection,
  catalogs: readonly [string, ModelCatalogEntry[]][] = [],
  ai: AiRegistry = new AiRegistry(),
  modelsStore?: ModelsStore
): Promise<AgentConfig> {
  return await updateConfig(configStore, workspaceRoot, (persisted) => {
    const persistedRuntime = new ModelRuntime(persisted, catalogs, ai, modelsStore);
    // 解析允许先找到模型，再由 Provider 工厂给出具体的 endpoint/credential 错误；
    // 这样 CLI/TUI 不会把缺少哪个环境变量的信息吞掉。
    const resolved = persistedRuntime.resolve(alias);
    const modelAlias = resolved.alias;
    const model = resolved.model;
    // 除了修复旧的推理字段外，只保存原始配置或动态模型的最小 alias；`resolved.model` 已包含
    // 目录/Provider 补齐的元数据，直接写回会把自动推导的 contextWindow 伪装成用户覆盖。
    const persistedModel = persisted.models[modelAlias] ?? {
      provider: resolved.providerAlias,
      model: model.model
    };
    const candidateModel = modelConfigForSwitch(persistedModel, model);
    const selection = resolveThinkingSelection({ ...persisted, models: { ...persisted.models, [modelAlias]: model } }, modelAlias, thinking);
    const effort = selection === "off"
      ? modelReasoningConfig(model)?.defaultEffort ?? persisted.thinking.effort
      : selection;
    const candidate = configSchema.parse({
      ...persisted,
      defaultModel: modelAlias,
      models: { ...persisted.models, [modelAlias]: candidateModel },
      thinking: { enabled: selection !== "off", effort }
    });

    // Validate endpoint and credentials before allowing this version to be written.
    new ModelRuntime(candidate, catalogs, ai, modelsStore).createModelSettings();
    return candidate;
  });
}

/**
 * 用户早期保存的 OpenCode Go 模型可能带有过时的 `reasoning: false` 和空档位表。
 * 只有运行时已经确认该模型具备思考档位时才修复这两个字段，其他用户显式关闭推理的模型
 * 仍保持原配置，不把目录推断扩散到配置文件。
 */
function modelConfigForSwitch(persistedModel: ModelAliasConfig, resolvedModel: ModelAliasConfig): ModelAliasConfig {
  if (persistedModel.capabilities?.reasoning !== false || !modelReasoningConfig(resolvedModel)) return persistedModel;
  return {
    ...persistedModel,
    capabilities: {
      ...persistedModel.capabilities,
      reasoning: true
    },
    thinkingLevelMap: modelThinkingLevelMap(resolvedModel)
  };
}

export function listModelChoices(
  config: AgentConfig,
  catalogs: readonly [string, ModelCatalogEntry[]][] = []
): ModelChoice[] {
  return new ModelRuntime(config, catalogs).listModels();
}

/** 普通模型选择器只展示各服务商设置中已启用且当前可用的模型。 */
export function filterPickerModelChoices(models: readonly ModelChoice[]): ModelChoice[] {
  return models.filter((model) => model.source === "configured" && model.available && model.showInPicker !== false);
}

export function listPickerModelChoices(
  config: AgentConfig,
  catalogs: readonly [string, ModelCatalogEntry[]][] = []
): ModelChoice[] {
  return filterPickerModelChoices(listModelChoices(config, catalogs));
}

export function listConfiguredModelChoices(
  config: AgentConfig,
  catalogs: readonly [string, ModelCatalogEntry[]][] = []
): ModelChoice[] {
  // 设置页需要展示所有已保存的模型，即使凭据暂时缺失或 provider 当前不可用。
  // “是否可用”只影响模型选择器和发送任务，不应让用户看不到自己的配置。
  return listModelChoices(config, catalogs).filter((model) => model.source === "configured");
}

export function hasUsableModelConfiguration(config: AgentConfig, alias = config.defaultModel): boolean {
  return hasUsableRegisteredModel(config, alias);
}

export function modelRuntimeInfo(
  config: AgentConfig,
  catalogs: readonly [string, ModelCatalogEntry[]][] = []
): ModelRuntimeInfo {
  return modelRuntimeInfoFromRuntime(config, new ModelRuntime(config, catalogs));
}

function modelRuntimeInfoFromRuntime(config: AgentConfig, runtime: ModelRuntime): ModelRuntimeInfo {
  const resolved = runtime.resolve(config.defaultModel);
  const thinking = effectiveThinkingSelection(resolved.model, config.thinking);
  const contextBudget = modelContextBudget(
    resolved.model,
    config.context.maxInputTokens,
    resolved.alias,
    { reasoning: thinking }
  );
  const providerType = config.providers[resolved.providerAlias]?.type ?? resolved.providerAlias;
  return {
    modelAlias: resolved.alias,
    provider: providerType,
    modelLabel: formatModelLabel(providerType, resolved.model.model),
    reasoningLabel: thinking === "off" ? "Off" : formatReasoningLabel(thinking),
    thinking,
    contextWindow: contextBudget.contextWindow,
    contextWindowIsFallback: contextBudget.contextWindowIsFallback,
    effectiveContextWindow: contextBudget.effectiveContextWindow,
    effectiveContextWindowPercent: contextBudget.effectiveContextWindowPercent,
    contextReserveTokens: contextBudget.contextReserveTokens,
    autoCompactTokenLimit: contextBudget.autoCompactTokenLimit,
    pricing: resolved.model.pricing,
    maxInputTokens: contextBudget.maxInputTokens
  };
}

export function resolveThinkingSelection(
  config: AgentConfig,
  alias: string,
  requested?: ThinkingSelection
): ThinkingSelection {
  const resolved = new ModelRuntime(config).resolve(alias);
  const model = resolved.model;
  if (requested === undefined) {
    const reasoning = modelReasoningConfig(model);
    if (!reasoning) return "off";
    if (alias === config.defaultModel && config.thinking.enabled && reasoning.efforts.includes(config.thinking.effort)) {
      return config.thinking.effort;
    }
    return reasoning.defaultEffort;
  }
  const levelMap = modelThinkingLevelMap(model);
  if (requested === "off") {
    if (modelReasoningConfig(model) && (levelMap.off === undefined || levelMap.off === null)) {
      throw new Error(`Model ${alias} does not support disabling thinking.`);
    }
    return "off";
  }
  if (levelMap[requested] === undefined || levelMap[requested] === null || !modelReasoningConfig(model)?.efforts.includes(requested)) {
    throw new Error(`Model ${alias} does not support ${requested} thinking effort.`);
  }
  return requested;
}

export function parseThinkingSelection(value: string | undefined): ThinkingSelection | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized as ThinkingSelection;
  throw new Error(`Unknown thinking effort: ${value}. Use off, minimal, low, medium, high, xhigh, or max.`);
}

function formatReasoningLabel(thinking: Exclude<ThinkingSelection, "off">): string {
  return thinking === "xhigh" ? "XHigh" : thinking[0]?.toUpperCase() + thinking.slice(1);
}

function formatModelLabel(provider: string, model: string): string {
  return model === provider || model.startsWith(`${provider}-`) ? model : `${provider}/${model}`;
}
