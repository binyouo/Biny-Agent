import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, lstat, rmdir, rename } from "node:fs/promises";
import path from "node:path";
import type { ManagedProcessOutput, ReadManagedProcessOutputOptions } from "./ManagedProcessService.js";
import { assertManagedLogBinding, bindManagedProcessLog, readManagedProcessLog, readBoundManagedLogBytes, removeBoundManagedLog, type ManagedProcessLogBinding } from "./managedProcessLog.js";

export const managedProcessLogLimits = {
  segmentBytes: 64 * 1024,
  processBytes: 1024 * 1024,
  pendingBytes: 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  completedLogs: 200,
  completedAgeMs: 24 * 60 * 60 * 1000
};
type Limits = typeof managedProcessLogLimits;
interface Segment { binding: ManagedProcessLogBinding; start: number; end: number; }
interface PendingChunk { bytes: Buffer; start: number; }
interface Owner { version: 1; id: string; pid: number; createdAt: number; completedAt?: number; }

/** 一个 Host 内共享的磁盘配额；写入、读取和淘汰共用队列，读取中的分段不会被删除。 */
export class ManagedProcessLogStore {
  private readonly logs = new Set<ManagedProcessLog>();
  private readonly limits: Limits;
  private initialization?: Promise<void>;
  private tail = Promise.resolve();
  private bytes = 0;
  private sweep?: ReturnType<typeof setInterval>;
  private closing = false;
  private maintenanceError?: string;

