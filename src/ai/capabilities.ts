/**
 * 模型能力与上下文预算推导。
 *
 * 配置里能力字段大多是可选的，这里负责把「配置 + 模型 ID 启发式 + 默认值」收敛成确定的
 * 能力集合、上下文预算和思考档位，让上层不必到处写兜底判断。
 */
import type { ModelAliasConfig, ModelThinkingConfig, ReasoningEffort, ThinkingLevelMap } from "../config/schema.js";
import type { ModelCapabilities, ModelContextBudget, ModelLimits, ProviderModelDefaults } from "./types.js";

export const defaultModelContextWindow = 32_768;
export const defaultModelOutputTokens = 8_192;
/** 默认把原始窗口的 95% 视为可用于输入的有效窗口。 */
export const defaultEffectiveContextWindowPercent = 95;
/** 默认在原始窗口达到 90% 时触发自动压缩。 */
export const defaultAutoCompactContextWindowPercent = 90;
const defaultToolSchemaReserveTokens = 1_024;
const defaultSystemPromptReserveTokens = 1_024;
const defaultProtocolSafetyMarginTokens = 512;
const minimumUsableInputTokens = 2_048;
const canonicalReasoningEfforts: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 模型级 canonical map。它表达的是 provider 可接受的参数，而不是模型真实“思考程度”。
 * `reasoning` 未显式声明时，再按模型能力推导可用档位。
 */
export function modelThinkingLevelMap(model: ModelAliasConfig): ThinkingLevelMap {
  if (model.thinkingLevelMap) return snapCanonicalNatives({ ...model.thinkingLevelMap });
  const reasoning = model.reasoning;
  if (!reasoning) return {};
  if (isKimiK27CodeModel(model.model)) return projectThinkingLevelMap(["enabled"], false);
  const map: ThinkingLevelMap = isKimiAlwaysThinkingModel(model.model) ? {} : { off: "none" };
  for (const effort of reasoning.efforts) map[effort] = reasoning.mapping?.[effort] ?? effort;
  return completeThinkingLevelMap(map, !isKimiAlwaysThinkingModel(model.model));
}

/** 从 canonical `reasoning` 配置推导 UI 和 provider 使用的档位。 */
export function modelReasoningConfig(model: ModelAliasConfig): ModelThinkingConfig | undefined {
  if (model.capabilities?.reasoning === false || model.compatibility?.supportsReasoning === false) return undefined;
  const map = modelThinkingLevelMap(model);
  const efforts = distinctReasoningEfforts(map);
  if (!efforts.length) return undefined;

  const reasoning = model.reasoning;
  const defaultEffort = reasoning?.defaultEffort && efforts.includes(reasoning.defaultEffort)
    ? reasoning.defaultEffort
    : efforts.includes("high") ? "high" : efforts[0]!;
  const mapping: Partial<Record<ReasoningEffort, string>> = {};
  for (const effort of efforts) mapping[effort] = map[effort] ?? effort;
  return {
    efforts,
    defaultEffort,
    mapping,
    budgetTokens: reasoning?.budgetTokens
  };
}

/**
 * 把跨模型保存的思考偏好投影成当前模型真正可执行的档位。
 * 不支持关闭的模型遇到旧的 `enabled: false` 配置时使用默认档位，避免状态与请求分裂。
 * 旧偏好落在未声明的档位上时按原生值/位置投影到代表档位，而不是直接关闭。
 */
export function effectiveThinkingSelection(
  model: ModelAliasConfig,
  thinking: { enabled: boolean; effort: ReasoningEffort }
): "off" | ReasoningEffort {
  const reasoning = modelReasoningConfig(model);
  if (!reasoning) return "off";
  if (thinking.enabled && reasoning.efforts.includes(thinking.effort)) return thinking.effort;
  if (thinking.enabled) {
    const equivalent = projectThinkingSelectionToModel(modelThinkingLevelMap(model), reasoning.efforts, thinking.effort);
    if (equivalent) return equivalent;
  }
  const off = modelThinkingLevelMap(model).off;
  return off !== undefined && off !== null ? "off" : reasoning.defaultEffort;
}

