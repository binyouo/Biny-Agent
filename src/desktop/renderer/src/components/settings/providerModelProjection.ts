/**
 * 模型设置页的投影辅助：把「已保存 + 草稿未提交」的模型配置合并成设置页可见的
 * ModelChoice 列表，并把列表按连接分组。纯函数，不触碰 IPC 与运行时。
 */
import type { ModelProfile, ReasoningEffort, ThinkingLevelMap } from "../../../../../config/schema.js";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { completeThinkingLevelMap, isKimiAlwaysThinkingModel, modelCapabilities, thinkingLevelMapForModel } from "../../../../../ai/capabilities.js";
import type { DesktopModelConnection, DesktopModelConfigurationInput } from "../../../../protocol.js";

const localThinkingLevels: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface ConnectionGroup {
  provider: string;
  providerType: string;
  /** 用户在创建对话框命名的显示名；内置目录服务商缺省。 */
  displayName?: string;
  models: ModelChoice[];
  defaultModel?: ModelChoice;
}

/** 把模型列表按 provider 归组，设置页里按「连接」为单位展示而不是罗列所有模型。 */
export function connectionLabel(models: ModelChoice[], connections: DesktopModelConnection[] = []): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();
  for (const connection of connections) {
    groups.set(connection.providerAlias, {
      provider: connection.providerAlias,
      providerType: connection.providerType,
      displayName: connection.displayName,
      models: []
    });
  }
  for (const model of models) {
    const current = groups.get(model.provider) ?? {
      provider: model.provider,
      providerType: model.providerType,
      models: []
    };
    current.models.push(model);
    if (!current.defaultModel) current.defaultModel = model;
    groups.set(model.provider, current);
  }
  return [...groups.values()];
}

/**
 * 把尚未提交的模型变更投影到设置页列表。这里不重新请求目录；已存在的条目保留后端返回
 * 的能力，但会补全旧缓存中的部分思考映射。新条目优先使用表单声明，只有明确支持思考但
 * 没有映射时才复用本地模型推导。
 */
export function stagedModelChoices(
  saved: ModelChoice[],
  upserts: DesktopModelConfigurationInput[],
  removeAliases: string[],
  modelProfiles: Record<string, Record<string, ModelProfile>>
): ModelChoice[] {
  const choices = new Map(saved.map((model) => [model.alias, model] as const));
  for (const alias of removeAliases) choices.delete(alias);
  for (const [alias, model] of choices) {
    const profile = modelProfiles[model.provider]?.[model.model];
    if (profile !== undefined) {
      choices.set(alias, applyModelProfileToChoice(model, profile));
      continue;
    }
    const automaticThinkingLevelMap = completeLegacyThinkingLevelMap(model);
    if (automaticThinkingLevelMap !== undefined) {
      choices.set(alias, applyThinkingLevelMapToChoice(model, automaticThinkingLevelMap));
    }
  }
  for (const input of upserts) {
    const existing = choices.get(input.alias);
    const profile = modelProfiles[input.providerAlias]?.[input.model];
    const previousContext = existing?.model === input.model && existing.provider === input.providerAlias
      && (input.baseUrl === undefined || input.baseUrl === existing.baseUrl) ? existing : undefined;
    const profileThinkingLevelMap = profile?.thinkingLevelMap;
    const inputThinkingLevelMap = input.thinkingLevelMap
      ?? (input.supportsThinking === true ? thinkingLevelMapForModel(input.model, true) : undefined);
    const inputEfforts = inputThinkingLevelMap
      ? Object.keys(inputThinkingLevelMap).filter((level): level is ModelChoice["efforts"][number] => level !== "off" && inputThinkingLevelMap[level] !== null)
      : [];
    choices.set(input.alias, {
      alias: input.alias,
      displayName: input.displayName,
      provider: input.providerAlias,
      providerType: input.providerType,
      model: input.model,
      modelKey: `${input.providerAlias}\u0000${input.model}`,
      supportsTools: input.supportsTools,
      capabilities: existing?.capabilities ?? {
        tools: input.supportsTools,
        parallelToolCalls: input.parallelToolCalls ?? false,
        reasoning: input.supportsThinking ?? false,
        reasoningStream: input.reasoningStream ?? false,
        reasoningSummary: input.reasoningSummary ?? false,
        vision: input.supportsVision ?? false,
        audio: input.supportsAudio ?? false,
        streaming: true
      },
      contextWindow: profile?.contextWindow ?? input.contextWindow ?? previousContext?.contextWindow,
      // 已补齐的容量必须同步清除旧 fallback 标记；未改容量时保留同一模型的运行时事实。
      contextWindowIsFallback: profile?.contextWindow !== undefined || input.contextWindow !== undefined
        ? false
        : previousContext?.contextWindowIsFallback ?? true,
      maxInputTokens: profile?.maxInputTokens ?? input.maxInputTokens,
      maxOutputTokens: profile?.maxOutputTokens ?? input.maxOutputTokens ?? existing?.maxOutputTokens,
      limits: input.limits,
      efforts: profileThinkingLevelMap
        ? Object.keys(profileThinkingLevelMap).filter((level): level is ModelChoice["efforts"][number] => level !== "off" && profileThinkingLevelMap[level] !== null)
        : existing?.efforts ?? inputEfforts,
      defaultThinking: profileThinkingLevelMap
        ? (Object.keys(profileThinkingLevelMap).find((level) => level !== "off" && profileThinkingLevelMap[level] !== null) as ModelChoice["defaultThinking"] | undefined) ?? "off"
        : existing?.defaultThinking ?? (inputEfforts.includes("high") ? "high" : inputEfforts[0] ?? "off"),
      thinkingLevelMap: profileThinkingLevelMap ?? inputThinkingLevelMap ?? existing?.thinkingLevelMap ?? {},
      apiBackend: input.apiBackend,
      baseUrl: input.baseUrl,
      headers: input.headers ?? existing?.headers,
      compatibility: input.compatibility,
      showInPicker: profile?.showInPicker ?? existing?.showInPicker ?? true,
      available: true,
      source: "configured"
    });
  }
  return [...choices.values()];
}

