/**
 * 会话导入/导出。
 *
 * 多种来源格式在这里互相转换，统一落到 Biny 自己的 `SessionEvent` 序列上：
 *
 * - **Biny bundle**：单文件 JSON（`format: "biny-session-bundle"`），自描述成
 *   `manifest + events + attachments` 三段。`events` 保留完整事件流；`attachments` 内嵌
 *   `user_message` 引用的附件本体（base64），让跨机器迁移后附件仍可打开。
 * - **外部对话格式**：一行一个 `{type:"user"|"assistant", message:{role,content}}` 的 JSONL，
 *   可导出也可导入。
 * - **外部 rollout**：只导入；事件在 `type:"response_item"` 的 payload 里。
 * - **ChatGPT 导出**：只导入；从 conversations.json 数组或单会话 mapping 中选择明确活动链。
 *
 * 所有外部格式都先翻译成事件、再用 `parseSessionEvents` 走一遍与读取路径相同的校验，
 * 避免把一份语法上能解析、语义上却非法的文件写进会话目录。导入一律分配全新 session id，
 * 绝不复用来源 id，因此同一文件导入多次会得到多条互不影响的会话。
 *
 * 兼容负担：旧版平铺 bundle（顶层直接带 `events`，没有 `manifest`）只在本仓库短暂存在过、
 * 从未发布；导入端顺手认一下（便宜），导出端一律只产新格式。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { attachmentFilePath, attachmentRoot, readAttachmentBytes, createAttachmentImportBatch, type AttachmentImportBatch, AttachmentImportCleanupError } from "../attachments/store.js";
import { rewriteAttachmentReferences } from "../attachments/references.js";
import { parseSessionEvents, readStoredSessionEvents } from "./events.js";
import type { SessionEvent } from "./recorder.js";
import { createSessionId } from "./recorder.js";
import { rebaseForkedSessionEvents } from "./fork.js";
import { createSessionFile, resolveSessionFile, sessionIdFromFile } from "./store.js";
import { refreshSessionIndex } from "./catalog.js";
import { publicAssistantMessage } from "./publicMessage.js";
import { codexLinesToBinyEvents } from "./import/codex.js";
import { importChatGptConversation, type ChatGptSkippedContentIssue, type PreparedChatGptSource } from "./import/chatgpt.js";
export { listChatGptConversations, type ChatGptConversationSummary } from "./import/chatgpt.js";
import { claudeLinesToBinyEvents, type ClaudeContentBlock, type ClaudeLine } from "./import/claude.js";

/** bundle 的格式标识与版本号；导入时据此拒绝不兼容的文件。 */
export const BINY_BUNDLE_FORMAT = "biny-session-bundle" as const;
export const BINY_BUNDLE_VERSION = 2 as const;
export type SessionTransferFormat = "biny" | "claude" | "codex" | "chatgpt";

/** 单个附件超过这个体积就不内嵌进 bundle，导入时记为 skipped（不阻塞整体导入）。 */
export const BINY_BUNDLE_ATTACHMENT_LIMIT = 50 * 1024 * 1024;

/**
 * bundle 清单：描述性元数据与统计，不参与恢复逻辑（恢复只看 `events`）。
 */
export interface BinySessionBundleManifest {
  sessionId: string;
  exportedAt: string;
  eventCount: number;
  attachmentCount: number;
  /** 因源文件缺失或超 50MB 上限而未内嵌、导出时就被跳过的附件名。 */
  skippedAttachments: string[];
}

/** bundle 里内嵌的一份附件；导入时分配新的批次路径并回填引用。 */
export interface BinySessionBundleAttachment {
  name: string;
  mimeType: string;
  /** 原始虚拟路径，支持单文件及导入批次内的文件。 */
  sourcePath: string;
  size: number;
  /** base64 编码的附件字节。 */
  data: string;
  /** 原始字节的 SHA-256，用于区分“可解码”和“内容完整”。 */
  sha256: string;
}

