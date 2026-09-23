/**
 * 会话导入/导出。
 *
 * 三种格式在这里互相转换，统一落到 Biny 自己的 `SessionEvent` 序列上：
 *
 * - **Biny bundle**：单文件 JSON（`format: "biny-session-bundle"`），自描述成
 *   `manifest + events + attachments` 三段。`events` 保留完整事件流；`attachments` 内嵌
 *   `user_message` 引用的附件本体（base64），让跨机器迁移后附件仍可打开。
 * - **外部对话格式**：一行一个 `{type:"user"|"assistant", message:{role,content}}` 的 JSONL，
 *   可导出也可导入。
 * - **外部 rollout**：只导入；事件在 `type:"response_item"` 的 payload 里。
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
import { attachmentFilePath, attachmentRoot, saveAttachment } from "../attachments/store.js";
import { parseSessionEvents, readStoredSessionEvents } from "./events.js";
import type { SessionEvent } from "./recorder.js";
import { createSessionId } from "./recorder.js";
import { rebaseForkedSessionEvents } from "./fork.js";
import { createSessionFile, resolveSessionFile, sessionIdFromFile } from "./store.js";
import { refreshSessionIndex } from "./catalog.js";
import { publicAssistantMessage } from "./publicMessage.js";

/** bundle 的格式标识与版本号；导入时据此拒绝不兼容的文件。 */
export const BINY_BUNDLE_FORMAT = "biny-session-bundle" as const;
export const BINY_BUNDLE_VERSION = 2 as const;
export type SessionTransferFormat = "biny" | "claude" | "codex";

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
  /** 因超 50MB 上限而未内嵌、导出时就被跳过的附件名。 */
  skippedAttachments: string[];
}

/** bundle 里内嵌的一份附件：按原始 `@attachments/` 虚拟路径还原。 */
export interface BinySessionBundleAttachment {
  name: string;
  mimeType: string;
  /** 原始虚拟路径（`@attachments/<file>`）；导入时若撞名会换新路径并回填事件引用。 */
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
  /** 还原成功 / 因故跳过的附件统计；非 bundle 导入恒为 0。 */
  attachmentsRestored: number;
  attachmentsSkipped: number;
  /** 撞名后换了新虚拟路径的附件数（事件引用已同步回填）。 */
  attachmentsRenamed: number;
  skippedAttachmentIssues: ImportedSessionAttachmentIssue[];
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
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(filePath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue; // 源文件已被清理，无可恢复内容。
        throw error;
      }
      const name = typeof reference.name === "string" && reference.name ? reference.name : path.basename(reference.path);
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
export async function importSessionFile(
  workspaceRoot: string,
  sourcePath: string,
  options: { format?: SessionTransferFormat } = {}
): Promise<ImportedSession> {
  const raw = await fs.readFile(sourcePath, "utf8");
  const format = options.format ?? detectSessionImportFormat(raw, sourcePath);
  const events = importEventsFromSource(raw, format, sourcePath);
  if (!events.length) throw new Error("导入文件里没有可用的会话事件。");
  const attachments = format === "biny" ? parseBinyBundleAttachments(raw) : [];
  return await persistImportedSession(workspaceRoot, events, format, attachments);
}

async function persistImportedSession(
  workspaceRoot: string,
  events: SessionEvent[],
  format: SessionTransferFormat,
  bundleAttachments: BinySessionBundleAttachment[]
): Promise<ImportedSession> {
  const restored = await restoreBundleAttachments(workspaceRoot, bundleAttachments);
  const remapped = restored.pathBySource.size > 0 ? rewriteAttachmentPaths(events, restored.pathBySource) : events;
  const rebased = rebaseForkedSessionEvents(remapped);
  const content = `${rebased.map((event) => JSON.stringify(event)).join("\n")}\n`;
  // 与读取路径共用同一套校验：任何能在列表/恢复里读出来的会话，必须能过这一关。
  const validated = parseSessionEvents(content);
  const sessionId = createSessionId();
  const filePath = await createSessionFile(workspaceRoot, sessionId, Buffer.from(content, "utf8"));
  refreshSessionIndex(workspaceRoot);
  return {
    sessionId,
    filePath,
    eventCount: validated.length,
    format,
    attachmentsRestored: restored.restored,
    attachmentsSkipped: restored.skipped.length,
    attachmentsRenamed: restored.renamed,
    skippedAttachmentIssues: restored.skipped
  };
}

function importEventsFromSource(raw: string, format: SessionTransferFormat, sourcePath: string): SessionEvent[] {
  if (format === "biny") return parseBinyBundle(raw, sourcePath);
  if (format === "claude") return claudeLinesToBinyEvents(parseJsonLines(raw, sourcePath));
  return codexLinesToBinyEvents(parseJsonLines(raw, sourcePath));
}

// ── 格式探测 ────────────────────────────────────────────────────────────────

/** 显式 format 优先；否则先看 bundle 信封，再按首行的字段形状区分两类外部格式。 */
function detectSessionImportFormat(raw: string, sourcePath: string): SessionTransferFormat {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && parsed.format === BINY_BUNDLE_FORMAT) return "biny";
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
  throw new Error(`无法识别会话文件格式：${path.basename(sourcePath)}。请明确指定是 Biny、Claude Code 还是 Codex。`);
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
 * 把内嵌附件写回项目附件目录。超 50MB 上限或 base64 损坏的记 skipped 不阻塞导入；`saveAttachment`
 * 自带时间戳+随机串前缀，撞名天然换到新路径，新旧虚拟路径的映射留给 `rewriteAttachmentPaths` 回填。
 */
async function restoreBundleAttachments(
  workspaceRoot: string,
  attachments: readonly BinySessionBundleAttachment[]
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
    const saved = await saveAttachment(workspaceRoot, attachment.name, attachment.mimeType, bytes);
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
    return { ...event, attachments: next };
  });
}

