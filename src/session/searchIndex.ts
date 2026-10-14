import type { DatabaseSync } from "node:sqlite";
import { SessionSearchStore, type SessionSearchRefreshOptions } from "./searchIndexStore.js";
import { acquireSessionSearchWorker, type SessionSearchWorkerLease } from "./searchIndexWorkerClient.js";

export * from "./searchIndexStore.js";

export class SessionSearchIndex extends SessionSearchStore {
  private workerLease: SessionSearchWorkerLease | undefined;
  private indexingController = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;

  override async refreshAll(options: SessionSearchRefreshOptions = {}): Promise<void> {
    return await this.track(super.refreshAll({ ...options, signal: this.indexingSignal(options.signal) }));
  }

  override async indexSessionFile(sessionId: string, filePath: string, signal?: AbortSignal): Promise<number> {
    const indexingSignal = this.indexingSignal(signal);
    indexingSignal.throwIfAborted();
    this.workerLease ??= acquireSessionSearchWorker(this.getAgentRoot());
    return await this.track(this.workerLease.index(sessionId, filePath, indexingSignal));
  }

  override close(): Promise<void> {
    this.closing ??= (async () => {
      this.indexingController.abort(new Error("Session history index closed."));
      await Promise.allSettled([...this.pending]);
      super.close();
      await this.workerLease?.release();
      this.workerLease = undefined;
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private indexingSignal(signal?: AbortSignal): AbortSignal {
    this.ensureOpen();
    return signal ? AbortSignal.any([signal, this.indexingController.signal]) : this.indexingController.signal;
  }

  protected override open(): DatabaseSync {
    this.ensureOpen();
    return super.open();
  }

  private ensureOpen(): void {
    if (this.closing) throw new Error("Session history index is closing.");
    if (this.indexingController.signal.aborted) this.indexingController = new AbortController();
  }

  private async track<Result>(promise: Promise<Result>): Promise<Result> {
    this.pending.add(promise);
    try { return await promise; }
    finally { this.pending.delete(promise); }
  }
}
