/** Verified automatic thinking defaults for the ordinary official Anthropic API. */
import { modelReasoningConfig, modelThinkingLevelMap, nativeReasoningEffort } from "./capabilities.js";
import type { ModelAliasConfig, ModelApiBackend, ReasoningEffort } from "../config/schema.js";

export interface AnthropicThinkingContext {
  providerType: string;
  baseUrl: string | undefined;
}

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

function isOfficialAnthropicRoute(api: ModelApiBackend, context: AnthropicThinkingContext | undefined): boolean {
  // Match the pinned SDK: strip one trailing slash, then version the bare origin.
  return context?.providerType === "anthropic" && api === "anthropic_messages"
    && ["https://api.anthropic.com", "https://api.anthropic.com/v1"].includes(context.baseUrl?.replace(/\/$/u, "") ?? "");
}

function isAlwaysThinkingFable(modelId: string): boolean {
  return modelId === "claude-fable-5" || modelId === "claude-fable-5-1";
}

/**
 * These exact Fable models accept adaptive thinking, but reject disabled.
 * Correct only automatic completion at the final resolved route: shared catalog
 * entries and explicit alias/profile reasoning maps remain untouched. Explicit
 * budget maps are not equivalent to adaptive effort, even if the map is empty.
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 */
export function applyAnthropicThinkingDefaults(
  model: ModelAliasConfig,
  api: ModelApiBackend,
  context: AnthropicThinkingContext,
  hasExplicitThinkingConfiguration = false
): ModelAliasConfig {
  if (hasExplicitThinkingConfiguration || !isOfficialAnthropicRoute(api, context)
    || !isAlwaysThinkingFable(model.model) || model.reasoning?.budgetTokens !== undefined
    || modelReasoningConfig(model) === undefined) return model;
  const map = modelThinkingLevelMap(model);
  if (map.off === null) return model;
  return { ...model, thinkingLevelMap: { ...map, off: null } };
}

/**
 * These exact models reject manual enabled/budget_tokens but accept adaptive.
 * Do not infer other model families or rewrite explicit user budget maps, even
 * empty maps: adaptive effort is not an equivalent token-budget guarantee.
 * https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking
 */
export function automaticAnthropicThinkingOptions(
  model: ModelAliasConfig,
  api: ModelApiBackend,
  enabled: boolean,
  effort: ReasoningEffort | undefined,
  context: AnthropicThinkingContext | undefined
): { thinking: { type: "adaptive"; display: "summarized" }; effort: AnthropicEffort }
  | { thinking: { type: "disabled" }; effort: undefined } | undefined {
  if (!isOfficialAnthropicRoute(api, context) || model.reasoning?.budgetTokens !== undefined
    || (!isAlwaysThinkingFable(model.model)
      && !["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"].includes(model.model))) return undefined;
  // Clear an inherited adaptive effort during auxiliary namespace merging.
  // Explicit off remains explicit, even where the model does not support it.
  if (!enabled) return { thinking: { type: "disabled" }, effort: undefined };
  if (effort === undefined) return undefined;
  const nativeEffort = nativeReasoningEffort(model, effort);
  // Preserve unsupported explicit effort mappings rather than guessing a new one.
  if (nativeEffort !== "low" && nativeEffort !== "medium" && nativeEffort !== "high"
    && nativeEffort !== "xhigh" && nativeEffort !== "max") return undefined;
  return { thinking: { type: "adaptive", display: "summarized" }, effort: nativeEffort };
}
