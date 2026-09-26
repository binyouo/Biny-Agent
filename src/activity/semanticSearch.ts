/**
 * Activity 语义检索：仅检索已有本地 OCR 帧向量，按帧返回分数。
 *
 * 同一 session 的多个命中帧分别保留。查询只使用已有索引，缺失向量由后台补齐，避免积压采集数据
 * 把一次前台搜索变成批量推理和写库。
 *
 * 固定使用本地 multilingual-e5-small；模型未下载/不可用
 * 时返回 ok=false 和当前可用的关键词 CLI 入口，不抛给调用方。
 */
import { setTimeout as delay } from "node:timers/promises";
import type { ActivityStore, ActivityOcrEmbeddingSource } from "./store.js";
import type { EmbeddingModelRuntime } from "../llm/embedding/types.js";
import { listLocalEmbeddingModels } from "../llm/embedding/LocalEmbeddingRuntime.js";
import { cosineSimilarity } from "../llm/embedding/vector.js";

/** 每轮最多补齐 32 帧，剩余帧下轮续接。 */
const OCR_EMBED_BATCH_LIMIT = 32;
/** 参与 cosine 排序的向量上限（取最新 N 条，防库体无限增长拖慢检索）。 */

const OCR_SCORE_LIMIT = 5_000;

export interface ActivitySemanticSearchDeps {
  store: ActivityStore;
  /** 本地嵌入运行时；未安装/不可用时返回 undefined。 */
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  query: string;
  limit?: number;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}

export interface ActivityEmbeddingPrecomputeDeps {
  store: ActivityStore;
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  now?: () => Date;
}

export type ActivityEmbeddingPrecomputeResult =
  | { ok: true; embedded: number; model: string; dimensions: number }
  | { ok: false; reason: "no_runtime" | "no_vectors"; message: string };

export interface ActivitySemanticHit {
  createdAt: number;
  id: string;
  snapshotId: string;
  text: string;
  score: number;
  sessionId: string;
  startedAt: string;
  similarity: number;
  project?: string;
  summary: string;
  topics: string[];
  highlights: string[];
  source?: "ocr";
  excerpt?: string;
  occurredAt?: string;
}

export type ActivitySemanticSearchResult =
  | { ok: true; hits: ActivitySemanticHit[]; model: string; dimensions: number }
  | { ok: false; reason: "no_runtime" | "no_vectors"; message: string };



/**
 * 后台补齐当前本地模型指纹下的 OCR 帧向量。
 * 只接受约定的本地 multilingual-e5-small；模型不可用时不改变数据库。
 */
export async function precomputeActivityEmbeddings(
  deps: ActivityEmbeddingPrecomputeDeps
): Promise<ActivityEmbeddingPrecomputeResult> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  // 固定本地模型的指纹由同一模型描述符计算；空轮先查库，避免反复探测或加载权重。
  const localModel = listLocalEmbeddingModels().find(({ ref }) => ref.kind === "local" && ref.model === "multilingual-e5-small")!;
  if (!deps.store.listOcrEmbeddingSources(localModel.fingerprint, 1).length) {
    return { ok: true, embedded: 0, model: "multilingual-e5-small", dimensions: localModel.dimensions ?? 0 };
  }
  const runtime = await resolveActivityEmbeddingRuntime(deps.getEmbeddingRuntime);
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  if (!runtime) return unsupportedRuntimeResult();
  const embedded = await embedMissingActivitySources(deps, runtime);
  return {
    ok: true,
    embedded,
    model: activityEmbeddingModelName(runtime),
    dimensions: runtime.descriptor.dimensions ?? 0
  };
}

