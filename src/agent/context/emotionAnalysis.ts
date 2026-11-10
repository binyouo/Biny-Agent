/**
 * 对话上下文情绪的低频分析与防抖调度。
 *
 * 分析只读取当前 session 的活动消息路径，输出仅允许更新 context 情绪；模型失败、解析
 * 失败或结果没有变化都静默结束，不把这条旁路变成主回合的依赖。
 */
import type { AgentModel, AgentUsage, ModelRequestContext, ModelRequestMetrics } from "../core/types.js";
import { z } from "zod";
import type { UsageModelInfo, UsageModelInfoResolver } from "../../observability/usage.js";
import { generateNativeText } from "../../llm/nativeJson.js";
import { DEFAULT_EMOTION_STATE, type EmotionState } from "./emotionTypes.js";
import { EmotionStorage } from "./emotionStorage.js";

const analysisDelayMs = 5_000;
const recentMessageLimit = 10;
const recentMessageMaxChars = 150;
const autoEmotionResultSchema = z.object({
  mood: z.string().trim().min(1).max(40),
  valence: z.number(),
  reason: z.string().trim().max(200)
});
const autoEmotionSystemPrompt = [
  "You analyze chat conversation sentiment FROM BINY'S PERSPECTIVE. Biny is an AI participant in this chat. Based on the recent messages, determine how Biny should feel right now.",
  "Return exactly one JSON object with exactly these three fields: mood, valence, and reason. Do not include Markdown or other text.",
  "- mood: one word (happy, excited, amused, content, neutral, bored, annoyed, sad, upset, angry)",
  "- valence: 0-10 (0=very negative, 5=neutral, 10=very positive). Let it actually swing: boredom, friction, dead ends and being rushed pull it down; wins, playful banter and curiosity push it up. Reserve 5-7 for genuinely flat exchanges — a routine task that just works is closer to 7, a grind is not.",
  "- reason: brief reason (under 20 chars)",
  "Examples:",
  '{"mood":"happy","valence":8,"reason":"大家聊得很开心"}',
  '{"mood":"annoyed","valence":3,"reason":"有人在骂我"}',
  '{"mood":"bored","valence":4,"reason":"重复枯燥的调试"}',
  '{"mood":"amused","valence":7,"reason":"话题很有趣"}',
  '{"mood":"neutral","valence":5,"reason":"普通闲聊"}',
  "This is only an expression context. Do not infer permissions, task status, security decisions, or verified facts."
].join("\n");

export interface EmotionAnalysisMessage {
  role: "user" | "assistant";
  text: string;
}

export type EmotionAnalysisFailure = "invalid_json" | "invalid_shape";

export interface AnalyzeContextEmotionOptions {
  sessionId: string;
  storage: EmotionStorage;
  getModel: () => AgentModel | undefined;
  getMessages: () => Promise<readonly EmotionAnalysisMessage[]>;
  now?: () => Date;
  signal?: AbortSignal;
  onUsage?: (usage: AgentUsage, model?: Readonly<UsageModelInfo>) => void | Promise<void>;
  getUsageModelInfo?: UsageModelInfoResolver;
  onRequestMetrics?: (metrics: ModelRequestMetrics) => void | Promise<void>;
  requestContext?: ModelRequestContext;
  /** 分析产出有效结果即触发；updated 区分是否实际写入了新的 context 快照。 */
  onAnalyzed?: (state: EmotionState, updated: boolean) => void | Promise<void>;
  /** 模型给出了输出但无法解析或结构不符时触发；请求本身的错误仍向上传播。 */
  onFailed?: (reason: EmotionAnalysisFailure) => void | Promise<void>;
  onUpdated?: (state: EmotionState) => void | Promise<void>;
}

