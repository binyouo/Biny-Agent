/**
 * Agent 情绪状态的共享类型与纯计算规则。
 *
 * 情绪只影响表达层。状态本身由 Markdown 存储，blendEmotion 负责在注入 prompt 前处理
 * 时间衰减与 base/context 融合。
 */

export interface EmotionState {
  mood: string;
  valence: number;
  energy: number;
  updatedAt: string;
  trigger?: string;
}

export type EmotionScope = "base" | "context";

export interface BlendedEmotion extends EmotionState {
  fatigue: number;
  base?: EmotionState;
  context?: EmotionState;
  source: "base" | "context" | "blended";
}

export const BASE_DECAY_MS = 6 * 60 * 60 * 1_000;
export const CONTEXT_DECAY_MS = 2 * 60 * 60 * 1_000;
export const EMOTION_RESTING_VALENCE = 6;

export const DEFAULT_EMOTION_STATE: EmotionState = {
  mood: "cheerful",
  valence: 7,
  energy: 7,
  updatedAt: "",
  trigger: "default personality — curious, slightly sassy, warm"
};

/**
 * 计算当前真正注入模型的情绪。
 *
 * 每层的 valence 会线性回到 6；超过窗口后该层变成 cheerful/6，但仍保留它作为一条
 * 已存在的层参与融合。context 的 mood 优先，valence 按 0.3/0.7 融合，energy 以 base
 * 为准。没有 base 文件时使用默认 cheerful base 作为锚点。
 */
export function blendEmotion(
  base: EmotionState | undefined,
  context: EmotionState | undefined,
  fatigue: number,
  now: Date = new Date()
): BlendedEmotion {
  const effectiveBase = decayState(base ?? DEFAULT_EMOTION_STATE, BASE_DECAY_MS, now);
  const effectiveContext = context === undefined
    ? undefined
    : decayState(context, CONTEXT_DECAY_MS, now);
  const normalizedFatigue = clamp(fatigue, 0, 100);

  const state = effectiveContext === undefined
    ? effectiveBase
    : {
      mood: effectiveContext.mood,
      valence: Math.round(0.3 * effectiveBase.valence + 0.7 * effectiveContext.valence),
      energy: effectiveBase.energy,
      updatedAt: effectiveContext.updatedAt || effectiveBase.updatedAt,
      trigger: effectiveContext.trigger ?? effectiveBase.trigger
    };
  const source: BlendedEmotion["source"] = effectiveContext === undefined
    ? "base"
    : base === undefined ? "context" : "blended";

  return {
    ...state,
    fatigue: normalizedFatigue,
    base: effectiveBase,
    context: effectiveContext,
    source
  };
}

function decayState(
  state: EmotionState,
  decayMs: number,
  now: Date
): EmotionState {
  const updatedAt = Date.parse(state.updatedAt);
  const currentTime = now.getTime();
  if (!state.updatedAt || !Number.isFinite(updatedAt) || !Number.isFinite(currentTime)) return normalizeState(state);
  const age = currentTime - updatedAt;
  if (age <= 0) return normalizeState(state);
  if (age > decayMs) {
    return {
      ...normalizeState(state),
      mood: DEFAULT_EMOTION_STATE.mood,
      valence: EMOTION_RESTING_VALENCE
    };
  }
  const normalized = normalizeState(state);
  return {
    ...normalized,
    valence: Math.round(normalized.valence + (EMOTION_RESTING_VALENCE - normalized.valence) * (age / decayMs))
  };
}

function normalizeState(state: EmotionState): EmotionState {
  return {
    mood: state.mood.trim() || DEFAULT_EMOTION_STATE.mood,
    valence: clamp(state.valence, 0, 10),
    energy: clamp(state.energy, 0, 10),
    updatedAt: state.updatedAt,
    trigger: state.trigger?.trim() || undefined
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
