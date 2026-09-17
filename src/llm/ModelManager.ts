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
import type { ModelSettings } from "./ProviderRuntime.js";
import { AiRegistry } from "./AiRegistry.js";
import { FileModelsStore, restoreProviderCatalogs, type ModelsStore } from "./ModelsStore.js";
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

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AgentConfig,
    private readonly configStore: AgentConfigStore = createFileConfigStore(workspaceRoot),
    private readonly ai: AiRegistry = new AiRegistry(),
    private readonly modelsStore?: ModelsStore,
    catalogs: readonly [string, ModelCatalogEntry[]][] = []
  ) {
    this.runtime = new ModelRuntime(config, catalogs, ai, modelsStore);
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
   * 所有 AgentSession 回合共用的轻量准备：进程内配置变更才重读磁盘，
   * 当前 OAuth provider 临近过期才联网续期，其余 prompt 只做同步配置校验。
   */
  async preparePrompt(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const revision = this.configStore.revision?.();
    if (revision !== undefined && revision !== this.observedConfigRevision) {
      await this.refreshFromDisk();
    }

    const refreshed = await this.runtime.refreshActiveCredential(signal);
    if (refreshed) {
      const providerAlias = resolveModelConfig(this.config).providerAlias;
      const effective = await updateConfig(this.configStore, this.workspaceRoot, (persisted) => configSchema.parse({
        ...persisted,
        providers: {
          ...persisted.providers,
          [providerAlias]: refreshed
        }
      }));
      this.applyConfig(effective);
    }

    this.runtime.validate();
  }

  async refreshModelCatalog(providerAlias = resolveModelConfig(this.config).providerAlias): Promise<ModelCatalogEntry[]> {
    return await this.runtime.refreshModels(providerAlias);
  }

  async switchModel(alias: string, thinking?: ThinkingSelection): Promise<ModelRuntimeInfo> {
    const catalogs = this.runtime.catalogsSnapshot();
    const effective = await updateConfig(this.configStore, this.workspaceRoot, (persisted) => {
      const persistedRuntime = new ModelRuntime(persisted, catalogs, this.ai, this.modelsStore);
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
      new ModelRuntime(candidate, catalogs, this.ai, this.modelsStore).createModelSettings();
      return candidate;
    });
    // 项目覆盖的 defaultModel/thinking 仍然优先；保存后重新读取有效配置，避免内存状态
    // 短暂显示一个实际上被项目覆盖遮住的模型。
    this.applyConfig(effective);
    return this.getInfo();
  }

  async refreshFromDisk(): Promise<ModelRuntimeInfo> {
    const nextConfig = await this.configStore.load(this.workspaceRoot);
    this.applyConfig(nextConfig);
    return this.getInfo();
  }

  private applyConfig(nextConfig: AgentConfig): void {
    const nextRuntime = new ModelRuntime(nextConfig, this.runtime.catalogsSnapshot(), this.ai, this.modelsStore);
    const nextSettings = nextRuntime.createModelSettings();
    Object.assign(this.config, nextConfig);
    this.runtime = nextRuntime;
    this.activeSettings = nextSettings;
    this.observedConfigRevision = this.configStore.revision?.();
  }
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
