/** Narrow automatic capability corrections for verified Google model IDs. */
import { modelReasoningConfig, modelThinkingLevelMap } from "./capabilities.js";
import type { ModelAliasConfig, ModelApiBackend } from "../config/schema.js";

/**
 * Google documents no off control for these Pro models: 2.5 Pro cannot use a
 * zero budget, and 3.1 Pro supports low/medium/high, not minimal. The generic
 * capability completion otherwise invents off even when the catalog omits it.
 *
 * Correct automatic metadata only. Explicit alias reasoning/maps and profiles
 * remain the user's responsibility; do not reinterpret a historical map as an
 * automatic one. Unknown IDs, suppliers and other wire protocols stay unchanged.
 */
export function applyGoogleProThinkingDefaults(
  model: ModelAliasConfig,
  providerType: string,
  api: ModelApiBackend,
  hasExplicitThinkingConfiguration = false
): ModelAliasConfig {
  if (hasExplicitThinkingConfiguration
    || (providerType !== "gemini" && providerType !== "google-native")
    || (api !== "google_generative_ai" && api !== "chat_completions")
    || (model.model !== "gemini-2.5-pro" && model.model !== "gemini-3.1-pro-preview")
    || modelReasoningConfig(model) === undefined) return model;
  const thinkingLevelMap = modelThinkingLevelMap(model);
  if (thinkingLevelMap.off === null) return model;
  // null, unlike omission, survives later completeThinkingLevelMap calls.
  return { ...model, thinkingLevelMap: { ...thinkingLevelMap, off: null } };
}