export async function searchActivitySemantic(deps: ActivitySemanticSearchDeps): Promise<ActivitySemanticSearchResult> {
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  if (!deps.query.trim()) return { ok: false, reason: "no_vectors", message: "查询不能为空。" };

  const runtime = await resolveActivityEmbeddingRuntime(deps.getEmbeddingRuntime);
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  if (!runtime) return unsupportedRuntimeResult();
  const fingerprint = runtime.fingerprint;

  const ocrRows = deps.store.listOcrEmbeddingRows(fingerprint, OCR_SCORE_LIMIT);
  if (!ocrRows.length) return { ok: false, reason: "no_vectors", message: "还没有可检索的 Activity 向量；后台会补齐索引，当前可用 biny activity search 查询关键词。" };

  const queryResult = await runtime.embed({ texts: [deps.query], inputType: "query", signal: deps.signal });
  // 推理后端未必能中断在途计算；取消后不再读取或返回迟到结果。
  await deps.checkpoint?.();
  deps.signal?.throwIfAborted();
  const queryVector = queryResult.embeddings[0];
  if (!queryVector) return { ok: false, reason: "no_vectors", message: "查询向量生成失败。" };

  const scored: ActivitySemanticHit[] = ocrRows
    .map((row) => ({ row, similarity: cosineSimilarity(queryVector, row.embedding) }))
    .filter(({ similarity }) => Number.isFinite(similarity))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.max(1, Math.min(100, deps.limit ?? 20)))
    .map(({ row, similarity }) => ({
      createdAt: row.createdAt, id: row.id, snapshotId: row.snapshotId, text: row.text, score: similarity,
      sessionId: row.sessionId, startedAt: row.startedAt, occurredAt: row.occurredAt,
      similarity, summary: row.text, topics: [], highlights: [], source: "ocr", excerpt: row.text
    }));

  return {
    ok: true,
    model: activityEmbeddingModelName(runtime),
    dimensions: queryResult.dimensions,
    hits: scored
  };
}

async function resolveActivityEmbeddingRuntime(
  getRuntime: () => Promise<EmbeddingModelRuntime | undefined>
): Promise<EmbeddingModelRuntime | undefined> {
  let runtime: EmbeddingModelRuntime | undefined;
  try {
    runtime = await getRuntime();
  } catch {
    runtime = undefined;
  }
  if (!runtime) return undefined;
  const runtimeRef = runtime.descriptor.ref;
  if (runtime.descriptor.source !== "local" || runtimeRef.kind !== "local" || runtimeRef.model !== "multilingual-e5-small") {
    return undefined;
  }
  return runtime;
}

function unsupportedRuntimeResult(): { ok: false; reason: "no_runtime"; message: string } {
  return {
    ok: false,
    reason: "no_runtime",
    message: "Activity 本地 multilingual-e5-small 不可用（未下载或运行时未配置）。可以改用 biny activity search 查询关键词。"
  };
}

function activityEmbeddingModelName(runtime: EmbeddingModelRuntime): string {
  const ref = runtime.descriptor.ref;
  return ref.kind === "local" ? ref.model : ref.kind === "provider" ? `${ref.provider}/${ref.model}` : "unavailable";
}

async function embedMissingActivitySources(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime
): Promise<number> {
  const fingerprint = runtime.fingerprint;
  const ocrMissing = deps.store.listOcrEmbeddingSources(fingerprint, OCR_EMBED_BATCH_LIMIT);
  return await embedOcrPassages(deps, runtime, fingerprint, ocrMissing);
}

async function embedOcrPassages(
  deps: ActivityEmbeddingPrecomputeDeps,
  runtime: EmbeddingModelRuntime,
  fingerprint: string,
  sources: ReadonlyArray<ActivityOcrEmbeddingSource>
): Promise<number> {
  let embedded = 0;
  for (const [index, source] of sources.entries()) {
    await deps.checkpoint?.();
    deps.signal?.throwIfAborted();
    try {
      const result = await runtime.embed({ texts: [source.text], inputType: "passage", signal: deps.signal });
      // 本地推理可能忽略取消；结果提交前再次检查，保留缺失项供下一轮恢复。
      await deps.checkpoint?.();
      deps.signal?.throwIfAborted();
      const vector = result.embeddings[0];
      if (vector?.length) {
        const saved = deps.store.upsertOcrEmbedding(
          source.id,
          fingerprint,
          vector,
          (deps.now?.() ?? new Date()).toISOString(),
          runtime.descriptor.ref.kind === "auto" ? "unavailable" : runtime.descriptor.ref.model
        );
        if (saved) embedded += 1;
      }
    } catch (error) {
      if (deps.signal?.aborted) throw error;
    }
    if ((index + 1) % 4 === 0 || index === sources.length - 1) {
      await delay(250, undefined, { signal: deps.signal });
    }
  }
  return embedded;
}