/**
 * 已知具备可调推理档位的模型家族。
 *
 * OpenAI 兼容端点（尤其是中转站和自建网关）几乎都不返回 `reasoning_efforts`，
 * 只按响应字段判断的话，grok-4.5、GPT-5 这类模型都会被当成不支持
 * 思考，界面上只剩一个「默认」档。所以在服务商没有声明时按模型 ID 兜底推断。
 *
 * 这是一张需要维护的启发式清单：宁可漏判（退回单一默认档，行为与今天一致），
 * 也不要误判（给不支持的模型发 reasoning 参数，严格的服务端会直接报错）。
 */
const reasoningModelPatterns: RegExp[] = [
  /^o[1341](?![a-z0-9])/iu,                       // OpenAI o1 / o3 / o4
  /\bgpt-5/iu,
  /\bgrok-(?:3-mini|[4-9])/iu,
  /\bclaude-(?:sonnet-|opus-|haiku-)?(?:[4-9]|3[.-]7)/iu,
  /\bdeepseek-(?:r1|reasoner)/iu,
  /\bdeepseek-v(?:[4-9]|3[.-][1-9])/iu,
  /\bqw[qe]n?3/iu,                                // Qwen3 / QwQ
  /\bkimi-k(?:[2-9]|1[.-]5)/iu,
  /\bminimax-m[1-9]/iu,
  /\bgemini-(?:[3-9]|2[.-]5)/iu,
  /\bhunyuan-t[1-9]|\bhy[1-9]|\btc-code/iu,
  /\bstep-[3-9]/iu,
  /\bmimo-v?[2-9]/iu,
  /\bernie-x[1-9]/iu,
  /\bnemotron/iu,
  /\bgpt-oss/iu,
  /(?:^|[-/])(?:thinking|reasoner|reasoning)(?:$|[-.])/iu
];

function modelIdentifier(modelId: string): string {
  const normalized = modelId.trim();
  return normalized.split("/").pop() ?? normalized;
}

/** Kimi K3 always reasons and exposes only low/high/max via reasoning_effort. */
export function isKimiK3Model(modelId: string): boolean {
  return /^kimi-k3(?:$|[-.])/iu.test(modelIdentifier(modelId));
}

/** Kimi K3/K2.7 Code 没有可关闭的思考开关；两者的原生参数形状不同。 */
export function isKimiAlwaysThinkingModel(modelId: string): boolean {
  const identifier = modelIdentifier(modelId);
  return isKimiK3Model(identifier) || isKimiK27CodeModel(identifier);
}

function isKimiK27CodeModel(modelId: string): boolean {
  return /^kimi-k2\.7-code(?:$|[-.])/iu.test(modelIdentifier(modelId));
}

/**
 * 服务商没有声明推理档位时，按模型 ID 推断。返回空数组表示按不支持处理。
 */
export function inferReasoningEfforts(modelId: string): ReasoningEffort[] {
  const identifier = modelIdentifier(modelId);
  if (!identifier) return [];
  if (/^deepseek-v4-(?:flash|pro)$/iu.test(identifier)) return ["high", "max"];
  // GLM 全系支持 low/medium/high/max 四档 reasoning_effort，避免落进 ["high","max"]
  // 兜底导致 medium 不可选、默认档偏高。
  if (/^glm-(?:[5-9]|4[.-][5-9]|z1)/iu.test(identifier)) return ["low", "medium", "high", "max"];
  if (isKimiK3Model(identifier)) return ["low", "high", "max"];
  if (isKimiK27CodeModel(identifier)) return ["high"];
  return reasoningModelPatterns.some((pattern) => pattern.test(identifier)) ? ["high", "max"] : [];
}

/** 把目录/桌面配置里的支持提示转换成模型级 canonical map。 */
export function thinkingLevelMapForModel(
  modelId: string,
  supportsThinking = true,
  declaredEfforts: ReasoningEffort[] = []
): ThinkingLevelMap {
  if (!supportsThinking) {
    return { off: "none" };
  }
  if (isKimiK3Model(modelId)) {
    return projectThinkingLevelMap(["low", "high", "max"], false);
  }
  if (isKimiK27CodeModel(modelId)) {
    return projectThinkingLevelMap(["enabled"], false);
  }
  const efforts = declaredEfforts.length ? declaredEfforts : inferReasoningEfforts(modelId);
  const resolved = efforts.length ? efforts : ["high", "max"] as ReasoningEffort[];
  return projectThinkingLevelMap(resolved, true);
}

