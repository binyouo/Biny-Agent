/**
 * 设置草稿与主窗口关闭之间的有界握手。应用退出会丢弃渲染层草稿，不等待关闭确认。
 *
 * 主进程只保存脱敏的 dirty/canSave 状态。真正的三选一确认由 Renderer 现有设置详情层完成；
 * Renderer 崩溃、窗口销毁或超时都按取消处理，避免主进程无限等待或误丢草稿。
 */
import { randomUUID } from "node:crypto";
import { desktopIpc, type DesktopSettingsCloseIntent, type DesktopSettingsCloseResponse, type DesktopSettingsDraftState } from "../../protocol.js";

export interface SettingsCloseRenderer {
  isDestroyed(): boolean;
  send(channel: string, request: unknown): void;
  once(event: "destroyed" | "render-process-gone", listener: (...args: unknown[]) => void): this;
  removeListener(event: "destroyed" | "render-process-gone", listener: (...args: unknown[]) => void): this;
}

export type DesktopSettingsCloseDecision = "proceed" | "cancel";

interface PendingCloseRequest {
  id: string;
  promise: Promise<DesktopSettingsCloseDecision>;
  settle(decision: DesktopSettingsCloseDecision): void;
}

const defaultTimeoutMs = 30_000;

export class DesktopSettingsCloseCoordinator {
  private state: DesktopSettingsDraftState = { dirty: false, canSave: false, open: false };
  private pending?: PendingCloseRequest;

  constructor(private readonly timeoutMs = defaultTimeoutMs) {}

  updateState(state: DesktopSettingsDraftState): void {
    this.state = { ...state };
  }

  reset(): void {
    this.pending?.settle("cancel");
    this.pending = undefined;
    this.state = { dirty: false, canSave: false, open: false };
  }

  async request(
    renderer: SettingsCloseRenderer | undefined,
    intent: DesktopSettingsCloseIntent
  ): Promise<DesktopSettingsCloseDecision> {
    if (!this.state.dirty || intent === "quit") return "proceed";
    if (this.pending) return await this.pending.promise;
    if (!renderer || renderer.isDestroyed()) return "cancel";

    const id = randomUUID();
    let settled = false;
    const timeout: { value?: ReturnType<typeof setTimeout> } = {};
    let resolvePromise: (decision: DesktopSettingsCloseDecision) => void = () => undefined;
    const promise = new Promise<DesktopSettingsCloseDecision>((resolve) => {
      resolvePromise = resolve;
    });
    const rendererUnavailable = (): void => settle("cancel");
    const cleanup = (): void => {
      if (timeout.value) clearTimeout(timeout.value);
      renderer.removeListener("destroyed", rendererUnavailable);
      renderer.removeListener("render-process-gone", rendererUnavailable);
      if (this.pending?.id === id) this.pending = undefined;
    };
    const settle = (decision: DesktopSettingsCloseDecision): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(decision);
    };
    this.pending = { id, promise, settle };
    renderer.once("destroyed", rendererUnavailable);
    renderer.once("render-process-gone", rendererUnavailable);
    timeout.value = setTimeout(() => settle("cancel"), this.timeoutMs);
    try {
      renderer.send(desktopIpc.settingsCloseRequest, {
        requestId: id,
        intent,
        canSave: this.state.canSave
      });
    } catch {
      settle("cancel");
    }
    return await promise;
  }

  resolve(requestId: string, response: DesktopSettingsCloseResponse): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== requestId) return false;
    if (response === "saved" || response === "discarded") {
      this.state = { dirty: false, canSave: false, open: false };
      pending.settle("proceed");
    } else {
      pending.settle("cancel");
    }
    return true;
  }
}