export interface BinySessionBundle {
  format: typeof BINY_BUNDLE_FORMAT;
  version: typeof BINY_BUNDLE_VERSION;
  manifest: BinySessionBundleManifest;
  events: SessionEvent[];
  attachments: BinySessionBundleAttachment[];
}

export interface ExportedSessionFile {
  /** 不带目录、不带扩展名的基准文件名；调用方决定落盘位置和扩展名。 */
  baseName: string;
  extension: "json" | "jsonl";
  content: string;
}

export interface ImportedSessionAttachmentIssue {
  name: string;
  reason: "too-large" | "invalid";
}

export interface ImportedSession {
  sessionId: string;
  filePath: string;
  eventCount: number;
  format: SessionTransferFormat;
  sourceConversationId?: string;
  sourceTitle?: string;
  skippedContentCount: number;
  skippedContentIssues: ChatGptSkippedContentIssue[];
  /** 还原成功 / 因故跳过的附件统计；非 bundle 导入恒为 0。 */
  attachmentsRestored: number;
  attachmentsSkipped: number;
  /** 撞名后换了新虚拟路径的附件数（事件引用已同步回填）。 */
  attachmentsRenamed: number;
  skippedAttachmentIssues: ImportedSessionAttachmentIssue[];
}

export class SessionImportCleanupError extends AttachmentImportCleanupError {
  constructor(cause: unknown, retainedAttachmentPaths: readonly string[]) {
    super(cause, retainedAttachmentPaths);
    this.name = "SessionImportCleanupError";
  }
}

// ── 导出 ────────────────────────────────────────────────────────────────────

/** 无损导出：把整条会话事件打包成 `manifest + events + attachments` 的自描述 JSON。 */
export async function exportSessionBundle(workspaceRoot: string, session: string): Promise<ExportedSessionFile> {
  const { events } = await readStoredSessionEvents(workspaceRoot, session);
  const filePath = await resolveSessionFile(workspaceRoot, session);
  const sessionId = sessionIdFromFile(filePath);
  const { attachments, skipped } = await collectBundleAttachments(workspaceRoot, events);
  const manifest: BinySessionBundleManifest = {
    sessionId,
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
    attachmentCount: attachments.length,
    skippedAttachments: skipped
  };
  const bundle: BinySessionBundle = {
    format: BINY_BUNDLE_FORMAT,
    version: BINY_BUNDLE_VERSION,
    manifest,
    events,
    attachments
  };
  return {
    baseName: sanitizeBaseName(sessionId),
    extension: "json",
    content: `${JSON.stringify(bundle, null, 2)}\n`
  };
}

/** 导出成外部兼容的 JSONL，供其他客户端直接 resume。只保留对话事实，丢弃运行遥测。 */
export async function exportSessionClaudeCode(workspaceRoot: string, session: string): Promise<ExportedSessionFile> {
  const { events } = await readStoredSessionEvents(workspaceRoot, session);
  const filePath = await resolveSessionFile(workspaceRoot, session);
  const lines = binyEventsToClaudeLines(events);
  if (!lines.length) throw new Error("会话里没有可导出的对话内容。");
  return {
    baseName: sanitizeBaseName(sessionIdFromFile(filePath)),
    extension: "jsonl",
    content: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  };
}

/**
 * 收集事件里 `user_message` 引用的附件本体。逐路径去重；文件已不在磁盘（被清理）或超过
 * 50MB 上限的就跳过并记下名字——导出不应因为一个大附件而整体失败。
 */
