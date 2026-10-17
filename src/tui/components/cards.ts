/**
 * 报告类 slash command 的内联卡片组件。
 *
 * `/status` 历史卡片：命令原文一行，下面是带边框的对齐卡片，
 * label 统一 dim、对齐到固定列，value 分段着色（总量加粗、括号细节 dim）。
 * 组件只负责展示，卡片数据由 runtime 的 `CommandCardData` 提供；
 * 细节行的展开/折叠是本地交互状态，不进入 reducer。
 */
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import { formatTokens } from "./chrome.js";
import type { CardValueStyle, CommandCardData, CommandCardRow, CommandCardValue } from "../../runtime/commandCard.js";
import type { CardTranscriptItem, TranscriptItem } from "../types.js";
import type { TranscriptItemComponent } from "./messages.js";

export class CardComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private item: CardTranscriptItem;
  private expanded = false;
  private renderWidth = 80;

  constructor(item: CardTranscriptItem) {
    super();
    this.itemId = item.id;
    this.item = item;
  }

  update(item: TranscriptItem): void {
    if (item.kind !== "card") return;
    this.item = item;
    this.invalidate();
  }

  /** 有可折叠的细节行时切换展开状态；返回是否有细节可展开。 */
  toggleDetails(): boolean {
    if (!hasDetailRows(this.item.data) && cardBody(this.item.data, false, this.renderWidth, 9).length <= 8) return false;
    this.expanded = !this.expanded;
    this.invalidate();
    return true;
  }

  override render(width: number): string[] {
    this.renderWidth = width;
    return renderCardLines(this.item, this.expanded, width);
  }
}

/** 纯渲染函数：把卡片数据按宽度渲染成带 ANSI 的行，供组件和测试使用。 */
export function renderCardLines(item: CardTranscriptItem, expanded: boolean, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const commandLines = item.command ? [theme.fg("accent", theme.bold(truncateToWidth(item.command, safeWidth, "…")))] : [];
  const visibleRows = visibleCardRows(item.data, expanded);

  // 极窄终端放弃边框，退回 label: value 平铺。
  if (safeWidth < 10) {
    const rows = expanded ? visibleRows : visibleRows.slice(0, 8);
    return [
      ...commandLines,
      ...rows.map((row) => truncateToWidth(`${row.label ? `${row.label}: ` : ""}${rowValueText(row)}`, safeWidth, "…")),
      ...(!expanded && (visibleRows.length > 8 || hasDetailRows(item.data)) ? [truncateToWidth("ctrl+o details", safeWidth, "…")] : [])
    ];
  }

  const body = cardBody(item.data, expanded, safeWidth, expanded ? Infinity : 9);
  const budget = expanded ? body.length : 8;
  const hidden = item.data.sections.reduce((count, section) => count + section.rows.filter((row) => row.detail).length, 0);
  const overflow = body.length > budget;
  const hint = expanded ? "ctrl+o to collapse"
    : hidden || overflow ? "… more details · ctrl+o to expand" : undefined;

  return [
    ...commandLines,
    topBorder(item.title, safeWidth),
    ...body.slice(0, budget),
    bottomBorder(safeWidth),
    ...(hint ? [theme.fg("dim", truncateToWidth(hint, safeWidth, "…"))] : [])
  ];
}

function cardBody(data: CommandCardData, expanded: boolean, width: number, maxRows: number): string[] {
  const contentWidth = Math.max(1, width - 4);
  const rows = visibleCardRows(data, expanded);
  const labelWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0);
  const valueCol = labelWidth ? Math.min(labelWidth + 4, Math.floor(contentWidth / 2)) : 0;
  const body: string[] = [];
  for (const section of data.sections) {
    const visible = section.rows.filter((row) => !row.detail || expanded);
    if (!visible.length) continue;
    if (body.length) body.push(emptyRow(contentWidth));
    for (const row of visible) {
      body.push(...rowLines(row, valueCol, contentWidth).slice(0, Math.max(0, maxRows - body.length)));
      if (body.length >= maxRows) return body;
    }
  }
  return body;
}

function topBorder(title: string, width: number): string {
  const maxTitle = Math.max(0, width - 6);
  const truncated = truncateToWidth(title, maxTitle, "…");
  const fill = Math.max(0, width - 5 - visibleWidth(truncated));
  return `╭─ ${theme.fg("accent", theme.bold(truncated))} ${"─".repeat(fill)}╮`;
}

function bottomBorder(width: number): string {
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function emptyRow(contentWidth: number, text = ""): string {
  const content = truncateToWidth(text, contentWidth, "…");
  return `│ ${content}${" ".repeat(Math.max(0, contentWidth - visibleWidth(content)))} │`;
}

function rowLines(row: CommandCardRow, valueCol: number, contentWidth: number): string[] {
  const label = row.label === ""
    ? " ".repeat(valueCol)
    : theme.fg("dim", padLabel(row.label, valueCol));
  const value = normalizeValue(row.value).map((segment) => renderSegment(segment, row.tone)).join("");
  return wrapTextWithAnsi(value, Math.max(1, contentWidth - valueCol)).map((line, index) =>
    emptyRow(contentWidth, `${index === 0 ? label : " ".repeat(valueCol)}${line}`)
  );
}

function padLabel(label: string, valueCol: number): string {
  const base = truncateToWidth(` ${label}:`, Math.max(1, valueCol - 1), "…");
  return base + " ".repeat(Math.max(0, valueCol - visibleWidth(base)));
}

function renderSegment(segment: CommandCardValue, tone: CommandCardRow["tone"]): string {
  const text = typeof segment === "string"
    ? segment
    : "tokens" in segment
      ? formatTokens(segment.tokens)
      : segment.text;
  const style = typeof segment === "string" ? undefined : "style" in segment ? segment.style : undefined;
  return styleText(text, style ?? tone);
}

function styleText(text: string, style: CardValueStyle | undefined): string {
  switch (style) {
    case "dim": return theme.fg("dim", text);
    case "muted": return theme.fg("muted", text);
    case "accent": return theme.fg("accent", text);
    case "success": return theme.fg("success", text);
    case "warning": return theme.fg("warning", text);
    case "error": return theme.fg("error", text);
    case "bold": return theme.bold(theme.fg("text", text));
    default: return text;
  }
}

function visibleCardRows(data: CommandCardData, expanded: boolean): CommandCardRow[] {
  return data.sections.flatMap((section) => section.rows.filter((row) => !row.detail || expanded));
}

function hasDetailRows(data: CommandCardData): boolean {
  return data.sections.some((section) => section.rows.some((row) => row.detail));
}

function normalizeValue(value: CommandCardRow["value"]): CommandCardValue[] {
  if (Array.isArray(value)) return [...value];
  return [value];
}

function rowValueText(row: CommandCardRow): string {
  return normalizeValue(row.value)
    .map((segment) => typeof segment === "string" ? segment : "tokens" in segment ? formatTokens(segment.tokens) : segment.text)
    .join("");
}
