/** The native SDK runs only in an on-demand, independently disposable process. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ComputerDriver, DriverReply } from "./controller.js";
import { computerImageSchema, type ComputerAction, type WindowTarget } from "./protocol.js";
import { desktopCaptureSchedule } from "./captureSchedule.js";
import { resolveCuaProcessEntry } from "./workerEntry.js";
export { parseCuaReply } from "./cuaContract.js";

const maxIpcBytes = 2 * 1024 * 1024;
const maxPendingRequests = 32;
const responseSchema = z.object({ id: z.string().max(240), error: z.string().max(16_384).optional(), result: z.object({ data: z.record(z.unknown()), images: z.array(computerImageSchema).max(1), errorCode: z.string().optional() }).optional() }).strict();
interface Host { child: ChildProcess; exited: Promise<void>; done: boolean; intentional: boolean; closing?: Promise<void> }
interface Pending { host: Host; resolve: (result: DriverReply) => void; reject: (error: Error) => void; cleanup: () => void }
export interface CuaProcessDriverOptions {
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  killTimeoutMs?: number;
  idleClock?: {
    setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  };
}

export class CuaProcessDriver implements ComputerDriver {
  private host?: Host;
  private readonly pending = new Map<string, Pending>();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private runtimeStarted = false;
  private enabled = false;
  private disposed = false;
  private epoch = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly entry: URL;
  constructor(private readonly onExit: () => void, entry = new URL("./cuaProcess.js", import.meta.url), private readonly options: CuaProcessDriverOptions = {}) {
    this.entry = resolveCuaProcessEntry(entry);
  }
  workerPath(): string { return fileURLToPath(this.entry); }
  async diagnostics(): Promise<DriverReply> {
    this.assertLive(); await this.host?.closing; this.assertLive();
    const host = this.host ?? this.spawn();
    try { return await this.call(host, "diagnostics", {}); }
    finally {
      if (!this.runtimeStarted && !this.starting && !this.pending.size) await this.retire(host);
      else this.armIdle();
    }
  }
  private assertLive(): void { if (this.disposed) throw new Error("driver_disposed"); }
  private spawn(): Host {
    const child = fork(fileURLToPath(this.entry), [], {
      execPath: process.execPath, execArgv: [],
      // The signed app executable is retained, but its child must run Node rather than open another GUI.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json"
    });
    let exited!: () => void;
    const host: Host = { child, exited: new Promise<void>(resolve => { exited = resolve; }), done: false, intentional: false };
    this.host = host;
    child.on("message", (raw: unknown) => {
      let withinBudget = false;
      try { withinBudget = Buffer.byteLength(JSON.stringify(raw), "utf8") <= maxIpcBytes; } catch { /* Invalid IPC values are rejected below. */ }
      const parsed = withinBudget ? responseSchema.safeParse(raw) : undefined;
      if (!parsed?.success) { this.failAndRetire(host, withinBudget ? "invalid SDK process response" : "SDK process response exceeded IPC budget"); return; }
      const reply = parsed.data; const job = this.pending.get(reply.id);
      if (!job || job.host !== host) return;
      this.pending.delete(reply.id); job.cleanup();
      if (reply.error || !reply.result) job.reject(new Error(reply.error ?? "SDK process omitted result")); else job.resolve(reply.result);
      this.armIdle();
    });
    child.on("error", error => this.failAndRetire(host, `driver_sdk_missing_or_crashed: ${error.message}`));
    child.on("disconnect", () => { if (!host.done && !host.intentional) this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); });
    child.once("exit", (code, signal) => {
      host.done = true; exited();
      const startup = !this.runtimeStarted && Boolean(this.starting);
      this.failed(host, startup ? `driver_sdk_missing_or_crashed: process exited ${String(code ?? signal)}` : `driver_process_exited: ${String(code ?? signal)}; outcome may be unknown`);
      if (this.host === host) { this.host = undefined; this.runtimeStarted = false; }
      child.removeAllListeners();
    });
    return host;
  }
  private rejectPending(host: Host, message: string): void {
    for (const [id, job] of this.pending) {
      if (job.host !== host) continue;
      this.pending.delete(id); job.cleanup(); job.reject(new Error(message));
    }
  }
  private failed(host: Host, message: string, notifyEnabled = false): void {
    this.rejectPending(host, message);
    if (this.host === host && !host.intentional) {
      const wasActive = this.enabled && (this.runtimeStarted || Boolean(this.starting) || notifyEnabled);
      this.enabled = false; this.epoch++; this.runtimeStarted = false; this.clearIdle();
      if (wasActive) this.onExit();
    }
  }
  private failAndRetire(host: Host, message: string): void {
    const reason = message.startsWith("driver_process_disconnected") && !this.runtimeStarted && this.starting
      ? `driver_sdk_missing_or_crashed: ${message}` : message;
    this.failed(host, reason); void this.retire(host).catch(() => undefined);
  }
  private call(host: Host, method: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<DriverReply> {
    signal?.throwIfAborted();
    if (this.pending.size >= maxPendingRequests) return Promise.reject(new Error("driver_busy: IPC request budget reached"));
    if (host.done || !host.child.connected) return Promise.reject(new Error("driver_process_disconnected; outcome may be unknown"));
    const id = randomUUID(); const request = { id, method, args };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > maxIpcBytes) return Promise.reject(new Error("driver_request_too_large: request was not dispatched"));
    this.clearIdle();
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        try { host.child.send({ cancel: id }, error => { if (error) this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); }); }
        catch { this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); }
      };
      const timer = setTimeout(() => {
        const job = this.pending.get(id); if (!job) return;
        if (method === "stop") { this.pending.delete(id); job.cleanup(); reject(new Error("SDK process shutdown timed out")); }
        else this.failAndRetire(host, "SDK process timed out; outcome may be unknown");
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { host, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      try { host.child.send(request, error => { if (error) this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); }); }
      catch { this.failAndRetire(host, "driver_process_disconnected; outcome may be unknown"); }
      if (signal?.aborted) abort();
    });
  }
  async start(): Promise<void> {
    this.assertLive(); if (!this.enabled) { this.enabled = true; this.epoch++; }
    await this.stopping; await this.ensureStarted();
  }
  private async ensureStarted(): Promise<void> {
    this.assertLive();
    if (!this.enabled) throw new Error("driver_not_connected");
    if (this.runtimeStarted && this.host && !this.host.closing) return;
    if (!this.starting) {
      const epoch = this.epoch; let host: Host | undefined;
      const starting = (async () => {
        await this.host?.closing;
        if (!this.enabled || epoch !== this.epoch) throw new Error("driver_start_cancelled");
        host = this.host ?? this.spawn(); await this.call(host, "start", {});
        if (!this.enabled || epoch !== this.epoch || host.done || host.intentional) throw new Error("driver_start_cancelled");
        this.runtimeStarted = true;
      })().catch(async (error: unknown) => {
        if (epoch === this.epoch) { this.enabled = false; this.runtimeStarted = false; }
        if (host) await this.retire(host);
        throw error;
      }).finally(() => { if (this.starting === starting) this.starting = undefined; this.armIdle(); });
      this.starting = starting;
    }
    await this.starting;
  }
  async stop(): Promise<void> {
    this.enabled = false; this.epoch++; this.runtimeStarted = false; this.clearIdle();
    if (!this.stopping) {
      const stopping = this.host ? this.retire(this.host) : Promise.resolve();
      this.stopping = stopping.finally(() => { this.stopping = undefined; });
    }
    await this.stopping;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); }
  private retire(host: Host): Promise<void> {
    if (host.closing) return host.closing;
    host.intentional = true;
    if (this.host === host) { this.runtimeStarted = false; this.clearIdle(); }
    this.rejectPending(host, "driver_stopped; interrupted outcome may be unknown");
    host.closing = (async () => {
      const deadline = Date.now() + 4_000;
      let shutdownCompleted = false;
      try {
        if (!host.done && host.child.connected) {
          await this.call(host, "stop", {}, undefined, Math.min(this.options.shutdownTimeoutMs ?? 2_000, 2_000));
          shutdownCompleted = true;
        }
      }
      catch { /* Shutdown failure is resolved by bounded process termination, never replay. */ }
      await this.terminate(host, deadline, shutdownCompleted);
    })();
    return host.closing;
  }
  private async terminate(host: Host, deadline: number, shutdownCompleted: boolean): Promise<void> {
    const phaseMs = Math.min(this.options.killTimeoutMs ?? 500, 500);
    if (host.done) return;
    if (shutdownCompleted && await this.waitExit(host, Math.min(phaseMs, Math.max(0, deadline - Date.now() - 2 * phaseMs)))) return;
    host.child.kill("SIGTERM");
    if (await this.waitExit(host, Math.min(phaseMs, Math.max(0, deadline - Date.now() - phaseMs)))) return;
    host.child.kill("SIGKILL");
    if (!await this.waitExit(host, Math.min(phaseMs, Math.max(0, deadline - Date.now())))) throw new Error("driver_process_did_not_exit");
  }
  private waitExit(host: Host, timeoutMs: number): Promise<boolean> {
    if (host.done) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void host.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
  }
  private clearIdle(): void {
    if (this.idleTimer === undefined) return;
    (this.options.idleClock?.clearTimeout ?? clearTimeout)(this.idleTimer); this.idleTimer = undefined;
  }
  private armIdle(): void {
    this.clearIdle();
    const host = this.host;
    if (!host || host.done || host.closing || !this.enabled || !this.runtimeStarted || this.starting || this.pending.size) return;
    this.idleTimer = (this.options.idleClock?.setTimeout ?? setTimeout)(() => {
      this.idleTimer = undefined;
      if (this.host === host && this.enabled && !this.starting && !this.pending.size) void this.retire(host).catch(() => {
        host.intentional = false;
        this.failed(host, "driver_idle_retirement_failed", true);
      });
    }, this.options.idleTimeoutMs ?? 900_000);
    this.idleTimer.unref();
  }
  private async ready(signal: AbortSignal): Promise<Host> {
    signal.throwIfAborted(); await this.ensureStarted(); signal.throwIfAborted();
    if (!this.host || !this.runtimeStarted) throw new Error("driver_not_connected");
    return this.host;
  }
  async list(session: string, pid: number | undefined, signal: AbortSignal): Promise<DriverReply> { return await this.call(await this.ready(signal), "list", { session, pid }, signal); }
  observe(session: string, target: WindowTarget, signal: AbortSignal): Promise<DriverReply> { return desktopCaptureSchedule.run("active", async () => this.call(await this.ready(signal), "observe", { session, target }, signal)); }
  async act(session: string, action: ComputerAction, signal: AbortSignal): Promise<DriverReply> { return await this.call(await this.ready(signal), "act", { session, action }, signal); }
}