async function collectBundleAttachments(
  workspaceRoot: string,
  events: readonly SessionEvent[]
): Promise<{ attachments: BinySessionBundleAttachment[]; skipped: string[] }> {
  const attachments: BinySessionBundleAttachment[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "user_message" || !Array.isArray(event.attachments)) continue;
    for (const reference of event.attachments) {
      if (!isRecord(reference) || typeof reference.path !== "string" || seen.has(reference.path)) continue;
      seen.add(reference.path);
      const filePath = attachmentFilePath(attachmentRoot(workspaceRoot), reference.path);
      if (!filePath) continue;
      const name = typeof reference.name === "string" && reference.name ? reference.name : path.basename(reference.path);
      let bytes: Buffer;
      try {
        const storedBytes = await readAttachmentBytes(workspaceRoot, reference.path);
        if (storedBytes === undefined) { skipped.push(name); continue; }
        bytes = storedBytes;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) { skipped.push(name); continue; }
        throw error;
      }
      if (bytes.byteLength > BINY_BUNDLE_ATTACHMENT_LIMIT) {
        skipped.push(name);
        continue;
      }
      attachments.push({
        name,
        mimeType: typeof reference.mimeType === "string" ? reference.mimeType : "application/octet-stream",
        sourcePath: reference.path,
        size: bytes.byteLength,
        data: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }
  }
  return { attachments, skipped };
}

// ── 导入 ────────────────────────────────────────────────────────────────────

/**
 * 导入一份会话文件，返回新建会话的 id。
 *
 * 事件先按来源格式解析、再走一遍 `parseSessionEvents` 校验，最后经 `createSessionFile`
 * 以 `O_EXCL` 落盘，保证不会覆盖任何已存在的会话。
 */
export interface SessionImportOptions {
  format?: SessionTransferFormat;
  conversationId?: string;
}
export interface ParsedSessionImport {
  format: SessionTransferFormat;
  events: SessionEvent[];
  attachments: BinySessionBundleAttachment[];
  sourceConversationId?: string;
  sourceTitle?: string;
  skippedContentCount: number;
  skippedContentIssues: ChatGptSkippedContentIssue[];
}

/** 与实际导入共用的纯解析入口；不会创建 session 或还原附件。 */
export function parseSessionImport(raw: string, sourcePath: string, options: SessionImportOptions = {}): ParsedSessionImport {
  const format = options.format ?? detectSessionImportFormat(raw, sourcePath);
  const source = format === "chatgpt" ? importChatGptConversation(raw, sourcePath, options.conversationId)
    : { events: importEventsFromSource(raw, format, sourcePath), sourceConversationId: undefined, sourceTitle: undefined,
      skippedContentCount: 0, skippedContentIssues: [] };
  const events = validateImportedEvents(source.events);
  return { format, ...source, events, attachments: format === "biny" ? parseBinyBundleAttachments(raw) : [] };
}

/** Internal adapter for a selected conversation from the current scanned snapshot. */
export function parsePreparedChatGptImport(source: PreparedChatGptSource, conversationId?: string): ParsedSessionImport {
  const imported = source.importConversation(conversationId);
  return { format: "chatgpt", ...imported, events: validateImportedEvents(imported.events), attachments: [] };
}

