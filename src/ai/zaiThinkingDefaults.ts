/** Narrow defaults for the ordinary official Z.ai Chat Completions API. */
import { modelReasoningConfig, modelThinkingLevelMap, nativeReasoningEffort } from "./capabilities.js";
import type { ModelAliasConfig, ModelApiBackend, ReasoningEffort } from "../config/schema.js";

export interface ZaiThinkingContext {
  providerType: string;
  baseUrl: string | undefined;
}

type ZaiEffort = "low" | "high" | "max";
function isZaiEffort(value: string): value is ZaiEffort {
  return value === "low" || value === "high" || value === "max";
}
function isOfficialModel(modelId: string, api: ModelApiBackend, context: ZaiThinkingContext | undefined): boolean {
  return context?.providerType === "zai" && api === "chat_completions"
    && context.baseUrl?.replace(/\/$/u, "") === "https://api.z.ai/api/paas/v4"
    && (modelId === "glm-5.3" || modelId === "glm-5.3-flash");
}

/**
 * Ordinary GLM-5.3 API requests accept low/high/max, not none or xhigh. Coding
 * Plan has different mappings and is deliberately excluded, as are gateways.
 * Only correct automatic capability completion; never edit shared catalogs or
 * reinterpret explicit alias/profile maps, including historical saved off.
 * https://docs.z.ai/guides/capabilities/thinking
 */
export function applyZaiThinkingDefaults(
  model: ModelAliasConfig,
  api: ModelApiBackend,
  context: ZaiThinkingContext,
  hasExplicitThinkingConfiguration = false
): ModelAliasConfig {
  if (hasExplicitThinkingConfiguration || !isOfficialModel(model.model, api, context)
    || modelReasoningConfig(model) === undefined) return model;
  const map = modelThinkingLevelMap(model);
  if (map.off === null) return model;
  return { ...model, thinkingLevelMap: { ...map, off: null } };
}

/**
 * Preserve the native max on both the pinned compatible SDK and the shared
 * request adapter. The SDK reads openaiCompatible; the adapter reads canonical
 * zai before its generic max -> xhigh fallback. Caller raw/camel alias options
 * retain their higher precedence. Do not change the global effort mapper.
 *
 * Decide for the whole model map, not the currently requested level. Explicit
 * off or any unknown on value keeps the entire old option path. Otherwise an
 * auxiliary max -> off request resolves to a supported level and refreshes both
 * namespaces, without leaving an inherited max or clearing caller metadata.
 */
export function automaticZaiThinkingOptions(
  model: ModelAliasConfig,
  api: ModelApiBackend,
  enabled: boolean,
  effort: ReasoningEffort | undefined,
  context: ZaiThinkingContext | undefined
): { zai: { reasoningEffort: ZaiEffort }; openaiCompatible: { reasoningEffort: ZaiEffort } } | undefined {
  if (!enabled || effort === undefined || !isOfficialModel(model.model, api, context)
    || modelReasoningConfig(model) === undefined) return undefined;
  const map = modelThinkingLevelMap(model);
  if (typeof map.off === "string") return undefined;
  const values = Object.entries(map).filter(([level]) => level !== "off")
    .map(([, value]) => value).filter((value): value is string => typeof value === "string");
  if (!values.length || values.some(value => !isZaiEffort(value))) return undefined;
  const native = nativeReasoningEffort(model, effort);
  if (!isZaiEffort(native)) return undefined;
  return { zai: { reasoningEffort: native }, openaiCompatible: { reasoningEffort: native } };
}