  constructor(public root: string, limits: Partial<Limits> = {}) {
    this.limits = { ...managedProcessLogLimits, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Managed log limits must be positive safe integers.");
    if (this.limits.segmentBytes > this.limits.processBytes || this.limits.processBytes > this.limits.totalBytes) throw new RangeError("Managed log segment, process and total budgets must be ordered.");
  }

  async initialize(): Promise<void> {
    if (this.closing) throw new Error("Managed log store is closing.");
    this.initialization ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if ((await lstat(this.root)).isSymbolicLink()) throw new Error("Managed log root must not be a symbolic link.");
      this.root = await realpath(this.root);
      await this.assertDirectory(this.root);
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}\.log$/u.test(entry.name)) continue;
        const directory = path.join(this.root, entry.name);
        await this.assertDirectory(directory);
        const marker = path.join(directory, "owner.json");
        const markerFile = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let markerBinding: ManagedProcessLogBinding;
        let markerBytes: Buffer;
        try {
          markerBinding = await bindManagedProcessLog(marker, markerFile);
          const info = await markerFile.stat();
          if (info.size > 1024) throw new Error("Invalid managed log owner marker.");
          markerBytes = await readBoundManagedLogBytes(markerBinding, 0, info.size);
        } finally { await markerFile.close(); }
        const owner = JSON.parse(markerBytes.toString("utf8")) as Owner;
        if (owner.version !== 1 || `${owner.id}.log` !== entry.name || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || !Number.isFinite(owner.createdAt)
          || (owner.completedAt !== undefined && !Number.isFinite(owner.completedAt))) throw new Error("Invalid managed log owner marker.");
        // 未完成且 owner 仍存活的日志不属于这次恢复；不能删除另一个 owner 的文件。
        if (owner.completedAt === undefined && processAlive(owner.pid)) throw new Error("Managed logs are still owned by a live process.");
        const log = new ManagedProcessLog(this, directory, owner, markerBinding, this.limits);
        for (const file of await readdir(directory)) {
          if (file === "owner.json") continue;
          if (!/^\d{16}\.seg$/u.test(file)) throw new Error("Unexpected file in managed log directory.");
          const filePath = path.join(directory, file);
          const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const binding = await bindManagedProcessLog(filePath, handle);
            const size = Number((await handle.stat()).size);
            const start = Number(file.slice(0, 16));
            if (size > this.limits.segmentBytes || !Number.isSafeInteger(start + size)) throw new Error("Invalid managed log segment.");
            log.segments.push({ binding, start, end: start + size });
            this.bytes += size;
          } finally { await handle.close(); }
        }
        log.segments.sort((a, b) => a.start - b.start);
        if (log.segments.some((segment, index) => index > 0 && log.segments[index - 1]!.end > segment.start)) throw new Error("Overlapping managed log segments.");
        log.totalBytes = log.segments.at(-1)?.end ?? 0;
        log.completedAt = owner.completedAt ?? owner.createdAt;
        this.logs.add(log);
      }
      await this.prune();
      this.sweep = setInterval(() => { void this.exclusive(() => this.prune()).catch(error => { this.maintenanceError = message(error); }); }, 60_000);
      this.sweep.unref();
    })();
    await this.initialization;
    if (this.closing) throw new Error("Managed log store is closing.");
  }

  async create(id: string, onDispose: () => void): Promise<ManagedProcessLog> {
    await this.initialize();
    return this.exclusive(async () => {
      if (this.closing) throw new Error("Managed log store is closing.");
      await this.prune();
      const directory = path.join(this.root, `${id}.log`);
      await mkdir(directory, { mode: 0o700 });
      const owner: Owner = { version: 1, id, pid: process.pid, createdAt: Date.now() };
      const marker = path.join(directory, "owner.json");
      let binding: ManagedProcessLogBinding | undefined;
      try {
        const handle = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { binding = await bindManagedProcessLog(marker, handle); await handle.writeFile(JSON.stringify(owner)); }
        finally { await handle.close(); }
      } catch (error) {
        try {
          if (binding) await removeBoundManagedLog(binding);
          await this.assertDirectory(directory);
          await rmdir(directory);
        } catch (cleanup) { throw new AggregateError([error, cleanup], "Managed log preparation and cleanup failed."); }
        throw error;
      }
      const log = new ManagedProcessLog(this, directory, owner, binding, this.limits, onDispose);
      this.logs.add(log);
      return log;
    });
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async recordLifecycle(filename: string, entry: string): Promise<void> {
    if (Buffer.byteLength(entry) + 1 > 1024 * 1024) throw new Error("Managed process lifecycle entry exceeds 1 MiB.");
    await this.exclusive(async () => {
      const target = path.join(await realpath(path.dirname(filename)), path.basename(filename));
      const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
      let file = await open(target, flags, 0o600);
      try {
        await bindManagedProcessLog(target, file);
        const size = Number((await file.stat()).size);
        if (size + Buffer.byteLength(entry) + 1 > 1024 * 1024) {
          await file.close();
          await rename(target, `${target}.1`);
          file = await open(target, flags | constants.O_EXCL, 0o600);
          await bindManagedProcessLog(target, file);
        }
        await file.writeFile(`${entry}\n`, "utf8");
      } finally { await file.close(); }
    });
  }

  async append(log: ManagedProcessLog, chunk: PendingChunk): Promise<{ writtenBytes: number; error?: string }> {
    let writtenBytes = 0;
    try { await this.exclusive(async () => {
      await this.assertDirectory(log.directory);
      let position = 0;
      while (position < chunk.bytes.length) {
        let segment = log.segments.at(-1);
        const offset = chunk.start + position;
        if (!segment || segment.end !== offset || segment.end - segment.start >= this.limits.segmentBytes) {
          const filename = path.join(log.directory, `${String(offset).padStart(16, "0")}.seg`);
          const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
          try { segment = { binding: await bindManagedProcessLog(filename, handle), start: offset, end: offset }; }
          finally { await handle.close(); }
          log.segments.push(segment);
        }
        const length = Math.min(chunk.bytes.length - position, this.limits.segmentBytes - (segment.end - segment.start));
        while (log.retainedBytes + length > this.limits.processBytes || log.segments.length > 32) await this.removeSegment(log, log.segments[0]!);
        while (this.bytes + length > this.limits.totalBytes) {
          const candidate = [...this.logs].flatMap(entry => entry.segments.filter(part => part !== segment && part.end > part.start).map(part => ({ entry, part })))
            .sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.part.start - b.part.start)[0];
          if (!candidate) throw new Error("Managed log budget is exhausted.");
          await this.removeSegment(candidate.entry, candidate.part);
        }
        const handle = await open(segment.binding.path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try {
          await assertManagedLogBinding(segment.binding, handle);
          let written = 0;
          while (written < length) {
            const result = await handle.write(chunk.bytes, position + written, length - written, segment.end - segment.start);
            if (!result.bytesWritten) throw new Error("Managed log write made no progress.");
            written += result.bytesWritten;
            writtenBytes += result.bytesWritten;
            segment.end += result.bytesWritten;
            this.bytes += result.bytesWritten;
          }
        } finally { await handle.close(); }
        position += length;
      }
    }); } catch (error) { return { writtenBytes, error: message(error) }; }
    return { writtenBytes };
  }

  async complete(log: ManagedProcessLog): Promise<void> {
    await this.exclusive(async () => {
      log.completedAt = Date.now();
      await this.assertDirectory(log.directory);
      const bytes = Buffer.from(JSON.stringify({ ...log.owner, completedAt: log.completedAt }));
      const marker = await open(log.marker.path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        await assertManagedLogBinding(log.marker, marker);
        await marker.writeFile(bytes);
        await marker.truncate(bytes.length);
      } finally { await marker.close(); }
      await this.prune();
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.initialization?.catch(() => undefined);
    if (this.sweep) clearInterval(this.sweep);
    await this.tail;
    if (this.maintenanceError) throw new Error(this.maintenanceError);
  }

  private async prune(): Promise<void> {
    const completed = [...this.logs].filter(log => log.completedAt !== undefined).sort((a, b) => a.completedAt! - b.completedAt!);
    let remaining = completed.length;
    for (const log of completed) {
      if (remaining <= this.limits.completedLogs && Date.now() - log.completedAt! < this.limits.completedAgeMs && this.bytes <= this.limits.totalBytes) continue;
      for (const segment of [...log.segments]) await this.removeSegment(log, segment);
      await removeBoundManagedLog(log.marker);
      await rmdir(log.directory);
      this.logs.delete(log);
      log.disposed = true;
      log.onDispose?.();
      remaining--;
    }
  }

  private async removeSegment(log: ManagedProcessLog, segment: Segment): Promise<void> {
    await this.assertDirectory(log.directory);
    await removeBoundManagedLog(segment.binding);
    this.bytes -= segment.end - segment.start;
    log.segments.splice(log.segments.indexOf(segment), 1);
  }

  private async assertDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Managed log directory changed identity.");
  }
}

export class ManagedProcessLog {
  readonly segments: Segment[] = [];
  totalBytes = 0;
  completedAt?: number;
  disposed = false;
  private readonly pending: PendingChunk[] = [];
  private pendingBytes = 0;
  private pumping?: Promise<void>;
  private settledThrough = 0;
  private readonly waiters = new Set<{ offset: number; done(): void }>();
  private ending = false;
  private finishing?: Promise<void>;
  private error?: string;
  private droppedBytes = 0;

  constructor(private readonly store: ManagedProcessLogStore, readonly directory: string, readonly owner: Owner, readonly marker: ManagedProcessLogBinding, private readonly limits: Limits, readonly onDispose?: () => void) {}
  get createdAt(): number { return this.owner.createdAt; }
  get retainedBytes(): number { return this.segments.reduce((sum, part) => sum + part.end - part.start, 0); }
  get complete(): boolean { return this.completedAt !== undefined; }

  accept(input: Buffer): void {
    if (this.ending || !input.length) return;
    const start = this.totalBytes;
    this.totalBytes += input.length;
    const skip = Math.max(0, input.length - this.limits.pendingBytes);
    while (this.pending.length && this.pendingBytes + input.length - skip > this.limits.pendingBytes) {
      const discarded = this.pending.shift()!;
      this.pendingBytes -= discarded.bytes.length;
      this.droppedBytes += discarded.bytes.length;
    }
    this.droppedBytes += skip;
    const bytes = Buffer.from(input.subarray(skip));
    this.pending.push({ bytes, start: start + skip });
    this.pendingBytes += bytes.length;
    this.pumping ??= this.pump().finally(() => { this.pumping = undefined; });
  }

  async flush(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const offset = this.totalBytes;
    if (this.settledThrough >= offset) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        this.waiters.delete(waiter); signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error); else resolve();
      };
      const waiter = { offset, done: () => finish() };
      const abort = (): void => finish(signal?.reason);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  seal(): Promise<void> {
    this.ending = true;
    return this.flush();
  }

  recordError(error: unknown): void { this.error = message(error); }

  finish(): Promise<void> {
    return this.finishing ??= (async () => { await this.seal(); await this.store.complete(this); })();
  }

  async read(options: ReadManagedProcessOutputOptions = {}, signal?: AbortSignal, final = this.complete): Promise<Omit<ManagedProcessOutput, "processId">> {
    return this.readPage(options, signal, final, 256 * 1024);
  }

  async tail(signal?: AbortSignal): Promise<string> {
    const output = await this.readPage({ fromEnd: true, maxBytes: this.limits.processBytes }, signal, this.complete, this.limits.processBytes);
    if (output.logError) throw new Error(output.logError);
    return output.content;
  }

  private async readPage(options: ReadManagedProcessOutputOptions, signal: AbortSignal | undefined, final: boolean, maximum: number): Promise<Omit<ManagedProcessOutput, "processId">> {
    const maxBytes = options.maxBytes ?? 64 * 1024;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximum) throw new RangeError(`maxBytes must be an integer between 1 and ${maximum}.`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative integer.");
    await this.flush(signal);
    return this.store.exclusive(async () => {
      signal?.throwIfAborted();
      if (this.disposed) throw new Error("Managed process log has expired.");
      const totalBytes = this.totalBytes;
      const requested = options.fromEnd ? Math.max(0, totalBytes - maxBytes) : Math.min(offset, totalBytes);
      let available = this.segments.filter(part => part.end > requested);
      if (options.fromEnd) {
        let first = available.length - 1;
        while (first > 0 && available[first - 1]!.end === available[first]!.start) first--;
        available = available.slice(Math.max(0, first));
      }
      const start = Math.max(requested, available[0]?.start ?? totalBytes);
      let end = start;
      const contiguous: Segment[] = [];
      for (const part of available) {
        if (part.start > end) break;
        contiguous.push(part);
        end = part.end;
      }
      const output = await readManagedProcessLog({ path: this.directory, totalBytes: end,
        read: async (buffer, offset, length, position) => {
          signal?.throwIfAborted();
          const part = contiguous.find(segment => segment.start <= position && segment.end > position);
          if (!part) return { bytesRead: 0 };
          const bytes = await readBoundManagedLogBytes(part.binding, position - part.start, Math.min(length, part.end - position), signal);
          bytes.copy(buffer, offset);
          return { bytesRead: bytes.length };
        }
      }, { offset: start, maxBytes }, signal, { final: final || end < totalBytes, maximumBytes: maximum });
      return { ...output, totalBytes,
        hasMore: output.nextOffset + (output.pendingUtf8Bytes ?? 0) < totalBytes,
        gap: start > requested ? { startOffset: requested, endOffset: start } : undefined,
        droppedBytes: this.droppedBytes, logError: this.error };
    });
  }

  private async pump(): Promise<void> {
    while (this.pending.length) {
      const chunk = this.pending.shift()!;
      this.pendingBytes -= chunk.bytes.length;
      const result = await this.store.append(this, chunk);
      if (result.error) this.error = result.error;
      this.droppedBytes += chunk.bytes.length - result.writtenBytes;
      this.settledThrough = chunk.start + chunk.bytes.length;
      for (const waiter of this.waiters) if (waiter.offset <= this.settledThrough) waiter.done();
    }
    this.settledThrough = this.totalBytes;
    for (const waiter of this.waiters) waiter.done();
  }
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
