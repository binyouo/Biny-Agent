import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getSharedProxyAwareFetch } from "../network/proxyFetch.js";
import { globalConfigDir, workspaceAgentDir } from "../config/paths.js";
import { redactSecrets } from "../utils/secrets.js";

const telegramApiBase = "https://api.telegram.org";
const telegramLongPollSeconds = 50;
const telegramTextLimit = 4_000;
const telegramMediaLimitBytes = 20 * 1024 * 1024;

const telegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional()
}).passthrough();

const telegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional()
}).passthrough();

const telegramPhotoSizeSchema = z.object({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional()
}).passthrough();

const telegramFileSchema = z.object({
  file_path: z.string().min(1),
  file_size: z.number().int().nonnegative().optional()
}).passthrough();

const telegramFileContentSchema = z.object({
  file_id: z.string().min(1),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().int().nonnegative().optional()
}).passthrough();

const telegramReactionSchema = z.object({
  type: z.enum(["emoji", "custom_emoji", "paid"]),
  emoji: z.string().optional(),
  custom_emoji_id: z.string().optional()
}).passthrough();

export const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  from: telegramUserSchema.optional(),
  chat: telegramChatSchema,
  text: z.string().optional(),
  caption: z.string().optional(),
  message_thread_id: z.number().int().positive().optional(),
  media_group_id: z.string().optional(),
  photo: z.array(telegramPhotoSizeSchema).optional(),
  animation: telegramFileContentSchema.optional(),
  audio: telegramFileContentSchema.optional(),
  document: telegramFileContentSchema.optional(),
  video: telegramFileContentSchema.optional(),
  video_note: telegramFileContentSchema.optional(),
  voice: telegramFileContentSchema.optional(),
  new_chat_members: z.array(telegramUserSchema).optional(),
  sticker: telegramFileContentSchema.extend({
    emoji: z.string().optional(),
    set_name: z.string().optional(),
    is_animated: z.boolean().optional(),
    is_video: z.boolean().optional()
  }).optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).passthrough().optional(),
  contact: z.object({
    first_name: z.string(),
    last_name: z.string().optional(),
    phone_number: z.string().optional()
  }).passthrough().optional(),
  poll: z.object({
    question: z.string(),
    options: z.array(z.object({ text: z.string() }).passthrough()).optional()
  }).passthrough().optional(),
  reply_to_message: z.object({
    from: telegramUserSchema.optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    photo: z.array(telegramPhotoSizeSchema).optional()
  }).passthrough().optional()
}).passthrough();

const telegramCallbackQuerySchema = z.object({
  id: z.string().min(1),
  from: telegramUserSchema,
  message: z.object({
    message_id: z.number().int(),
    chat: telegramChatSchema,
    text: z.string().optional(),
    caption: z.string().optional()
  }).passthrough().optional(),
  data: z.string().optional()
}).passthrough();

const telegramMessageReactionSchema = z.object({
  chat: telegramChatSchema,
  message_id: z.number().int(),
  date: z.number().int(),
  user: telegramUserSchema.optional(),
  old_reaction: z.array(telegramReactionSchema),
  new_reaction: z.array(telegramReactionSchema)
}).passthrough();

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
  message_reaction: telegramMessageReactionSchema.optional()
}).passthrough();

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

const telegramHistoryMessageSchema = z.object({
  at: z.number().int().nonnegative(),
  sender: z.string().max(120),
  text: z.string().max(2_000)
}).strict();

const telegramGroupStateSchema = z.object({
  messages: z.array(telegramHistoryMessageSchema).max(50),
  lastPatrolAt: z.number().int().nonnegative().optional(),
  lastReactionAt: z.number().int().nonnegative().optional()
}).strict();

const telegramStateSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().regex(/^[1-9]\d*$/u).optional(),
  nextUpdateId: z.number().int().nonnegative().optional(),
  pendingUpdates: z.array(telegramUpdateSchema).optional(),
  sessions: z.record(z.string(), z.string()),
  groups: z.record(z.string(), telegramGroupStateSchema)
}).strict();

