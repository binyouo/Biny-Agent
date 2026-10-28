import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { z } from "zod";
import type { NativeProcessDriver } from "./nativeDriver.js";
import { updateConfig, type AgentConfigStore } from "../config/store.js";
import { appshotsSettingsSchema, type AppshotEvent, type AppshotsSettings, type AppshotsState } from "./appshotsProtocol.js";
const captureSchema = z.object({ path: z.string().min(1), bundleId: z.string().min(1), appName: z.string().default("应用"), pid: z.number().int().positive(), windowId: z.number().int().positive(), title: z.string().optional(), axText: z.string().max(64000).optional(), axError: z.string().optional(), axPending: z.boolean().optional(), frame: z.unknown().optional(), appIcon: z.unknown().optional() });
const contextSchema = z.object({ axText: z.string().max(64000).optional(), axError: z.string().max(4000).optional() });
type Capture = { bytes: Buffer; context: string; name: string; bundle: string; at: number; contextPending?: boolean; onContext?: (context: string) => void };
const frameSchema = z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive() });
const iconSchema = z.string().max(256_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u);
type AppshotFeedback = { type: "hotkey" } | { type: "captured"; bytes: Buffer; frame: z.infer<typeof frameSchema>; icon?: string };
const ownBundles = ["com.biny.desktop", "com.biny.computer-use", "com.github.Electron"];
export class Appshots {
  private snapshot: AppshotsState = { settings: { hotkey: "", target: "current" }, active: false, capturing: false };
  private readonly pending = new Map<string, Capture>();
  private readonly contexts = new Map<string, Capture>();
  private readonly earlyContexts = new Map<string, z.infer<typeof contextSchema>>();
  private readonly requests = new Map<string, AppshotsSettings["target"]>();
  private readonly unsubscribe: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private monitorGeneration = 0;
  private healthProbe = 0;
  private arming?: Promise<AppshotsState>;
  private rearmRequested = false;
  private closed = false;
  private events: Promise<void> = Promise.resolve();
  constructor(private readonly driver: NativeProcessDriver, private readonly store: AgentConfigStore, private readonly emit: (event: AppshotEvent, feedback?: AppshotFeedback) => void) {
    this.unsubscribe = driver.onNativeEvent((event, raw) => { if (event === "appshot") this.events = this.events.then(() => this.receive(raw)); });
  }
  async state(): Promise<AppshotsState> { this.snapshot.settings = (await this.store.load()).appshots; return { ...this.snapshot, settings: { ...this.snapshot.settings } }; }
  async settings(value: AppshotsSettings): Promise<AppshotsState> {
    value = appshotsSettingsSchema.parse(value);
    await updateConfig(this.store, undefined, config => ({ ...config, appshots: value }));
    return await this.prewarm();
  }
  async prewarm(): Promise<AppshotsState> {
    if (this.closed) throw new Error("appshots_closed");
    this.monitorGeneration++;
    this.rearmRequested = true;
    if (this.arming) return await this.arming;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    // Publish the flight before work starts, and clear it before exposing the final result.
    this.arming = Promise.resolve().then(async () => {
      try {
        let attempted: string | undefined;
        do {
          this.rearmRequested = false;
          const config = await this.store.load(); this.snapshot.settings = config.appshots;
          if (this.closed) break;
          const monitor = JSON.stringify([config.appshots.hotkey, config.activity.sensitiveApplications]);
          if (monitor === attempted) continue;
          attempted = monitor;
          try {
            if (!config.appshots.hotkey) { if (this.snapshot.active) await this.driver.daemonCommand("appshot_monitor_stop"); this.snapshot.active = false; }
            else {
              const reply = await this.driver.daemonCommand("appshot_monitor_start", { hotkey: config.appshots.hotkey, emit_events: true, include_ax: true, async_context: true, exclude_bundles: [...ownBundles, ...config.activity.sensitiveApplications] });
              if (this.closed) { await this.driver.daemonCommand("appshot_monitor_stop"); this.snapshot.active = false; return { ...this.snapshot }; }
              if (reply.data.armed !== true) throw new Error("appshot_monitor_not_armed: 热键监听未启动");
              this.snapshot.active = true;
            }
            this.snapshot.error = undefined;
          } catch (error) {
            if (config.appshots.hotkey) this.snapshot.active = false;
            const message = error instanceof Error ? error.message : String(error);
            this.snapshot.error = config.appshots.hotkey ? message : `appshot_monitor_stop_failed: 无法确认监听已停止。${message}`;
          }
        } while (this.rearmRequested && !this.closed);
        if (this.heartbeat) clearInterval(this.heartbeat);
        if (this.snapshot.active && !this.closed) {
          const generation = this.monitorGeneration;
          const hotkey = this.snapshot.settings.hotkey;
          this.heartbeat = setInterval(() => {
            const probe = ++this.healthProbe;
            const recover = (): void => {
              if (this.closed || generation !== this.monitorGeneration || probe !== this.healthProbe || !this.snapshot.active) return;
              if (hotkey) this.snapshot.active = false;
              this.snapshot.error = hotkey ? "appshot_monitor_disconnected: 正在恢复热键监听" : "appshot_monitor_stop_failed: 正在重试停止热键监听";
              const recovery = this.prewarm();
              const recoveryGeneration = this.monitorGeneration;
              void recovery.catch(error => { if (!this.closed && recoveryGeneration === this.monitorGeneration) this.snapshot.error = error instanceof Error ? error.message : String(error); });
            };
            void this.driver.daemonCommand("appshot_status").then(reply => {
              if (reply.data.live !== true || reply.data.owned === false || (typeof reply.data.hotkey === "string" && reply.data.hotkey !== hotkey)) recover();
            }).catch(recover);
          }, 60_000);
          this.heartbeat.unref?.();
        }
        return { ...this.snapshot };
      } catch (error) {
        if (!this.closed) {
          if (this.snapshot.active) {
            try { await this.driver.daemonCommand("appshot_monitor_stop"); this.snapshot.active = false; }
            catch (stopError) {
              const combined = new AggregateError([error, stopError], "appshot_monitor_stop_failed: 配置读取失败且无法确认旧监听已停止。");
              this.snapshot.error = combined.message;
              throw combined;
            }
          }
          this.snapshot.error = error instanceof Error ? error.message : String(error);
        }
        throw error;
      } finally { this.arming = undefined; }
    });
    return await this.arming;
  }
  async capture(): Promise<AppshotsState> {
    if (this.closed) throw new Error("appshots_closed");
    if (this.snapshot.capturing) throw new Error("appshot_capture_busy");
    this.snapshot.capturing = true;
    const id = randomUUID();
    try {
      const config = await this.store.load(); this.snapshot.settings = config.appshots;
      this.starting(id, config.appshots.target);
      const reply = await this.driver.daemonCommand("appshot_capture", { include_ax: true, async_context: true, appshot_id: id, wait_frontmost: true, exclude_bundles: [...ownBundles, ...config.activity.sensitiveApplications] });
      await this.accept(id, reply.data);
    } catch (error) { this.failed(id, error); }
    finally { this.snapshot.capturing = false; }
    return { ...this.snapshot };
  }
  private starting(id: string, target: AppshotsSettings["target"], hotkey = false): void {
    if (this.closed) return;
    if (this.requests.size >= 8) { const oldest = this.requests.keys().next().value!; this.requests.delete(oldest); this.earlyContexts.delete(oldest); }
    this.requests.set(id, target); this.emit({ type: "starting", id, target }, hotkey ? { type: "hotkey" } : undefined);
  }
  private failed(id: string, error: unknown): void {
    this.requests.delete(id); this.earlyContexts.delete(id); this.snapshot.error = error instanceof Error ? error.message : String(error);
    if (!this.closed) this.emit({ type: "failed", id, error: this.snapshot.error });
  }
  private async receive(raw: unknown): Promise<void> {
    const event = z.object({ type: z.enum(["starting", "captured", "failed", "context"]), id: z.string(), data: z.unknown().optional(), error: z.string().optional() }).safeParse(raw);
    if (!event.success || this.closed) return;
    const value = event.data;
    try {
      if (value.type === "starting") this.starting(value.id, (await this.store.load()).appshots.target, true);
      else if (value.type === "captured") await this.accept(value.id, value.data);
      else if (value.type === "context") await this.receiveContext(value.id, contextSchema.parse(value.data));
      else this.failed(value.id, new Error(value.error ?? "appshot_capture_failed"));
    } catch (error) { this.failed(value.id, error); }
  }
  private async accept(id: string, raw: unknown): Promise<void> {
    const data = captureSchema.parse(raw);
    let bytes: Buffer;
    try {
      const file = await open(data.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const info = await file.stat(); if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("appshot_image_budget_exceeded"); bytes = await file.readFile(); }
      finally { await file.close(); }
    } finally { await unlink(data.path).catch(() => undefined); }
    if (this.closed) { bytes.fill(0); return; }
    const target = this.requests.get(id);
    if (!target) { bytes.fill(0); return; }
    const config = await this.store.load();
    if (this.closed) { bytes.fill(0); return; }
    if ([...ownBundles, ...config.activity.sensitiveApplications].includes(data.bundleId)) { bytes.fill(0); throw new Error("appshot_application_excluded"); }
    for (const [key, value] of this.pending) if (Date.now() - value.at > 300_000 || this.pending.size >= 8) { value.bytes.fill(0); this.pending.delete(key); this.contexts.delete(key); }
    for (const [key, value] of this.contexts) if (Date.now() - value.at > 300_000 || this.contexts.size >= 8) this.contexts.delete(key);
    const source = { appName: data.appName, bundleId: data.bundleId, pid: data.pid, windowId: data.windowId, title: data.title };
    const context = JSON.stringify({ source, accessibility: data.axText?.slice(0, 24000) ?? "", accessibilityError: data.axPending ? "accessibility_pending" : data.axError });
    const capture: Capture = { bytes, context, name: `${data.appName}.jpg`, bundle: data.bundleId, at: Date.now(), contextPending: data.axPending };
    this.pending.set(id, capture);
    if (data.axPending) this.contexts.set(id, capture);
    this.requests.delete(id);
    const early = this.earlyContexts.get(id); this.earlyContexts.delete(id);
    if (early && data.axPending) await this.receiveContext(id, early);
    if (this.closed || this.pending.get(id) !== capture) return;
    const frame = frameSchema.safeParse(data.frame), icon = iconSchema.safeParse(data.appIcon);
    this.snapshot.error = undefined; this.emit({ type: "captured", id, target, source }, frame.success ? { type: "captured", bytes, frame: frame.data, icon: icon.success ? icon.data : undefined } : undefined);
  }
  private async receiveContext(id: string, data: z.infer<typeof contextSchema>): Promise<void> {
    const capture = this.contexts.get(id);
    if (!capture) { if (this.requests.has(id)) this.earlyContexts.set(id, data); return; }
    const config = await this.store.load();
    if (this.closed || this.contexts.get(id) !== capture) return;
    this.contexts.delete(id);
    capture.contextPending = false;
    if (Date.now() - capture.at > 300_000 || config.activity.sensitiveApplications.includes(capture.bundle)) { capture.onContext = undefined; return; }
    const source = (JSON.parse(capture.context) as { source: unknown }).source;
    capture.context = JSON.stringify({ source, accessibility: data.axText?.slice(0, 24000) ?? "", accessibilityError: data.axError });
    capture.onContext?.(capture.context); capture.onContext = undefined;
  }
  async take(id: string): Promise<Capture> {
    const capture = this.pending.get(id);
    if (!capture || Date.now() - capture.at > 300_000) { if (capture) capture.bytes.fill(0); this.pending.delete(id); this.contexts.delete(id); throw new Error("appshot_capture_expired"); }
    const config = await this.store.load();
    // Privacy reads yield; only the pending owner may transfer or clear bytes.
    if (this.pending.get(id) !== capture) throw new Error("appshot_capture_expired");
    if (this.closed || Date.now() - capture.at > 300_000) { capture.bytes.fill(0); this.pending.delete(id); this.contexts.delete(id); throw new Error("appshot_capture_expired"); }
    if (config.activity.sensitiveApplications.includes(capture.bundle)) { capture.bytes.fill(0); this.pending.delete(id); this.contexts.delete(id); throw new Error("appshot_application_excluded"); }
    this.pending.delete(id); return capture;
  }
  async close(): Promise<void> {
    this.closed = true; this.monitorGeneration++; this.unsubscribe(); if (this.heartbeat) clearInterval(this.heartbeat);
    let armingError: unknown;
    let armingFailed = false;
    try { await this.arming; } catch (error) { armingFailed = true; armingError = error; }
    try { if (this.snapshot.active) await this.driver.daemonCommand("appshot_monitor_stop"); }
    catch (error) { if (armingFailed) throw new AggregateError([armingError, error], "appshot_shutdown_failed"); throw error; }
    finally { this.driver.detach(); for (const value of this.pending.values()) value.bytes.fill(0); this.pending.clear(); this.contexts.clear(); this.earlyContexts.clear(); this.requests.clear(); }
    if (armingFailed) throw armingError;
  }
}
