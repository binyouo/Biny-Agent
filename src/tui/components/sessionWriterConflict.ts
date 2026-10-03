/**
 * Session writer 冲突提示。
 *
 * 组件只负责把冲突状态和 Retry 键位画出来；取得 writer、读取历史和重试流程仍由
 * `BinyTui`/runtime 负责，避免展示层直接触碰 session 文件。
 */
import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/index.js";
import type { SessionWriterConflictInfo } from "../../runtime/SessionLease.js";

export type SessionWriterConflictView = SessionWriterConflictInfo;

export class SessionWriterConflictComponent implements Component {
  private retrying = false;

  constructor(
    private readonly conflict: SessionWriterConflictView,
    private readonly onRetry: () => void
  ) {}

  setRetrying(retrying: boolean): void {
    this.retrying = retrying;
  }

  invalidate(): void {
    // 每次 render 都按终端宽度截断，无缓存需要失效。
  }

  handleInput(data: string): void {
    if (this.retrying) return;
    if (matchesKey(data, "enter") || data.toLowerCase() === "r") this.onRetry();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const executing = this.conflict.conflictKind === "execution";
    const owner = this.conflict.ownerSurface === "desktop" ? "桌面端"
      : this.conflict.ownerSurface === "tui" ? "终端 TUI"
      : this.conflict.ownerSurface === "cli" ? "命令行" : "另一个执行入口";
    const title = truncateToWidth(`  🔒 ${executing ? `此会话正在由${owner}执行` : "此会话的写入权被占用"}`, safeWidth, "…");
    const detail = truncateToWidth(executing ? "  等待本轮结束后刷新状态；同目录的其他会话仍可使用。"
      : "  等待原进程完成或在那边关闭会话后刷新；其他会话仍可使用。", safeWidth, "…");
    const identity = [
      `  会话：${this.conflict.sessionId}`,
      this.conflict.runId === undefined ? undefined : `  运行：${this.conflict.runId}`,
      this.conflict.ownerPid === undefined ? undefined : `  ${executing ? "运行时" : "占用"}进程：${String(this.conflict.ownerPid)}`
    ].filter((line) => line !== undefined);
    const action = this.retrying ? "  刷新中…" : "  Enter/R 刷新状态（不会重发消息）";
    return [
      theme.fg("warning", title),
      theme.fg("muted", detail),
      ...identity.map((line) => theme.fg("dim", truncateToWidth(line, safeWidth, "…"))),
      theme.fg("dim", truncateToWidth(action, safeWidth, "…"))
    ];
  }
}
