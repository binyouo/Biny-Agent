/** Regex CPU work stays off the Host thread; one bounded request is active at a time. */
import { Worker } from "node:worker_threads";

export const maxRegexQueryBytes = 64 * 1024;
export const maxRegexBatchLines = 128;
export const regexBatchTargetBytes = 64 * 1024;
// A batch may end with one streamed line, whose existing limit is 1 MiB.
const maxRegexBatchBytes = regexBatchTargetBytes + 1024 * 1024;
const maxRegexWorkers = 8;
const regexBatchTimeoutMs = 1_000;
const regexStartupTimeoutMs = 5_000;
let activeWorkers = 0;

export interface RegexBatchWindow {
  skipMatches: number;
  remainingMatches: number;
  contextLines: number;
  remainingContext: number;
  hasMore: boolean;
}

export class RegexExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegexExecutionError";
  }
}

// Static, self-contained CJS works in both compiled CLI and bundled Desktop.
// Query and file text are data, never interpolated into executable source.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const expression = new RegExp(workerData.query, workerData.flags);
parentPort.on("message", ({ lines, window }) => {
  const indexes = [];
  let hits = 0;
  let remainingContext = window.remainingContext;
  let hasMore = window.hasMore;
  for (const line of lines) {
    remainingContext = Math.max(0, remainingContext - 1);
    const index = expression.exec(line)?.index;
    indexes.push(index === undefined ? null : index);
    if (index !== undefined) {
      hits += 1;
      if (hits > window.skipMatches + window.remainingMatches) hasMore = true;
      else if (hits > window.skipMatches) remainingContext = window.contextLines;
    }
    if (hasMore && remainingContext === 0) break;
  }
  parentPort.postMessage(indexes);
});
parentPort.postMessage("ready");
`;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CancellableRegexMatcher {
  private pending: PendingRequest | undefined;
  private stopped = false;
  private failure: unknown;
  private termination: Promise<void> | undefined;
  private readonly onAbort = (): void => this.fail(this.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  private readonly onError = (error: Error): void => this.fail(new RegexExecutionError("Grep regex worker failed.", { cause: error }));
  private readonly onExit = (code: number): void => {
    if (!this.stopped) this.fail(new RegexExecutionError(`Grep regex worker exited unexpectedly (${String(code)}).`));
  };
  private readonly onMessage = (value: unknown): void => {
    if (this.stopped) return;
    const pending = this.pending;
    if (!pending) {
      this.fail(new RegexExecutionError("Grep regex worker returned an unexpected response."));
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(value);
  };

  private constructor(private readonly worker: Worker, private readonly signal: AbortSignal | undefined) {
    worker.on("message", this.onMessage);
    worker.on("error", this.onError);
    worker.on("exit", this.onExit);
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  static async create(query: string, flags: string, signal?: AbortSignal): Promise<CancellableRegexMatcher> {
    signal?.throwIfAborted();
    if (Buffer.byteLength(query, "utf8") > maxRegexQueryBytes) throw new RegexExecutionError("Grep regex exceeds its 64 KiB pattern limit.");
    if (activeWorkers >= maxRegexWorkers) throw new RegexExecutionError("Grep regex worker limit reached; retry after another search finishes.");
    activeWorkers += 1;
    let worker: Worker;
    try {
      worker = new Worker(workerSource, {
        eval: true,
        workerData: { query, flags },
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 }
      });
    } catch (error) {
      activeWorkers -= 1;
      throw new RegexExecutionError("Grep regex worker could not start.", { cause: error });
    }
    const matcher = new CancellableRegexMatcher(worker, signal);
    try {
      const ready = matcher.request(regexStartupTimeoutMs);
      if (signal?.aborted) matcher.onAbort();
      if (await ready !== "ready") throw new RegexExecutionError("Grep regex worker returned an invalid startup response.");
      return matcher;
    } catch (error) {
      await matcher.close();
      throw error;
    }
  }

  async match(lines: readonly string[], window: RegexBatchWindow): Promise<Array<number | undefined>> {
    this.signal?.throwIfAborted();
    if (this.stopped) throw this.failure;
    if (this.pending) throw new RegexExecutionError("Grep regex matcher already has a pending request.");
    if (!lines.length || lines.length > maxRegexBatchLines || lines.reduce((bytes, line) => bytes + Buffer.byteLength(line, "utf8"), 0) > maxRegexBatchBytes) {
      throw new RegexExecutionError("Grep regex batch exceeds its line or byte limit.");
    }
    const response = this.request(regexBatchTimeoutMs);
    try {
      this.worker.postMessage({ lines, window });
    } catch (error) {
      this.fail(new RegexExecutionError("Grep regex request could not be sent.", { cause: error }));
    }
    const indexes = await response;
    this.signal?.throwIfAborted();
    if (!Array.isArray(indexes) || indexes.length < 1 || indexes.length > lines.length
      || indexes.some((index: unknown, i: number) => index !== null && (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > lines[i]!.length))) {
      const error = new RegexExecutionError("Grep regex worker returned an invalid match response.");
      this.fail(error);
      throw error;
    }
    return indexes.map((index: number | null) => index ?? undefined);
  }

  close(): Promise<void> {
    if (!this.stopped) this.fail(new RegexExecutionError("Grep regex matcher is closed."));
    return this.termination!;
  }

  private request(timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(() => this.fail(new RegexExecutionError(`Grep regex ${timeoutMs === regexStartupTimeoutMs ? "startup" : "matching"} timed out.`)), timeoutMs)
      };
    });
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.failure = error;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.worker.off("message", this.onMessage);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    // Await actual termination before releasing the scheduler or worker-count slot.
    this.termination = this.worker.terminate().then(() => undefined).finally(() => {
      activeWorkers -= 1;
      this.worker.off("error", this.onError);
      this.worker.off("exit", this.onExit);
    });
  }
}
