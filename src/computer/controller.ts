import { z } from "zod";
import { ToolOutcomeUnknownError } from "../tools/types.js";
import { computerActionSchema, computerImageSchema, windowTargetSchema, type ComputerAction, type ComputerAuditEntry, type ComputerImage, type ComputerPreview, type ComputerStatus, type WindowTarget } from "./protocol.js";

export interface DriverReply { data: Record<string, unknown>; images: ComputerImage[]; errorCode?: string }
export interface ComputerDriver {
  start(): Promise<void>; stop(): Promise<void>;
  list(session: string, pid: number | undefined, signal: AbortSignal): Promise<DriverReply>;
  observe(session: string, target: WindowTarget, signal: AbortSignal): Promise<DriverReply>;
  act(session: string, action: ComputerAction, signal: AbortSignal): Promise<DriverReply>;
}
const captureSchema = z.object({ pid: z.number().int(), window_id: z.number().int().safe(), capture_id: z.string().min(1), screenshot_width: z.number().int().positive(), screenshot_height: z.number().int().positive(), screenshot_frame_valid: z.literal(true), elements: z.array(z.object({ element_token: z.string().optional() }).passthrough()).optional() }).passthrough();
interface Capture { id: string; target: WindowTarget; at: number; width: number; height: number; tokens: Set<string>; appId?: string }
export class ComputerUseController {
  private snapshot: ComputerStatus = { state: "disabled", preview: false, foregroundAllowed: false, lastOutcome: "not-dispatched" };
  private capture?: Capture;
  private generation = 0;
  private active?: AbortController;
  private tail: Promise<void> = Promise.resolve();
  // 空闲后的物理进程重建由 driver 负责；这里仅记录是否完成首次显式启动。
  private started = false;
  private starting?: { promise: Promise<void>; generation: number; signal: AbortSignal };
  private entries: ComputerAuditEntry[] = [];
  // PiP 帧泵：预览开启时以 3fps 推送「可注视」的连续画面（Alma 设计：目的是可注视而非流畅）。
  private framePump?: ReturnType<typeof setInterval>;
  private readonly frameIntervalMs = 1000 / 3;
  private readonly driver: ComputerDriver;
  private readonly options: { enabled?: boolean; now?: () => number; preview?: (frame: ComputerPreview | undefined) => void; refreshPreview?: (session: string | undefined) => Promise<void>; authorize?: (session: string, target: WindowTarget, signal: AbortSignal) => Promise<string> };
  constructor(driver: ComputerDriver, options: { enabled?: boolean; now?: () => number; preview?: (frame: ComputerPreview | undefined) => void; refreshPreview?: (session: string | undefined) => Promise<void>; authorize?: (session: string, target: WindowTarget, signal: AbortSignal) => Promise<string> } = {}) {
    this.driver = driver; this.options = options;
    if (options.enabled) this.snapshot.state = "ready";
  }
  status(): ComputerStatus { return { ...this.snapshot }; }
  audit(): ComputerAuditEntry[] { return this.entries.map(entry => ({ ...entry, target: { ...entry.target } })); }
  setLogging(enabled: boolean): void { this.snapshot.actionLogging = enabled; if (!enabled) this.entries = []; }
  private record(action: ComputerAction, at: number, outcome: ComputerStatus["lastOutcome"], generation: number): void {
    if (!this.snapshot.actionLogging || generation !== this.generation) return;
    this.entries.push({ at, action: action.action, target: { pid: action.pid, windowId: action.windowId }, outcome, durationMs: Math.max(0, this.now() - at) });
    this.entries = this.entries.slice(-50);
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
    this.invalidate(); this.started = false; this.entries = []; this.snapshot = { ...this.snapshot, state: "disabled", owner: undefined, foregroundAllowed: false }; this.setPreview(false); this.stopFramePump();
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
    if (enabled) this.startFramePump(); else this.stopFramePump();
    if (!enabled) this.options.preview?.(undefined);
  }
  private startFramePump(): void {
    if (this.framePump || !this.options.refreshPreview) return;
    this.framePump = setInterval(() => {
      if (!this.snapshot.preview || this.snapshot.state !== "ready") return;
      void this.options.refreshPreview?.(this.snapshot.owner).catch(() => undefined);
    }, this.frameIntervalMs);
    if (typeof this.framePump === "object" && "unref" in this.framePump) this.framePump.unref();
  }
  private stopFramePump(): void {
    if (!this.framePump) return;
    clearInterval(this.framePump);
    this.framePump = undefined;
  }
  setForeground(enabled: boolean): void { this.snapshot.foregroundAllowed = enabled; this.invalidate(); }
  crashed(): void { this.invalidate(); this.started = false; this.snapshot.state = "disabled"; this.snapshot.owner = undefined; this.snapshot.diagnostic = "driver_exited"; this.snapshot.lastOutcome = "unknown"; }
  private invalidate(): void { this.generation++; this.capture = undefined; this.active?.abort(); this.options.preview?.(undefined); }
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
  observe(session: string, target: WindowTarget, signal?: AbortSignal): Promise<DriverReply> {
    target = windowTargetSchema.parse(target);
    return this.enqueue(session, signal, (s, generation) => this.captureWindow(session, target, s, generation));
  }
  private async captureWindow(session: string, target: WindowTarget, signal: AbortSignal, generation: number): Promise<DriverReply> {
    this.capture = undefined;
    const appId = await this.options.authorize?.(session, target, signal);
    signal.throwIfAborted(); if (generation !== this.generation) throw new Error("computer_authorization_invalidated");
    const reply = await this.driver.observe(session, target, signal);
    signal.throwIfAborted(); if (generation !== this.generation) throw new Error("computer_observation_invalidated");
    if (reply.errorCode) return reply;
    const data = captureSchema.parse(reply.data);
    if (data.pid !== target.pid || String(data.window_id) !== target.windowId) throw new Error("capture_target_mismatch");
    const images = reply.images.map(image => computerImageSchema.parse(image));
    if (images.length !== 1) throw new Error("computer_observation_requires_one_image");
    const at = this.now();
    this.capture = { id: data.capture_id, target: { ...target }, appId, at, width: data.screenshot_width, height: data.screenshot_height, tokens: new Set(data.elements?.flatMap(element => element.element_token ? [element.element_token] : []) ?? []) };
    if (this.snapshot.preview) this.options.preview?.({ image: images[0]!, target, capturedAt: at });
    return { ...reply, images };
  }
  act(session: string, input: Omit<ComputerAction, "delivery"> & { delivery?: ComputerAction["delivery"] }, signal?: AbortSignal): Promise<DriverReply> {
    const action = computerActionSchema.parse(input);
    return this.enqueue(session, signal, async (s, generation) => {
      const capture = this.capture;
      if (!capture || capture.id !== action.captureId || capture.target.pid !== action.pid || capture.target.windowId !== action.windowId) throw new Error("capture_target_mismatch_or_missing");
      if (this.now() - capture.at >= 60_000) { this.capture = undefined; throw new Error("capture_expired: observe again"); }
      if (action.x !== undefined && (action.x >= capture.width || action.y === undefined || action.y >= capture.height)) throw new Error("capture_coordinates_out_of_bounds");
      if (action.elementToken && !capture.tokens.has(action.elementToken)) throw new Error("element_token_not_in_observation");
      if (action.delivery === "foreground" && !this.snapshot.foregroundAllowed) throw new Error("foreground_permission_required: ask user to switch or enable foreground delivery");
      const appId = await this.options.authorize?.(session, capture.target, s);
      if (appId !== capture.appId) { this.capture = undefined; throw new Error("capture_app_identity_changed: observe again"); }
      s.throwIfAborted();
      if (generation !== this.generation) throw new Error("computer_authorization_invalidated");
      this.capture = undefined; this.snapshot.lastOutcome = "not-dispatched";
      let result: DriverReply;
      const at = this.now();
      try {
        result = await this.driver.act(session, action, s);
      } catch (error) {
        if (generation === this.generation) {
          this.record(action, at, "unknown", generation);
          this.invalidate(); this.snapshot.lastOutcome = "unknown"; this.snapshot.state = "unknown";
        }
        throw new ToolOutcomeUnknownError("interrupted", `computer action outcome unknown: ${error instanceof Error ? error.message : String(error)}`);
      }
      const effect = result.data.effect;
      const status = result.errorCode || effect === "refused" ? "refused" : effect === "confirmed" ? "completed" : "unverified";
      this.record(action, at, status, generation);
      if (s.aborted || generation !== this.generation) return this.verificationUnavailable(result, status, "computer_verification_interrupted", generation);
      this.snapshot.lastOutcome = status;
      // A fresh post-action frame is evidence for the next decision, not proof of the intended postcondition.
      if (status === "refused") return { ...result, data: { ...result.data, status } };
      try {
        const observation = await this.captureWindow(session, capture.target, s, generation);
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
