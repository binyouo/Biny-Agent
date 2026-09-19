/**
 * 底部信息区、状态行、快捷键行和启动头部。
 *
 * 这些组件都直接实现终端 `Component`：按当前宽度算好一行文本再着色，
 * 宽度不够时整条丢弃或截断，不会撑破终端。
 */
import os from "node:os";
import path from "node:path";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PermissionMode } from "../../permission/PermissionManager.js";
import type { ContextBudgetStatus } from "../../agent/context/types.js";
import type { TuiStatus } from "../types.js";
import { theme } from "../theme/index.js";
import { formatToolDuration } from "../transcriptText.js";

export interface FooterData {
  cwd: string;
  sessionId: string;
  viewingSessionId?: string;
  gitBranch?: string;
  modelLabel: string;
  thinkingLabel?: string;
  permissionMode: PermissionMode;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  contextSource?: "estimated" | "provider";
  cacheHitRate?: number;
  sessionCacheHitRate?: number;
}

/** 预算 → footer 水位字段；百分比按模型自身上下文窗口算，没有窗口信息时才退回输入预算。 */
export function footerUsageFromBudget(budget: ContextBudgetStatus): Pick<FooterData, "contextUsedTokens" | "contextMaxTokens" | "contextSource"> {
  return {
    contextUsedTokens: budget.usedTokens,
    contextMaxTokens: budget.contextWindow ?? budget.maxTokens,
    contextSource: budget.source
  };
}

/** 两行：工作区路径与会话，上下文用量与右对齐的模型。 */
export class FooterComponent implements Component {
  private data: FooterData;

  constructor(data: FooterData) {
    this.data = data;
  }

  setData(data: FooterData): void {
    this.data = data;
  }

  invalidate(): void {
    // 每次 render 都重新计算，无缓存需要失效。
  }

  render(width: number): string[] {
    const layout = footerLayout(this.data, width);
    return [
      theme.fg("dim", layout.workspace),
      contextColorize(layout.contextPercent, layout.context)
        + theme.fg("dim", `${layout.meta}${layout.gap}${layout.model}`)
    ];
  }
}

export function footerLayout(data: FooterData, width: number): {
  workspace: string;
  context: string;
  contextPercent: number | undefined;
  meta: string;
  gap: string;
  model: string;
} {
  const safeWidth = Math.max(1, Math.floor(width));

  const workspaceParts = [formatDisplayPath(data.cwd)];
  if (data.gitBranch) workspaceParts.push(`(${data.gitBranch})`);
  const session = shortSessionId(data.viewingSessionId ?? data.sessionId);
  const viewing = data.viewingSessionId !== undefined && data.viewingSessionId !== data.sessionId;
  if (session) workspaceParts.push(`• ${viewing ? "viewing " : ""}${session}`);
  const workspace = truncateToWidth(workspaceParts.join(" "), safeWidth, "…");

  const percent = contextPercent(data.contextUsedTokens, data.contextMaxTokens);
  const context = formatContextUsage(data.contextUsedTokens, data.contextMaxTokens, data.contextSource);

  const metaParts: string[] = [data.permissionMode];
  if (data.cacheHitRate !== undefined) metaParts.push(`CH ${String(Math.round(data.cacheHitRate * 100))}%`);
  if (data.sessionCacheHitRate !== undefined) metaParts.push(`S-CH ${String(Math.round(data.sessionCacheHitRate * 100))}%`);
  const meta = ` · ${metaParts.join(" · ")}`;

  const model = data.thinkingLabel && data.thinkingLabel.toLowerCase() !== "off"
    ? `${data.modelLabel} • ${data.thinkingLabel.toLowerCase()}`
    : data.modelLabel;

  const leftWidth = visibleWidth(context) + visibleWidth(meta);
  const modelWidth = visibleWidth(model);
  if (leftWidth + 2 + modelWidth <= safeWidth) {
    return {
      workspace,
      context,
      contextPercent: percent,
      meta,
      gap: " ".repeat(safeWidth - leftWidth - modelWidth),
      model
    };
  }

  // 窄终端优先保留上下文用量，模型名截断后紧跟其后。
  const available = Math.max(0, safeWidth - leftWidth - 1);
  const truncatedModel = available > 0 ? truncateToWidth(model, available, "…") : "";
  return {
    workspace,
    context,
    contextPercent: percent,
    meta: truncateToWidth(meta, Math.max(0, safeWidth - visibleWidth(context))),
    gap: truncatedModel ? " " : "",
    model: truncatedModel
  };
}

