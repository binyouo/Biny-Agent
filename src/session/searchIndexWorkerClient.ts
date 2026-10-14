import path from "node:path";
import { Worker } from "node:worker_threads";

interface PendingIndex {
  id: number;
  sessionId: string;
  filePath: string;
  signal: AbortSignal;
  abort: () => void;
  resolve: (count: number) => void;
  reject: (error: unknown) => void;
}

interface IndexReply {
  id: number;
  count?: number;
  error?: { name: string; message: string; code?: string };
}

export interface SessionSearchWorkerLease {
  index(sessionId: string, filePath: string, signal: AbortSignal): Promise<number>;
  release(): Promise<void>;
}

const workers = new Map<string, { worker: SessionSearchWorker; leases: number }>();

export function acquireSessionSearchWorker(agentRoot: string): SessionSearchWorkerLease {
  const key = path.resolve(agentRoot);
  let shared = workers.get(key);
  if (!shared) {
    shared = { worker: new SessionSearchWorker(key), leases: 0 };
    workers.set(key, shared);
  }
  shared.leases += 1;
  const entry = shared;
  let released = false;
  return {
    index: (sessionId, filePath, signal) => released
      ? Promise.reject(new Error("Session history worker lease released."))
      : entry.worker.index(sessionId, filePath, signal),
    async release() {
      if (released) return;
      released = true;
      entry.leases -= 1;
      if (entry.leases) return;
      workers.delete(key);
      await entry.worker.close();
    }
  };
}

class SessionSearchWorker {
  private readonly worker: Worker;
  private readonly exited: Promise<void>;
  private readonly queue: PendingIndex[] = [];
  private active: PendingIndex | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | undefined;
  private closing = false;
  private nextId = 0;

  constructor(agentRoot: string) {
    const source = import.meta.url.endsWith(".ts");
    const entry = new URL(source ? "./searchIndexWorker.ts" : "./searchIndexWorker.js", import.meta.url);
    const workerUrl = source ? new URL(`data:text/javascript,${encodeURIComponent(
      `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(entry.href)});`
    )}`) : entry;
    this.worker = new Worker(workerUrl, {
      workerData: { agentRoot }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }
    });
    this.worker.on("message", (reply: IndexReply) => this.complete(reply));
    this.worker.once("error", error => { this.failure ??= error; });
    this.exited = new Promise(resolve => this.worker.once("exit", code => {
      clearTimeout(this.deadline);
      this.failure ??= new Error(`Session history worker exited (${String(code)}).`);
      if (this.active) this.settle(this.active, undefined, this.failure);
      this.active = undefined;
      for (const request of this.queue.splice(0)) this.settle(request, undefined, this.failure);
      resolve();
    }));
    this.worker.unref();
  }

  index(sessionId: string, filePath: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new Error("Session history worker closed."));
    if (this.queue.length + Number(Boolean(this.active)) >= 64) return Promise.reject(new Error("Too many pending session history indexing requests."));
    return new Promise((resolve, reject) => {
      const request: PendingIndex = {
        id: ++this.nextId, sessionId, filePath, signal, resolve, reject,
        abort: () => {
          if (this.active === request) {
            this.worker.postMessage({ type: "cancel", id: request.id });
          } else {
            const index = this.queue.indexOf(request);
            if (index >= 0) this.queue.splice(index, 1);
            this.settle(request, undefined, signal.reason);
          }
        }
      };
      signal.addEventListener("abort", request.abort, { once: true });
      this.queue.push(request);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.worker.ref();
      const error = new Error("Session history worker closed.");
      for (const request of this.queue.splice(0)) this.settle(request, undefined, error);
      if (this.active) this.worker.postMessage({ type: "cancel", id: this.active.id });
      else this.worker.postMessage({ type: "close" });
    }
    await this.exited;
  }

  private dispatch(): void {
    if (this.active || this.failure) return;
    if (this.closing) { this.worker.postMessage({ type: "close" }); return; }
    const request = this.queue.shift();
    if (!request) { this.worker.unref(); return; }
    this.active = request;
    this.worker.ref();
    this.deadline = setTimeout(() => {
      this.failure ??= new Error("Session history indexing timed out.");
      void this.worker.terminate();
    }, 30_000);
    this.worker.postMessage({ type: "index", id: request.id, sessionId: request.sessionId, filePath: request.filePath });
  }

  private complete(reply: IndexReply): void {
    const request = this.active;
    if (!request || request.id !== reply.id) return;
    clearTimeout(this.deadline);
    this.active = undefined;
    const error = this.failure ?? (reply.error ? Object.assign(new Error(reply.error.message), reply.error) : undefined);
    this.settle(request, reply.count, error);
    this.dispatch();
  }

  private settle(request: PendingIndex, count?: number, error?: unknown): void {
    request.signal.removeEventListener("abort", request.abort);
    if (request.signal.aborted) request.reject(request.signal.reason);
    else if (error) request.reject(error);
    else request.resolve(count ?? 0);
  }
}
