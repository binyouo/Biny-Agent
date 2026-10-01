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
  private tail: Promise<void> = Promise.resolve();

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

    const records: RuntimeHostJournalRecord[] = [];
    let malformed = false;
    let highWaterSequence = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<RuntimeHostJournalRecord>;
        if (!Number.isSafeInteger(value.sequence) || (value.sequence ?? 0) <= 0) {
          malformed = true;
          continue;
        }
        const sequence = value.sequence as number;
        highWaterSequence = Math.max(highWaterSequence, sequence);
        if (!isRuntimeUpdate(value.update)) {
          malformed = true;
          continue;
        }
        if (records.at(-1)?.sequence !== undefined && sequence !== records.at(-1)!.sequence + 1) malformed = true;
        records.push({ sequence, update: value.update });
      } catch {
        malformed = true;
      }
    }
    this.persistedSequence = highWaterSequence;
    if (malformed) {
      this.lastError = journalFailureMessage;
      return { sequence: highWaterSequence, records: [] };
    }
    if (records.length > this.historyLimit) records.splice(0, records.length - this.historyLimit);
    return { sequence: highWaterSequence, records };
  }

  persist(sequence: number, readHistory: () => readonly RuntimeHostJournalRecord[]): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (sequence <= this.persistedSequence) return;
      const records = [...readHistory()];
      const record = records.find((item) => item.sequence === sequence);
      if (!record) throw new Error("Runtime Host event is missing from the in-memory replay history.");
      const replaceJournal = this.lastError !== undefined
        || sequence % this.historyLimit === 0
        || sequence !== this.persistedSequence + 1;
      if (replaceJournal) {
        const latestSequence = records.at(-1)?.sequence ?? sequence;
        await writeRuntimeHostJournalAtomically(
          this.filePath,
          records.map((item) => JSON.stringify(item)).join("\n") + (records.length ? "\n" : "")
        );
        this.persistedSequence = latestSequence;
      } else {
        await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        this.persistedSequence = sequence;
      }
      this.lastError = undefined;
    }).catch(() => {
      this.lastError = journalFailureMessage;
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
}
