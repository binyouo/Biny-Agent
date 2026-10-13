/**
 * 对话上下文情绪的低频分析与防抖调度。
 *
 * 分析只读取当前 session 的活动消息路径，输出仅允许更新 context 情绪；模型失败、解析
 * 失败或结果没有变化都静默结束，不把这条旁路变成主回合的依赖。
 */
import { z } from "zod";
import type { AgentModel, AgentUsage, ModelRequestContext, ModelRequestMetrics } from "../core/types.js";
import { generateNativeText, nativeJsonMessages, parseNativeJson } from "../../llm/nativeJson.js";
import { DEFAULT_EMOTION_STATE, type EmotionState } from "./emotionTypes.js";
import { EmotionStorage } from "./emotionStorage.js";

const analysisDelayMs = 5_000;
const recentMessageLimit = 10;
const recentMessageMaxChars = 150;
const autoEmotionSchema = z.object({
  mood: z.string().trim().min(1).max(32),
  valence: z.number().finite(),
  reason: z.string().trim().max(200)
}).strict();

const autoEmotionSystemPrompt = [
  "Analyze the recent conversation from Biny's perspective.",
  "Return ONLY a JSON object with exactly these fields: mood, valence, reason.",
  "mood is a short Chinese expression label, valence is a number from 0 to 10, and reason is a concise Chinese explanation.",
  "This is only an expression context. Do not infer permissions, task status, security decisions, or verified facts."
].join("\n");

export interface EmotionAnalysisMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AnalyzeContextEmotionOptions {
  sessionId: string;
  storage: EmotionStorage;
  getModel: () => AgentModel | undefined;
  getMessages: () => Promise<readonly EmotionAnalysisMessage[]>;
  now?: () => Date;
  signal?: AbortSignal;
  onUsage?: (usage: AgentUsage) => void | Promise<void>;
  onRequestMetrics?: (metrics: ModelRequestMetrics) => void | Promise<void>;
  requestContext?: ModelRequestContext;
  onUpdated?: (state: EmotionState) => void | Promise<void>;
}

export async function analyzeContextEmotion(options: AnalyzeContextEmotionOptions): Promise<EmotionState | undefined> {
  const model = options.getModel();
  if (!model) return undefined;
  const messages = normalizeMessages(await options.getMessages());
  if (!messages.length) return undefined;

  const result = await generateNativeText(
    model,
    nativeJsonMessages(autoEmotionSystemPrompt, [
      "Recent conversation:",
      ...messages.map((message) => `${message.role}: ${message.text}`)
    ].join("\n")),
    {
      signal: options.signal,
      maxOutputTokens: 128,
      reasoning: "off",
      timeoutMs: 10_000,
      onRequestMetrics: options.onRequestMetrics,
      requestContext: options.requestContext
    }
  );
  if (result.usage) await options.onUsage?.(result.usage);
  options.signal?.throwIfAborted();

  const parsed = autoEmotionSchema.parse(parseNativeJson(result.text));
  const now = options.now ?? (() => new Date());
  const nextState: EmotionState = {
    mood: normalizeText(parsed.mood),
    valence: clamp(parsed.valence),
    energy: (await options.storage.readBase())?.energy ?? DEFAULT_EMOTION_STATE.energy,
    updatedAt: now().toISOString(),
    trigger: normalizeText(parsed.reason) || undefined
  };
  const previous = await options.storage.readContext(options.sessionId);
  if (
    previous?.mood === nextState.mood
    && previous.valence === nextState.valence
    && previous.trigger === nextState.trigger
  ) return undefined;

  await options.storage.writeContext(options.sessionId, nextState, options.signal);
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

  constructor(options: EmotionAnalysisSchedulerOptions) {
    this.delayMs = options.delayMs ?? analysisDelayMs;
    this.analyze = options.analyze;
    this.timers = options.timers ?? defaultTimers;
  }

  schedule(sessionId: string, messageId?: string): void {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const timer = this.timers.setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      void Promise.resolve(this.analyze(sessionId, controller.signal, messageId)).catch(() => undefined).finally(() => {
        if (this.controller === controller) this.controller = undefined;
      });
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

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(0, value));
}