/**
 * 把服务商的原生档位按顺序投影到 Biny 的六个本地档位。
 * 服务商只有三档时，相邻本地档位共享一个原生档位，永远不会下发服务商不认识的值。
 */
export function projectThinkingLevelMap(nativeValues: readonly string[], supportsOff = true): ThinkingLevelMap {
  const uniqueValues = [...new Set(nativeValues.filter((value) => value.trim().length > 0))];
  const map: ThinkingLevelMap = supportsOff ? { off: "none" } : {};
  if (!uniqueValues.length) return map;
  for (const [index, level] of canonicalReasoningEfforts.entries()) {
    const nativeIndex = uniqueValues.length === 1
      ? 0
      : Math.round((index * (uniqueValues.length - 1)) / (canonicalReasoningEfforts.length - 1));
    map[level] = uniqueValues[nativeIndex]!;
  }
  return snapCanonicalNatives(map);
}

/**
 * 不变式：原生值与 canonical 档位同名时必须同名映射。纯位置投影会把声明档位错位
 * （如 [high,max] 模型的 high 档被投影成 max），展示与请求就和模型声明对不上。
 */
function snapCanonicalNatives(map: ThinkingLevelMap): ThinkingLevelMap {
  const natives = new Set(Object.values(map).filter((value): value is string => typeof value === "string"));
  for (const level of canonicalReasoningEfforts) {
    if (natives.has(level)) map[level] = level;
  }
  return map;
}

/**
 * 把任意档位选择投影到模型声明的档位集合：原生值等价优先，未声明的档位按 canonical
 * 位置取最近代表（与六档网格投影到该模型的结果一致）。显式 null 表示模型不支持，
 * 不参与投影，返回 undefined 交给调用方回退。
 */
export function projectThinkingSelectionToModel(
  levelMap: ThinkingLevelMap,
  efforts: readonly ReasoningEffort[],
  level: ReasoningEffort
): ReasoningEffort | undefined {
  const native = levelMap[level];
  if (typeof native === "string") {
    const equivalent = efforts.find((candidate) => levelMap[candidate] === native);
    if (equivalent) return equivalent;
    return undefined;
  }
  if (native !== undefined && native !== null) return undefined;
  const natives = [...new Set(efforts.map((candidate) => levelMap[candidate]))]
    .filter((value): value is string => typeof value === "string");
  if (!natives.length) return undefined;
  const index = canonicalReasoningEfforts.indexOf(level);
  const nativeIndex = natives.length === 1
    ? 0
    : Math.round((index * (natives.length - 1)) / (canonicalReasoningEfforts.length - 1));
  const target = natives[Math.max(0, Math.min(natives.length - 1, nativeIndex))]!;
  return efforts.find((candidate) => levelMap[candidate] === target);
}

/** 补全目录或缓存中的部分映射；显式写过的 level/null 保持原意。 */
export function completeThinkingLevelMap(source: ThinkingLevelMap, supportsOff = true): ThinkingLevelMap {
  const nativeValues = canonicalReasoningEfforts
    .map((level) => source[level])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const map = projectThinkingLevelMap(nativeValues, supportsOff);
  for (const level of canonicalReasoningEfforts) {
    if (source[level] !== undefined) map[level] = source[level];
  }
  if (source.off !== undefined) map.off = source.off;
  return map;
}

/**
 * 每个不同的原生值只保留一个 canonical 档位，优先保留与原生值同名的档位。
 * 六档 UI 网格投影到档位更少的模型后必然出现重复原生值；不去重的话客户端会展示
 * 多个实际等价的思考深度，用户只能逐档试探。返回值保持 canonical 顺序。
 */
function distinctReasoningEfforts(map: ThinkingLevelMap): ReasoningEffort[] {
  const representative = new Map<string, ReasoningEffort>();
  for (const level of canonicalReasoningEfforts) {
    const native = map[level];
    if (native === undefined || native === null) continue;
    const current = representative.get(native);
    if (current === undefined || (level === native && current !== native)) representative.set(native, level);
  }
  return canonicalReasoningEfforts.filter((level) => {
    const native = map[level];
    return native !== undefined && native !== null && representative.get(native) === level;
  });
}