// ── 外部对话格式 ─────────────────────────────────────────────────────────────

interface ClaudeContentText { type: "text"; text: string }
interface ClaudeContentThinking { type: "thinking"; thinking?: string; text?: string }
interface ClaudeContentToolUse { type: "tool_use"; id?: string; name?: string; input?: unknown }
interface ClaudeContentToolResult {
  type: "tool_result";
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
}
type ClaudeContentBlock = ClaudeContentText | ClaudeContentThinking | ClaudeContentToolUse | ClaudeContentToolResult | { type?: string };

interface ClaudeLine {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | ClaudeContentBlock[] };
}

function binyEventsToClaudeLines(events: readonly SessionEvent[]): ClaudeLine[] {
  const lines: ClaudeLine[] = [];
  for (const event of events) {
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
      lines.push({
        type: "assistant",
        timestamp: event.time,
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: event.toolCallId ?? `call_${String(lines.length)}`,
            name: event.tool,
            input: isRecord(event.args) ? event.args : {}
          }]
        }
      });
      continue;
    }
    if (event.type === "tool_result") {
      lines.push({
        type: "user",
        timestamp: event.time,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: event.toolCallId ?? "",
            content: toolResultText(event.result),
            is_error: event.executionStatus === "failed" || event.executionStatus === "cancelled"
          }]
        }
      });
    }
  }
  return lines;
}

function claudeLinesToBinyEvents(lines: unknown[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of lines) {
    if (!isRecord(line)) continue;
    const claude = line as ClaudeLine;
    if (claude.type !== "user" && claude.type !== "assistant") continue;
    const message = claude.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    const time = typeof claude.timestamp === "string" ? claude.timestamp : undefined;
    if (role === "user") {
      pushClaudeUserContent(events, message.content, time);
      continue;
    }
    if (role === "assistant") pushClaudeAssistantContent(events, message.content, time);
  }
  return events;
}

function pushClaudeUserContent(events: SessionEvent[], content: string | ClaudeContentBlock[] | undefined, time: string | undefined): void {
  if (typeof content === "string") {
    if (content.trim()) events.push({ type: "user_message", content, time });
    return;
  }
  if (!Array.isArray(content)) return;
  const textParts: string[] = [];
  for (const block of content) {
    if (isClaudeTextBlock(block)) {
      textParts.push(block.text);
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "tool_result") {
      // 工具结果在外部格式里以 user 角色承载；只有真正执行过才单独翻译，避免伪造结果。
      const result = block as ClaudeContentToolResult;
      events.push({
        type: "tool_result",
        tool: "tool",
        toolCallId: typeof result.tool_use_id === "string" ? result.tool_use_id : undefined,
        result: claudeToolResultText(result.content),
        executionStatus: result.is_error === true ? "failed" : "succeeded",
        time
      });
    }
  }
  const text = textParts.join("\n").trim();
  if (text) events.push({ type: "user_message", content: text, time });
}

function pushClaudeAssistantContent(events: SessionEvent[], content: string | ClaudeContentBlock[] | undefined, time: string | undefined): void {
  if (typeof content === "string") {
    if (content.trim()) events.push({ type: "assistant_message", content, time });
    return;
  }
  if (!Array.isArray(content)) return;
  const textParts: string[] = [];
  let reasoning = "";
  const toolCalls: Array<{ id?: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (isClaudeTextBlock(block)) {
      textParts.push(block.text);
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "thinking") {
      const thinking = (block as ClaudeContentThinking);
      const value = typeof thinking.thinking === "string" ? thinking.thinking : thinking.text;
      if (typeof value === "string") reasoning = reasoning ? `${reasoning}\n${value}` : value;
      continue;
    }
    if (block.type === "tool_use") {
      const use = block as ClaudeContentToolUse;
      if (typeof use.name === "string" && use.name) toolCalls.push({ id: use.id, name: use.name, input: use.input });
    }
  }
  const text = textParts.join("\n").trim();
  if (text) {
    events.push({
      type: "assistant_message",
      content: text,
      reasoningContent: reasoning || undefined,
      time
    });
    reasoning = "";
  }
  for (const call of toolCalls) {
    events.push({
      type: "tool_call",
      tool: call.name,
      args: isRecord(call.input) ? call.input : {},
      toolCallId: call.id,
      time
    });
  }
}

