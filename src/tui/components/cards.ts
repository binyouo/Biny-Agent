/**
 * 报告类 slash command 的内联卡片组件。
 *
 * `/status` 历史卡片：命令原文一行，下面是带边框的对齐卡片，
 * label 统一 dim、对齐到固定列，value 分段着色（总量加粗、括号细节 dim）。
 * 组件只负责展示，卡片数据由 runtime 的 `CommandCardData` 提供；
 * 细节行的展开/折叠是本地交互状态，不进入 reducer。
 */
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import { formatTokens } from "./chrome.js";
import type { CardValueStyle, CommandCardData, CommandCardRow, CommandCardValue } from "../../runtime/commandCard.js";
import type { CardTranscriptItem, TranscriptItem } from "../types.js";
import type { TranscriptItemComponent } from "./messages.js";

export class CardComponent extends Container implements TranscriptItemComponent {
  readonly itemId: string;
  private item: CardTranscriptItem;
  private expanded = false;

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
    if (!hasDetailRows(this.item.data)) return false;
    this.expanded = !this.expanded;
    this.invalidate();
    return true;
  }

  override render(width: number): string[] {
    return renderCardLines(this.item, this.expanded, width);
  }
}

/** 纯渲染函数：把卡片数据按宽度渲染成带 ANSI 的行，供组件和测试使用。 */
export function renderCardLines(item: CardTranscriptItem, expanded: boolean, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const commandLine = theme.fg("accent", theme.bold(item.command));
  const visibleRows = visibleCardRows(item.data, expanded);

  // 极窄终端放弃边框，退回 label: value 平铺。
  if (safeWidth < 10) {
    return [
      commandLine,
      ...visibleRows.map((row) => truncateToWidth(`${row.label}: ${rowValueText(row)}`, safeWidth, "…"))
    ];
  }

  const contentWidth = safeWidth - 4;
  const labelWidth = visibleRows.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0);
  // 值列 = label 宽 + 4：最长 label 冒号后也保留 2 个空格。
  const valueCol = labelWidth + 4;

  const body: string[] = [];
  let firstSection = true;
  for (const section of item.data.sections) {
    const rows = section.rows.filter((row) => !row.detail || expanded);
    if (!rows.length) continue;
    if (!firstSection) body.push(emptyRow(contentWidth));
    firstSection = false;
    for (const row of rows) body.push(rowLine(row, valueCol, contentWidth));
  }

  return [
    commandLine,
    topBorder(item.title, safeWidth),
    ...body,
    bottomBorder(safeWidth),
    ...(detailHint(item.data, visibleRows.length, expanded) ? [detailHint(item.data, visibleRows.length, expanded)!] : [])
  ];
}

function topBorder(title: string, width: number): string {
  const maxTitle = Math.max(0, width - 6);
  const truncated = truncateToWidth(title, maxTitle, "…");
  const fill = Math.max(0, width - 5 - truncated.length);
  return `╭─ ${theme.fg("accent", theme.bold(truncated))} ${"─".repeat(fill)}╮`;
}

function bottomBorder(width: number): string {
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function emptyRow(contentWidth: number): string {
  return `│ ${" ".repeat(contentWidth)} │`;
}

function rowLine(row: CommandCardRow, valueCol: number, contentWidth: number): string {
  const label = row.label === ""
    ? " ".repeat(valueCol)
    : theme.fg("dim", padLabel(row.label, valueCol));
  const value = normalizeValue(row.value).map((segment) => renderSegment(segment, row.tone)).join("");
  const content = truncateToWidth(`${label}${value}`, contentWidth, "…");
  const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
  return `│ ${content}${pad} │`;
}

function padLabel(label: string, valueCol: number): string {
  const base = ` ${label}:`;
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

function detailHint(data: CommandCardData, visibleCount: number, expanded: boolean): string | undefined {
  if (expanded) {
    return `${theme.fg("dim", "ctrl+o")}${theme.fg("muted", " to collapse")}`;
  }
  const hidden = data.sections.reduce((total, section) => total + section.rows.filter((row) => row.detail).length, 0);
  if (hidden <= 0) return undefined;
  const noun = hidden === 1 ? "field" : "fields";
  return `${theme.fg("dim", ` · ${String(hidden)} more ${noun} · `)}${theme.fg("dim", "ctrl+o")}${theme.fg("muted", " to expand")}`;
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