export async function analyzeContextEmotion(options: AnalyzeContextEmotionOptions): Promise<EmotionState | undefined> {
  const model = options.getModel();
  if (!model) return undefined;
  const usageModel = options.getUsageModelInfo?.(model);
  const messages = normalizeMessages(await options.getMessages());
  if (!messages.length) return undefined;

  const result = await generateNativeText(
    model,
    [{
      role: "user",
      content: [{ type: "text", text: [
        "Recent conversation:",
        ...messages.map((message) => `${message.role}: ${message.text}`)
      ].join("\n") }]
    }],
    {
      systemPrompt: autoEmotionSystemPrompt,
      signal: options.signal,
      maxOutputTokens: 50,
      reasoning: "off",
      timeoutMs: 10_000,
      onRequestMetrics: options.onRequestMetrics,
      requestContext: options.requestContext
    }
  );
  if (result.usage) await options.onUsage?.(result.usage, usageModel);
  options.signal?.throwIfAborted();

  // 小模型常带代码围栏或前后缀文字：剥围栏后取首个 { 到末位 } 的片段再解析。
  const unfenced = result.text.trim().replace(/^```[a-zA-Z]*\s*/u, "");
  const cleaned = unfenced.replace(/\s*```$/u, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  let parsed: unknown;
  try { parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned); }
  catch {
    await options.onFailed?.("invalid_json");
    return undefined;
  }
  const record = parsed as { valence?: unknown } | null;
  if (record !== null && typeof record === "object" && typeof record.valence === "string") {
    record.valence = Number(record.valence);
  }
  const validated = autoEmotionResultSchema.safeParse(parsed);
  if (!validated.success) {
    await options.onFailed?.("invalid_shape");
    return undefined;
  }
  const now = options.now ?? (() => new Date());
  const nextState: EmotionState = {
    mood: validated.data.mood,
    valence: Math.min(10, Math.max(0, Math.round(validated.data.valence))),
    energy: (await options.storage.readBase())?.energy ?? DEFAULT_EMOTION_STATE.energy,
    updatedAt: now().toISOString(),
    trigger: validated.data.reason || undefined
  };
  const previous = await options.storage.readContext(options.sessionId);
  if (
    previous?.mood === nextState.mood
    && previous.valence === nextState.valence
    && previous.trigger === nextState.trigger
  ) {
    await options.onAnalyzed?.(nextState, false);
    return undefined;
  }

  await options.storage.writeContext(options.sessionId, nextState, options.signal);
  await options.onAnalyzed?.(nextState, true);
  await options.onUpdated?.(nextState);
  return nextState;
}

export interface EmotionAnalysisSchedulerOptions {
  delayMs?: number;
  analyze: (sessionId: string, signal: AbortSignal, messageId?: string) => void | Promise<void>;
  timers?: {
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  };
}

const defaultTimers: NonNullable<EmotionAnalysisSchedulerOptions["timers"]> = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

export class EmotionAnalysisScheduler {
  private readonly delayMs: number;
  private readonly analyze: EmotionAnalysisSchedulerOptions["analyze"];
  private readonly timers: NonNullable<EmotionAnalysisSchedulerOptions["timers"]>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(options: EmotionAnalysisSchedulerOptions) {
    this.delayMs = options.delayMs ?? analysisDelayMs;
    this.analyze = options.analyze;
    this.timers = options.timers ?? defaultTimers;
  }

  schedule(sessionId: string, messageId?: string): void {
    if (this.closed) return;
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const timer = this.timers.setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      const task = Promise.resolve().then(() => this.analyze(sessionId, controller.signal, messageId)).catch(() => undefined).finally(() => {
        if (this.controller === controller) this.controller = undefined;
        this.pending.delete(task);
      });
      this.pending.add(task);
    }, this.delayMs);
    this.timer = timer;
    timer.unref?.();
  }

  cancel(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  /** Cancel promptly, then join every admitted analysis, including superseded work. */
  async cancelAndDrain(): Promise<void> {
    this.cancel();
    await Promise.allSettled([...this.pending]);
  }

  /** Terminal disposal seals timer admission synchronously before joining active work. */
  close(): Promise<void> {
    this.closed = true;
    return this.cancelAndDrain();
  }
}

function normalizeMessages(messages: readonly EmotionAnalysisMessage[]): EmotionAnalysisMessage[] {
  return messages
    .map((message) => ({
      role: message.role,
      text: Array.from(message.text).slice(0, recentMessageMaxChars).join("")
    }))
    .filter((message) => message.text.trim())
    .slice(-recentMessageLimit);
}
