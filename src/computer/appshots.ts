import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { z } from "zod";
import type { NativeProcessDriver } from "./nativeDriver.js";
import { updateConfig, type AgentConfigStore } from "../config/store.js";
import { appshotsSettingsSchema, type AppshotEvent, type AppshotsSettings, type AppshotsState } from "./appshotsProtocol.js";
const captureSchema = z.object({ path: z.string().min(1), bundleId: z.string().min(1), appName: z.string().default("应用"), pid: z.number().int().positive(), windowId: z.number().int().positive(), title: z.string().optional(), axText: z.string().max(64000).optional(), axError: z.string().optional() });
const ownBundles = ["com.biny.desktop", "com.biny.computer-use", "com.github.Electron"];
export class Appshots {
  private snapshot: AppshotsState = { settings: { hotkey: "", target: "current" }, active: false, capturing: false };
  private readonly pending = new Map<string, { bytes: Buffer; context: string; name: string; bundle: string; at: number }>();
  private readonly requests = new Map<string, AppshotsSettings["target"]>();
  private readonly unsubscribe: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private arming?: Promise<AppshotsState>;
  private closed = false;
  private events: Promise<void> = Promise.resolve();
  constructor(private readonly driver: NativeProcessDriver, private readonly store: AgentConfigStore, private readonly emit: (event: AppshotEvent) => void) {
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
    if (this.arming) return await this.arming;
    this.arming = (async () => {
      const config = await this.store.load(); this.snapshot.settings = config.appshots;
      try {
        if (!config.appshots.hotkey) { if (this.snapshot.active) await this.driver.daemonCommand("appshot_monitor_stop"); this.snapshot.active = false; }
        else {
          await this.driver.daemonCommand("appshot_monitor_start", { hotkey: config.appshots.hotkey, emit_events: true, include_ax: true, exclude_bundles: [...ownBundles, ...config.activity.sensitiveApplications] });
          if (this.closed) { await this.driver.daemonCommand("appshot_monitor_stop"); return this.snapshot; }
          this.snapshot.active = true;
        }
        this.snapshot.error = undefined;
      } catch (error) { this.snapshot.active = false; this.snapshot.error = error instanceof Error ? error.message : String(error); }
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.snapshot.active && !this.closed) {
        this.heartbeat = setInterval(() => { void this.driver.daemonCommand("appshot_status").then(reply => {
          if (!reply.data.live) { this.snapshot.active = false; this.snapshot.error = "appshot_monitor_disconnected: 请重新预热"; }
        }).catch(() => { this.snapshot.active = false; this.snapshot.error = "appshot_monitor_disconnected: 请重新预热"; }); }, 60_000);
        this.heartbeat.unref?.();
      }
      return { ...this.snapshot };
    })().finally(() => { this.arming = undefined; });
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
      const reply = await this.driver.daemonCommand("appshot_capture", { include_ax: true, wait_frontmost: true, exclude_bundles: [...ownBundles, ...config.activity.sensitiveApplications] });
      await this.accept(id, reply.data);
    } catch (error) { this.failed(id, error); }
    finally { this.snapshot.capturing = false; }
    return { ...this.snapshot };
  }
  private starting(id: string, target: AppshotsSettings["target"]): void {
    if (this.closed) return;
    if (this.requests.size >= 8) this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(id, target); this.emit({ type: "starting", id, target });
  }
  private failed(id: string, error: unknown): void {
    this.requests.delete(id); this.snapshot.error = error instanceof Error ? error.message : String(error);
    if (!this.closed) this.emit({ type: "failed", id, error: this.snapshot.error });
  }
  private async receive(raw: unknown): Promise<void> {
    const event = z.object({ type: z.enum(["starting", "captured", "failed"]), id: z.string(), data: z.unknown().optional(), error: z.string().optional() }).safeParse(raw);
    if (!event.success || this.closed) return;
    const value = event.data;
    try {
      if (value.type === "starting") this.starting(value.id, (await this.store.load()).appshots.target);
      else if (value.type === "captured") await this.accept(value.id, value.data);
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
    const target = this.requests.get(id); this.requests.delete(id);
    if (!target) { bytes.fill(0); return; }
    const config = await this.store.load();
    if ([...ownBundles, ...config.activity.sensitiveApplications].includes(data.bundleId)) { bytes.fill(0); throw new Error("appshot_application_excluded"); }
    for (const [key, value] of this.pending) if (Date.now() - value.at > 300_000 || this.pending.size >= 8) { value.bytes.fill(0); this.pending.delete(key); }
    const source = { appName: data.appName, bundleId: data.bundleId, pid: data.pid, windowId: data.windowId, title: data.title };
    const context = JSON.stringify({ source, accessibility: data.axText?.slice(0, 24000) ?? "", accessibilityError: data.axError });
    this.pending.set(id, { bytes, context, name: `${data.appName}.jpg`, bundle: data.bundleId, at: Date.now() });
    this.snapshot.error = undefined; this.emit({ type: "captured", id, target, source });
  }
  async take(id: string): Promise<{ bytes: Buffer; context: string; name: string }> {
    const capture = this.pending.get(id);
    if (!capture || Date.now() - capture.at > 300_000) { if (capture) capture.bytes.fill(0); this.pending.delete(id); throw new Error("appshot_capture_expired"); }
    const config = await this.store.load();
    if (config.activity.sensitiveApplications.includes(capture.bundle)) { capture.bytes.fill(0); this.pending.delete(id); throw new Error("appshot_application_excluded"); }
    this.pending.delete(id); return capture;
  }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe(); if (this.heartbeat) clearInterval(this.heartbeat);
    await this.arming;
    try { if (this.snapshot.active) await this.driver.daemonCommand("appshot_monitor_stop"); }
    finally { this.driver.detach(); for (const value of this.pending.values()) value.bytes.fill(0); this.pending.clear(); this.requests.clear(); }
  }
}