/**
 * 汇总模型能力。默认按「支持工具、支持流式」处理，因为绝大多数模型都支持，配置里显式
 * 关掉才当作不支持；reasoning 则以是否配了思考参数为准。
 */
export function modelCapabilities(model: ModelAliasConfig): ModelCapabilities {
  const reasoning = modelReasoningConfig(model);
  const reasoningEnabled = model.capabilities?.reasoning ?? reasoning !== undefined;
  return {
    tools: model.capabilities?.tools ?? model.supportsTools ?? true,
    parallelToolCalls: model.capabilities?.parallelToolCalls ?? false,
    reasoning: reasoningEnabled,
    reasoningStream: reasoningEnabled ? model.capabilities?.reasoningStream ?? true : false,
    reasoningSummary: reasoningEnabled ? model.capabilities?.reasoningSummary ?? false : false,
    vision: model.capabilities?.vision ?? false,
    audio: model.capabilities?.audio ?? false,
    streaming: model.capabilities?.streaming ?? true
  };
}

/**
 * 在 ProviderRuntime 边界把用户、内置、插件和动态目录的缺省字段合并成一份模型元数据。
 * 只有 Provider 明确允许按 ID 推断时才启用 reasoning 家族规则；未知模型保持保守关闭。
 */
export function normalizeModelMetadata(
  model: ModelAliasConfig,
  defaults: ProviderModelDefaults = { capabilities: {} }
): ModelAliasConfig {
  const explicitCapabilities = model.capabilities ?? {};
  const reasoningDisabled = explicitCapabilities.reasoning === false || model.compatibility?.supportsReasoning === false;
  const declaredEfforts = modelReasoningConfigWithoutCapabilityGate(model)?.efforts ?? [];
  const inferredEfforts = !reasoningDisabled && defaults.inferReasoningFromId === true
    ? inferReasoningEfforts(model.model)
    : [];
  const defaultEfforts = !reasoningDisabled
    ? defaults.reasoningEfforts ?? []
    : [];
  const fallbackEfforts: ReasoningEffort[] = ["high", "max"];
  const reasoningEfforts: ReasoningEffort[] = declaredEfforts.length
    ? declaredEfforts
    : inferredEfforts.length
      ? inferredEfforts
      : explicitCapabilities.reasoning === true
        ? defaultEfforts.length ? defaultEfforts : fallbackEfforts
        : [];
  const baseReasoning = reasoningDisabled
    ? undefined
    : model.reasoning ?? createReasoningConfig(reasoningEfforts, defaults.thinkingLevelMap);
  const limits = mergeLimits(defaults.limits, model.limits);
  const thinkingLevelMap = reasoningDisabled
    ? { off: "none" }
    : model.thinkingLevelMap
      ? snapCanonicalNatives({ ...model.thinkingLevelMap })
      : (baseReasoning ? reasoningConfigToMap(baseReasoning, model.model) : defaults.thinkingLevelMap);
  const reasoning = reasoningDisabled
    ? undefined
    : reasoningConfigFromMap(thinkingLevelMap, baseReasoning);
  const hasReasoning = !reasoningDisabled && (reasoning !== undefined || explicitCapabilities.reasoning === true);
  const capabilities: ModelCapabilities = {
    tools: explicitCapabilities.tools ?? model.supportsTools ?? defaults.capabilities.tools ?? true,
    parallelToolCalls: explicitCapabilities.parallelToolCalls ?? defaults.capabilities.parallelToolCalls ?? false,
    reasoning: explicitCapabilities.reasoning ?? hasReasoning,
    reasoningStream: (explicitCapabilities.reasoning ?? hasReasoning)
      ? explicitCapabilities.reasoningStream ?? (hasReasoning ? defaults.capabilities.reasoningStream ?? true : true)
      : false,
    reasoningSummary: (explicitCapabilities.reasoning ?? hasReasoning)
      ? explicitCapabilities.reasoningSummary ?? (hasReasoning ? defaults.capabilities.reasoningSummary ?? false : false)
      : false,
    vision: explicitCapabilities.vision ?? defaults.capabilities.vision ?? false,
    audio: explicitCapabilities.audio ?? defaults.capabilities.audio ?? false,
    streaming: explicitCapabilities.streaming ?? defaults.capabilities.streaming ?? true
  };
  return {
    ...model,
    capabilities,
    contextWindow: model.contextWindow ?? defaults.contextWindow,
    maxInputTokens: model.maxInputTokens ?? defaults.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens ?? defaults.maxOutputTokens,
    limits,
    thinkingLevelMap,
    reasoning
  };
}

