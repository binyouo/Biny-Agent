/**
 * 内嵌终端管理器。
 *
 * 每个项目按终端标签复用 PTY 会话：关闭右侧面板不杀 shell，重新打开时回放最近输出接着用。
 * node-pty 是原生模块，惰性加载并把失败转成可展示的错误，避免缺少编译产物时拖垮主进程。
 */
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import type { DesktopTerminalEvent } from "../../protocol.js";

// 回放缓冲上限。够恢复可视区域和一段回滚历史，又不会让长跑任务无限占内存。
const maxReplayBytes = 256 * 1024;

interface TerminalSession {
  id: string;
  projectId: string;
  slotId: string;
  pty: IPty;
  replay: string;
  sequence: number;
  stopping?: boolean;
}

type PreviewStatus = { kind: "starting"; terminalId: string } | { kind: "running"; terminalId: string; url: string } | { kind: "failed"; error: string } | { kind: "stopped" };
interface PreviewLaunch { terminalId: string; status: "starting" | "running"; url?: string; candidate?: string; timer?: ReturnType<typeof setTimeout>; deadline: number }

export interface DesktopTerminalCreation {
  terminalId: string;
  replay: string;
  sequence: number;
}

export class DesktopTerminalManager {
  private generation = 0;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly byProject = new Map<string, string>();
  /** node-pty 是异步 import，创建期间先在项目维度占位，并发 create 复用同一次创建。 */
  private readonly pendingByProject = new Map<string, Promise<DesktopTerminalCreation>>();

  private readonly pendingPreviews = new Map<string, Promise<DesktopTerminalCreation>>();
  private readonly previewFailures = new Map<string, string>();
  private readonly previews = new Map<string, PreviewLaunch>();

  constructor(private readonly emit: (event: DesktopTerminalEvent) => void) {}

  async startPreview(projectId: string, cwd: string, command: string): Promise<DesktopTerminalCreation> {
    const pending = this.pendingPreviews.get(projectId);
    if (pending) return await pending;
    const start = async (): Promise<DesktopTerminalCreation> => {
      this.previewFailures.delete(projectId);
      const existing = this.list(projectId).some((entry) => entry.slotId === "preview");
      const handle = await this.create(projectId, cwd, 100, 30, "preview");
      if (!existing) {
        const launch: PreviewLaunch = { terminalId: handle.terminalId, status: "starting", deadline: Date.now() + 60_000 };
        this.previews.set(projectId, launch);
        this.schedulePreviewProbe(projectId, launch);
      }
      // shell 随服务退出，避免下次启动误把已结束的 shell 当作仍运行的开发服务器。
      if (!existing) this.write(handle.terminalId, `${command}; exit\r`);
      return handle;
    };
    const operation = start(); this.pendingPreviews.set(projectId, operation);
    try { return await operation; } finally { if (this.pendingPreviews.get(projectId) === operation) this.pendingPreviews.delete(projectId); }
  }

  previewFailure(projectId: string): string | undefined { return this.previewFailures.get(projectId); }
  clearPreviewFailure(projectId: string): void { this.previewFailures.delete(projectId); }
  previewStatus(projectId: string): PreviewStatus {
    const launch = this.previews.get(projectId);
    if (launch) return launch.status === "running" && launch.url
      ? { kind: "running", terminalId: launch.terminalId, url: launch.url }
      : { kind: "starting", terminalId: launch.terminalId };
    const error = this.previewFailures.get(projectId);
    return error ? { kind: "failed", error } : { kind: "stopped" };
  }

  private schedulePreviewProbe(projectId: string, launch: PreviewLaunch): void {
    launch.timer = setTimeout(() => { void this.probePreview(projectId, launch); }, 250);
    launch.timer.unref?.();
  }

