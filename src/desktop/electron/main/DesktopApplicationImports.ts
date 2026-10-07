import type { ApplicationImportService } from "../../../imports/service.js";
import type { ApplicationImportHistory, ApplicationImportSnapshot, ApplicationImportSource } from "../../../imports/types.js";

type ImportService = Pick<ApplicationImportService, "snapshot" | "preview" | "run" | "setSyncEnabled" | "configureSyncSelection" | "sync">;

export class DesktopApplicationImports {
  private operation?: Promise<unknown>;
  private pendingAdmissions = 0;
  private readonly requests = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private syncError?: string;
  private refreshError?: string;
  private closed = false;
  constructor(private readonly service: ImportService, private readonly assertReady: () => Promise<void>, private readonly afterMcpImport?: () => Promise<void>) {}
  assertIdle(): void {
    if (this.operation) throw new Error("导入正在进行，请等待完成后再启动任务。");
  }
  async withRuntimeAdmission<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("导入服务已关闭。");
    this.assertIdle();
    this.pendingAdmissions += 1;
    try { return await operation(); }
    finally { this.pendingAdmissions -= 1; }
  }
  async snapshot() {
    const snapshot = await this.track(() => this.service.snapshot());
    return this.withErrors(snapshot);
  }
  async preview(source: ApplicationImportSource, filePath?: string) { return await this.track(() => this.service.preview(source, filePath)); }
  async run(input: Parameters<ImportService["run"]>[0]) {
    return await this.mutate(async () => {
      const result = await this.service.run(input);
      await this.refreshImportedMcp([result]);
      return result;
    });
  }
  async configureSyncSelection(input: Parameters<ImportService["configureSyncSelection"]>[0]) { return await this.track(() => this.service.configureSyncSelection(input)); }
  async setSyncEnabled(enabled: boolean) { return await this.track(() => this.service.setSyncEnabled(enabled)); }
  async sync() {
    const result = await this.mutate(async () => {
      const previous = new Set((await this.service.snapshot()).history.map(history => history.id));
      const next = await this.service.sync();
      await this.refreshImportedMcp(next.history.filter(history => !previous.has(history.id)));
      return next;
    });
    this.syncError = undefined;
    return this.withErrors(result);
  }
  start(onChanged: () => Promise<void>): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      if (this.operation || this.pendingAdmissions > 0) return;
      void this.snapshot().then(async snapshot => {
        if (!snapshot.sync.enabled || this.closed || this.operation || this.pendingAdmissions > 0) return;
        await this.sync();
        await onChanged();
      }).catch(() => { this.syncError = "自动同步暂未完成。可在导入设置中立即检查或重试。"; });
    }, 60_000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.requests]);
  }
  private withErrors(snapshot: ApplicationImportSnapshot): ApplicationImportSnapshot {
    const lastError = [snapshot.sync.lastError, this.syncError, this.refreshError].filter(Boolean).join("\n");
    return lastError ? { ...snapshot, sync: { ...snapshot.sync, lastError } } : snapshot;
  }
  private async refreshImportedMcp(histories: ApplicationImportHistory[]): Promise<void> {
    if (!this.afterMcpImport || !histories.some(history => history.results.some(result => result.category === "mcp" && result.status === "imported"))) return;
    try { await this.afterMcpImport(); this.refreshError = undefined; }
    catch { this.refreshError = "内容已导入，但 MCP 运行时刷新未完成。请重启 Biny 后检查。"; }
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("导入服务已关闭。");
    this.assertIdle();
    if (this.pendingAdmissions > 0) throw new Error("任务或设置请求正在处理中，请等待完成后再导入内容。");
    const pending = this.track(async () => { await this.assertReady(); return await operation(); });
    this.operation = pending;
    try { return await pending; }
    finally { if (this.operation === pending) this.operation = undefined; }
  }
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("导入服务已关闭。");
    const pending = operation();
    this.requests.add(pending);
    try { return await pending; }
    finally { this.requests.delete(pending); }
  }
}
