/**
 * 云端 Embedding 传输层。
 *
 * 只接受 ProviderDefinition 明确声明的 wire；鉴权、代理和重试继续沿用 provider 配置，
 * 不会把聊天模型名称当作 embedding 能力探针。
 */
import type {
  ProviderDefinition,
  ProviderEmbeddingDefinition,
  ProviderEmbeddingModelDefinition
} from "../../ai/types.js";
import { createRetryFetch } from "../../ai/retry.js";
import type { ProviderConfig } from "../../config/schema.js";
import { createProxyAwareFetch } from "../../network/proxyFetch.js";
import { embeddingModelFingerprint, embeddingProviderEndpointHash } from "./fingerprint.js";
import type {
  EmbeddingInputType,
  EmbeddingModelDescriptor,
  EmbeddingModelRuntime,
  EmbeddingRequest,
  EmbeddingResult
} from "./types.js";
import { normalizeEmbedding } from "./vector.js";

const defaultEmbeddingTimeoutMs = 30_000;
const maxEmbeddingBatchSize = 256;

export interface ProviderEmbeddingRuntimeOptions {
  fetcher?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
}

export class ProviderEmbeddingRuntime implements EmbeddingModelRuntime {
  readonly descriptor: EmbeddingModelDescriptor;
  readonly fingerprint: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;

  constructor(
    readonly providerAlias: string,
    private readonly config: ProviderConfig,
    private readonly definition: ProviderDefinition,
    readonly modelId: string,
    options: ProviderEmbeddingRuntimeOptions = {}
  ) {
    const embedding = requireEmbeddingDefinition(providerAlias, definition);
    const baseUrl = config.baseUrl ?? definition.baseUrl;
    if (!baseUrl) throw new Error(`No embedding endpoint configured for provider ${providerAlias}.`);
    validateEndpoint(baseUrl, providerAlias);
    const declared = embeddingModels(config, embedding).find((model) => model.id === modelId);
    if (!declared) {
      throw new Error(`Embedding model ${modelId} is not explicitly declared for provider ${providerAlias}.`);
    }
    this.endpoint = embeddingEndpoint(baseUrl, embedding, modelId);
    this.apiKey = resolveApiKey(config, definition, options.env ?? process.env);
    if ((config.requiresApiKey ?? definition.requiresApiKey) && !this.apiKey) {
      const envName = config.apiKeyEnv ?? definition.apiKeyEnv;
      throw new Error(`No embedding credentials available for provider ${providerAlias}; configure ${envName ?? "an API key"}.`);
    }
    this.fetcher = createRetryFetch(
      config.retry ?? { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      options.fetcher ?? createProxyAwareFetch()
    );
    this.descriptor = providerDescriptor(providerAlias, config, definition, modelId, declared);
    this.fingerprint = this.descriptor.fingerprint;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    validateEmbeddingRequest(request);
    request.signal?.throwIfAborted();
    const wire = requireEmbeddingDefinition(this.providerAlias, this.definition).wire;
    const embeddings = wire === "google-generative-ai"
      ? await this.embedGoogle(request.texts, request.inputType, request.signal)
      : await this.embedOpenAi(request.texts, request.signal);
    const dimensions = validateEmbeddingBatch(embeddings, request.texts.length, this.descriptor.dimensions);
    return {
      embeddings,
      dimensions,
      fingerprint: this.fingerprint,
      model: this.descriptor.ref
    };
  }

  private async embedOpenAi(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.config.headers
      },
      body: JSON.stringify({
        model: this.modelId,
        input: texts,
        encoding_format: "float",
        dimensions: this.descriptor.dimensions
      }),
      signal: requestSignal(signal, this.config.timeoutMs)
    });
    if (!response.ok) throw new Error(`Embedding request failed for provider ${this.providerAlias} (${String(response.status)}).`);
    const payload = await response.json() as unknown;
    const data = objectValue(payload)?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`Embedding provider ${this.providerAlias} returned an invalid result count.`);
    }
    const ordered: Array<Float32Array | undefined> = Array.from({ length: texts.length });
    for (const [fallbackIndex, item] of data.entries()) {
      const value = objectValue(item);
      const index = integerValue(value?.index) ?? fallbackIndex;
      if (index < 0 || index >= texts.length || ordered[index] !== undefined || !Array.isArray(value?.embedding)) {
        throw new Error(`Embedding provider ${this.providerAlias} returned malformed vector metadata.`);
      }
      ordered[index] = normalizeEmbedding(value.embedding.map(numberValue));
    }
    if (ordered.some((embedding) => embedding === undefined)) {
      throw new Error(`Embedding provider ${this.providerAlias} omitted a vector.`);
    }
    return ordered as Float32Array[];
  }

  private async embedGoogle(
    texts: readonly string[],
    inputType: EmbeddingInputType,
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    const embeddings: Float32Array[] = [];
    for (const text of texts) {
      signal?.throwIfAborted();
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { "x-goog-api-key": this.apiKey } : {}),
          ...this.config.headers
        },
        body: JSON.stringify({
          model: `models/${this.modelId.replace(/^models\//u, "")}`,
          content: { parts: [{ text }] },
          taskType: inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          outputDimensionality: this.descriptor.dimensions
        }),
        signal: requestSignal(signal, this.config.timeoutMs)
      });
      if (!response.ok) throw new Error(`Embedding request failed for provider ${this.providerAlias} (${String(response.status)}).`);
      const payload = objectValue(await response.json() as unknown);
      const values = objectValue(payload?.embedding)?.values;
      if (!Array.isArray(values)) throw new Error(`Embedding provider ${this.providerAlias} returned no vector.`);
      embeddings.push(normalizeEmbedding(values.map(numberValue)));
    }
    return embeddings;
  }
}

