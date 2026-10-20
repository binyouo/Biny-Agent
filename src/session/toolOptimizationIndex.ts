import { parseSessionEvents } from "./events.js";
import { assertSessionFileSize, maxSessionEvents, readSessionEventLines } from "./limits.js";
import { sameSessionFingerprint, sessionFileFingerprint, type SessionFileFingerprint } from "./parseCache.js";
import { readSessionFileOrCached } from "./store.js";
import type { ToolOptimizationEntry } from "./toolOptimization.js";

type IndexedEntry = Omit<ToolOptimizationEntry, "origin"> & { toolCallId?: string };

/** 只缓存统计投影；日志替换、重写或追加后重建该会话，日志仍是唯一事实来源。 */
export class ToolOptimizationIndex {
  private readonly cache = new Map<string, { fingerprint: SessionFileFingerprint; entries: IndexedEntry[] }>();
  private retainedEntries = 0;

  async read(workspaceRoot: string, sessionId: string): Promise<readonly IndexedEntry[]> {
    const result = await readSessionFileOrCached(workspaceRoot, sessionId, (file, stat) => {
      const cached = this.cache.get(file);
      if (!cached || !sameSessionFingerprint(cached.fingerprint, sessionFileFingerprint(stat))) return undefined;
      this.cache.delete(file);
      this.cache.set(file, cached);
      return cached.entries;
    }, async (handle, file, stat) => {
      assertSessionFileSize(stat.size, file);
      const entries: IndexedEntry[] = [];
      let count = 0;
      const commands = new Map<string, string>();
      for await (const line of readSessionEventLines(handle, stat.size)) {
        for (const event of parseSessionEvents(line)) {
          if (++count > maxSessionEvents) throw new Error("Session event limit exceeded.");
          if (event.type === "tool_call" && event.tool === "Bash" && event.toolCallId && typeof (event.args as { command?: unknown } | undefined)?.command === "string") {
            commands.set(event.toolCallId, (event.args as { command: string }).command);
          }
          if (event.type !== "tool_result" || !event.optimization || !event.time) continue;
          if (!Number.isFinite(Date.parse(event.time))) throw new Error("Invalid optimization timestamp.");
          const optimization = event.optimization.kind === "rtk" && !event.optimization.originalCommand
            ? { ...event.optimization, originalCommand: commands.get(event.toolCallId ?? "") } : event.optimization;
          entries.push({ optimization, time: event.time, toolCallId: event.toolCallId });
        }
      }
      return entries;
    });
    const previous = this.cache.get(result.filePath);
    this.retainedEntries -= previous?.entries.length ?? 0;
    this.cache.delete(result.filePath);
    this.cache.set(result.filePath, { fingerprint: sessionFileFingerprint(result.stat), entries: result.value });
    this.retainedEntries += result.value.length;
    while (this.cache.size > 256 || this.retainedEntries > 50_000) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.retainedEntries -= this.cache.get(oldest)!.entries.length;
      this.cache.delete(oldest);
    }
    return result.value;
  }
}