/**
 * 上下文预算以模型自身窗口为基准：先按有效窗口比例保留统一 headroom，再叠加
 * provider 硬上限和用户额外上限。输出、reasoning、工具 schema 等字段只用于诊断与展示，
 * 不能再次从有效窗口中重复扣除。
 */
export function modelContextBudget(
  model: ModelAliasConfig,
  configuredMaxInputTokens: number | undefined,
  modelAlias?: string,
  options: {
    reasoning?: "off" | ReasoningEffort;
    toolSchemaTokens?: number;
    systemPromptTokens?: number;
  } = {}
): ModelContextBudget {
  const capabilities = modelCapabilities(model);
  const maxOutputTokens = model.maxOutputTokens;
  const modelLimits = model.limits;
  const contextWindowIsFallback = model.contextWindow === undefined;
  // 网关常常只返回 max input。把它按 95% 有效窗口反推原始窗口，既能容纳已声明的
  // 输入上限，又不会把模型 ID 启发式误当成官方上下文元数据；两者都缺失时保持 32K
  // 的保守下限。
  const contextWindow = model.contextWindow ?? Math.max(
    defaultModelContextWindow,
    Math.ceil((model.maxInputTokens ?? configuredMaxInputTokens ?? 0) * 100 / defaultEffectiveContextWindowPercent)
  );
  const outputReserveTokens = Math.min(
    maxOutputTokens ?? defaultModelOutputTokens,
    Math.max(2_048, Math.floor(contextWindow * 0.25))
  );
  const reasoningReserveTokens = options.reasoning !== undefined && options.reasoning !== "off" && capabilities.reasoning
    ? Math.max(
      modelLimits?.reasoningReserveTokens ?? 0,
      reasoningBudgetTokens(model, options.reasoning)
    )
    : 0;
  const toolSchemaReserveTokens = options.toolSchemaTokens
    ?? modelLimits?.toolSchemaReserveTokens
    ?? (capabilities.tools ? defaultToolSchemaReserveTokens : 0);
  const systemPromptReserveTokens = options.systemPromptTokens
    ?? modelLimits?.systemPromptReserveTokens
    ?? defaultSystemPromptReserveTokens;
  const protocolSafetyMarginTokens = modelLimits?.protocolSafetyMarginTokens ?? defaultProtocolSafetyMarginTokens;
  const effectiveContextWindowPercent = defaultEffectiveContextWindowPercent;
  const effectiveContextWindow = Math.max(
    minimumUsableInputTokens,
    Math.floor((contextWindow * effectiveContextWindowPercent) / 100)
  );
  const contextReserveTokens = Math.max(0, contextWindow - effectiveContextWindow);
  const autoCompactTokenLimit = Math.max(
    1,
    Math.min(
      effectiveContextWindow,
      Math.floor((contextWindow * defaultAutoCompactContextWindowPercent) / 100)
    )
  );
  // maxInputTokens 是 provider 的硬上限与用户额外上限叠加后的可发输入预算；它不再
  // 直接等于「模型窗口减去一组固定 reserve」。
  const providerInputLimit = model.maxInputTokens ?? modelLimits?.maxInputTokens;
  const cappedInputTokens = Math.min(
    effectiveContextWindow,
    providerInputLimit ?? Number.MAX_SAFE_INTEGER,
    configuredMaxInputTokens ?? Number.MAX_SAFE_INTEGER
  );
  const inputFloor = Math.min(
    minimumUsableInputTokens,
    contextWindow,
    providerInputLimit ?? Number.MAX_SAFE_INTEGER,
    configuredMaxInputTokens ?? Number.MAX_SAFE_INTEGER
  );
  return {
    modelAlias,
    contextWindow,
    contextWindowIsFallback,
    effectiveContextWindow,
    effectiveContextWindowPercent,
    contextReserveTokens,
    autoCompactTokenLimit,
    maxInputTokens: Math.min(contextWindow, Math.max(inputFloor, cappedInputTokens)),
    maxOutputTokens,
    outputReserveTokens,
    reasoningReserveTokens,
    toolSchemaReserveTokens,
    systemPromptReserveTokens,
    protocolSafetyMarginTokens
  };
}

