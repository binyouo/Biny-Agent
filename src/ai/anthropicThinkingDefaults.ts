/** Verified automatic thinking defaults for the ordinary official Anthropic API. */
import { nativeReasoningEffort } from "./capabilities.js";
import type { ModelAliasConfig, ModelApiBackend, ReasoningEffort } from "../config/schema.js";

export interface AnthropicThinkingContext {
  providerType: string;
  baseUrl: string;
}

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

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
  // Match the pinned SDK: strip one trailing slash, then version the bare origin.
  if (context?.providerType !== "anthropic"
    || !["https://api.anthropic.com", "https://api.anthropic.com/v1"].includes(context.baseUrl.replace(/\/$/u, ""))
    || api !== "anthropic_messages" || model.reasoning?.budgetTokens !== undefined
    || !["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"].includes(model.model)) return undefined;
  // Clear an inherited adaptive effort during auxiliary namespace merging.
  if (!enabled) return { thinking: { type: "disabled" }, effort: undefined };
  if (effort === undefined) return undefined;
  const nativeEffort = nativeReasoningEffort(model, effort);
  // Preserve unsupported explicit effort mappings rather than guessing a new one.
  if (nativeEffort !== "low" && nativeEffort !== "medium" && nativeEffort !== "high"
    && nativeEffort !== "xhigh" && nativeEffort !== "max") return undefined;
  return { thinking: { type: "adaptive", display: "summarized" }, effort: nativeEffort };
}