function validateImportedEvents(events: readonly SessionEvent[]): SessionEvent[] {
  if (!events.length) throw new Error("导入文件里没有可用的会话事件。");
  return parseSessionEvents(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

export async function importSessionFile(
  workspaceRoot: string,
  sourcePath: string,
  options: SessionImportOptions = {}
): Promise<ImportedSession> {
  return await persistImportedSession(workspaceRoot, parseSessionImport(await fs.readFile(sourcePath, "utf8"), sourcePath, options));
}

/** Internal persistence seam; callers must first use a validated import parser. */
export async function persistImportedSession(
  workspaceRoot: string,
  source: ParsedSessionImport
): Promise<ImportedSession> {
  const { events, format, attachments: bundleAttachments } = source;
  let batch: AttachmentImportBatch | undefined;
  try {
    const restored = await restoreBundleAttachments(bundleAttachments, async () => {
      batch ??= await createAttachmentImportBatch(workspaceRoot);
      return batch;
    });
    const remapped = restored.pathBySource.size > 0 ? rewriteAttachmentPaths(events, restored.pathBySource) : events;
    const rebased = rebaseForkedSessionEvents(remapped);
    const content = `${rebased.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const validated = parseSessionEvents(content);
    const sessionId = createSessionId();
    const filePath = await createSessionFile(workspaceRoot, sessionId, Buffer.from(content, "utf8"));
    batch?.commit();
    refreshSessionIndex(workspaceRoot);
    return {
      sessionId,
      filePath,
      eventCount: validated.length,
      format,
      sourceConversationId: source.sourceConversationId,
      sourceTitle: source.sourceTitle,
      skippedContentCount: source.skippedContentCount,
      skippedContentIssues: source.skippedContentIssues,
      attachmentsRestored: restored.restored,
      attachmentsSkipped: restored.skipped.length,
      attachmentsRenamed: restored.renamed,
      skippedAttachmentIssues: restored.skipped
    };
  } catch (error) {
    if (!batch) {
      if (error instanceof AttachmentImportCleanupError) throw new SessionImportCleanupError(error.cause, error.retainedAttachmentPaths);
      throw error;
    }
    const retainedAttachmentPaths = await batch.rollback();
    if (!retainedAttachmentPaths.length) throw error;
    throw new SessionImportCleanupError(error, retainedAttachmentPaths);
  }
}

function importEventsFromSource(raw: string, format: Exclude<SessionTransferFormat, "chatgpt">, sourcePath: string): SessionEvent[] {
  if (format === "biny") return parseBinyBundle(raw, sourcePath);
  if (format === "claude") return claudeLinesToBinyEvents(parseJsonLines(raw, sourcePath));
  return codexLinesToBinyEvents(parseJsonLines(raw, sourcePath));
}

// ── 格式探测 ────────────────────────────────────────────────────────────────

/** 显式 format 优先；否则先看 bundle 信封，再按首行的字段形状区分两类外部格式。 */
export function detectSessionImportFormat(raw: string, sourcePath: string): SessionTransferFormat {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("[")) return "chatgpt";
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && parsed.format === BINY_BUNDLE_FORMAT) return "biny";
      if (isRecord(parsed) && isRecord(parsed.mapping)) return "chatgpt";
    } catch {
      // 单 JSON 解析失败就按 JSONL 继续探测。
    }
  }
  // 外部 rollout 首行可能是 session_meta，另一类格式可能有 summary 行，只看首行不可靠，
  // 扫前 20 个非空行找特征字段。
  const probeLines = raw.split("\n").filter((line) => line.trim().length > 0).slice(0, 20);
  for (const probeLine of probeLines) {
    try {
      const parsed: unknown = JSON.parse(probeLine);
      if (isRecord(parsed)) {
        if (parsed.type === "response_item" || parsed.type === "turn_context" || parsed.type === "session_meta") return "codex";
        if (typeof parsed.message === "object" && parsed.message !== null) return "claude";
      }
    } catch {
      // 单行解析失败继续看下一行，最后落到扩展名启发式。
    }
  }
  if (/\.json$/iu.test(sourcePath)) return "biny";
  throw new Error(`无法识别会话文件格式：${path.basename(sourcePath)}。请明确指定是 Biny、Claude Code、Codex 还是 ChatGPT。`);
}

// ── Biny bundle ─────────────────────────────────────────────────────────────

function parseBinyBundle(raw: string, sourcePath: string): SessionEvent[] {
  const parsed = parseBinyBundleEnvelope(raw, sourcePath);
  // 新旧两种形态（带 manifest 的新格式 / 从未发布的旧平铺格式）都把事件放在顶层 `events`。
  if (!Array.isArray(parsed.events)) throw new Error("Biny 会话包缺少 events 数组。");
  const content = `${parsed.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return parseSessionEvents(content);
}

/** 解析 bundle 信封并校验 format/version。 */
function parseBinyBundleEnvelope(raw: string, sourcePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Biny 会话包不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.format !== BINY_BUNDLE_FORMAT) {
    throw new Error(`不是 Biny 会话包（缺少 format: "${BINY_BUNDLE_FORMAT}"）：${path.basename(sourcePath)}`);
  }
  if (parsed.version !== BINY_BUNDLE_VERSION) {
    throw new Error(`不支持的 Biny 会话包版本：${String(parsed.version)}`);
  }
  return parsed;
}

/** 读 bundle 内嵌的附件段；缺失（旧格式 / 外部 JSONL）时按空处理。 */
function parseBinyBundleAttachments(raw: string): BinySessionBundleAttachment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // 事件解析那边已经报过更准确的错；这里失败就当没有附件。
  }
  if (!isRecord(parsed) || parsed.format !== BINY_BUNDLE_FORMAT || !Array.isArray(parsed.attachments)) return [];
  const result: BinySessionBundleAttachment[] = [];
  for (const entry of parsed.attachments) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name !== "string" || typeof entry.sourcePath !== "string" || typeof entry.data !== "string") continue;
    result.push({
      name: entry.name,
      mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "application/octet-stream",
      sourcePath: entry.sourcePath,
      size: typeof entry.size === "number" ? entry.size : -1,
      data: entry.data,
      sha256: typeof entry.sha256 === "string" ? entry.sha256 : ""
    });
  }
  return result;
}

