/** 真实浏览器连接的协议边界；会话标识防止重连后误用旧标签 ID。 */
import { z } from "zod";

export const relayUrlSchema = z.string().url().max(4096).refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "浏览器仅支持不含凭据的 HTTP(S) 地址。");
export const relayTargetSchema = z.object({ browserId: z.string().uuid(), tabId: z.number().int().nonnegative() }).strict();
const selectorSchema = z.string().trim().min(1).max(2000);
const frame = { frameId: z.string().min(1).max(200).optional(), documentId: z.string().min(1).max(200).optional() };
const locating = { ...frame, selector: selectorSchema, timeoutMs: z.number().int().min(0).max(8000).optional() };
export const relayBinarySchema = z.object({ mimeType: z.string().max(120), data: z.string().max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
export const relaySchemas = {
  status: z.object({}).strict(),
  tabs: z.object({ browserId: z.string().uuid().optional() }).strict(),
  read: relayTargetSchema.extend({ ...frame, maxCharacters: z.number().int().min(1000).max(100000).optional() }),
  navigate: relayTargetSchema.extend({ url: relayUrlSchema, waitUntil: z.enum(["none", "domcontentloaded", "load"]).optional(), timeoutMs: z.number().int().min(0).max(8000).optional() }),
  click: relayTargetSchema.extend(locating),
  fill: relayTargetSchema.extend({ ...locating, value: z.string().max(50000) }),
  press: relayTargetSchema.extend({ ...locating, selector: selectorSchema.optional(), key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }),
  screenshot: relayTargetSchema.extend({ fullPage: z.boolean().optional() }),
  scroll: relayTargetSchema.extend({ ...frame, selector: selectorSchema.optional(), deltaX: z.number().min(-10000).max(10000).optional(), deltaY: z.number().min(-10000).max(10000) }),
  wait: relayTargetSchema.extend({ ...frame, selector: selectorSchema.optional(), state: z.enum(["visible", "hidden", "attached", "domcontentloaded", "load"]).optional(), timeoutMs: z.number().int().min(0).max(8000).optional() }),
  upload: relayTargetSchema.extend({ ...locating, files: z.array(z.object({ name: z.string().min(1).max(200).regex(/^[^/\\\x00]+$/), mimeType: z.string().max(120), data: relayBinarySchema.shape.data })).min(1).max(10) }),
  download: relayTargetSchema.extend({ ...frame, url: relayUrlSchema, timeoutMs: z.number().int().min(1).max(8000).optional() })
};
export type RelayMethod = keyof typeof relaySchemas;
export const relayStatusSchema = z.object({
  running: z.boolean(), connected: z.boolean(),
  browsers: z.array(z.object({ browserId: z.string().uuid(), browserName: z.string().trim().min(1).max(80) })).max(8)
}).refine((value) => value.connected === (value.browsers.length > 0) && (!value.connected || value.running), "连接状态不完整。");
export type RelayStatus = z.infer<typeof relayStatusSchema>;
export const relayTabSchema = z.object({ id: z.number().int().nonnegative(), windowId: z.number().int(), url: relayUrlSchema, title: z.string().max(4096), active: z.boolean() });
export const relayPageSchema = z.object({
  url: relayUrlSchema, title: z.string().max(4096), text: z.string().max(100000),
  interactive: z.array(z.object({ tag: z.string(), name: z.string(), selector: z.string() })).max(200),
  frameId: z.string().optional(), documentId: z.string().optional(),
  frames: z.array(z.object({ frameId: z.string(), documentId: z.string(), url: z.string() })).max(200).optional()
});
export function isRelayMutation(method: RelayMethod): boolean { return !["status", "tabs", "read", "screenshot", "wait"].includes(method); }

export class BrowserRelayError extends Error {
  constructor(readonly code: "unavailable" | "invalid" | "busy" | "unknown", message: string) { super(message); this.name = "BrowserRelayError"; }
}