/** 上下文用量：`ctx 25%/128k`，未知窗口时只显示已用量。 */
export function formatContextUsage(
  used: number | undefined,
  max: number | undefined,
  source?: "estimated" | "provider"
): string {
  if (used === undefined) return "ctx —";
  const prefix = source === "estimated" ? "~" : "";
  if (max === undefined || max <= 0) return `ctx ${prefix}${formatTokens(used)}`;
  return `ctx ${prefix}${String(contextPercent(used, max) ?? 0)}%/${formatTokens(max)}`;
}

/** Token 数量的紧凑显示：1.2k / 128k / 1.5M。 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.max(0, Math.round(count)));
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${String(Math.round(count / 1000))}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${String(Math.round(count / 1_000_000))}M`;
}

/**
 * 会话标识的短形式。
 *
 * 会话 id 通常是 UUIDv7，时间戳位于前半部分；终端空间有限时取最后一段随机部分，
 * 没有分段时才退回截断。
 */
export function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) return "";
  const segments = trimmed.split("-").filter(Boolean);
  const tail = segments[segments.length - 1] ?? trimmed;
  if (segments.length > 1 && tail.length >= 4) return tail;
  return trimmed.length <= 10 ? trimmed : trimmed.slice(0, 8);
}

export function formatDisplayPath(cwd: string, homeDirectory = os.homedir()): string {
  if (cwd === homeDirectory) return "~";
  if (!cwd.startsWith(`${homeDirectory}${path.sep}`)) return cwd;
  return `~${path.sep}${path.relative(homeDirectory, cwd)}`;
}

function contextPercent(used: number | undefined, max: number | undefined): number | undefined {
  if (used === undefined || max === undefined || max <= 0) return undefined;
  return Math.min(999, Math.max(0, Math.round((used / max) * 100)));
}

function contextColorize(percent: number | undefined, text: string): string {
  if (percent !== undefined && percent > 90) return theme.fg("error", text);
  if (percent !== undefined && percent > 70) return theme.fg("warning", text);
  return theme.fg("dim", text);
}

/** 运行状态行：只展示 Agent 回合传入的实时和完成耗时。 */
export class StatusIndicatorComponent implements Component {
  private readonly ui: TUI;
  private readonly frames = ["•", "◦", "·", "◦"];
  private status: TuiStatus = "idle";
  private frameIndex = 0;
  private startedAtMs: number | undefined;
  private finishedDurationMs: number | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  constructor(ui: TUI) {
    this.ui = ui;
  }

  setState(status: TuiStatus, startedAtMs?: number, finishedDurationMs?: number): void {
    this.status = status;
    const active = status !== "idle";
    if (active) {
      if (this.startedAtMs === undefined) this.startedAtMs = startedAtMs ?? Date.now();
      this.finishedDurationMs = undefined;
      this.startTicker();
    } else {
      // 耗时以 reducer 中的真实 Agent 回合为唯一来源；模型切换等维护状态
      // 返回空闲时没有完成耗时，不能由组件自行结算出 `Worked for`。
      this.finishedDurationMs = finishedDurationMs;
      this.startedAtMs = undefined;
      this.stopTicker();
    }
    this.ui.requestRender();
  }

  dispose(): void {
    this.stopTicker();
  }

  invalidate(): void {
    // 每次 render 都按当前时间计算耗时，无缓存需要失效。
  }

  render(width: number): string[] {
    const durationMs = this.startedAtMs === undefined
      ? this.finishedDurationMs
      : Math.max(0, Date.now() - this.startedAtMs);
    const message = statusMessage(
      this.status,
      durationMs,
      this.startedAtMs === undefined ? "✓" : this.frames[this.frameIndex] ?? "•"
    );
    if (!message) return [""];
    const rendered = this.status === "idle" && durationMs !== undefined
      ? statusDivider(message, width)
      : truncateToWidth(message, width, "…");
    return [statusColorize(this.status, rendered)];
  }

  private startTicker(): void {
    if (this.tickTimer !== undefined) return;
    this.tickTimer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.ui.requestRender();
    }, 120);
  }

  private stopTicker(): void {
    if (this.tickTimer === undefined) return;
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }
}

