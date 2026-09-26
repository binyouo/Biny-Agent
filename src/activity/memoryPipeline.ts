/** Activity 分析结果的统一记忆投影。
 *
 * 分析结果先保存在 Activity 数据库，再由这里把稳定候选写入 SQLite 记忆并把会话材料
 * 投影到主题沉淀层。两条投影都允许失败而不回滚已落库的 Activity 分析。
 */
import { LocalMemory } from "../agent/context/LocalMemory.js";
import { CrystalService } from "../agent/context/crystalService.js";
import { CrystalStorage } from "../agent/context/crystalStorage.js";
import type { CrystalConfig } from "../agent/context/crystalTypes.js";
import type {
  ActivityAnalyzerDeps,
  ActivityMemoryCandidate,
  ActivityMemoryWriteContext
} from "./analyzer.js";
import { activityMemoryInput } from "./memoryInput.js";
import type { ActivityPendingAnalysisSession, ActivitySessionAnalysis } from "./store.js";
import type { MemoryEntry } from "../agent/context/memoryTypes.js";

export interface ActivityMemoryPipelineOptions {
  workspaceRoot: string;
  resolveWorkspace?: (project: string | undefined) => Promise<string | undefined>;
  skipUnknownWorkspace?: boolean;
  indexEntry?: (entry: MemoryEntry) => Promise<void>;
  findSimilarEntries?: NonNullable<ConstructorParameters<typeof LocalMemory>[7]>;
  requireSemantic?: boolean;
  getCrystalConfig?: () => CrystalConfig;
  agentDir?: string;
}

export interface ActivityMemoryPipeline {
  writeMemories: NonNullable<ActivityAnalyzerDeps["writeMemories"]>;
  onAnalyzed: NonNullable<ActivityAnalyzerDeps["onAnalyzed"]>;
  close(): void;
}

export async function createActivityMemoryPipeline(options: ActivityMemoryPipelineOptions): Promise<ActivityMemoryPipeline> {
  const crystalStorage = new CrystalStorage({ agentDir: options.agentDir });
  const crystals = new CrystalService({
    storage: crystalStorage,
    getConfig: options.getCrystalConfig
  });
  await crystals.initialize();

  const writeMemories = async (
    candidates: readonly ActivityMemoryCandidate[],
    context: ActivityMemoryWriteContext
  ): Promise<void> => {
    context.signal?.throwIfAborted();
    const workspaceRoot = await options.resolveWorkspace?.(context.project);
    let hadDeferredCandidate = false;
    for (const candidate of candidates) {
      await context.checkpoint?.();
      context.signal?.throwIfAborted();
      if (workspaceRoot === undefined && options.skipUnknownWorkspace === true && candidate.type !== "user") {
        console.error("[ActivityMemoryPipeline] project memory skipped because workspace is unknown", context.sessionId);
        continue;
      }
      const memory = new LocalMemory(
        workspaceRoot ?? options.workspaceRoot,
        () => context.model,
        undefined,
        5,
        undefined,
        undefined,
        options.indexEntry === undefined ? undefined : { indexEntry: options.indexEntry },
        options.findSimilarEntries,
        () => context.model
      );
      let deferred = false;
      try {
        const input = activityMemoryInput(candidate, context);
        const result = await memory.writeAutoEntry(input, {
          signal: context.signal,
          checkpoint: context.checkpoint,
          now: new Date(context.analyzedAt),
          requireSemantic: options.requireSemantic !== false
        });
        deferred = result.deferred === true;
      } catch (error) {
        await context.checkpoint?.();
        context.signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        console.error("[ActivityMemoryPipeline] memory candidate write failed", context.sessionId);
      } finally {
        memory.close();
      }
      if (deferred) hadDeferredCandidate = true;
    }
    if (hadDeferredCandidate) throw new Error("本地语义检索暂不可用，部分活动记忆未写入。");
  };

  const onAnalyzed = async (
    analysis: ActivitySessionAnalysis,
    session: ActivityPendingAnalysisSession,
    signal?: AbortSignal
  ): Promise<void> => {
    const terms = [
      analysis.project,
      ...analysis.topics,
      ...analysis.highlights,
      ...analysis.entities
    ].filter((value): value is string => Boolean(value?.trim()));
    await crystals.processAnchor({
      signal,
      threadId: `activity:${analysis.project?.trim() || "unclassified"}`,
      anchorId: `activity:${session.id}`,
      day: session.startedAt.slice(0, 10),
      text: [analysis.summary, ...analysis.topics, ...analysis.highlights].join("\n"),
      source: "activity",
      terms
    });
  };

  return {
    writeMemories,
    onAnalyzed,
    close: () => crystals.close()
  };
}
