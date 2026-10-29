import { randomUUID } from "node:crypto";
import { maskJson, restoreJson } from "./json.js";
import { SseRestorer } from "./stream.js";
import { recordMask } from "./record.js";
import { requestPreview } from "./requestPreview.js";
import { RedactionStore } from "./store.js";
import { restorePlaceholders } from "./placeholders.js";
import { globalConfigDir } from "../config/paths.js";
import { redactionWanted, type RedactionSettings } from "./settings.js";

export interface PrivacyFetchContext { settings: RedactionSettings; provider: string; model: string }
const stores = new Map<string, RedactionStore>();
const MAX_BODY = 16_000_000;

function sessionStore(sessionId: string | undefined): RedactionStore {
  if (!sessionId) return new RedactionStore(randomUUID());
  const key = JSON.stringify([globalConfigDir(), sessionId]);
  let store = stores.get(key);
  if (!store) {
    if (stores.size >= 128) stores.delete(stores.keys().next().value!);
    store = new RedactionStore(sessionId);
  }
  stores.delete(key); stores.set(key, store);
  return store;
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out + decoder.decode();
      out += decoder.decode(value, { stream: true });
      if (out.length > MAX_BODY) throw new Error("Privacy request body limit reached.");
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}

/** 未能处理的请求直接报错，调用下层 fetch 前完成全部脱敏。 */
export function createPrivacyFetch(baseFetch: typeof globalThis.fetch, context: PrivacyFetchContext): typeof globalThis.fetch {
  if (!redactionWanted(context.settings)) return baseFetch;
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const sessionId = headers.get("x-session-id") ?? undefined;
    let body = init?.body;
    if (body == null && input instanceof Request && input.body) body = await readBody(input.clone().body!);
    if (body != null && typeof body !== "string") throw new Error("Privacy requires a JSON text request body.");
    if (body == null) return await baseFetch(input, init);
    if (body.length > MAX_BODY) throw new Error("Privacy request body limit reached.");
    let request: { model?: unknown; stream?: unknown } | null;
    try { request = JSON.parse(body); } catch { throw new Error("Privacy cannot mask malformed request JSON."); }
    const store = sessionStore(sessionId);
    const values = store.snapshot();
    const result = maskJson(body, context.settings, store);
    // 捕获所属会话已知值与本次发送值；后续请求、容量淘汰均不改变正在返回的回复。
    for (const group of result.segments) for (const segment of group.segments) values.set(segment.masked, segment.original);
    const restore = (text: string, json = false): string => restorePlaceholders(text, values, json);
    const kinds = [...new Set([...values.keys()].map(tag => tag.slice(2, tag.lastIndexOf("_"))))];
    // 无论是否命中敏感内容都记录一次请求，便于在设置里观测实际发出去的内容；未命中的计数为 0。
    recordMask({ provider: context.provider, model: typeof request?.model === "string" ? request.model : context.model,
      sessionId, operation: headers.get("x-biny-operation") ?? "agent", segments: result.segments,
      preview: requestPreview(body, result), requestBytes: Buffer.byteLength(body, "utf8") });
    headers.delete("content-length");
    signal?.throwIfAborted();
    const response = await baseFetch(input, { ...init, headers, body: result.text });
    if (!response.body || values.size === 0) return response;
    const requestUrl = input instanceof Request ? input.url : String(input);
    const inferredSse = request?.stream === true || requestUrl.includes(":streamGenerateContent");
    const contentType = response.headers.get("content-type") ?? (inferredSse ? "text/event-stream" : "application/json");
    if (!contentType.includes("json") && !contentType.includes("event-stream")) return response;
    const reader = response.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
    const sse = contentType.includes("event-stream") ? new SseRestorer(restore, kinds) : undefined;
    let buffer = "";
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
            let output = "";
            if (sse) output = sse.push(text, done);
            else {
              buffer += text;
              if (buffer.length > MAX_BODY) throw new Error("Privacy response body limit reached.");
              if (done) output = restoreJson(buffer, restore);
            }
            if (output) controller.enqueue(encoder.encode(output));
            if (done) { reader.releaseLock(); controller.close(); }
            if (output || done) return;
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } }
    });
    const nextHeaders = new Headers(response.headers);
    nextHeaders.delete("content-length"); nextHeaders.delete("content-encoding");
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: nextHeaders });
  };
}
