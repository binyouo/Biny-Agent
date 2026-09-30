/** Main-process bridge; optional import-only native SDK lives in the static worker entry. */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ComputerDriver, DriverReply } from "./controller.js";
import { computerImageSchema, type ComputerAction, type WindowTarget } from "./protocol.js";
import { desktopCaptureSchedule } from "./captureSchedule.js";
import { resolveCuaWorkerEntry } from "./workerEntry.js";
export { parseCuaReply } from "./cuaContract.js";

const responseSchema = z.object({ id: z.string(), error: z.string().optional(), result: z.object({ data: z.record(z.unknown()), images: z.array(computerImageSchema).max(1), errorCode: z.string().optional() }).optional() }).strict();
interface Pending { worker: Worker; resolve: (result: DriverReply) => void; reject: (error: Error) => void; cleanup: () => void }
export class CuaWorkerDriver implements ComputerDriver {
  private worker?: Worker;
  private readonly pending = new Map<string, Pending>();
  private starting?: Promise<void>;
  private runtimeStarted = false;
  private readonly onExit: () => void;
  private readonly entry: URL;
  constructor(onExit: () => void, entry = new URL("./cuaWorker.js", import.meta.url)) { this.onExit = onExit; this.entry = resolveCuaWorkerEntry(entry); }
  workerPath(): string { return fileURLToPath(this.entry); }
  async diagnostics(): Promise<DriverReply> {
    const worker = this.worker ?? this.spawn();
    try { return await this.call(worker, "diagnostics", {}); }
    finally { if (!this.runtimeStarted && !this.starting) worker.unref(); }
  }
  private spawn(): Worker {
    const worker = new Worker(this.entry); this.worker = worker;
    worker.on("message", (raw: unknown) => {
      const parsed = responseSchema.safeParse(raw); if (!parsed.success) { this.failed(worker, "invalid SDK worker response"); return; }
      const reply = parsed.data; const job = this.pending.get(reply.id); if (!job || job.worker !== worker) return;
      this.pending.delete(reply.id); job.cleanup();
      if (reply.error || !reply.result) job.reject(new Error(reply.error ?? "SDK worker omitted result")); else job.resolve(reply.result);
    });
    worker.once("error", error => this.failed(worker, `driver_sdk_missing_or_crashed: ${error.message}`));
    worker.once("exit", code => this.failed(worker, `driver_worker_exited: ${code}`));
    return worker;
  }
  private failed(worker: Worker, message: string): void {
    for (const [id, job] of this.pending) { if (job.worker !== worker) continue; this.pending.delete(id); job.cleanup(); job.reject(new Error(message)); }
    if (this.worker === worker) { this.worker = undefined; const wasActive = this.runtimeStarted || Boolean(this.starting); this.runtimeStarted = false; if (wasActive) this.onExit(); }
  }
  private call(worker: Worker, method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply> {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = (): void => { worker.postMessage({ cancel: id }); };
      const timer = setTimeout(() => { abort(); const job = this.pending.get(id); if (job) { this.pending.delete(id); job.cleanup(); reject(new Error("SDK worker timed out; outcome may be unknown")); } }, 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { worker, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      worker.postMessage({ id, method, args });
      if (signal?.aborted) abort();
    });
  }
  async start(): Promise<void> {
    if (this.runtimeStarted) return;
    if (!this.starting) {
      const worker = this.worker ?? this.spawn();
      worker.ref();
      this.starting = this.call(worker, "start", {}).then(() => { this.runtimeStarted = true; }).catch(async error => { if (this.worker === worker) this.worker = undefined; this.runtimeStarted = false; await worker.terminate(); throw error; }).finally(() => { this.starting = undefined; });
    }
    await this.starting;
  }
  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const worker = this.worker; this.runtimeStarted = false; if (!worker) return;
    // The native addon registers callbacks for this Node environment. Replacing its worker
    // after shutdown breaks later futures in 0.30.4; retain the idle host until app disposal.
    try { await this.call(worker, "stop", {}); } finally { worker.unref(); }
  }
  async dispose(): Promise<void> {
    try { await this.stop(); }
    finally { const worker = this.worker; this.worker = undefined; if (worker) { await worker.terminate(); this.failed(worker, "driver_disposed"); } }
  }
  private ready(): Worker { if (!this.worker || !this.runtimeStarted) throw new Error("driver_not_connected"); return this.worker; }
  list(session: string, pid: number | undefined, signal: AbortSignal): Promise<DriverReply> { return this.call(this.ready(), "list", { session, pid }, signal); }
  observe(session: string, target: WindowTarget, signal: AbortSignal): Promise<DriverReply> { return desktopCaptureSchedule.run("active", () => this.call(this.ready(), "observe", { session, target }, signal)); }
  act(session: string, action: ComputerAction, signal: AbortSignal): Promise<DriverReply> { return this.call(this.ready(), "act", { session, action }, signal); }
}