interface RestoredAttachments {
  restored: number;
  renamed: number;
  skipped: ImportedSessionAttachmentIssue[];
  /** 原始 sourcePath → 实际落盘的虚拟路径（撞名时会不同）。 */
  pathBySource: Map<string, string>;
}

/**
 * 有效附件写入本次导入的独占批次；超上限或损坏的条目记 skipped。
 * 路径映射回填后创建 Session，Session 创建成功才提交该批次。
 */
async function restoreBundleAttachments(
  attachments: readonly BinySessionBundleAttachment[],
  batchForWrite: () => Promise<AttachmentImportBatch>
): Promise<RestoredAttachments> {
  const result: RestoredAttachments = { restored: 0, renamed: 0, skipped: [], pathBySource: new Map() };
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      result.skipped.push({ name: attachment.name, reason: "invalid" });
      continue;
    }
    if (attachment.size > BINY_BUNDLE_ATTACHMENT_LIMIT || attachment.data.length > Math.ceil(BINY_BUNDLE_ATTACHMENT_LIMIT / 3) * 4) {
      result.skipped.push({ name: attachment.name, reason: "too-large" });
      continue;
    }
    if (!isStrictBase64(attachment.data) || !/^[0-9a-f]{64}$/u.test(attachment.sha256)) {
      result.skipped.push({ name: attachment.name, reason: "invalid" });
      continue;
    }
    const bytes = Buffer.from(attachment.data, "base64");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== attachment.size || checksum !== attachment.sha256) {
      result.skipped.push({ name: attachment.name, reason: "invalid" });
      continue;
    }
    const saved = await (await batchForWrite()).save(attachment.name, attachment.mimeType, bytes);
    result.restored += 1;
    if (saved.path !== attachment.sourcePath) result.renamed += 1;
    result.pathBySource.set(attachment.sourcePath, saved.path);
  }
  return result;
}

function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

/** 撞名后附件实际路径变了，把事件里的引用从旧 sourcePath 回填到新路径。 */
function rewriteAttachmentPaths(events: readonly SessionEvent[], pathBySource: ReadonlyMap<string, string>): SessionEvent[] {
  return events.map((event) => {
    if (event.type !== "user_message" || !Array.isArray(event.attachments)) return event;
    const next = event.attachments.map((reference) => {
      if (!isRecord(reference) || typeof reference.path !== "string") return reference;
      const renamed = pathBySource.get(reference.path);
      return renamed === undefined ? reference : { ...reference, path: renamed };
    });
    return { ...event, content: rewriteAttachmentReferences(event.content, pathBySource), attachments: next };
  });
}

