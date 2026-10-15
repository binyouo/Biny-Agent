/**
 * Transcript 条目组件。
 *
 * 每种条目对应一个终端组件：用户消息保留背景卡片，工具使用紧凑状态行，
 * assistant 正文和 thinking 走 Markdown 渲染，通知和错误是单行文本。
 * 组件只负责展示，内容由 `TranscriptView` 从 reducer 状态同步进来。
 */
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { classifyDiffLines } from "../../utils/diffLines.js";
import { markdownTheme, theme } from "../theme/index.js";
import { formatToolDuration, thinkingHeaderLabel } from "../transcriptText.js";
import type {
  AssistantTranscriptItem,
  ActivityTranscriptItem,
  NotificationTranscriptItem,
  ReasoningTranscriptItem,
  ToolTranscriptItem,
  ToolTranscriptStatus,
  TranscriptItem
} from "../types.js";

/** 条目组件的公共契约：能按条目更新自己。 */
export interface TranscriptItemComponent extends Container {
  readonly itemId: string;
  update(item: TranscriptItem): void;
}

/** 用户消息：整宽背景卡片，上下各一行同色留白，内容缩进一格。 */
export class UserMessageComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly body: Markdown;

  constructor(item: Extract<TranscriptItem, { kind: "user" }>) {
    super();
    this.itemId = item.id;
    this.body = new Markdown(item.content, 0, 0, markdownTheme(), {
      color: (text) => theme.fg("userMessageText", text)
    }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true });
    const box = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
    box.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(box);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "user") return;
    this.body.setText(item.content);
  }
}

/** Assistant 正文：不加背景，缩进一格，走完整 Markdown。 */
export class AssistantMessageComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly body: Markdown;

  constructor(item: AssistantTranscriptItem) {
    super();
    this.itemId = item.id;
    this.body = new Markdown(item.content, 1, 0, markdownTheme());
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "assistant") return;
    this.body.setText(item.content);
  }
}

/** Thinking：只显示状态和耗时，原始 reasoning 不进入 TUI 主界面。 */
export class ThinkingComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly header: Text;
  private readonly body: Markdown;
  private item: ReasoningTranscriptItem;

  constructor(item: ReasoningTranscriptItem) {
    super();
    this.itemId = item.id;
    this.item = item;
    this.header = new Text(thinkingHeader(item), 1, 0);
    this.body = new Markdown(reasoningBody(), 1, 0, markdownTheme(), {
      color: (text) => theme.fg("thinkingText", text),
      italic: true
    });
    this.addChild(new Spacer(1));
    this.addChild(this.header);
    this.addChild(this.body);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "reasoning") return;
    this.item = item;
    this.header.setText(thinkingHeader(item));
    // reasoning 增量只用于让状态行进入进行中状态；原文保留在 Session，不在这里渲染。
    this.body.setText(reasoningBody());
  }
}

function reasoningBody(): string {
  return "";
}

function reasoningIsRunning(item: ReasoningTranscriptItem): boolean {
  return item.startedAtMs !== undefined && item.durationMs === undefined;
}

function thinkingHeader(item: ReasoningTranscriptItem): string {
  const running = reasoningIsRunning(item);
  const marker = running ? "✶ " : "• ";
  return theme.fg("thinkingText", `${marker}${theme.italic(thinkingHeaderLabel(item, running))}`);
}

/** 工具前的公开说明：作为活动摘要显示，不占用 assistant 正文语义。 */
export class ActivitySummaryComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly text: Text;

  constructor(item: ActivityTranscriptItem) {
    super();
    this.itemId = item.id;
    this.text = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.text);
    this.update(item);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "activity") return;
    this.text.setText(theme.fg("text", item.content));
  }
}

/** 工具调用默认只显示摘要，详情由用户主动展开。 */
export class ToolExecutionComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private item: ToolTranscriptItem;
  private detailsExpanded = false;
  private leadingSpace = true;

  constructor(item: ToolTranscriptItem) {
    super();
    this.itemId = item.id;
    this.item = item;
  }

  update(item: TranscriptItem): void {
    if (item.kind === "tool") this.item = item;
  }

  setLeadingSpace(value: boolean): void {
    this.leadingSpace = value;
  }

  toggleDetails(): void {
    this.detailsExpanded = !this.detailsExpanded;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const item = this.item;
    const marker = toolStatusMarker(item.status);
    const { verb, rest } = splitToolTitle(item.title);
    const elapsed = item.status === "running" && item.startedAtMs !== undefined
      ? Math.max(0, Date.now() - item.startedAtMs) : undefined;
    const duration = formatToolDuration(item.durationMs ?? elapsed);
    const stats = toolResultStats(item);
    const suffix = [stats, duration].filter(Boolean).join(" · ");
    const title = theme.fg(toolStatusToken(item.status), marker)
      + theme.fg("toolTitle", theme.bold(verb)) + theme.fg("accent", rest);
    // 窄终端先保留动作标题，再按空间容纳完整统计，不能让长目标挤掉全部结果。
    const titleWidth = suffix && visibleWidth(suffix) + 8 <= safeWidth
      ? safeWidth - visibleWidth(suffix) - 2 : safeWidth;
    const left = truncateToWidth(title, titleWidth, "…");
    const row = titleWidth < safeWidth
      ? `${left}${" ".repeat(safeWidth - visibleWidth(left) - visibleWidth(suffix))}${theme.fg("dim", suffix)}`
      : left;
    const lines = this.leadingSpace ? ["", row] : [row];
    const source = item.output ?? item.progress ?? emptyToolOutput(item);
    const failed = ["failed", "denied", "unknown", "cancelled"].includes(item.status);
    if (this.detailsExpanded) {
      const details = item.details || item.output || item.progress || emptyToolOutput(item);
      lines.push(...toolDetailLines(details, safeWidth, 12, "toolOutput"));
    } else if (failed) {
      lines.push(...toolDetailLines(source, safeWidth, 3, toolStatusToken(item.status)));
    }
    return lines;
  }
}

