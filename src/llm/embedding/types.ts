/**
 * Embedding 模型与运行时的独立契约。
 *
 * Embedding 不是聊天模型能力：它有自己的传输协议、缓存指纹和隐私边界，不能通过
 * 模型名称或 tool calling 能力推断。
 */
export type EmbeddingInputType = "query" | "passage";

export type LocalEmbeddingModelId =
  | "multilingual-e5-small";

export type EmbeddingModelRef =
  | { kind: "auto" }
  | { kind: "local"; model: LocalEmbeddingModelId }
  | { kind: "provider"; provider: string; model: string };

export const defaultLocalEmbeddingModel: LocalEmbeddingModelId = "multilingual-e5-small";
export const defaultEmbeddingModelRef: EmbeddingModelRef = { kind: "auto" };



export interface EmbeddingModelDescriptor {
  ref: EmbeddingModelRef;
  /** 向量空间的稳定身份；阈值与索引都按它隔离，不能只按模型显示名复用。 */
  fingerprint: string;
  displayName: string;
  description?: string;
  dimensions?: number;
  /** 语义召回的最低相似度；不同向量空间不可共用。 */
  recommendedThreshold: number;
  source: "local" | "provider";
  providerType?: string;
  endpoint?: string;
  /** 主进程生成的 provider + endpoint 摘要；renderer 不自行导入 Node crypto/索引模块。 */
  privacyEndpointHash?: string;
  available?: boolean;
  installed?: boolean;
  modelSizeBytes?: number;
}

export interface EmbeddingRequest {
  texts: readonly string[];
  inputType: EmbeddingInputType;
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  embeddings: Float32Array[];
  dimensions: number;
  fingerprint: string;
  model: EmbeddingModelRef;
}

export interface EmbeddingModelRuntime {
  readonly descriptor: EmbeddingModelDescriptor;
  readonly fingerprint: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export interface LocalEmbeddingDownloadProgress {
  model: LocalEmbeddingModelId;
  status: "checking" | "downloading" | "ready";
  progress?: number;
  loadedBytes?: number;
  totalBytes?: number;
  file?: string;
}

export interface LocalEmbeddingModelStatus {
  descriptor: EmbeddingModelDescriptor;
  installed: boolean;
}

export function embeddingModelRefKey(ref: EmbeddingModelRef): string {
  return ref.kind === "auto" ? "auto" : ref.kind === "local"
    ? `local:${ref.model}`
    : `provider:${ref.provider}:${ref.model}`;
}