export type TelegramGroupState = z.infer<typeof telegramGroupStateSchema>;
export type TelegramChannelState = z.infer<typeof telegramStateSchema>;

export interface TelegramDownloadedFile {
  filePath: string;
  bytes: Buffer;
}

export function emptyTelegramChannelState(): TelegramChannelState {
  return { version: 1, sessions: {}, groups: {} };
}

export class TelegramChannelStore {
  readonly path: string;

  constructor(readonly workspaceRoot: string) {
    this.path = path.join(workspaceAgentDir(workspaceRoot), "channels", "telegram.json");
  }

  async read(): Promise<TelegramChannelState> {
    try {
      return telegramStateSchema.parse(JSON.parse(await fs.readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if (isNotFound(error)) return emptyTelegramChannelState();
      throw error;
    }
  }

  async write(state: TelegramChannelState): Promise<void> {
    const validated = telegramStateSchema.parse(state);
    const directory = path.dirname(this.path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.path);
      await fs.chmod(this.path, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

export class TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = getSharedProxyAwareFetch()
  ) {
    if (!token.trim()) throw new Error("Telegram bot token is required.");
  }

  async getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }> {
    const result = await this.call("getMe", {}, signal);
    const parsed = z.object({ id: z.number().int(), username: z.string().optional() }).passthrough().safeParse(result);
    if (!parsed.success) throw new Error("Telegram getMe returned an invalid bot identity.");
    return parsed.data;
  }

  async getUpdates(offset: number | undefined, signal?: AbortSignal, timeoutSeconds = telegramLongPollSeconds): Promise<TelegramUpdate[]> {
    const result = await this.call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query", "message_reaction"]
    }, signal);
    if (!Array.isArray(result)) throw new Error("Telegram getUpdates returned an invalid update list.");
    return result.map((update) => telegramUpdateSchema.parse(update));
  }

