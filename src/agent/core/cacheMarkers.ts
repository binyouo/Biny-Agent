/**
 * Prompt 缓存标记。
 *
 * Agent 每轮请求的前缀（system prompt + 历史）几乎不变，按协议给稳定段打缓存标记能
 * 命中服务商的 prompt cache：输入按约 1/10 计费、首字延迟更低。两种协议形态不同：
 * - anthropic_messages：内容块级 `cache_control` 断言点（经 providerOptions.anthropic）；
 *   system 走 streamText 的 instructions 选项，SDK 禁止 messages 携带 system 消息，
 *   所以这里把 instructions 包装成带标记的 SystemModelMessage 数组。
 * - openai-compatible：消息级 `cache_control` 字段（经 providerOptions.openaiCompatible，
 *   SDK 会把它展开进请求 JSON 的消息对象）；对尾部两条消息打标，与 。
 * responses / google_generative_ai 是隐式缓存，不下发标记。
 */
import type { ModelMessage, SystemModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import type { CacheMarkerPlan } from "./types.js";

const ephemeral = { type: "ephemeral" } as const;

/** 按 api 后端决定缓存标记计划；隐式缓存的协议返回 undefined。 */
export function cacheMarkerPlanFor(api: string): CacheMarkerPlan | undefined {
  if (api === "anthropic_messages") return { protocol: "anthropic" };
  if (api === "responses" || api === "google_generative_ai") return undefined;
  return { protocol: "openai-compatible" };
}

/**
 * 组装 streamText 的 instructions：anthropic 协议把 system 包装成带断言点的
 * SystemModelMessage 数组，其余协议维持字符串。
 */
export function markInstructions(
  systemPrompt: string | undefined,
  plan: CacheMarkerPlan | undefined
): string | SystemModelMessage[] | undefined {
  if (!systemPrompt) return undefined;
  if (plan?.protocol === "anthropic") {
    return [{ role: "system", content: systemPrompt, providerOptions: { anthropic: { cacheControl: ephemeral } } }];
  }
  return systemPrompt;
}

/** 给请求尾部消息打缓存标记；返回浅拷贝，不改 canonical 消息。 */
export function applyCacheMarkers(messages: ModelMessage[], plan: CacheMarkerPlan | undefined): ModelMessage[] {
  if (!plan || messages.length === 0) return messages;
  return plan.protocol === "anthropic" ? markAnthropicTail(messages) : markOpenAICompatibleTail(messages);
}

function markOpenAICompatibleTail(messages: ModelMessage[]): ModelMessage[] {
  const firstMarked = Math.max(0, messages.length - 2);
  return messages.map((message, index) => index < firstMarked
    ? message
    : {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        openaiCompatible: { cache_control: ephemeral }
      }
    });
}

function markAnthropicTail(messages: ModelMessage[]): ModelMessage[] {
  // 断言点放在倒数第二条消息的最后一个稳定内容块：末条消息（最新输入/工具结果）要到
  // 下一轮才进入可复用前缀，现在标记只会白白扩大当轮的 cache write。
  if (messages.length < 2) return messages;
  const index = messages.length - 2;
  const message = messages[index]!;
  const marked = markLastStablePart(message);
  if (marked === undefined) return messages;
  return [...messages.slice(0, index), marked, ...messages.slice(index + 1)];
}

function markLastStablePart(message: ModelMessage): ModelMessage | undefined {
  if (message.role === "system") return undefined;
  if (typeof message.content === "string") {
    // 字符串内容只出现在 user 消息上；转为单 text part 才能携带断言点。
    if (message.role !== "user") return undefined;
    return {
      ...message,
      content: [{ type: "text", text: message.content, providerOptions: { anthropic: { cacheControl: ephemeral } } }]
    };
  }
  const parts = [...message.content];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    // 断言点只打在稳定内容块上；思考与审批分块不能标。
    if (!isMarkablePart(part)) continue;
    parts[index] = { ...part, providerOptions: { ...part.providerOptions, anthropic: { cacheControl: ephemeral } } };
    return { ...message, content: parts } as ModelMessage;
  }
  return undefined;
}

/** anthropic 断言点的合法载体；思考/审批分块不接受 cache_control。 */
function isMarkablePart(part: unknown): part is TextPart | ToolCallPart | ToolResultPart {
  const candidate = part as { type?: string } | undefined;
  return candidate?.type === "text" || candidate?.type === "tool-call" || candidate?.type === "tool-result";
}
