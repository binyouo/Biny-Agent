/** Activity 后台记忆使用全局配置的模型与事实索引，不依赖聊天 Session。 */
import path from "node:path";
import type { AgentConfig } from "../../../config/schema.js";
import type { MemoryEntry, MemorySimilarSearchOptions } from "../../../agent/context/memoryTypes.js";
import { LocalMemory } from "../../../agent/context/LocalMemory.js";
import { MemoryEmbeddingService } from "../../../agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../../../agent/context/MemoryVectorIndex.js";
import { LocalEmbeddingManager } from "../../../llm/embedding/LocalEmbeddingRuntime.js";
import { selectMemoryEmbeddingModel } from "../../../llm/embedding/selectMemoryModel.js";
import type { EmbeddingModelRuntime } from "../../../llm/embedding/types.js";
import { ProviderRegistry } from "../../../llm/ProviderRuntime.js";

export class DesktopActivityMemoryIndex {
  private readonly localManager: LocalEmbeddingManager;
  private readonly localMemory: LocalMemory;
  private readonly embeddings: MemoryEmbeddingService;

  constructor(private readonly options: {
    workspaceRoot: string;
    agentDir: string;
    loadConfig: () => Promise<AgentConfig>;
    fetcher?: typeof globalThis.fetch;
  }) {
    this.localManager = new LocalEmbeddingManager(path.join(options.agentDir, "models", "embeddings"));
    this.localMemory = new LocalMemory(options.workspaceRoot, () => {
      throw new Error("Activity 的模型由当前分析操作提供。");
    });
    this.embeddings = new MemoryEmbeddingService({
      localMemory: this.localMemory,
      localManager: this.localManager,
      getVectorIndex: () => new MemoryVectorIndex(options.agentDir),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(options.agentDir),
      getActiveModel: () => undefined,
      getProviderModels: () => [],
      getRuntime: async () => await this.embeddingRuntime()
    });
  }

  private async embeddingRuntime(): Promise<EmbeddingModelRuntime | undefined> {
    const config = await this.options.loadConfig();
    const providers = new ProviderRegistry(config, [], undefined, undefined, this.options.fetcher);
    const providerModels = providers.listEmbeddingModels();
    const selected = selectMemoryEmbeddingModel(config.context.memory.embeddingModel, providerModels);
    if (!selected || selected.kind === "auto") return undefined;
    if (selected.kind === "local") {
      return await this.localManager.createRuntime(selected.model).catch(() => undefined);
    }
    const descriptor = providerModels.find((candidate) => candidate.ref.kind === "provider"
      && candidate.ref.provider === selected.provider && candidate.ref.model === selected.model);
    if (!descriptor?.endpoint || descriptor.available !== true) return undefined;
    return providers.createEmbeddingRuntime(selected);
  }

  async findSimilarEntries(query: string, options: MemorySimilarSearchOptions): Promise<MemoryEntry[] | undefined> {
    const snapshot = await this.localMemory.listMemoryEntries({ signal: options.signal });
    return await this.embeddings.findSimilarEntries(
      query,
      options.userId === undefined
        ? snapshot.entries
        : snapshot.entries.filter((entry) => entry.userId === (options.userId ?? undefined)),
      options.limit,
      options.minimumSimilarity,
      options.signal
    );
  }

  async indexEntry(entry: MemoryEntry): Promise<void> {
    await this.embeddings.indexEntry(entry);
  }

  async close(): Promise<void> {
    this.embeddings.close();
    this.localMemory.close();
    await this.localManager.close();
  }
}
