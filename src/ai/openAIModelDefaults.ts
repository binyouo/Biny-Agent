/** Verified model defaults, scoped to the official OpenAI API connection. */
import { modelReasoningConfig, modelThinkingLevelMap } from "./capabilities.js";
import type { ModelAliasConfig, ModelApiBackend } from "../config/schema.js";

function isOfficialOpenAI(providerType: string, endpoint: string | undefined): boolean {
  return providerType === "openai"
    && endpoint?.replace(/\/+$/u, "") === "https://api.openai.com/v1";
}

function isResponsesOnlyPro(modelId: string): boolean {
  return modelId === "gpt-5.2-pro" || modelId === "gpt-5.4-pro";
}

/**
 * Astra function tools require Responses; these two Pro models require it for
 * all requests. Never store this default in shared catalog metadata: explicit
 * model/provider formats must remain authoritative. Do not infer a model family.
 * https://developers.openai.com/api/docs/guides/latest-model
 * https://developers.openai.com/api/docs/models/gpt-5.2-pro
 * https://developers.openai.com/api/docs/models/gpt-5.4-pro
 */
export function officialOpenAIModelApiDefault(
  modelId: string | undefined,
  providerType: string,
  endpoint: string | undefined
): ModelApiBackend | undefined {
  return isOfficialOpenAI(providerType, endpoint)
    && (modelId === "gpt-6-astra" || (modelId !== undefined && isResponsesOnlyPro(modelId)))
    ? "responses" : undefined;
}

/**
 * The Pro models above support medium/high/xhigh, not none. Generic capability
 * completion invents off when it is omitted, so suppress only that automatic
 * option on the verified Responses route. Explicit alias reasoning/maps and
 * profiles remain the user's responsibility, including historical saved maps.
 */
export function applyOpenAIProThinkingDefaults(
  model: ModelAliasConfig,
  providerType: string,
  endpoint: string | undefined,
  api: ModelApiBackend,
  hasExplicitThinkingConfiguration = false
): ModelAliasConfig {
  if (hasExplicitThinkingConfiguration || !isOfficialOpenAI(providerType, endpoint)
    || api !== "responses" || !isResponsesOnlyPro(model.model)
    || modelReasoningConfig(model) === undefined) return model;
  const thinkingLevelMap = modelThinkingLevelMap(model);
  if (thinkingLevelMap.off === null) return model;
  // null, unlike omission, survives later capability completion.
  return { ...model, thinkingLevelMap: { ...thinkingLevelMap, off: null } };
}
