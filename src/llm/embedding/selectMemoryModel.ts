/** 长期记忆缺省使用本地模型；只有显式 auto 才按 Provider 能力选择。 */
import { defaultEmbeddingModelRef, type EmbeddingModelDescriptor, type EmbeddingModelRef } from "./types.js";

const providerOrder = ["openai", "openrouter", "gemini", "openai-compatible"];

export function selectMemoryEmbeddingModel(
  selection: EmbeddingModelRef | undefined,
  descriptors: readonly EmbeddingModelDescriptor[]
): EmbeddingModelRef | undefined {
  if (selection === undefined) return defaultEmbeddingModelRef;
  if (selection?.kind === "local") return selection;
  if (selection?.kind === "provider") {
    return descriptors.some((descriptor) => descriptor.available === true
      && descriptor.ref.kind === "provider"
      && descriptor.ref.provider === selection.provider
      && descriptor.ref.model === selection.model) ? selection : undefined;
  }
  const available = descriptors.filter((descriptor) => descriptor.source === "provider"
    && descriptor.ref.kind === "provider" && descriptor.available === true);
  for (const type of providerOrder) {
    const candidates = available.filter((descriptor) => descriptor.providerType === type);
    if (!candidates.length) continue;
    const preferred = type === "gemini" ? "gemini-embedding-001"
      : type === "openrouter" ? "openai/text-embedding-3-small"
        : "text-embedding-3-small";
    const chosen = candidates.find((descriptor) => descriptor.ref.kind === "provider" && descriptor.ref.model === preferred)
      ?? candidates[0];
    return chosen?.ref;
  }
  return undefined;
}
