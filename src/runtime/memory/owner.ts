import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { MemoryMaintenance, PersistedSleepRunError } from "../../agent/context/MemoryMaintenance.js";
import { MemoryStorage } from "../../agent/context/memoryStorage.js";
import { MemoryEmbeddingService } from "../../agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../../agent/context/MemoryVectorIndex.js";
import type { MemoryEntry, MemoryMaintenanceOptions } from "../../agent/context/memoryTypes.js";
import type { AgentConfig } from "../../config/schema.js";
import { updateConfig, type AgentConfigStore } from "../../config/store.js";
import { LocalEmbeddingManager } from "../../llm/embedding/LocalEmbeddingRuntime.js";
import { selectMemoryEmbeddingModel } from "../../llm/embedding/selectMemoryModel.js";
import type { EmbeddingModelRuntime, EmbeddingModelRef, LocalEmbeddingModelId } from "../../llm/embedding/types.js";
import { ProviderRegistry } from "../../llm/ProviderRuntime.js";
import { resolveMemoryModelAlias } from "../../llm/toolModel.js";
import { createProviderCredentialPersistence } from "../../llm/modelFactory.js";

/** 一个 Agent 数据根的维护与模型资源 owner；请求配置快照不跨异步调用共享。 */
export class AgentMemoryOwner {
  private readonly context = new AsyncLocalStorage<AgentConfig>();
  private readonly local: LocalEmbeddingManager;
  private readonly memory: MemoryStorage;
  private readonly maintenance: MemoryMaintenance;
  private readonly embeddings: MemoryEmbeddingService;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  private closingPromise: Promise<void> | undefined;
  private rebuildRetryAt = 0;
  private rebuildFailures = 0;
  private maintenanceAction: string | undefined;
  private rebuildState: string | undefined;

  constructor(private readonly root: string, private readonly store: AgentConfigStore, local?: LocalEmbeddingManager) {
    this.local = local ?? new LocalEmbeddingManager(path.join(root, "models", "embeddings"));
    const model = () => {
      const config = this.config();
      const alias = resolveMemoryModelAlias(config);
      if (!alias) throw new Error("没有可用的记忆工具模型，请在设置中配置工具模型。");
      return new ProviderRegistry(config, [], undefined, undefined, undefined,
        createProviderCredentialPersistence(store, root)).createModelSettings(alias).model;
    };
    this.memory = new MemoryStorage(root, { agentDir: root });
    this.maintenance = new MemoryMaintenance(this.memory, model);
    this.embeddings = new MemoryEmbeddingService({
      localMemory: {
        listMemoryEntries: options => this.memory.listEntries(options),
        getOverview: options => this.memory.getOverview(options)
      },
      localManager: this.local,
      getVectorIndex: () => new MemoryVectorIndex(root),
      getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
      getActiveModel: () => this.selectedModel(),
      getConfiguredModel: () => this.config().context.memory.embeddingModel,
      getProviderModels: () => new ProviderRegistry(this.config()).listEmbeddingModels(),
      getNeedsRebuild: () => this.config().needsEmbeddingRebuild,
      getRuntime: () => this.runtime()
    });
  }

