import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRuntimeUpdate } from "../agentEvents.js";
import { isRuntimeUpdate } from "./protocol.js";

export interface RuntimeHostJournalRecord {
  sequence: number;
  update: AgentRuntimeUpdate;
}

export type RuntimeHostJournalStatus =
  | { state: "healthy"; sequence: number; persistedSequence: number }
  | { state: "degraded"; sequence: number; persistedSequence: number; error: string };

const journalFailureMessage = "Runtime Host event journal persistence failed; recent events may be unavailable after a process restart.";

interface WidgetPreviewDelta {
  baseSequence: number;
  prefixLength: number;
  suffix: string;
  update: AgentRuntimeUpdate;
}

function previewKey(event: Extract<NonNullable<AgentRuntimeUpdate["event"]>, { type: "tool.input" }>): string {
  return JSON.stringify([event.sessionId, event.runId, event.toolCallId]);
}

function widgetArgs(update: AgentRuntimeUpdate): Record<string, unknown> | undefined {
  const event = update.event;
  return event?.type === "tool.input" && event.tool === "WidgetRenderer"
    && event.args !== null && typeof event.args === "object" && !Array.isArray(event.args)
    ? event.args as Record<string, unknown> : undefined;
}

/** 同目录临时文件 + fsync + rename，避免压缩中断留下半份可被误读的 journal。 */
export async function writeRuntimeHostJournalAtomically(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let tempFile: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    tempFile = await fs.open(tempPath, "wx", 0o600);
    await tempFile.writeFile(content, "utf8");
    await tempFile.sync();
    await tempFile.close();
    tempFile = undefined;
    await fs.rename(tempPath, filePath);
    if (process.platform !== "win32") {
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await tempFile?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class RuntimeHostEventJournal {
  private persistedSequence = 0;
  private lastError: string | undefined;
  private needsRewrite = false;
  private tail: Promise<void> = Promise.resolve();
  /** 只持有已成功落盘且仍在窗口内的 HTML 基线；不引用 Server 会清空的旧预览参数。 */
  private readonly widgetPreviews = new Map<string, { sequence: number; html: string }>();

  constructor(
    private readonly filePath: string,
    private readonly historyLimit: number
  ) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit <= 0) {
      throw new Error("historyLimit must be a positive safe integer.");
    }
  }

  async initialize(): Promise<{ sequence: number; records: RuntimeHostJournalRecord[] }> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return { sequence: 0, records: [] };
      }
      throw error;
    }

    // A complete final JSON record is recoverable without LF, but unsafe to append to.
    this.needsRewrite = text.length > 0 && !text.endsWith("\n");
    const records: RuntimeHostJournalRecord[] = [];
    const latestPreviews = new Map<string, number>();
    this.widgetPreviews.clear();
    let malformed = false;
    let highWaterSequence = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<RuntimeHostJournalRecord> & { widgetPreview?: Partial<WidgetPreviewDelta> };
        if (!Number.isSafeInteger(value.sequence) || (value.sequence ?? 0) <= 0) {
          malformed = true;
          continue;
        }
        const sequence = value.sequence as number;
        highWaterSequence = Math.max(highWaterSequence, sequence);
        const update = value.widgetPreview === undefined ? value.update : this.restoreWidgetPreview(sequence, value.widgetPreview);
        if (!isRuntimeUpdate(update) || value.widgetPreview !== undefined && value.update !== undefined) {
          malformed = true;
          continue;
        }
        if (records.at(-1)?.sequence !== undefined && sequence !== records.at(-1)!.sequence + 1) malformed = true;
        const record = { sequence, update };
        this.rememberWidgetPreview(record);
        if (update.event?.type === "tool.input") {
          const key = previewKey(update.event);
          const previousIndex = latestPreviews.get(key);
          const previous = previousIndex === undefined ? undefined : records[previousIndex];
          if (previous?.update.event?.type === "tool.input") records[previousIndex!] = {
            ...previous, update: { ...previous.update, event: { ...previous.update.event, args: {} } }
          };
          latestPreviews.set(key, records.length);
        }
        records.push(record);
      } catch {
        malformed = true;
      }
    }
    this.persistedSequence = highWaterSequence;
    if (malformed) {
      this.lastError = journalFailureMessage;
      this.widgetPreviews.clear();
      return { sequence: highWaterSequence, records: [] };
    }
    if (records.length > this.historyLimit) records.splice(0, records.length - this.historyLimit);
    return { sequence: highWaterSequence, records };
  }

  persist(sequence: number, readHistory: () => readonly RuntimeHostJournalRecord[], rewrite = false): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (sequence <= this.persistedSequence) return;
      const history = readHistory();
      const record = history[sequence - (history[0]?.sequence ?? sequence)];
      if (record?.sequence !== sequence) throw new Error("Runtime Host event is missing from the in-memory replay history.");
      const replaceJournal = rewrite || this.needsRewrite || this.lastError !== undefined
        || sequence % this.historyLimit === 0
        || sequence !== this.persistedSequence + 1;
      if (replaceJournal) {
        const records = [...history];
        const latestSequence = records.at(-1)?.sequence ?? sequence;
        await writeRuntimeHostJournalAtomically(
          this.filePath,
          records.map((item) => JSON.stringify(item)).join("\n") + (records.length ? "\n" : "")
        );
        this.persistedSequence = latestSequence;
        this.widgetPreviews.clear();
        for (const item of records) this.rememberWidgetPreview(item);
      } else {
        await fs.appendFile(this.filePath, `${JSON.stringify(this.encodeWidgetPreview(record))}\n`, { mode: 0o600 });
        this.persistedSequence = sequence;
        this.rememberWidgetPreview(record);
      }
      this.needsRewrite = false;
      this.lastError = undefined;
    }).catch(() => {
      this.lastError = journalFailureMessage;
      this.widgetPreviews.clear();
    });
    return this.tail;
  }

  status(sequence: number): RuntimeHostJournalStatus {
    if (this.lastError !== undefined) {
      return { state: "degraded", sequence, persistedSequence: this.persistedSequence, error: this.lastError };
    }
    return { state: "healthy", sequence, persistedSequence: this.persistedSequence };
  }

  async close(): Promise<void> {
    await this.tail;
  }

  private encodeWidgetPreview(record: RuntimeHostJournalRecord): RuntimeHostJournalRecord | { sequence: number; widgetPreview: WidgetPreviewDelta } {
    const args = widgetArgs(record.update);
    const event = record.update.event;
    if (!args || typeof args.html !== "string" || event?.type !== "tool.input") return record;
    const previous = this.widgetPreviews.get(previewKey(event));
    if (!previous || previous.sequence < record.sequence - this.historyLimit + 1) return record;
    let prefixLength = 0;
    const limit = Math.min(previous.html.length, args.html.length);
    while (prefixLength < limit && previous.html.charCodeAt(prefixLength) === args.html.charCodeAt(prefixLength)) prefixLength++;
    // 增量行没有顶层 update，旧 reader 会显式拒绝该窗口，不会把后缀当作完整预览。
    return { sequence: record.sequence, widgetPreview: {
      baseSequence: previous.sequence, prefixLength, suffix: args.html.slice(prefixLength),
      update: { ...record.update, event: { ...event, args: { ...args, html: undefined } } }
    } };
  }

  private restoreWidgetPreview(sequence: number, delta: Partial<WidgetPreviewDelta>): AgentRuntimeUpdate {
    if (!delta || !isRuntimeUpdate(delta.update) || !Number.isSafeInteger(delta.baseSequence)
      || !Number.isSafeInteger(delta.prefixLength) || typeof delta.suffix !== "string") {
      throw new Error("Invalid Widget preview delta.");
    }
    const args = widgetArgs(delta.update);
    const event = delta.update.event;
    const previous = event?.type === "tool.input" ? this.widgetPreviews.get(previewKey(event)) : undefined;
    const prefixLength = delta.prefixLength!;
    if (!args || args.html !== undefined || event?.type !== "tool.input" || !previous
      || previous.sequence !== delta.baseSequence || previous.sequence >= sequence
      || previous.sequence < sequence - this.historyLimit + 1 || prefixLength < 0 || prefixLength > previous.html.length) {
      throw new Error("Widget preview delta baseline is unavailable.");
    }
    return { ...delta.update, event: { ...event, args: { ...args, html: previous.html.slice(0, prefixLength) + delta.suffix } } };
  }

  private rememberWidgetPreview(record: RuntimeHostJournalRecord): void {
    for (const [key, previous] of this.widgetPreviews) {
      if (previous.sequence >= record.sequence - this.historyLimit + 1) break;
      this.widgetPreviews.delete(key);
    }
    const event = record.update.event;
    if (event?.type !== "tool.input") return;
    const key = previewKey(event);
    const args = widgetArgs(record.update);
    if (event.tool !== "WidgetRenderer") this.widgetPreviews.delete(key);
    else if (typeof args?.html === "string") {
      this.widgetPreviews.delete(key);
      this.widgetPreviews.set(key, { sequence: record.sequence, html: args.html });
    }
  }
}