  async downloadFile(fileId: string, signal?: AbortSignal): Promise<TelegramDownloadedFile> {
    const result = await this.call("getFile", { file_id: fileId }, signal);
    const file = telegramFileSchema.safeParse(result);
    if (!file.success || file.data.file_size !== undefined && file.data.file_size > telegramMediaLimitBytes) {
      throw new Error("Telegram media file is invalid or exceeds the 20 MB download limit.");
    }
    const segments = file.data.file_path.split("/");
    if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/u.test(segment) || segment === "." || segment === "..")) {
      throw new Error("Telegram returned an invalid media file path.");
    }
    const url = `${telegramApiBase}/file/bot${this.token}/${segments.map(encodeURIComponent).join("/")}`;
    const timeout = AbortSignal.timeout(60_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", redirect: "error", signal: requestSignal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new Error("Telegram media download cancelled.");
      throw new Error(redactSecrets(`Telegram media download failed: ${errorMessage(error)}`).replaceAll(this.token, "[redacted]"));
    }
    if (!response.ok) throw new Error(`Telegram media download failed (HTTP ${response.status}).`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > telegramMediaLimitBytes) {
      await response.body?.cancel();
      throw new Error("Telegram media file exceeds the 20 MB download limit.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Telegram media download returned no response body.");
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > telegramMediaLimitBytes) {
          await reader.cancel();
          throw new Error("Telegram media file exceeds the 20 MB download limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
    if (!bytes.length) throw new Error("Telegram media file is empty.");
    return { filePath: file.data.file_path, bytes };
  }

  async sendMessage(chatId: number, text: string, signal?: AbortSignal, messageThreadId?: number): Promise<void> {
    for (const part of splitTelegramText(text)) {
      if (part.trim()) await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        message_thread_id: messageThreadId
      }, signal);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text }, signal);
  }

  async setMessageReaction(chatId: number, messageId: number, emoji: string, signal?: AbortSignal): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }]
    }, signal);
  }

  async sendPhoto(chatId: number, filePath: string, caption?: string, signal?: AbortSignal, messageThreadId?: number): Promise<void> {
    const resolved = await approvedGeneratedImagePath(filePath);
    if (!resolved) throw new Error("Only images generated by Biny's image command can be sent through Telegram.");
    await this.uploadPhoto(chatId, resolved, caption, signal, messageThreadId);
  }

  async sendOwnerSelfiePhoto(ownerId: number, chatId: number, filePath: string, caption?: string, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || chatId !== ownerId) {
      throw new Error("Selfie album images can only be sent to the authenticated owner's private chat.");
    }
    const resolved = await approvedGeneratedImagePath(filePath) ?? await approvedSelfieAlbumImagePath(filePath);
    if (!resolved) throw new Error("Only Biny-generated images or approved selfie album images can be sent to the owner.");
    await this.uploadPhoto(chatId, resolved, caption, signal);
  }

  private async uploadPhoto(chatId: number, resolved: string, caption?: string, signal?: AbortSignal, messageThreadId?: number): Promise<void> {
    const file = await fs.readFile(resolved);
    if (!file.length || file.length > 10_000_000 || !isRasterImage(file)) {
      throw new Error("Telegram photo must be a valid raster image no larger than 10 MB.");
    }
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([file]), path.basename(resolved));
    if (caption?.trim()) form.append("caption", caption.slice(0, 1_024));
    if (messageThreadId !== undefined) form.append("message_thread_id", String(messageThreadId));
    await this.call("sendPhoto", form, signal);
  }

  private async call(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(method === "getUpdates" ? 60_000 : 15_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(`${telegramApiBase}/bot${this.token}/${method}`, {
        method: "POST",
        redirect: "error",
        headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new Error("Telegram request cancelled.");
      throw new Error(redactSecrets(`Telegram ${method} request failed: ${errorMessage(error)}`).replaceAll(this.token, "[redacted]"));
    }

    let payload: unknown;
    try { payload = await response.json() as unknown; }
    catch { throw new Error(`Telegram ${method} returned invalid JSON (HTTP ${response.status}).`); }
    const result = z.object({ ok: z.boolean(), result: z.unknown().optional(), description: z.string().optional() }).passthrough().safeParse(payload);
    if (!result.success || !response.ok || !result.data.ok) {
      const description = result.success ? result.data.description : undefined;
      const safeDescription = description?.replaceAll(this.token, "[redacted]");
      throw new Error(redactSecrets(`Telegram ${method} failed (HTTP ${response.status})${safeDescription ? `: ${safeDescription}` : ""}`));
    }
    return result.data.result;
  }
}

async function approvedGeneratedImagePath(filePath: string): Promise<string | undefined> {
  if (!path.isAbsolute(filePath)) return undefined;
  try {
    const tempDirectory = await fs.realpath(os.tmpdir());
    const [resolved, sourceDirectory, sourceFile] = await Promise.all([
      fs.realpath(filePath), fs.lstat(path.dirname(filePath)), fs.lstat(filePath)
    ]);
    if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink() || !sourceFile.isFile() || sourceFile.isSymbolicLink()) return undefined;
    const relative = path.relative(tempDirectory, resolved);
    const [directory, filename, ...extra] = relative.split(path.sep);
    if (extra.length || !/^biny-image-gen-[A-Za-z0-9_-]+$/u.test(directory ?? "") || !/^image\.(?:png|jpe?g|gif|webp)$/iu.test(filename ?? "")) return undefined;
    return resolved;
  } catch { return undefined; }
}

async function approvedSelfieAlbumImagePath(filePath: string): Promise<string | undefined> {
  if (!path.isAbsolute(filePath)) return undefined;
  const albumDirectory = path.join(globalConfigDir(), "selfies");
  try {
    const [resolvedDirectory, sourceDirectory, resolved, sourceFile] = await Promise.all([
      fs.realpath(albumDirectory), fs.lstat(path.dirname(filePath)), fs.realpath(filePath), fs.lstat(filePath)
    ]);
    if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink() || !sourceFile.isFile() || sourceFile.isSymbolicLink()) return undefined;
    if (await fs.realpath(path.dirname(filePath)) !== resolvedDirectory || path.dirname(resolved) !== resolvedDirectory) return undefined;
    if (!/^selfie-[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp)$/iu.test(path.basename(resolved))) return undefined;
    return resolved;
  } catch { return undefined; }
}

