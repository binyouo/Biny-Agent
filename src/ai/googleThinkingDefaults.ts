/** Narrow automatic capability corrections for verified Google model IDs. */
import { modelReasoningConfig, modelThinkingLevelMap } from "./capabilities.js";
import type { ModelAliasConfig, ModelApiBackend } from "../config/schema.js";

/**
 * Google documents no off control for these Pro models: 2.5 Pro cannot use a
 * zero budget, and 3.1 Pro supports low/medium/high, not minimal. The verified
 * official 3.7/3.8 Flash endpoints also reject minimal (3.7 now routes to 3.8).
 * Earlier Flash models still accept minimal and must retain their current map.
 * Generic capability completion otherwise invents off when the catalog omits it.
 *
 * Correct automatic metadata only. Explicit alias reasoning/maps and profiles
 * remain the user's responsibility; do not reinterpret a historical map as an
 * automatic one. Unknown IDs, suppliers and other wire protocols stay unchanged.
 */
export function applyGoogleProThinkingDefaults(
  model: ModelAliasConfig,
  providerType: string,
  api: ModelApiBackend,
  hasExplicitThinkingConfiguration = false,
  baseUrl?: string
): ModelAliasConfig {
  if (hasExplicitThinkingConfiguration
    || (providerType !== "gemini" && providerType !== "google-native")
    || (api !== "google_generative_ai" && api !== "chat_completions")
    || (model.model !== "gemini-2.5-pro" && model.model !== "gemini-3.1-pro-preview"
      && !isOfficialFlashWithoutMinimal(model.model, api, baseUrl))
    || modelReasoningConfig(model) === undefined) return model;
  const thinkingLevelMap = modelThinkingLevelMap(model);
  if (thinkingLevelMap.off === null) return model;
  // null, unlike omission, survives later completeThinkingLevelMap calls.
  return { ...model, thinkingLevelMap: { ...thinkingLevelMap, off: null } };
}

function isOfficialFlashWithoutMinimal(modelId: string, api: ModelApiBackend, baseUrl: string | undefined): boolean {
  if (modelId !== "gemini-3.7-flash" && modelId !== "gemini-3.8-flash") return false;
  // Do not infer a third-party gateway's parameter contract from its model name.
  // Keep the existing Pro policy unchanged; this endpoint gate is for new IDs.
  const endpoint = baseUrl?.replace(/\/$/u, "");
  return api === "google_generative_ai"
    ? endpoint === "https://generativelanguage.googleapis.com/v1beta"
    : api === "chat_completions" && endpoint === "https://generativelanguage.googleapis.com/v1beta/openai";
}