function applyModelProfileToChoice(choice: ModelChoice, profile: ModelProfile): ModelChoice {
  const capabilities = modelCapabilities({
    provider: choice.provider,
    model: choice.model,
    capabilities: {
      ...choice.capabilities,
      ...Object.fromEntries(Object.entries(profile.capabilities ?? {}).filter(([, value]) => value !== undefined))
    }
  });
  choice = {
    ...choice,
    capabilities,
    supportsTools: capabilities.tools,
    efforts: capabilities.reasoning ? choice.efforts : [],
    defaultThinking: capabilities.reasoning ? choice.defaultThinking : "off",
    showInPicker: profile.showInPicker ?? choice.showInPicker
  };
  const thinkingLevelMap = profile.thinkingLevelMap;
  if (thinkingLevelMap === undefined || profile.capabilities?.reasoning === false) {
    return {
      ...choice,
      contextWindow: profile.contextWindow ?? choice.contextWindow,
      contextWindowIsFallback: profile.contextWindow === undefined ? choice.contextWindowIsFallback : false,
      maxInputTokens: profile.maxInputTokens ?? choice.maxInputTokens,
      maxOutputTokens: profile.maxOutputTokens ?? choice.maxOutputTokens
    };
  }
  return {
    ...applyThinkingLevelMapToChoice(choice, thinkingLevelMap),
    contextWindow: profile.contextWindow ?? choice.contextWindow,
    contextWindowIsFallback: profile.contextWindow === undefined ? choice.contextWindowIsFallback : false,
    maxInputTokens: profile.maxInputTokens ?? choice.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens ?? choice.maxOutputTokens
  };
}

/** 仅修复旧的自动推导结果；带 null 的显式映射交给模型 profile 保持原意。 */
function completeLegacyThinkingLevelMap(choice: ModelChoice): ThinkingLevelMap | undefined {
  const map = choice.thinkingLevelMap;
  const configuredLevels = Object.keys(map).filter((level) => level !== "off");
  if (!configuredLevels.length || configuredLevels.length >= localThinkingLevels.length) return undefined;
  if (!configuredLevels.every((level) => localThinkingLevels.includes(level as ReasoningEffort))) return undefined;
  if (Object.values(map).some((value) => value === null)) return undefined;
  return completeThinkingLevelMap(map, !isKimiAlwaysThinkingModel(choice.model));
}

function applyThinkingLevelMapToChoice(choice: ModelChoice, thinkingLevelMap: ThinkingLevelMap): ModelChoice {
  const efforts = Object.keys(thinkingLevelMap)
    .filter((level): level is ModelChoice["efforts"][number] => level !== "off" && thinkingLevelMap[level] !== null);
  const defaultThinking = efforts.includes(choice.defaultThinking as ModelChoice["efforts"][number])
    ? choice.defaultThinking
    : efforts.includes("high") ? "high" : efforts[0] ?? "off";
  const reasoning = efforts.length > 0;
  return {
    ...choice,
    capabilities: {
      ...choice.capabilities,
      tools: choice.capabilities?.tools ?? choice.supportsTools ?? false,
      parallelToolCalls: choice.capabilities?.parallelToolCalls ?? false,
      reasoning,
      reasoningStream: reasoning && choice.capabilities?.reasoningStream !== false,
      reasoningSummary: reasoning && choice.capabilities?.reasoningSummary === true,
      vision: choice.capabilities?.vision ?? false,
      audio: choice.capabilities?.audio ?? false,
      streaming: choice.capabilities?.streaming ?? true
    },
    efforts,
    defaultThinking,
    thinkingLevelMap
  };
}
