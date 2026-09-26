/** 将近期 Activity 变成本轮聊天的短引用；语义匹配只读已有本地 OCR 向量。 */
import type { EmbeddingModelRuntime } from "../llm/embedding/types.js";
import { cosineSimilarity } from "../llm/embedding/vector.js";
import { redactSecrets } from "../utils/secrets.js";
import { isBareGreeting, recentActivityForGreeting } from "./greeting.js";
import type { ActivityStore } from "./store.js";

const relevantLookbackMs = 24 * 60 * 60 * 1_000;
const relevantThreshold = 0.75;
const relevantTimeoutMs = 350;

export interface ActivityChatContext {
  kind: "greeting" | "relevant";
  text: string;
}

export async function activityContextForTurn(options: {
  store: ActivityStore;
  input: string;
  now: Date;
  enabled: boolean;
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  signal?: AbortSignal;
}): Promise<ActivityChatContext | undefined> {
  if (!options.enabled) return undefined;
  if (isBareGreeting(options.input)) {
    const text = recentActivityForGreeting(options.store, options.input, options.now);
    return text ? { kind: "greeting", text } : undefined;
  }
  if (options.input.trim().length < 4) return undefined;

  // 本地模型可能正在加载或暂时卡住；辅助召回不能延迟主聊天请求。
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(undefined); }, relevantTimeoutMs);
  });
  try {
    const candidate = relevantActivityForChat(options.store, options.input, options.now,
      options.getEmbeddingRuntime, controller.signal).catch(() => undefined);
    const text = await Promise.race([candidate, timeout]);
    return text && !controller.signal.aborted ? { kind: "relevant", text } : undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function relevantActivityForChat(
  store: ActivityStore,
  input: string,
  now: Date,
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>,
  signal: AbortSignal
): Promise<string | undefined> {
  signal.throwIfAborted();
  const runtime = await getEmbeddingRuntime();
  signal.throwIfAborted();
  if (runtime?.descriptor.source !== "local" || runtime.descriptor.ref.kind !== "local"
    || runtime.descriptor.ref.model !== "multilingual-e5-small") return undefined;
  const rows = store.listOcrEmbeddingRows(runtime.fingerprint, 5_000);
  if (!rows.length) return undefined;
  const embedded = await runtime.embed({ texts: [input], inputType: "query", signal });
  signal.throwIfAborted();
  const query = embedded.embeddings[0];
  if (!query || embedded.fingerprint !== runtime.fingerprint) return undefined;

  const since = now.getTime() - relevantLookbackMs;
  const best = new Map<string, number>();
  // OCR 向量先形成有界命中窗口，再筛时间和会话；窗口外的分析不会补位。
  const hits = rows
    .map((row) => ({ row, score: cosineSimilarity(query, row.embedding) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
  for (const { row, score } of hits) {
    if (!Number.isFinite(row.createdAt) || row.createdAt < since) continue;
    if (score < relevantThreshold) continue;
    const previous = best.get(row.sessionId);
    if (previous === undefined || score > previous) best.set(row.sessionId, score);
  }
  const lines = [...best]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([id, score]) => ({ session: store.getSessionRecord(id), analysis: store.getAnalysis(id), score }))
    .filter(({ session, analysis }) => session !== undefined && Boolean(analysis?.title?.trim()))
    .map(({ session, analysis, score }) => {
      const ageMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(session!.startedAt)) / 60_000));
      const durationMinutes = Math.max(0, Math.round(((session!.endedAt ? Date.parse(session!.endedAt) : now.getTime()) - Date.parse(session!.startedAt)) / 60_000));
      const age = ageMinutes < 60 ? `${ageMinutes} 分钟前` : `${Math.round(ageMinutes / 60)} 小时前`;
      const project = analysis!.project ? ` [${analysis!.project}]` : "";
      const description = (analysis!.description ?? analysis!.summary).replace(/\s+/gu, " ").slice(0, 160);
      return `- ${age}，约 ${durationMinutes} 分钟：${analysis!.title}${project} — ${description}（相似度 ${score.toFixed(2)}）`;
    });
  if (!lines.length) return undefined;
  return redactSecrets(["## 与当前消息相关的过往活动", ...lines].join("\n")).slice(0, 800);
}
