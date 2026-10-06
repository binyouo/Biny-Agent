import { ComputerAuditStore } from "./auditStore.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ToolOutcomeUnknownError } from "../tools/types.js";
import { computerActionSchema, computerImageSchema, computerMirrorSchema, windowObserveSchema, type ComputerMirrorRequest, type ComputerAction, type ComputerAuditEntry, type ComputerImage, type ComputerPreview, type ComputerStatus, type WindowObserve, type WindowTarget } from "./protocol.js";

export interface DriverReply { data: Record<string, unknown>; images: ComputerImage[]; errorCode?: string }
export interface ComputerDriver {
  start(): Promise<void>; stop(): Promise<void>;
  list(session: string, pid: number | undefined, signal: AbortSignal): Promise<DriverReply>;
  observe(session: string, target: WindowObserve, signal: AbortSignal): Promise<DriverReply>;
  act(session: string, action: ComputerAction, signal: AbortSignal): Promise<DriverReply>;
  mirror?(operation: ComputerMirrorRequest["operation"], args: Record<string, unknown>): Promise<DriverReply>;
}
const captureSchema = z.object({ pid: z.number().int(), window_id: z.number().int().safe(), capture_id: z.string().min(1), screenshot_width: z.number().int().positive(), screenshot_height: z.number().int().positive(), screenshot_frame_valid: z.literal(true), elements: z.array(z.object({ element_token: z.string().optional() }).passthrough()).optional() }).passthrough();
interface Capture { id: string; target: WindowTarget; observation: WindowObserve; at: number; width: number; height: number; tokens: Set<string>; appId?: string }
interface ControllerOptions {
  enabled?: boolean;
  previewEnabled?: boolean;
  actionLogging?: boolean;
  auditStore?: ComputerAuditStore;
  now?: () => number;
  preview?: (frame: ComputerPreview | undefined) => void;
  refreshPreview?: (target: WindowTarget | undefined, signal: AbortSignal) => Promise<ComputerPreview | undefined>;
  authorize?: (session: string, target: WindowTarget, signal: AbortSignal) => Promise<string>;
  setPreviewVisible?: (visible: boolean) => void;
  previewIdleMs?: number;
  externalMirrors?: boolean;
  onMirrorChange?: (windowId: string, requestId?: string) => void;
  onPreviewError?: (error: string) => void;
}
export class ComputerUseController {
  private snapshot: ComputerStatus = { state: "disabled", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  private capture?: Capture;
  private generation = 0;
  private active?: AbortController;
  private tail: Promise<void> = Promise.resolve();
  // 空闲后的物理进程重建由 driver 负责；这里仅记录是否完成首次显式启动。
  private started = false;
  private starting?: { promise: Promise<void>; generation: number; signal: AbortSignal };
  private readonly journal: ComputerAuditStore;
  private mirrors = new Map<string, string>();
  // 关闭预览只撤销镜像打开请求，不中断输入；重新打开也不能复活旧请求。
  private mirrorGeneration = 0;
  // 预览只采集像素；在途捕获必须结束后才能接纳下一帧。
  private framePump?: ReturnType<typeof setInterval>;
  private previewRefresh?: AbortController;
  private previewRevision = 0;
  private readonly frameIntervalMs = 1000 / 3;
  // 预览窗的「用户在设置里开着」和「此刻真的显示着」是两件事：
  // 操控期间亮起监督窗，停手 90s 自动收起，
  // 但用户的选择不该因此被改掉。
  private previewShown = false;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private readonly previewIdleMs: number;
  constructor(private readonly driver: ComputerDriver, private readonly options: ControllerOptions = {}) {
    this.journal = options.auditStore ?? new ComputerAuditStore();
    this.snapshot.preview = options.previewEnabled ?? true;
    this.snapshot.actionLogging = options.actionLogging ?? false;
    this.previewIdleMs = options.previewIdleMs ?? 90_000;
    if (options.enabled) this.snapshot.state = "ready";
  }
  status(): ComputerStatus { return { ...this.snapshot }; }
  audit(): ComputerAuditEntry[] { return this.journal.recent(); }
  setLogging(enabled: boolean): void { this.snapshot.actionLogging = enabled; }
  private record(action: ComputerAction, at: number, outcome: ComputerStatus["lastOutcome"], detail: { bundleId?: string; errorCode?: string } = {}): void {
    if (!this.snapshot.actionLogging) return;
    try { this.journal.append({
      at, action: action.action, target: { pid: action.pid, windowId: action.windowId },
      outcome, durationMs: Math.max(0, this.now() - at), bundleId: detail.bundleId, errorCode: detail.errorCode
    }); } catch { this.snapshot.diagnostic = "computer_audit_write_failed"; }

  }
  async enable(): Promise<void> {
    if (this.snapshot.state !== "disabled") return;
    this.generation++;
    this.snapshot = { ...this.snapshot, state: "ready", diagnostic: undefined, lastOutcome: "not-dispatched" };
  }
  private async ensureStarted(signal: AbortSignal, generation: number): Promise<void> {
    signal.throwIfAborted();
    if (this.started) return;
    const previous = this.starting;
    if (previous && (previous.generation !== generation || previous.signal.aborted)) {
      // 等旧启动清理后再接纳新启动，避免迟到的 stop 关闭新请求正在使用的实例。
      await this.waitForStartup(previous.promise.catch(() => undefined), signal);
      signal.throwIfAborted();
      if (generation !== this.generation) throw new Error("computer_start_cancelled");
      return await this.ensureStarted(signal, generation);
    }
    if (!this.starting) {
      const promise = this.driver.start().then(async () => {
        if (signal.aborted || generation !== this.generation) {
          await this.driver.stop();
          throw new Error("computer_start_cancelled");
        }
        this.started = true;
        this.snapshot.diagnostic = undefined;
      }).catch((error: unknown) => {
        if (!signal.aborted && generation === this.generation) this.snapshot.diagnostic = error instanceof Error ? error.message : String(error);
        throw error;
      }).finally(() => { if (this.starting?.promise === promise) this.starting = undefined; });
      this.starting = { promise, generation, signal };
    }
    await this.waitForStartup(this.starting.promise, signal);
  }
  private async waitForStartup(startup: Promise<void>, signal: AbortSignal): Promise<void> {
    let abort: (() => void) | undefined;
    try {
      await Promise.race([startup, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  }
  async disable(): Promise<void> {
    this.invalidate(); this.started = false; this.snapshot = { ...this.snapshot, state: "disabled", owner: undefined, foregroundAllowed: false }; this.hidePreview(); this.stopFramePump();
    await this.driver.stop();
  }
  control(control: "pause" | "resume" | "takeover"): void {
    if (this.snapshot.state === "disabled") throw new Error("computer_disabled");
    this.invalidate(); this.snapshot.state = control === "resume" ? "ready" : control === "pause" ? "paused" : "taken-over";
  }
  release(session: string): void { if (this.snapshot.owner === session) { this.invalidate(); this.snapshot.owner = undefined; } }
  authorizationChanged(): void { this.invalidate(); }
  /** 当前有效期内的观察目标；PiP 帧泵用它决定重拍哪个窗口。 */
  currentCapture(): { target: WindowTarget } | undefined { return this.capture; }
  setPreview(enabled: boolean): void {
    this.snapshot.preview = enabled;
    if (!enabled) {
      this.mirrorGeneration++;
      for (const [windowId, requestId] of this.mirrors) { this.options.onMirrorChange?.(windowId); void this.driver.mirror?.("close", { window_id: Number(windowId), request_id: requestId }).catch(() => { this.snapshot.diagnostic = "computer_mirror_cleanup_failed"; }); }
      this.mirrors.clear();
    }
    if (enabled) this.showPreview(); else this.hidePreview();
  }
  dismissPreview(): void { this.hidePreview(); }
  /** 已派发动作续期监督窗，不改变用户的预览偏好。 */
  noteActivity(): void {
    if (!this.snapshot.preview) return;
    this.showPreview();
  }
  private showPreview(): void {
    this.previewShown = true;
    this.options.setPreviewVisible?.(true);
    this.startFramePump();
    this.armPreviewIdle();
  }
  private hidePreview(): void {
    const wasShown = this.previewShown;
    this.previewShown = false;
    this.clearPreviewIdle();
    this.stopFramePump();
    this.options.preview?.(undefined);
    if (wasShown) this.options.setPreviewVisible?.(false);
  }
  private armPreviewIdle(): void {
    this.clearPreviewIdle();
    this.previewTimer = setTimeout(() => { this.hidePreview(); }, this.previewIdleMs);
    if (typeof this.previewTimer === "object" && "unref" in this.previewTimer) this.previewTimer.unref();
  }
  private clearPreviewIdle(): void {
    if (!this.previewTimer) return;
    clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
  }
  private startFramePump(): void {
    if (this.framePump || !this.options.refreshPreview) return;
    this.framePump = setInterval(() => {
      if (!this.snapshot.preview || !this.previewShown || this.previewRefresh || this.active) return;
      if (["paused", "taken-over", "unknown"].includes(this.snapshot.state)) return;
      const controller = new AbortController();
      this.previewRefresh = controller;
      const revision = this.previewRevision, generation = this.generation, capture = this.capture;
      void (async () => {
        try {
          const frame = await this.options.refreshPreview?.(capture ? { ...capture.target } : undefined, controller.signal);
          if (controller.signal.aborted || revision !== this.previewRevision || generation !== this.generation || capture !== this.capture || this.active || !this.snapshot.preview || !this.previewShown) return;
          if (frame) this.options.preview?.(frame);
        } catch (error) { if (!controller.signal.aborted && revision === this.previewRevision) this.options.onPreviewError?.(error instanceof Error ? error.message : String(error)); }
        finally { if (this.previewRefresh === controller) this.previewRefresh = undefined; }
      })();
    }, this.frameIntervalMs);
    this.framePump.unref?.();
  }
  private stopFramePump(): void {
    this.previewRevision++; this.previewRefresh?.abort();
    if (!this.framePump) return;
    clearInterval(this.framePump);
    this.framePump = undefined;
  }
  setForeground(enabled: boolean): void { this.snapshot.foregroundAllowed = enabled; this.invalidate(); }
  crashed(): void { this.invalidate(); this.started = false; this.snapshot.state = "disabled"; this.snapshot.owner = undefined; this.snapshot.diagnostic = "driver_exited"; this.snapshot.lastOutcome = "unknown"; }
  private invalidate(): void {
    this.generation++; this.capture = undefined; this.active?.abort(); this.previewRefresh?.abort(); this.options.preview?.(undefined);
    for (const [windowId, requestId] of this.mirrors) { this.options.onMirrorChange?.(windowId); void this.driver.mirror?.("close", { window_id: Number(windowId), request_id: requestId }).catch(() => { this.snapshot.diagnostic = "computer_mirror_cleanup_failed"; }); }
    this.mirrors.clear();
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private enqueue<T>(session: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal, generation: number) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const run = this.tail.then(async () => {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new Error("computer_queue_invalidated");
      if (this.snapshot.state !== "ready") throw new Error(`computer_${this.snapshot.state}`);
      if (this.snapshot.owner && this.snapshot.owner !== session) throw new Error("computer_owner_conflict");
      this.snapshot.owner = session;
      const controller = new AbortController(); this.active = controller;
      const abort = (): void => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
      try {
        await this.ensureStarted(controller.signal, generation);
        controller.signal.throwIfAborted();
        if (generation !== this.generation || this.snapshot.state !== "ready") throw new Error("computer_start_cancelled");
        return await operation(controller.signal, generation);
      }
      finally { signal?.removeEventListener("abort", abort); if (this.active === controller) this.active = undefined; }
    });
    this.tail = run.then(() => undefined, () => undefined); return run;
  }
  list(session: string, pid?: number, signal?: AbortSignal): Promise<DriverReply> { return this.enqueue(session, signal, s => this.driver.list(session, pid, s)); }
  mirror(session: string, input: ComputerMirrorRequest, signal?: AbortSignal): Promise<DriverReply> {
    const request = computerMirrorSchema.parse(input);
    const mirrorGeneration = this.mirrorGeneration;
    return this.enqueue(session, signal, async (s, generation) => {
      const mirror = this.driver.mirror?.bind(this.driver);
      if (!mirror) throw new Error("computer_mirrors_unavailable");
      if (request.operation === "list") return await mirror("list", {});
      if (request.operation === "close") {
        const ids = request.all ? [...this.mirrors.keys()] : [request.windowId!];
        let closed = 0;
        for (const windowId of ids) {
          const requestId = this.mirrors.get(windowId);
          if (!requestId) continue;
          const reply = await mirror("close", { window_id: Number(windowId), request_id: requestId });
          closed += Number(reply.data.closed ?? 0); this.mirrors.delete(windowId); this.options.onMirrorChange?.(windowId);
        }
        return { data: { closed }, images: [] };
      }
      if (!this.snapshot.preview) throw new Error("computer_preview_disabled");
      if (mirrorGeneration !== this.mirrorGeneration) throw new Error("computer_mirror_invalidated");
      const target = { pid: request.pid!, windowId: request.windowId! };
      await this.options.authorize?.(session, target, s);
      s.throwIfAborted();
      if (generation !== this.generation) throw new Error("computer_authorization_invalidated");
      if (mirrorGeneration !== this.mirrorGeneration) throw new Error("computer_mirror_invalidated");
      const requestId = this.mirrors.get(target.windowId) ?? randomUUID();
      this.mirrors.set(target.windowId, requestId);
      try {
        const reply = await mirror("open", { pid: target.pid, window_id: Number(target.windowId), on_minimize: request.onMinimize, request_id: requestId, external: this.options.externalMirrors });
        if (s.aborted || generation !== this.generation || mirrorGeneration !== this.mirrorGeneration) {
          await mirror("close", { window_id: Number(target.windowId), request_id: requestId });
          throw new Error("computer_mirror_invalidated");
        }
        this.options.onMirrorChange?.(target.windowId, requestId);
        return reply;
      } catch (error) {
        if (this.mirrors.get(target.windowId) === requestId) this.mirrors.delete(target.windowId);
        // 超时也可能已经打开：只清理本次请求持有的镜像，不影响其他调用方。
        try { await mirror("close", { window_id: Number(target.windowId), request_id: requestId }); }
        catch { this.snapshot.diagnostic = "computer_mirror_cleanup_failed"; }
        throw error;
      }
    });
  }
  observe(session: string, target: WindowObserve, signal?: AbortSignal): Promise<DriverReply> {
    target = windowObserveSchema.parse(target);
    return this.enqueue(session, signal, (s, generation) => this.captureWindow(session, target, s, generation));
  }
  private async captureWindow(session: string, observation: WindowObserve, signal: AbortSignal, generation: number): Promise<DriverReply> {
    const target = { pid: observation.pid, windowId: observation.windowId };
    this.capture = undefined; this.previewRefresh?.abort();
    const appId = await this.options.authorize?.(session, target, signal);
    signal.throwIfAborted(); if (generation !== this.generation) throw new Error("computer_authorization_invalidated");
    const reply = await this.driver.observe(session, observation, signal);
    signal.throwIfAborted(); if (generation !== this.generation) throw new Error("computer_observation_invalidated");
    if (reply.errorCode) return reply;
    const data = captureSchema.parse(reply.data);
    if (data.pid !== target.pid || String(data.window_id) !== target.windowId) throw new Error("capture_target_mismatch");
    const images = reply.images.map(image => computerImageSchema.parse(image));
    if (images.length !== 1) throw new Error("computer_observation_requires_one_image");
    const at = this.now();
    this.capture = { id: data.capture_id, target, observation: { ...observation }, appId, at, width: data.screenshot_width, height: data.screenshot_height, tokens: new Set(data.elements?.flatMap(element => element.element_token ? [element.element_token] : []) ?? []) };
    if (this.snapshot.preview) this.options.preview?.({ image: images[0]!, target, capturedAt: at });
    return { ...reply, images };
  }
  act(session: string, input: Omit<ComputerAction, "delivery"> & { delivery?: ComputerAction["delivery"] }, signal?: AbortSignal): Promise<DriverReply> {
    const action = computerActionSchema.parse(input);
    return this.enqueue(session, signal, async (s, generation) => {
      const capture = this.capture;
      if (!capture || capture.id !== action.captureId || capture.target.pid !== action.pid || capture.target.windowId !== action.windowId) throw new Error("capture_target_mismatch_or_missing");
      if (this.now() - capture.at >= 60_000) { this.capture = undefined; throw new Error("capture_expired: observe again"); }
      if (action.coordinateSpace !== "screen" && [[action.x, action.y], [action.x1, action.y1], [action.x2, action.y2]].some(([x, y]) => x !== undefined && (x < 0 || y === undefined || y < 0 || x >= capture.width || y >= capture.height))) throw new Error("capture_coordinates_out_of_bounds");
      if (action.elementToken && !capture.tokens.has(action.elementToken)) throw new Error("element_token_not_in_observation");
      if (action.delivery === "foreground" && !this.snapshot.foregroundAllowed) throw new Error("foreground_permission_required: ask user to switch or enable foreground delivery");
      const appId = await this.options.authorize?.(session, capture.target, s);
      if (appId !== capture.appId) { this.capture = undefined; throw new Error("capture_app_identity_changed: observe again"); }
      s.throwIfAborted();
      if (generation !== this.generation) throw new Error("computer_authorization_invalidated");
      this.capture = undefined; this.previewRefresh?.abort(); this.snapshot.lastOutcome = "not-dispatched";
      let result: DriverReply;
      const at = this.now();
      try {
        result = await this.driver.act(session, action, s);
      } catch (error) {
        this.record(action, at, "unknown", { bundleId: capture.appId, errorCode: error instanceof Error ? error.message : String(error) });
        if (generation === this.generation) {
          this.invalidate(); this.snapshot.lastOutcome = "unknown"; this.snapshot.state = "unknown";
        }
        throw new ToolOutcomeUnknownError("interrupted", `computer action outcome unknown: ${error instanceof Error ? error.message : String(error)}`);
      }
      const effect = result.data.effect;
      const status = result.errorCode || effect === "refused" ? "refused" : effect === "confirmed" ? "completed" : "unverified";
      // 错误码可能挂在 result 上，也可能在 data 里（驱动把拒绝原因放在 data.code）。
      const failureCode = result.errorCode ?? (typeof result.data.code === "string" ? result.data.code : undefined);
      this.record(action, at, status, { bundleId: capture.appId, errorCode: failureCode });
      if (s.aborted || generation !== this.generation) return this.verificationUnavailable(result, status, "computer_verification_interrupted", generation);
      // 只有仍有效的已派发动作续期监督窗；迟到回执仍如实记录，但不能重开已停止的预览。
      if (status !== "refused") this.noteActivity();
      this.snapshot.lastOutcome = status;
      // A fresh post-action frame is evidence for the next decision, not proof of the intended postcondition.
      if (status === "refused") return { ...result, data: { ...result.data, status } };
      try {
        const observation = await this.captureWindow(session, capture.observation, s, generation);
        if (observation.errorCode) return this.verificationUnavailable(result, status, observation.errorCode, generation);
        return { data: { ...observation.data, status, action: result.data, observation: { available: true }, doNotRepeat: true }, images: observation.images };
      } catch (error) {
        return this.verificationUnavailable(result, status, `computer_verification_interrupted: ${error instanceof Error ? error.message : String(error)}`, generation);
      }
    });
  }
  private verificationUnavailable(result: DriverReply, status: ComputerStatus["lastOutcome"], reason: string, generation: number): DriverReply {
    if (generation === this.generation) { this.invalidate(); this.snapshot.state = "paused"; this.snapshot.lastOutcome = status; this.snapshot.diagnostic = `Input ${status}; observation unavailable: ${reason}. Do not repeat the input.`; }
    return { data: { status, action: result.data, observation: { available: false, reason }, observationRequired: true, workflowInterrupted: true, doNotRepeat: true }, images: [], errorCode: status === "refused" ? result.errorCode : undefined };
  }
}