  async execute(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped) throw new Error("Memory owner is closing.");
    const requestSignal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const task = (async () => {
      // 取消不依赖配置可读性，也不等待正在运行的模型或维护任务。
      if (action === "sleep.cancel") return this.maintenance.cancelMaintenance();
      if (action === "embedding.cancel-rebuild") return this.embeddings.cancelRebuild();
      if (action === "embedding.cancel-download") return this.embeddings.cancelDownload(localModel(payload.model));
      const config = await this.store.load(this.root);
      const maintenance = ["sleep.run", "sleep.preview", "embedding.rebuild", "embedding.download", "embedding.remove", "maintain"].includes(action);
      if (maintenance && this.maintenanceAction) {
        if (action === "maintain") return;
        throw new Error(`全局记忆维护 ${this.maintenanceAction} 正在进行。`);
      }
      if (maintenance) this.maintenanceAction = action;
      try { return await this.context.run(config, () => this.dispatch(action, payload, requestSignal)); }
      finally { if (maintenance) this.maintenanceAction = undefined; }
    })();
    this.pending.add(task);
    try { return await task; }
    finally { this.pending.delete(task); }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => { void this.tick().catch(() => undefined); };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try { await this.execute("maintain"); }
    finally { this.ticking = false; }
  }

  close(): Promise<void> {
    this.closingPromise ??= (async () => {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.abort.abort(new DOMException("Memory owner closed.", "AbortError"));
      this.maintenance.cancelMaintenance();
      this.embeddings.cancelRebuild();
      for (const model of ["multilingual-e5-small", "all-MiniLM-L6-v2"] as const) this.embeddings.cancelDownload(model);
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.embeddings.close()),
        Promise.resolve().then(() => this.memory.close()),
        Promise.resolve().then(() => this.local.close())
      ]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Memory resources could not all close.");
    })();
    return this.closingPromise;
  }

  private config(): AgentConfig {
    const config = this.context.getStore();
    if (!config) throw new Error("Memory operation requires a configuration snapshot.");
    return config;
  }

  private selectedModel(): EmbeddingModelRef | undefined {
    return selectMemoryEmbeddingModel(this.config().context.memory.embeddingModel,
      new ProviderRegistry(this.config()).listEmbeddingModels());
  }

  private async runtime(localReadyOnly = false): Promise<EmbeddingModelRuntime | undefined> {
    if (localReadyOnly) return this.local.isReady("multilingual-e5-small")
      ? this.local.createRuntime("multilingual-e5-small") : undefined;
    const selected = this.selectedModel();
    if (!selected || selected.kind === "auto") return undefined;
    if (selected.kind === "local") return this.local.createRuntime(selected.model);
    return new ProviderRegistry(this.config()).createEmbeddingRuntime(selected);
  }

  private async dispatch(action: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    switch (action) {
      case "embedding.status": return this.embeddings.status();
      case "embedding.runtime": return (await this.runtime(payload.localReadyOnly === true))?.descriptor ?? null;
      case "embedding.embed": {
        const runtime = await this.runtime(payload.localReadyOnly === true);
        if (!runtime || runtime.fingerprint !== payload.fingerprint) throw new Error("Embedding model changed before this request.");
        if (!Array.isArray(payload.texts) || !payload.texts.every(text => typeof text === "string")
          || (payload.inputType !== "query" && payload.inputType !== "passage")) throw new Error("Invalid embedding request.");
        const result = await runtime.embed({ texts: payload.texts, inputType: payload.inputType, signal });
        return { ...result, embeddings: result.embeddings.map(vector => Array.from(vector)) };
      }
      case "embedding.download": return this.embeddings.download(localModel(payload.model), signal);
      case "embedding.remove": return this.embeddings.removeLocalModel(localModel(payload.model));
      case "embedding.rebuild": return this.rebuild(signal);
      case "embedding.index": {
        const entry = await this.memory.getEntry(string(payload.id), { activeOnly: true, signal });
        if (entry) await this.embeddings.indexEntry(entry);
        return null;
      }
      case "embedding.remove-entries": {
        if (!Array.isArray(payload.ids) || !payload.ids.every(id => typeof id === "string")) throw new Error("Invalid memory IDs.");
        const stale = [];
        for (const id of payload.ids) if (!await this.memory.getEntry(id, { activeOnly: true, signal })) stale.push(id);
        this.embeddings.removeEntries(stale);
        return null;
      }
      case "embedding.similar-scope": {
        if (payload.userId !== undefined && payload.userId !== null && typeof payload.userId !== "string") throw new Error("Invalid memory user scope.");
        const entries = (await this.memory.listEntries({ signal })).entries;
        return await this.embeddings.findSimilarEntries(string(payload.query),
          payload.userId === undefined ? entries : entries.filter(entry => entry.userId === (payload.userId ?? undefined)),
          number(payload.limit), number(payload.minimumSimilarity), signal) ?? null;
      }
      case "embedding.similar": {
        const entries = await this.entries(payload.entries, signal);
        if (!entries) return null;
        return await this.embeddings.findSimilarEntries(string(payload.query), entries,
          number(payload.limit), number(payload.minimumSimilarity), signal) ?? null;
      }
      case "embedding.pairs": {
        const entries = await this.entries(payload.entries, signal);
        return entries ? this.embeddings.findSimilarPairs(entries, number(payload.minimumSimilarity), signal) : { examined: 0, pairs: [] };
      }
      case "sleep.status": return this.maintenance.loadMaintenanceStatus({ signal });
      case "sleep.preview": return this.maintenance.previewMaintenance({ ...this.config().context.memory, signal }, {
        findSimilarPairs: (entries, threshold, abort) => this.embeddings.findSimilarPairs(entries, threshold, abort)
      });
      case "sleep.run": return this.sleep({ trigger: "manual", signal });
      case "maintain": return this.maintain(signal);
      default: throw new Error(`Unknown memory operation: ${action}`);
    }
  }

  private async entries(value: unknown, signal: AbortSignal): Promise<MemoryEntry[] | undefined> {
    if (!Array.isArray(value)) throw new Error("Invalid memory references.");
    const revisions = new Map<string, number>();
    for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || !Number.isSafeInteger(item.revision)) {
        throw new Error("Invalid memory reference.");
      }
      revisions.set(item.id, item.revision);
    }
    const entries = (await this.memory.listEntries({ signal })).entries.filter(entry => revisions.has(entry.id));
    // 调用者已按用户/对话筛选；异步期间事实变更后不能把新归属的正文带回旧调用上下文。
    return entries.length === revisions.size && entries.every(entry => revisions.get(entry.id) === entry.revision)
      ? entries : undefined;
  }

  private async rebuild(signal: AbortSignal): Promise<void> {
    const selected = this.config().context.memory.embeddingModel;
    await this.embeddings.rebuild(signal);
    if (!this.config().needsEmbeddingRebuild) return;
    await updateConfig(this.store, this.root, config => JSON.stringify(config.context.memory.embeddingModel) === JSON.stringify(selected)
      ? { ...config, needsEmbeddingRebuild: false } : config);
  }

  private async sleep(options: MemoryMaintenanceOptions): Promise<unknown> {
    let rebuild = false;
    try {
      const result = await this.maintenance.runMemoryMaintenance({ ...this.config().context.memory, ...options }, {
        indexEntry: entry => this.embeddings.indexEntry(entry),
        prepareSynthesis: (content, signal) => this.embeddings.prepareSynthesis(content, signal),
        findSimilarPairs: (entries, threshold, signal) => this.embeddings.findSimilarPairs(entries, threshold, signal),
        requestRebuild: () => { rebuild = true; }
      });
      return { result, maintenance: this.maintenance.maintenanceStatus() };
    } catch (error) {
      if (error instanceof PersistedSleepRunError) return { maintenance: { lastRun: error.run } };
      throw error;
    } finally {
      // Sleep 审计结果属于事实操作；派生索引失败由下一次维护重建，不能覆盖已落库的结果。
      if (rebuild && !options.signal?.aborted) await this.rebuild(options.signal ?? this.abort.signal).catch(() => undefined);
    }
  }

  private async maintain(signal: AbortSignal): Promise<void> {
    const sleep = await this.maintenance.loadMaintenanceStatus({ signal });
    const status = await this.embeddings.status();
    if (status.operation?.state === "running") return;
    const rebuildState = JSON.stringify([status.activeModel, status.index.active?.modelFingerprint, status.pendingEntries, status.needsRebuild]);
    if (rebuildState !== this.rebuildState) {
      this.rebuildState = rebuildState;
      this.rebuildFailures = 0;
      this.rebuildRetryAt = 0;
    }
    if (status.activeModel && (status.needsRebuild || status.pendingEntries > 0) && Date.now() >= this.rebuildRetryAt) {
      try {
        await this.rebuild(signal);
        this.rebuildFailures = 0;
        this.rebuildRetryAt = 0;
      } catch {
        signal.throwIfAborted();
        this.rebuildFailures = Math.min(6, this.rebuildFailures + 1);
        this.rebuildRetryAt = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** (this.rebuildFailures - 1));
      }
    }
    const policy = this.config().context.memory;
    if (!policy.enabled || !policy.sleepEnabled) return;
    const now = new Date();
    const [hour, minute] = policy.sleepTime.split(":").map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hour! * 60 + minute!) return;
    if (sleep.state === "running") return;
    const today = now.toDateString();
    const runs = sleep.sleepRuns ?? [];
    if (runs.some(run => run.status === "completed" && new Date(run.startedAt).toDateString() === today)) return;
    if (runs.filter(run => run.status === "failed" && new Date(run.startedAt).toDateString() === today).length >= 3) return;
    await this.sleep({ trigger: "scheduled", signal });
  }
}

function localModel(value: unknown): LocalEmbeddingModelId {
  if (value !== "multilingual-e5-small" && value !== "all-MiniLM-L6-v2") throw new Error("Invalid local embedding model.");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected a nonempty string.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number.");
  return value;
}
