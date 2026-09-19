/**
 * 本地 Transformers.js Embedding 管理器。
 *
 * 模型权重不随应用分发，只在用户显式下载后从全局缓存离线加载。固定 revision 与 dtype
 * 参与指纹，避免同名模型更新后把不兼容向量混入已有索引。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProgressInfo } from "@huggingface/transformers";
import { embeddingModelFingerprint } from "./fingerprint.js";
import type {
  EmbeddingModelDescriptor,
  EmbeddingModelRuntime,
  EmbeddingRequest,
  EmbeddingResult,
  LocalEmbeddingDownloadProgress,
  LocalEmbeddingModelId,
  LocalEmbeddingModelStatus
} from "./types.js";
import { normalizeEmbedding } from "./vector.js";

const localEmbeddingBatchSize = 32;

interface LocalModelDefinition {
  id: LocalEmbeddingModelId;
  repository: string;
  revision: string;
  dtype: "q8";
  displayName: string;
  description: string;
  dimensions: number;
  modelSizeBytes: number;
  recommendedThreshold: number;
}

interface FeatureExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: true }): Promise<{
    data: ArrayLike<number>;
    dims: number[];
  }>;
  dispose(): Promise<void>;
}

interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
    options: {
      cache_dir: string;
      revision: string;
      dtype: "q8";
      local_files_only: boolean;
      progress_callback?: (progress: ProgressInfo) => void;
    }
  ): Promise<FeatureExtractor>;
  ModelRegistry: {
    is_pipeline_cached(
      task: "feature-extraction",
      model: string,
      options: { cache_dir: string; revision: string; dtype: "q8" }
    ): Promise<boolean>;
    clear_pipeline_cache(
      task: "feature-extraction",
      model: string,
      options: { cache_dir: string; revision: string; dtype: "q8" }
    ): Promise<{ filesDeleted: number }>;
  };
}

export interface LocalEmbeddingManagerOptions {
  moduleLoader?: () => Promise<TransformersModule>;
}

export const localEmbeddingModels: readonly LocalModelDefinition[] = [
  {
    id: "multilingual-e5-small",
    repository: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dtype: "q8",
    displayName: "Multilingual E5 Small",
    description: "适合中英文检索；对原文做平均池化并归一化。",
    dimensions: 384,
    modelSizeBytes: 145 * 1024 * 1024,
    recommendedThreshold: 0.8
  }
] as const;

export class LocalEmbeddingManager {
  private readonly extractors = new Map<LocalEmbeddingModelId, Promise<FeatureExtractor>>();
  private readonly readyModels = new Set<LocalEmbeddingModelId>();
  private readonly moduleLoader: () => Promise<TransformersModule>;

  constructor(readonly cacheDirectory: string, options: LocalEmbeddingManagerOptions = {}) {
    this.moduleLoader = options.moduleLoader ?? loadTransformers;
  }

  descriptors(): EmbeddingModelDescriptor[] {
    return listLocalEmbeddingModels();
  }

  isReady(): boolean {
    return this.readyModels.size > 0;
  }

  async list(): Promise<LocalEmbeddingModelStatus[]> {
    return await Promise.all(localEmbeddingModels.map(async (model) => {
      const installed = await this.isInstalled(model.id);
      return { descriptor: { ...localDescriptor(model), installed }, installed };
    }));
  }

  async isInstalled(modelId: LocalEmbeddingModelId): Promise<boolean> {
    const model = requireLocalModel(modelId);
    const transformers = await this.moduleLoader();
    return await transformers.ModelRegistry.is_pipeline_cached(
      "feature-extraction",
      model.repository,
      cacheOptions(this.cacheDirectory, model)
    );
  }

  async download(
    modelId: LocalEmbeddingModelId,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: LocalEmbeddingDownloadProgress) => void;
    } = {}
  ): Promise<LocalEmbeddingModelStatus> {
    const model = requireLocalModel(modelId);
    options.signal?.throwIfAborted();
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    options.onProgress?.({ model: modelId, status: "checking", progress: 0 });
    const extractor = await this.load(model, false, options.signal, options.onProgress);
    try {
      options.signal?.throwIfAborted();
    } finally {
      await extractor.dispose();
    }
    options.onProgress?.({ model: modelId, status: "ready", progress: 1 });
    return { descriptor: { ...localDescriptor(model), installed: true }, installed: true };
  }

  async remove(
    modelId: LocalEmbeddingModelId,
    options: { activeModel?: LocalEmbeddingModelId } = {}
  ): Promise<{ filesDeleted: number; bytesFreed: number }> {
    if (options.activeModel === modelId) throw new Error("The active embedding model cannot be deleted.");
    const model = requireLocalModel(modelId);
    const loaded = this.extractors.get(modelId);
    this.extractors.delete(modelId);
    this.readyModels.delete(modelId);
    if (loaded) await (await loaded).dispose();
    const transformers = await this.moduleLoader();
    const cacheRoot = path.join(this.cacheDirectory, ...model.repository.split("/"), model.revision);
    const beforeBytes = await directoryBytes(cacheRoot);
    const result = await transformers.ModelRegistry.clear_pipeline_cache(
      "feature-extraction",
      model.repository,
      cacheOptions(this.cacheDirectory, model)
    );
    const afterBytes = await directoryBytes(cacheRoot);
    return { filesDeleted: result.filesDeleted, bytesFreed: Math.max(0, beforeBytes - afterBytes) };
  }

  async createRuntime(modelId: LocalEmbeddingModelId): Promise<EmbeddingModelRuntime> {
    if (!await this.isInstalled(modelId)) {
      throw new Error(`Local embedding model ${modelId} has not been downloaded.`);
    }
    return new InstalledLocalEmbeddingRuntime(this, requireLocalModel(modelId));
  }

  async close(): Promise<void> {
    const loaded = [...this.extractors.values()];
    this.extractors.clear();
    this.readyModels.clear();
    await Promise.allSettled(loaded.map(async (extractor) => await (await extractor).dispose()));
  }

  async embed(model: LocalModelDefinition, request: EmbeddingRequest): Promise<EmbeddingResult> {
    validateLocalRequest(request);
    const extractor = await this.extractor(model);
    const embeddings: Float32Array[] = [];
    for (let offset = 0; offset < request.texts.length; offset += localEmbeddingBatchSize) {
      request.signal?.throwIfAborted();
      const texts = request.texts.slice(offset, offset + localEmbeddingBatchSize);
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      request.signal?.throwIfAborted();
      embeddings.push(...tensorRows(output, texts.length, model.dimensions));
    }
    return {
      embeddings,
      dimensions: model.dimensions,
      fingerprint: localFingerprint(model),
      model: { kind: "local", model: model.id }
    };
  }

  private async extractor(model: LocalModelDefinition): Promise<FeatureExtractor> {
    const existing = this.extractors.get(model.id);
    if (existing) return await existing;
    const loading = this.load(model, true).then((extractor) => {
      if (this.extractors.get(model.id) === loading) this.readyModels.add(model.id);
      return extractor;
    }).catch((error) => {
      this.extractors.delete(model.id);
      throw error;
    });
    this.extractors.set(model.id, loading);
    return await loading;
  }

  private async load(
    model: LocalModelDefinition,
    localFilesOnly: boolean,
    signal?: AbortSignal,
    onProgress?: (progress: LocalEmbeddingDownloadProgress) => void
  ): Promise<FeatureExtractor> {
    const transformers = await this.moduleLoader();
    signal?.throwIfAborted();
    return await transformers.pipeline("feature-extraction", model.repository, {
      cache_dir: this.cacheDirectory,
      revision: model.revision,
      dtype: model.dtype,
      local_files_only: localFilesOnly,
      progress_callback: onProgress === undefined ? undefined : (progress) => {
        signal?.throwIfAborted();
        const normalized = normalizeDownloadProgress(model.id, progress);
        if (normalized) onProgress(normalized);
      }
    });
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}

export function listLocalEmbeddingModels(): EmbeddingModelDescriptor[] {
  return localEmbeddingModels.map(localDescriptor);
}

class InstalledLocalEmbeddingRuntime implements EmbeddingModelRuntime {
  readonly descriptor: EmbeddingModelDescriptor;
  readonly fingerprint: string;

  constructor(
    private readonly manager: LocalEmbeddingManager,
    private readonly model: LocalModelDefinition
  ) {
    this.descriptor = { ...localDescriptor(model), installed: true };
    this.fingerprint = localFingerprint(model);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return await this.manager.embed(this.model, request);
  }
}

function localDescriptor(model: LocalModelDefinition): EmbeddingModelDescriptor {
  return {
    ref: { kind: "local", model: model.id },
    fingerprint: localFingerprint(model),
    displayName: model.displayName,
    description: model.description,
    dimensions: model.dimensions,
    recommendedThreshold: model.recommendedThreshold,
    source: "local",
    modelSizeBytes: model.modelSizeBytes
  };
}

function localFingerprint(model: LocalModelDefinition): string {
  return embeddingModelFingerprint({
    ref: { kind: "local", model: model.id },
    wire: "transformers-js/raw-mean-normalized-v1",
    revision: model.revision,
    dtype: model.dtype,
    dimensions: model.dimensions
  });
}

function tensorRows(
  output: { data: ArrayLike<number>; dims: number[] },
  expectedRows: number,
  expectedDimensions: number
): Float32Array[] {
  if (output.dims.length !== 2 || output.dims[0] !== expectedRows || output.dims[1] !== expectedDimensions) {
    throw new Error(`Local embedding model returned unexpected dimensions: ${output.dims.join("x")}.`);
  }
  if (output.data.length !== expectedRows * expectedDimensions) {
    throw new Error("Local embedding model returned an incomplete tensor.");
  }
  const rows: Float32Array[] = [];
  for (let row = 0; row < expectedRows; row += 1) {
    const start = row * expectedDimensions;
    const values = Array.from({ length: expectedDimensions }, (_, index) => output.data[start + index] ?? Number.NaN);
    rows.push(normalizeEmbedding(values));
  }
  return rows;
}

function normalizeDownloadProgress(
  model: LocalEmbeddingModelId,
  progress: ProgressInfo
): LocalEmbeddingDownloadProgress | undefined {
  if (progress.status === "progress_total") {
    return {
      model,
      status: "downloading",
      progress: Math.max(0, Math.min(1, progress.progress / 100)),
      loadedBytes: progress.loaded,
      totalBytes: progress.total
    };
  }
  if (progress.status === "progress") {
    return {
      model,
      status: "downloading",
      progress: Math.max(0, Math.min(1, progress.progress / 100)),
      loadedBytes: progress.loaded,
      totalBytes: progress.total,
      file: progress.file
    };
  }
  return undefined;
}

function cacheOptions(cacheDirectory: string, model: LocalModelDefinition): {
  cache_dir: string;
  revision: string;
  dtype: "q8";
} {
  return { cache_dir: cacheDirectory, revision: model.revision, dtype: model.dtype };
}

function requireLocalModel(modelId: LocalEmbeddingModelId): LocalModelDefinition {
  const model = localEmbeddingModels.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Unknown local embedding model: ${modelId}`);
  return model;
}

function validateLocalRequest(request: EmbeddingRequest): void {
  if (request.texts.length === 0 || request.texts.length > 256) {
    throw new Error("Local embedding request must contain between 1 and 256 texts.");
  }
  if (request.texts.some((text) => !text.trim())) throw new Error("Embedding input text cannot be empty.");
}

async function loadTransformers(): Promise<TransformersModule> {
  return await import("@huggingface/transformers") as unknown as TransformersModule;
}