function isRasterImage(data: Buffer): boolean {
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || data[0] === 255 && data[1] === 216 && data[2] === 255
    || /^GIF8[79]a/u.test(data.subarray(0, 6).toString())
    || data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP";
}

export async function sendTelegramOwnerNotification(text: string, api?: TelegramBotApi): Promise<boolean> {
  const token = process.env.BINY_TELEGRAM_BOT_TOKEN?.trim();
  const ownerId = parseTelegramId(process.env.BINY_TELEGRAM_OWNER_ID);
  if (!token || ownerId === undefined || ownerId <= 0 || !text.trim()) return false;
  await (api ?? new TelegramBotApi(token)).sendMessage(ownerId, text);
  return true;
}

export function shouldTelegramGroupMessageReachAgent(
  message: TelegramMessage,
  botId: number,
  botUsername: string | undefined,
  allowedGroupIds: ReadonlySet<string>
): boolean {
  if ((message.chat.type !== "group" && message.chat.type !== "supergroup")
    || !allowedGroupIds.has(String(message.chat.id))
    || !message.from
    || message.from.is_bot
    || !telegramMessageText(message)) return false;
  if (message.reply_to_message?.from?.id === botId) return true;
  const text = message.text?.trim() || message.caption?.trim() || "";
  return botUsername !== undefined && new RegExp(`(?:^|\\s)@${escapeRegExp(botUsername)}\\b`, "iu").test(text);
}

export function telegramMessageText(message: TelegramMessage): string {
  const text = message.text?.trim() || message.caption?.trim();
  if (text) return text;
  if (message.photo?.length) return "User sent a photo.";
  if (message.animation) return `User sent an animation${fileLabel(message.animation.file_name)}.`;
  if (message.audio) return `User sent an audio file${fileLabel(message.audio.file_name)}.`;
  if (message.voice) return "User sent a voice message.";
  if (message.video || message.video_note) return "User sent a video.";
  if (message.document) return `User sent a file${fileLabel(message.document.file_name)}.`;
  if (message.sticker) {
    const details = [message.sticker.emoji, message.sticker.set_name].filter(Boolean).join("; ");
    return `User sent a sticker${details ? ` (${details})` : ""}.`;
  }
  if (message.location) return `User shared a location: ${message.location.latitude}, ${message.location.longitude}.`;
  if (message.contact) return `User shared a contact: ${[message.contact.first_name, message.contact.last_name].filter(Boolean).join(" ")}${message.contact.phone_number ? `, ${message.contact.phone_number}` : ""}.`;
  if (message.poll) return `User shared a poll: ${message.poll.question}${message.poll.options?.length ? ` (${message.poll.options.map((option) => option.text).join(" / ")})` : ""}.`;
  if (message.new_chat_members?.length) return `New group members joined: ${message.new_chat_members.map(member => member.first_name ?? member.username ?? String(member.id)).join(", ")}.`;
  return "";
}

export function telegramMessageHistoryText(messages: TelegramGroupState["messages"]): string {
  return messages.map((message) => `[${new Date(message.at).toISOString()}] ${message.sender}: ${message.text}`).join("\n");
}

export function parseTelegramId(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function splitTelegramText(text: string): string[] {
  const characters = Array.from(text);
  const parts: string[] = [];
  while (characters.length > telegramTextLimit) parts.push(characters.splice(0, telegramTextLimit).join(""));
  if (characters.length) parts.push(characters.join(""));
  return parts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileLabel(fileName: string | undefined): string {
  if (!fileName?.trim()) return "";
  const safeName = path.basename(fileName.trim()).replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 180);
  return safeName ? `: ${safeName}` : "";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