  private async probePreview(projectId: string, launch: PreviewLaunch): Promise<void> {
    if (this.previews.get(projectId) !== launch || launch.status === "running") return;
    if (Date.now() >= launch.deadline) {
      this.dispose(launch.terminalId);
      this.previewFailures.set(projectId, "开发服务器在 60 秒内未提供可访问的本地地址，请检查终端输出。");
      return;
    }
    if (launch.candidate) {
      try {
        // 仅探测日志声明的环回地址；HTTP 有响应才代表服务实际可访问。
        await fetch(launch.candidate, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
        if (this.previews.get(projectId) === launch) { launch.url = launch.candidate; launch.status = "running"; }
        return;
      } catch { /* 启动过程中的连接拒绝可继续等待，直到有界超时。 */ }
    }
    if (this.previews.get(projectId) === launch) this.schedulePreviewProbe(projectId, launch);
  }

  async create(projectId: string, cwd: string, cols: number, rows: number, slotId = "default"): Promise<DesktopTerminalCreation> {
    const key = JSON.stringify([projectId, slotId]);
    const existingId = this.byProject.get(key);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) {
      existing.pty.resize(sanitizeSize(cols, 80), sanitizeSize(rows, 24));
      return { terminalId: existing.id, replay: existing.replay, sequence: existing.sequence };
    }
    const pending = this.pendingByProject.get(key);
    if (pending) return await pending;
    const creation = this.spawnSession(projectId, cwd, cols, rows, slotId);
    this.pendingByProject.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingByProject.get(key) === creation) this.pendingByProject.delete(key);
    }
  }

  list(projectId: string): { terminalId: string; slotId: string }[] {
    return [...this.sessions.values()].filter((session) => session.projectId === projectId)
      .map((session) => ({ terminalId: session.id, slotId: session.slotId }));
  }

  private async spawnSession(projectId: string, cwd: string, cols: number, rows: number, slotId: string): Promise<DesktopTerminalCreation> {
    const generation = this.generation;
    const { spawn } = await import("node-pty");
    if (generation !== this.generation) throw new Error("终端创建已取消：窗口正在关闭。");
    const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : "/bin/zsh";
    const pty = spawn(shell, ["-l"], {
      name: "xterm-256color",
      cwd,
      cols: sanitizeSize(cols, 80),
      rows: sanitizeSize(rows, 24),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
    });
    if (generation !== this.generation) { pty.kill(); throw new Error("终端创建已取消：窗口正在关闭。"); }
    const key = JSON.stringify([projectId, slotId]);
    const session: TerminalSession = { id: randomUUID(), projectId, slotId, pty, replay: "", sequence: 0 };
    this.sessions.set(session.id, session);
    this.byProject.set(key, session.id);
    pty.onData((data) => {
      session.replay = (session.replay + data).slice(-maxReplayBytes);
      if (slotId === "preview") {
        const launch = this.previews.get(projectId);
        if (launch?.terminalId === session.id && launch.status === "starting") {
          const clean = session.replay.slice(-8_000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
          const matches = clean.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s]*)?/giu);
          const match = [...matches].at(-1);
          if (match) {
            try {
              const url = new URL(match[0]);
              if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
              launch.candidate = url.href;
            } catch { /* 未完成的日志片段等待后续数据。 */ }
          }
        }
      }
      this.emit({ terminalId: session.id, type: "data", data, sequence: ++session.sequence });
    });
    pty.onExit(({ exitCode }) => {
      const launchAtExit = slotId === "preview" ? this.previews.get(projectId) : undefined;
      if (slotId === "preview") {
        const launch = this.previews.get(projectId);
        if (launch?.terminalId === session.id) { if (launch.timer) clearTimeout(launch.timer); this.previews.delete(projectId); }
      }
      if (slotId === "preview" && !session.stopping && (exitCode !== 0 || launchAtExit?.status === "starting")) {
        const output = session.replay.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").trim().slice(-2_000);
        this.previewFailures.set(projectId, output || `开发服务器在就绪前退出，代码 ${exitCode}。`);
      }
      this.sessions.delete(session.id);
      if (this.byProject.get(key) === session.id) this.byProject.delete(key);
      this.emit({ terminalId: session.id, type: "exit", exitCode, sequence: ++session.sequence });
    });
    return { terminalId: session.id, replay: "", sequence: 0 };
  }

  write(terminalId: string, data: string): void {
    this.sessions.get(terminalId)?.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.sessions.get(terminalId)?.pty.resize(sanitizeSize(cols, 80), sanitizeSize(rows, 24));
  }

  dispose(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    session.stopping = true;
    if (session.slotId === "preview") {
      this.previewFailures.delete(session.projectId);
      const launch = this.previews.get(session.projectId);
      if (launch?.terminalId === terminalId) { if (launch.timer) clearTimeout(launch.timer); this.previews.delete(session.projectId); }
    }
    this.sessions.delete(terminalId);
    const key = JSON.stringify([session.projectId, session.slotId]);
    if (this.byProject.get(key) === terminalId) this.byProject.delete(key);
    session.pty.kill();
  }

  disposeAll(): void {
    this.generation++;
    for (const session of this.sessions.values()) { session.stopping = true; session.pty.kill(); }
    this.sessions.clear();
    this.byProject.clear();
    this.previewFailures.clear();
    for (const launch of this.previews.values()) if (launch.timer) clearTimeout(launch.timer);
    this.previews.clear();
  }
}

function sanitizeSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 2 && value <= 1_000 ? Math.floor(value) : fallback;
}
