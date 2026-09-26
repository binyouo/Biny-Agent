/** CLI 与 Agent 共用本地连接客户端；密钥只从私有文件读取，不进入工具参数或结果。 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { globalAgentDir } from "../config/paths.js";
import { BrowserRelayError, isRelayMutation, relaySchemas, relayStatusSchema, type RelayMethod } from "./relayProtocol.js";

export const relayCredentialsSchema = z.object({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/) });
export function browserRelayFile(): string { return path.join(globalAgentDir(), "browser-relay.json"); }

export async function requestBrowserRelay(method: RelayMethod, args: unknown = {}, options: { file?: string; signal?: AbortSignal } = {}): Promise<unknown> {
  const validated = relaySchemas[method].safeParse(args);
  if (!validated.success) throw new BrowserRelayError("invalid", "浏览器参数无效，请核对连接 ID、标签 ID 和操作参数。");
  const parsed = validated.data;
  options.signal?.throwIfAborted();
  let credentials: z.infer<typeof relayCredentialsSchema>;
  try { credentials = relayCredentialsSchema.parse(JSON.parse(await readFile(options.file ?? browserRelayFile(), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && method === "status") return { running: false, connected: false, browsers: [] };
    throw new BrowserRelayError("unavailable", "真实浏览器连接不可用。请启动 Biny Desktop，在设置 → 浏览器连接扩展。");
  }
  options.signal?.throwIfAborted();
  let receivedResponse = false;
  try {
    const response = await fetch(`http://127.0.0.1:${credentials.port}/command`, {
      method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, args: parsed }),
      signal: AbortSignal.any([AbortSignal.timeout(18000), ...(options.signal ? [options.signal] : [])])
    });
    receivedResponse = true;
    // 服务端和扩展均限制载荷，客户端仍独立约束错误端点返回。
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error("empty response");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 13 * 1024 * 1024) throw new Error("response too large");
        chunks.push(chunk);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const value = z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), result: z.unknown() }),
      z.object({ ok: z.literal(false), code: z.enum(["unavailable", "invalid", "busy", "unknown"]), error: z.string().max(1000) })
    ]).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!value.ok && response.status === 400) throw new BrowserRelayError(value.code, value.error);
    if (!value.ok || response.status !== 200) throw new Error("unexpected response status");
    return method === "status" ? relayStatusSchema.parse(value.result) : value.result;
  } catch (error) {
    if (error instanceof BrowserRelayError) throw error;
    const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
    if (method === "status" && !options.signal?.aborted && cause?.code === "ECONNREFUSED") return { running: false, connected: false, browsers: [] };
    if (receivedResponse && !options.signal?.aborted) throw new BrowserRelayError(isRelayMutation(method) ? "unknown" : "invalid", isRelayMutation(method)
      ? "浏览器操作已请求，但响应无效，结果未确认；请检查页面，不会自动重试。"
      : "浏览器连接返回异常响应，请检查 Biny Desktop 的连接服务；当前浏览器状态无法确认。");
    throw new BrowserRelayError(isRelayMutation(method) ? "unknown" : "unavailable", isRelayMutation(method)
      ? "浏览器操作的结果未确认，请检查目标页面；不会自动重试。"
      : "真实浏览器连接中断或请求已取消，请检查连接后重新列出标签。");
  }
}
