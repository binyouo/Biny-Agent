/** Activity 分析结果的统一记忆投影。
 *
 * 分析结果先保存在 Activity 数据库，再由这里把稳定候选写入 SQLite 记忆。
 * 投影失败不回滚已落库的 Activity 分析。
 */
import { LocalMemory } from "../agent/context/LocalMemory.js";
import type {
  ActivityAnalyzerDeps,
  ActivityMemoryCandidate,
  ActivityMemoryWriteContext
} from "./analyzer.js";
import { activityMemoryInput } from "./memoryInput.js";
import type { MemoryEntry } from "../agent/context/memoryTypes.js";

export interface ActivityMemoryPipelineOptions {
  workspaceRoot: string;
  resolveWorkspace?: (project: string | undefined) => Promise<string | undefined>;
  skipUnknownWorkspace?: boolean;
  indexEntry?: (entry: MemoryEntry) => Promise<void>;
  findSimilarEntries?: NonNullable<ConstructorParameters<typeof LocalMemory>[7]>;
  requireSemantic?: boolean;
}

export interface ActivityMemoryPipeline {
  writeMemories: NonNullable<ActivityAnalyzerDeps["writeMemories"]>;
}

export async function createActivityMemoryPipeline(options: ActivityMemoryPipelineOptions): Promise<ActivityMemoryPipeline> {
  const writeMemories = async (
    candidates: readonly ActivityMemoryCandidate[],
    context: ActivityMemoryWriteContext
  ): Promise<void> => {
    context.signal?.throwIfAborted();
    const workspaceRoot = await options.resolveWorkspace?.(context.project);
    let hadFailedCandidate = false;
    for (const candidate of candidates) {
      await context.checkpoint?.();
      context.signal?.throwIfAborted();
      if (workspaceRoot === undefined && options.skipUnknownWorkspace === true && candidate.type !== "user") {
        console.error("[ActivityMemoryPipeline] project memory skipped because workspace is unknown", context.sessionId);
        continue;
      }
      const memory = new LocalMemory(workspaceRoot ?? options.workspaceRoot, () => context.model, undefined, 5, undefined, undefined, options.indexEntry === undefined ? undefined : { indexEntry: options.indexEntry }, options.findSimilarEntries);
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
        hadFailedCandidate = true;
        console.error("[ActivityMemoryPipeline] memory candidate write failed", context.sessionId);
      } finally {
        memory.close();
      }
      if (deferred) hadFailedCandidate = true;
    }
    if (hadFailedCandidate) throw new Error("语义检索暂不可用、写入判断或存储失败，部分活动记忆未写入。");
  };

  return { writeMemories };
}
