/** 实测 usage 只能复用到同一请求前缀；任何模型、system、工具或旧消息变化都会失配。 */
import { createHash } from "node:crypto";
import type { AgentModel, ModelStreamContext } from "../core/types.js";
import type { SessionUsageAnchor } from "../../session/metadata.js";
import { estimateMessageTokens } from "./tokenUsage.js";

export function requestFingerprints(model: AgentModel, context: ModelStreamContext, configurationIdentity?: string) {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    fixedFingerprint: hash([configurationIdentity, model.provider, model.providerAlias, model.modelId, model.vercelOptions, context.systemPrompt ?? "", context.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))]),
    messageFingerprints: context.messages.map((message) => hash(message))
  };
}

export function anchoredRequestTokens(anchor: SessionUsageAnchor | undefined, model: AgentModel, context: ModelStreamContext, configurationIdentity?: string): number | undefined {
  if (!anchor) return undefined;
  const candidate = requestFingerprints(model, context, configurationIdentity);
  if (candidate.fixedFingerprint !== anchor.fixedFingerprint || candidate.messageFingerprints.length < anchor.messageFingerprints.length) return undefined;
  if (anchor.messageFingerprints.some((hash, index) => hash !== candidate.messageFingerprints[index])) return undefined;
  return anchor.inputTokens + estimateMessageTokens(context.messages.slice(anchor.messageFingerprints.length));
}