export function listProviderEmbeddingModels(
  providerAlias: string,
  config: ProviderConfig,
  definition: ProviderDefinition
): EmbeddingModelDescriptor[] {
  if (!definition.embedding) return [];
  return embeddingModels(config, definition.embedding).map((model) => providerDescriptor(
    providerAlias,
    config,
    definition,
    model.id,
    model
  ));
}

function embeddingModels(
  config: ProviderConfig,
  definition: ProviderEmbeddingDefinition
): ProviderEmbeddingModelDefinition[] {
  const models = new Map(definition.models.map((model) => [model.id, { ...model }]));
  for (const configured of config.embeddingModels ?? []) {
    const baseline = models.get(configured.id);
    models.set(configured.id, {
      id: configured.id,
      displayName: configured.displayName,
      dimensions: configured.dimensions ?? baseline?.dimensions,
      recommendedThreshold: configured.recommendedThreshold ?? baseline?.recommendedThreshold ?? 0.3,
      description: baseline?.description
    });
  }
  return [...models.values()];
}

function providerDescriptor(
  providerAlias: string,
  config: ProviderConfig,
  definition: ProviderDefinition,
  modelId: string,
  declared?: ProviderEmbeddingModelDefinition
): EmbeddingModelDescriptor {
  const baseUrl = config.baseUrl ?? definition.baseUrl;
  const ref = { kind: "provider" as const, provider: providerAlias, model: modelId };
  const endpoint = baseUrl === undefined ? undefined : safeDisplayEndpoint(baseUrl);
  return {
    ref,
    fingerprint: embeddingModelFingerprint({
      ref,
      wire: definition.embedding?.wire ?? "unavailable",
      endpoint: baseUrl,
      dimensions: declared?.dimensions
    }),
    displayName: declared?.displayName ?? modelId,
    description: declared?.description,
    dimensions: declared?.dimensions,
    recommendedThreshold: declared?.recommendedThreshold ?? 0.3,
    source: "provider",
    providerType: config.type,
    endpoint,
    privacyEndpointHash: endpoint === undefined ? undefined : embeddingProviderEndpointHash(providerAlias, endpoint),
    available: baseUrl !== undefined && (
      !(config.requiresApiKey ?? definition.requiresApiKey)
      || resolveApiKey(config, definition, process.env) !== undefined
    )
  };
}

function requireEmbeddingDefinition(providerAlias: string, definition: ProviderDefinition): ProviderEmbeddingDefinition {
  if (!definition.embedding) throw new Error(`Provider ${providerAlias} does not declare an embedding wire capability.`);
  return definition.embedding;
}

function embeddingEndpoint(
  baseUrl: string,
  embedding: ProviderEmbeddingDefinition,
  modelId: string
): string {
  const base = baseUrl.replace(/\/+$/u, "");
  if (embedding.wire === "google-generative-ai") {
    const model = encodeURIComponent(modelId.replace(/^models\//u, ""));
    return `${base}/models/${model}:embedContent`;
  }
  return `${base}/embeddings`;
}

function resolveApiKey(
  config: ProviderConfig,
  definition: ProviderDefinition,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (config.apiKey) return config.apiKey;
  const envName = config.apiKeyEnv ?? definition.apiKeyEnv;
  return envName ? env[envName] : undefined;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs ?? defaultEmbeddingTimeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function validateEndpoint(value: string, providerAlias: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`Invalid embedding endpoint for provider ${providerAlias}.`);
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`Embedding endpoint for provider ${providerAlias} must use HTTP or HTTPS.`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`Embedding endpoint for provider ${providerAlias} must not contain credentials.`);
  }
}

function validateEmbeddingRequest(request: EmbeddingRequest): void {
  if (request.texts.length === 0 || request.texts.length > maxEmbeddingBatchSize) {
    throw new Error(`Embedding request must contain between 1 and ${String(maxEmbeddingBatchSize)} texts.`);
  }
  if (request.texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("Embedding input text cannot be empty.");
  }
}

function validateEmbeddingBatch(
  embeddings: readonly Float32Array[],
  expectedCount: number,
  declaredDimensions?: number
): number {
  if (embeddings.length !== expectedCount || embeddings.length === 0) {
    throw new Error("Embedding result count does not match the request.");
  }
  const dimensions = embeddings[0]?.length ?? 0;
  if (dimensions === 0 || embeddings.some((embedding) => embedding.length !== dimensions)) {
    throw new Error("Embedding provider returned inconsistent vector dimensions.");
  }
  if (declaredDimensions !== undefined && declaredDimensions !== dimensions) {
    throw new Error(`Embedding provider returned ${String(dimensions)} dimensions; expected ${String(declaredDimensions)}.`);
  }
  return dimensions;
}

function safeDisplayEndpoint(value: string): string {
  const endpoint = new URL(value);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  endpoint.search = "";
  return endpoint.toString().replace(/\/$/u, "");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Embedding vector contains a non-finite value.");
  return value;
}