export function statusMessage(status: TuiStatus, durationMs?: number, indicator = "•"): string {
  const duration = durationMs === undefined ? "" : ` (${formatToolDuration(durationMs)}`;
  const suffix = duration
    ? `${duration}${status === "thinking" || status === "running" ? " · esc to interrupt)" : ")"}`
    : status === "thinking" || status === "running" ? " (esc to interrupt)" : "";
  if (status === "thinking" || status === "running") return `${indicator} Working${suffix}`;
  if (status === "waiting_permission") return `${indicator} Waiting for approval${suffix}`;
  if (durationMs !== undefined) return `Worked for ${formatToolDuration(durationMs)}`;
  return "";
}

/** 将状态文案嵌入整行分割线，避免底部出现孤立的完成提示。 */
export function statusDivider(message: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const labelWidth = safeWidth - 3;
  if (labelWidth <= 0) return "─".repeat(safeWidth);
  const label = truncateToWidth(message, labelWidth, "…");
  const remaining = Math.max(0, safeWidth - 3 - visibleWidth(label));
  return `─ ${label} ${"─".repeat(remaining)}`;
}

function statusColorize(status: TuiStatus, text: string): string {
  if (status === "waiting_permission") {
    return theme.fg("warning", text);
  }
  return theme.fg("muted", text);
}

export interface ShortcutHint {
  key: string;
  description: string;
}

/** 快捷键提示行：键位 dim，说明 muted，放不下的整条丢弃。 */
export class ShortcutsBarComponent implements Component {
  private status: TuiStatus = "idle";

  setState(status: TuiStatus): void {
    this.status = status;
  }

  invalidate(): void {
    // 无缓存。
  }

  render(width: number): string[] {
    const hints = visibleShortcutHints(shortcutHints(this.status), width);
    return [hints
      .map((hint) => `${theme.fg("dim", hint.key)}${theme.fg("muted", ` ${hint.description}`)}`)
      .join(theme.fg("muted", " · "))];
  }
}

export function shortcutHints(status: TuiStatus): ShortcutHint[] {
  const busy = status === "thinking" || status === "running";
  const hints: ShortcutHint[] = [];
  if (status === "waiting_permission") {
    hints.push({ key: "enter", description: "answer" }, { key: "ctrl+o", description: "details" });
  } else if (busy) {
    hints.push({ key: "esc", description: "interrupt" });
  } else {
    hints.push({ key: "enter", description: "send" }, { key: "/", description: "commands" });
  }
  // 越靠前越重要：窄终端从末尾开始丢弃提示。
  hints.push(
    { key: "↑/↓", description: "history" },
    { key: "ctrl+c twice", description: "exit" }
  );
  return hints;
}

export function visibleShortcutHints(hints: readonly ShortcutHint[], width: number): ShortcutHint[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const visible: ShortcutHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const segment = visibleWidth(`${hint.key} ${hint.description}`) + (visible.length ? 3 : 0);
    if (used + segment > safeWidth) break;
    visible.push(hint);
    used += segment;
  }
  return visible;
}

/** 启动头部：产品名与版本、一行紧凑提示、工作区和引导语。 */
export class WelcomeComponent implements Component {
  constructor(private readonly cwd: string, private readonly version: string | undefined) {}

  invalidate(): void {
    // 无缓存。
  }

  render(width: number): string[] {
    const inner = Math.max(8, width - 2);
    const hints = visibleShortcutHints(welcomeHints, inner);
    return [
      ` ${theme.fg("accent", theme.bold("Biny"))}${this.version ? theme.fg("dim", ` v${this.version}`) : ""}`,
      ` ${hints
        .map((hint) => `${theme.fg("dim", hint.key)}${theme.fg("muted", ` ${hint.description}`)}`)
        .join(theme.fg("muted", " · "))}`,
      "",
      ` ${theme.fg("dim", truncateToWidth(`Workspace · ${this.cwd}`, inner, "…"))}`,
      ` ${theme.fg("dim", truncateToWidth(
        "A local agent is ready. Describe a task, or ask how to use and extend Biny.",
        inner,
        "…"
      ))}`
    ];
  }
}

export const welcomeHints: readonly ShortcutHint[] = [
  { key: "/", description: "commands" },
  { key: "esc", description: "interrupt" },
  { key: "ctrl+c twice", description: "exit" }
];