// ── 外部 rollout ───────────────────────────────────────────────────────────

interface CodexContentPart { type?: string; text?: string }
interface CodexReasoningSummaryPart { type?: string; text?: string }
interface CodexMessagePayload {
  type?: string;
  role?: string;
  content?: CodexContentPart[];
  // function_call / custom_tool_call
  name?: string;
  call_id?: string;
  arguments?: unknown;
  input?: unknown;
  // function_call_output / custom_tool_call_output
  output?: unknown;
  // reasoning
  summary?: CodexReasoningSummaryPart[];
}
interface CodexLine { type?: string; timestamp?: string; payload?: CodexMessagePayload }

/**
 * 把外部 rollout 翻成 Biny 事件。真实 payload 形态：
 *
 * - `message`：`content[].text`，`input_text`（user）/`output_text`（assistant）。
 * - `function_call`：`name` + `call_id` + `arguments`（**JSON 字符串**）。
 * - `custom_tool_call`：`name` + `call_id` + `input`（原始字符串，例如某些外部工具的结构化输入）。
 * - `function_call_output` / `custom_tool_call_output`：`call_id` + `output`（通常是
 *   `{"output":"...","metadata":{...}}` 的 JSON 字符串）。
 * - `reasoning`：`summary[].text`（`summary_text`），折成 assistant 事件的 reasoningContent。
 *
 * 事件顺序与源文件一致：遇到 call 立即发 `tool_call`，遇到 output 立即发 `tool_result`，
 * 用 `call_id` 对回工具名。一个 message 可能跟在若干 call 之后，因此逐 payload 处理、不做预分组合。
 */
function codexLinesToBinyEvents(lines: unknown[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  const toolNameByCallId = new Map<string, string>();
  let pendingReasoning = "";
  for (const line of lines) {
    if (!isRecord(line)) continue;
    const codex = line as CodexLine;
    if (codex.type !== "response_item") continue;
    const payload = codex.payload;
    if (!isRecord(payload)) continue;
    const time = typeof codex.timestamp === "string" ? codex.timestamp : undefined;

    if (payload.type === "reasoning") {
      const text = codexReasoningText(payload);
      if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${text}` : text;
      continue;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const name = typeof payload.name === "string" && payload.name ? payload.name : "tool";
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      if (callId) toolNameByCallId.set(callId, name);
      const rawArgs = payload.type === "function_call" ? payload.arguments : payload.input;
      events.push({
        type: "tool_call",
        tool: name,
        args: codexToolArgs(rawArgs),
        toolCallId: callId,
        reasoningContent: nonEmpty(pendingReasoning),
        time
      });
      pendingReasoning = "";
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      events.push({
        type: "tool_result",
        tool: (callId && toolNameByCallId.get(callId)) || "tool",
        result: codexToolOutput(payload.output),
        toolCallId: callId,
        time
      });
      continue;
    }
    if (payload.type === "message") {
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((part): part is CodexContentPart => isRecord(part) && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (!text) continue;
      if (payload.role === "user") {
        events.push({ type: "user_message", content: text, time });
      } else if (payload.role === "assistant") {
        events.push({ type: "assistant_message", content: text, reasoningContent: nonEmpty(pendingReasoning), time });
        pendingReasoning = "";
      }
    }
  }
  return events;
}

/** function_call 的 arguments 是 JSON 字符串，尝试解析成对象；custom_tool_call 的 input 是原始文本。 */
function codexToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return isRecord(raw) ? raw : {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { input: raw };
  } catch {
    return { input: raw };
  }
}

/** output 常是 `{"output":...,"metadata":...}` 的 JSON 字符串；提取可读的 output，失败就保留原文。 */
function codexToolOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.output === "string") return parsed.output;
    return parsed;
  } catch {
    return raw;
  }
}

function codexReasoningText(payload: CodexMessagePayload): string {
  if (!Array.isArray(payload.summary)) return "";
  return payload.summary
    .filter((part): part is CodexReasoningSummaryPart => isRecord(part) && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
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

function claudeToolResultText(content: ClaudeContentToolResult["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => isRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
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

function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/** 文本块收窄守卫：`isRecord` 给的是宽 Record，这里单独判定 `type:"text"` 且 `text` 是字符串。 */
function isClaudeTextBlock(block: unknown): block is ClaudeContentText {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}
