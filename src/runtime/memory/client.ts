import { globalAgentDir, globalConfigDir } from "../../config/paths.js";
import type { MemoryEntry, MemorySimilarSearchOptions, MemoryMaintenanceStatus, MemorySimilarityScan, MemorySleepPreview } from "../../agent/context/memoryTypes.js";
import type { MemoryEmbeddingRuntimeStatus } from "../../agent/context/MemoryEmbeddingService.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRuntime, EmbeddingResult, LocalEmbeddingModelId } from "../../llm/embedding/types.js";
import { discoverMemoryOwner, memoryRequest } from "./transport.js";

/** 无资源所有权的调用上下文；销毁会话不会关闭全局 owner 或取消维护。 */
export class AgentMemoryClient {
  constructor(readonly root = globalAgentDir(), readonly configRoot = globalConfigDir()) {}

  async call<T>(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const owner = await discoverMemoryOwner(this.root, this.configRoot);
    signal?.throwIfAborted();
    return memoryRequest<T>(owner!, action, payload, signal);
  }

  async existingStatus(): Promise<MemoryEmbeddingRuntimeStatus | undefined> {
    const owner = await discoverMemoryOwner(this.root, this.configRoot, false);
    return owner ? memoryRequest(owner, "embedding.status", {}) : undefined;
  }

  status(): Promise<MemoryEmbeddingRuntimeStatus> { return this.call("embedding.status"); }
  download(model: LocalEmbeddingModelId): Promise<void> { return this.call("embedding.download", { model }); }
  cancelDownload(model: LocalEmbeddingModelId): Promise<boolean> { return this.call("embedding.cancel-download", { model }); }
  removeLocalModel(model: LocalEmbeddingModelId): Promise<{ filesDeleted: number; bytesFreed: number }> {
    return this.call("embedding.remove", { model });
  }
  rebuild(): Promise<void> { return this.call("embedding.rebuild"); }
  cancelRebuild(): Promise<boolean> { return this.call("embedding.cancel-rebuild"); }
  indexEntry(entry: MemoryEntry): Promise<void> { return this.call("embedding.index", { id: entry.id }); }
  sleepStatus(): Promise<MemoryMaintenanceStatus> { return this.call("sleep.status"); }
  runSleep(): Promise<unknown> { return this.call("sleep.run"); }
  previewSleep(): Promise<MemorySleepPreview> { return this.call("sleep.preview"); }
  cancelSleep(): Promise<boolean> { return this.call("sleep.cancel"); }
  maintain(): Promise<void> { return this.call("maintain"); }

  async embeddingRuntime(localReadyOnly = false, signal?: AbortSignal): Promise<EmbeddingModelRuntime | undefined> {
    const descriptor = await this.call<EmbeddingModelDescriptor | null>("embedding.runtime", { localReadyOnly }, signal);
    if (!descriptor) return undefined;
    return {
      descriptor,
      fingerprint: descriptor.fingerprint,
      embed: async request => {
        const result = await this.call<Omit<EmbeddingResult, "embeddings"> & { embeddings: number[][] }>("embedding.embed", {
          texts: request.texts, inputType: request.inputType, fingerprint: descriptor.fingerprint, localReadyOnly
        }, request.signal);
        return { ...result, embeddings: result.embeddings.map(vector => Float32Array.from(vector)) };
      }
    };
  }

  async findSimilarInScope(query: string, options: MemorySimilarSearchOptions): Promise<MemoryEntry[] | undefined> {
    return await this.call<MemoryEntry[] | null>("embedding.similar-scope", {
      query, userId: options.userId, limit: options.limit, minimumSimilarity: options.minimumSimilarity
    }, options.signal) ?? undefined;
  }
  async findSimilarEntries(query: string, entries: readonly MemoryEntry[], limit: number, minimumSimilarity: number, signal?: AbortSignal): Promise<MemoryEntry[] | undefined> {
    return await this.call<MemoryEntry[] | null>("embedding.similar", {
      query, entries: entries.map(entry => ({ id: entry.id, revision: entry.revision })), limit, minimumSimilarity
    }, signal) ?? undefined;
  }
  findSimilarPairs(entries: readonly MemoryEntry[], minimumSimilarity: number, signal?: AbortSignal): Promise<MemorySimilarityScan> {
    return this.call("embedding.pairs", { entries: entries.map(entry => ({ id: entry.id, revision: entry.revision })), minimumSimilarity }, signal);
  }
}