// ── 外部对话格式 ─────────────────────────────────────────────────────────────

function binyEventsToClaudeLines(events: readonly SessionEvent[]): ClaudeLine[] {
  const lines: ClaudeLine[] = [];
  // Legacy facts may omit call IDs. Reserve explicit IDs before generating any,
  // including references on results that must never point at a synthetic call.
  const usedToolCallIds = new Set(events.flatMap((event) =>
    (event.type === "tool_call" || event.type === "tool_result") && event.toolCallId !== undefined
      ? [event.toolCallId] : []));
  const explicitCallCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type === "tool_call" && event.toolCallId !== undefined) {
      explicitCallCounts.set(event.toolCallId, (explicitCallCounts.get(event.toolCallId) ?? 0) + 1);
    }
  }
  type PendingCall = { id: string; order: number; closed: boolean; groups: PendingGroup[] };
  type PendingGroup = { calls: PendingCall[]; head: number; count: number; uncertainThrough: number };
  const pendingByTool = new Map<string, PendingGroup>();
  const pendingBySequence = new Map<string, Map<number | undefined, PendingGroup>>();
  const pendingById = new Map<string, PendingCall>();
  const idUncertainThrough = new Map<string, number>();
  let callOrder = 0;
  let boundaryUncertainThrough = 0;
  const groupFor = <Key,>(index: Map<Key, PendingGroup>, key: Key): PendingGroup => {
    let group = index.get(key);
    if (!group) {
      group = { calls: [], head: 0, count: 0, uncertainThrough: 0 };
      index.set(key, group);
    }
    return group;
  };
  const solePendingCall = (group: PendingGroup): PendingCall | undefined => {
    if (group.count !== 1) return undefined;
    // Every closed entry is skipped at most once in each of its two groups.
    while (group.calls[group.head]?.closed) group.head += 1;
    return group.calls[group.head];
  };
  const closePendingCall = (call: PendingCall | undefined): void => {
    if (!call || call.closed) return;
    call.closed = true;
    for (const group of call.groups) group.count -= 1;
    pendingById.delete(call.id);
  };
  for (const event of events) {
    if (event.type === "user_message" || event.type === "assistant_message"
      || event.type === "agent_message" || event.type === "turn_interrupted") {
      // A conversation boundary is not evidence that an unresolved invocation closed.
      boundaryUncertainThrough = callOrder;
    }
    if (event.type === "user_message") {
      lines.push({
        type: "user",
        timestamp: event.time,
        message: { role: "user", content: event.content }
      });
      continue;
    }
    if (event.type === "assistant_message") {
      const content: ClaudeContentBlock[] = [];
      const reasoning = reasoningTextOf(event);
      if (reasoning) content.push({ type: "thinking", thinking: reasoning });
      const text = publicAssistantMessage(event.content);
      if (text) content.push({ type: "text", text });
      if (!content.length) continue;
      lines.push({ type: "assistant", timestamp: event.time, message: { role: "assistant", content } });
      continue;
    }
    if (event.type === "tool_call") {
      let toolCallId = event.toolCallId ?? `call_${String(lines.length)}`;
      if (event.toolCallId === undefined) {
        const baseId = toolCallId;
        for (let suffix = 1; usedToolCallIds.has(toolCallId); suffix += 1) {
          toolCallId = `${baseId}_${String(suffix)}`;
        }
        usedToolCallIds.add(toolCallId);
      }
      if (!event.auditOnly) {
        let sequences = pendingBySequence.get(event.tool);
        if (!sequences) {
          sequences = new Map();
          pendingBySequence.set(event.tool, sequences);
        }
        const groups = [groupFor(pendingByTool, event.tool), groupFor(sequences, event.sequence)];
        const call: PendingCall = { id: toolCallId, order: ++callOrder, closed: false, groups };
        for (const group of groups) {
          group.calls.push(call);
          group.count += 1;
        }
        // Globally unreused nonempty IDs are the only IDs eligible for removal.
        // Reused IDs still retain every invocation in their tool/sequence groups.
        pendingById.set(toolCallId, call);
      }
      lines.push({
        type: "assistant",
        timestamp: event.time,
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: toolCallId,
            name: event.tool,
            input: isRecord(event.args) ? event.args : {}
          }]
        }
      });
      continue;
    }
    if (event.type === "tool_result") {
      const matchingGroups: PendingGroup[] = [];
      if (event.toolCallId === undefined && !event.auditOnly) {
        if (event.sequence === undefined) {
          const group = pendingByTool.get(event.tool);
          if (group) matchingGroups.push(group);
        } else {
          const sequences = pendingBySequence.get(event.tool);
          const unknown = sequences?.get(undefined);
          const exact = sequences?.get(event.sequence);
          if (unknown) matchingGroups.push(unknown);
          if (exact) matchingGroups.push(exact);
        }
      }
      // A unique name/sequence match is evidence; FIFO among ambiguous calls is not.
      const matchCount = matchingGroups.reduce((count, group) => count + group.count, 0);
      const soleGroup = matchCount === 1 ? matchingGroups.find((group) => group.count === 1) : undefined;
      const candidate = soleGroup ? solePendingCall(soleGroup) : undefined;
      const inferredCall = candidate && candidate.id !== ""
        && candidate.order > boundaryUncertainThrough
        && candidate.order > (idUncertainThrough.get(candidate.id) ?? 0)
        && candidate.groups.every((group) => candidate.order > group.uncertainThrough)
        && (explicitCallCounts.get(candidate.id) ?? 0) <= 1
        ? candidate : undefined;
      const toolCallId = event.toolCallId ?? inferredCall?.id ?? "";
      if (!event.auditOnly) {
        if (event.toolCallId !== undefined) {
          if (toolCallId !== "" && (explicitCallCounts.get(toolCallId) ?? 0) <= 1) {
            closePendingCall(pendingById.get(toolCallId));
          } else {
            // Empty or reused IDs cannot prove which invocation an explicit result closed.
            idUncertainThrough.set(toolCallId, callOrder);
          }
        } else if (inferredCall) {
          closePendingCall(inferredCall);
        } else {
          // Retain uncertain candidates as blockers for later same-tool results.
          // Deleting them would make an old late result look unique to a new call.
          // Cutoffs poison only existing calls, without scanning retained blockers.
          // Both unknown and exact sequences remain possible competitors.
          for (const group of matchingGroups) group.uncertainThrough = callOrder;
        }
      }
      lines.push({
        type: "user",
        timestamp: event.time,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolCallId,
            content: toolResultText(event.result),
            is_error: event.executionStatus === "failed" || event.executionStatus === "cancelled"
          }]
        }
      });
    }
  }
  return lines;
}

// ── 共享小工具 ──────────────────────────────────────────────────────────────

function parseJsonLines(raw: string, sourcePath: string): unknown[] {
  const lines: unknown[] = [];
  const rows = raw.split("\n");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined || !row.trim()) continue;
    try {
      lines.push(JSON.parse(row));
    } catch (error) {
      throw new Error(`第 ${String(index + 1)} 行不是合法 JSON（${path.basename(sourcePath)}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}

function reasoningTextOf(event: Extract<SessionEvent, { type: "assistant_message" }>): string {
  if (typeof event.reasoningContent === "string" && event.reasoningContent) return event.reasoningContent;
  const blocks = event.reasoningBlocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** 文件名只保留安全字符，避免导出的默认文件名带路径分隔符或奇怪字符。 */
function sanitizeBaseName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+/, "").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "session";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