/** 把内部档位名映射成服务商认识的取值；没配映射就原样下发。 */
export function nativeReasoningEffort(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): string {
  const native = modelThinkingLevelMap(model)[effort];
  return native ?? modelReasoningConfig(model)?.mapping?.[effort] ?? effort;
}

/** 按思考预算 token 计费的协议（如 Anthropic）需要具体数值，这里给出各档默认值。 */
export function reasoningBudgetTokens(
  model: ModelAliasConfig,
  effort: ReasoningEffort
): number {
  return modelReasoningConfig(model)?.budgetTokens?.[effort]
    ?? (effort === "max" || effort === "xhigh" ? 8_192 : effort === "high" ? 4_096 : 2_048);
}

function modelReasoningConfigWithoutCapabilityGate(model: ModelAliasConfig): ModelThinkingConfig | undefined {
  const map = model.thinkingLevelMap ?? (model.reasoning ? modelThinkingLevelMap(model) : {});
  const efforts = distinctReasoningEfforts(map);
  if (!efforts.length && !model.reasoning) return undefined;
  const defaultEffort = model.reasoning?.defaultEffort && efforts.includes(model.reasoning.defaultEffort)
    ? model.reasoning.defaultEffort
    : efforts.includes("high") ? "high" : efforts[0];
  if (!defaultEffort) return undefined;
  const mapping: Partial<Record<ReasoningEffort, string>> = {};
  for (const effort of efforts) mapping[effort] = map[effort] ?? effort;
  return {
    efforts,
    defaultEffort,
    mapping,
    budgetTokens: model.reasoning?.budgetTokens
  };
}

function createReasoningConfig(
  efforts: ReasoningEffort[],
  defaultMap: ThinkingLevelMap | undefined
): ModelThinkingConfig | undefined {
  if (!efforts.length) return undefined;
  const mapping: Partial<Record<ReasoningEffort, string>> = {};
  for (const effort of efforts) mapping[effort] = defaultMap?.[effort] ?? effort;
  const defaultEffort = efforts.includes("high") ? "high" : efforts[0]!;
  return { efforts, defaultEffort, mapping, budgetTokens: undefined };
}

function reasoningConfigFromMap(
  map: ThinkingLevelMap | undefined,
  source: ModelThinkingConfig | undefined
): ModelThinkingConfig | undefined {
  if (!map) return source;
  const efforts = distinctReasoningEfforts(map);
  if (!efforts.length) return undefined;
  const defaultEffort = source?.defaultEffort && efforts.includes(source.defaultEffort)
    ? source.defaultEffort
    : efforts.includes("high") ? "high" : efforts[0]!;
  const mapping: Partial<Record<ReasoningEffort, string>> = {};
  for (const effort of efforts) mapping[effort] = map[effort] ?? effort;
  return {
    efforts,
    defaultEffort,
    mapping,
    budgetTokens: source?.budgetTokens
  };
}

function reasoningConfigToMap(reasoning: ModelThinkingConfig, modelId: string): ThinkingLevelMap {
  if (isKimiK27CodeModel(modelId)) return projectThinkingLevelMap(["enabled"], false);
  const map: ThinkingLevelMap = {};
  for (const effort of reasoning.efforts) map[effort] = reasoning.mapping?.[effort] ?? effort;
  return completeThinkingLevelMap(map, !isKimiAlwaysThinkingModel(modelId));
}

function mergeLimits(base: ModelLimits | undefined, override: ModelLimits | undefined): ModelLimits | undefined {
  if (!base && !override) return undefined;
  return {
    maxInputTokens: override?.maxInputTokens ?? base?.maxInputTokens,
    reasoningReserveTokens: override?.reasoningReserveTokens ?? base?.reasoningReserveTokens,
    toolSchemaReserveTokens: override?.toolSchemaReserveTokens ?? base?.toolSchemaReserveTokens,
    systemPromptReserveTokens: override?.systemPromptReserveTokens ?? base?.systemPromptReserveTokens,
    protocolSafetyMarginTokens: override?.protocolSafetyMarginTokens ?? base?.protocolSafetyMarginTokens
  };
}