function toolResultStats(item: ToolTranscriptItem): string {
  if (item.status === "running" || item.status === "pending") return "";
  if (item.fileChange?.diff) {
    let additions = 0;
    let deletions = 0;
    for (const line of classifyDiffLines(item.fileChange.diff)) {
      if (line.kind === "add") additions += 1;
      if (line.kind === "delete") deletions += 1;
    }
    return `+${additions} −${deletions}`;
  }
  const stats: string[] = [];
  if (item.exitCode !== undefined && item.exitCode !== 0) stats.push(`exit ${item.exitCode}`);
  if (item.outputLines !== undefined) stats.push(`${item.outputLines} lines${item.truncated ? "…" : ""}`);
  return stats.join(" · ");
}

/** 按终端实际行数限额；外部控制字符不能移动光标或注入框架光标标记。 */
function toolDetailLines(source: string, width: number, limit: number, token: Parameters<typeof theme.fg>[0]): string[] {
  const text = source.slice(0, 16_000).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replaceAll("\t", "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "").trimEnd();
  if (!text) return [];
  const body = new Text(text, 0, 0).render(Math.max(1, width - 3));
  const truncated = body.length > limit || source.length > 16_000;
  const visible = body.slice(0, truncated ? limit - 1 : limit);
  if (truncated) visible.push("… details truncated");
  return visible.map((line, index) => truncateToWidth(
    theme.fg("dim", index === 0 ? " └ " : "   ") + theme.fg(token, line), width, "…"
  ));
}

/** 标题首词是动作，加粗展示；其余部分是操作目标。 */
export function splitToolTitle(title: string): { verb: string; rest: string } {
  const boundary = title.indexOf(" ");
  if (boundary <= 0) return { verb: title, rest: "" };
  return { verb: title.slice(0, boundary), rest: title.slice(boundary) };
}

function emptyToolOutput(item: ToolTranscriptItem): string {
  if (item.status === "running" || item.status === "pending") return "Working…";
  if (item.status === "success") return "Completed";
  if (item.status === "denied") return "Denied";
  if (item.status === "skipped") return "Skipped";
  if (item.status === "cancelled") return "Cancelled";
  if (item.status === "unknown") return "Completion status unknown";
  return "Failed";
}

export function toolStatusMarker(status: ToolTranscriptStatus): string {
  if (status === "success") return "✓ ";
  if (status === "failed" || status === "denied") return "✗ ";
  if (status === "unknown") return "? ";
  if (status === "cancelled") return "⏹ ";
  if (status === "running") return "● ";
  if (status === "pending") return "○ ";
  if (status === "skipped") return "– ";
  return "• ";
}

function toolStatusToken(status: ToolTranscriptStatus): "success" | "error" | "accent" | "warning" | "muted" {
  if (status === "success") return "success";
  if (status === "failed" || status === "denied") return "error";
  if (status === "unknown" || status === "cancelled") return "warning";
  if (status === "running") return "accent";
  if (status === "pending") return "warning";
  return "muted";
}

/** 系统通知和错误：单行文本，按语气着色。 */
export class NoticeComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private readonly text: Text;
  private readonly kind: "notification" | "error";

  constructor(item: NotificationTranscriptItem | Extract<TranscriptItem, { kind: "error" }>) {
    super();
    this.itemId = item.id;
    this.kind = item.kind;
    this.text = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.text);
    this.update(item);
  }

  update(item: TranscriptItem): void {
    if (item.kind !== this.kind) return;
    this.text.setText(noticeText(item as NotificationTranscriptItem | Extract<TranscriptItem, { kind: "error" }>));
  }
}

function noticeText(item: NotificationTranscriptItem | Extract<TranscriptItem, { kind: "error" }>): string {
  if (item.kind === "error") return theme.fg("error", `Error ${item.content}`);
  if (item.tone === "success") return theme.fg("success", `• ${item.content}`);
  if (item.tone === "warning") return theme.fg("warning", `• ${item.content}`);
  return theme.fg("muted", `• ${item.content}`);
}
