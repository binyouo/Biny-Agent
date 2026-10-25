/**
 * 会话级文件变更收集（右侧 dock「变更」视图的数据源）。
 *
 * 从时间线轮次里抽出已准备或已提交的文件变更，按路径聚合成「每个文件一行」的变更记录：
 * 保留最近一次操作类型、工具调用次数、按时间拼接的合并 diff 与 ±行数，最近修改的
 * 文件排最前。unified diff 的 hunk 拆分与 ±行数统计也放在这里，聊天里的合并编辑行
 * 与 dock 变更视图共用同一份解析。
 */
import type { TimelineTool, TimelineTurn } from "./sessionTimeline.js";
import { classifyDiffLines } from "../../../utils/diffLines.js";

export interface DiffHunkLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** 展示行号：add/ctx 用新行号，del 用旧行号。 */
  lineNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffHunkLine[];
}

/** 把 unified diff 拆成 hunk；meta 行（diff --git/index/---/+++）不渲染，路径已在行上表达。 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const part of classifyDiffLines(diff)) {
    const raw = part.line;
    if (part.kind === "hunk") {
      oldLine = part.oldStart;
      newLine = part.newStart;
      current = { oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(current);
      continue;
    }
    if (part.kind === "old-header" || part.kind === "new-header" || raw.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (!current || part.kind === "meta") continue;
    if (part.kind === "add") {
      current.lines.push({ kind: "add", text: raw.slice(1), lineNo: newLine });
      newLine += 1;
    } else if (part.kind === "delete") {
      current.lines.push({ kind: "del", text: raw.slice(1), lineNo: oldLine });
      oldLine += 1;
    } else {
      current.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, lineNo: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

export function countDiffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const part of classifyDiffLines(diff)) {
    if (part.kind === "add") add += 1;
    else if (part.kind === "delete") del += 1;
  }
  return { add, del };
}

const toolDiffStats = new WeakMap<TimelineTool, { diff: string; stats: { add: number; del: number } }>();

/** 聊天行与变更面板共享统计；工具快照释放后不再保留对应 diff。 */
export function countToolDiffStats(tool: TimelineTool): { add: number; del: number } {
  const diff = typeof tool.diff === "string" ? tool.diff : "";
  let cached = toolDiffStats.get(tool);
  if (!cached || cached.diff !== diff) {
    cached = { diff, stats: countDiffStats(diff) };
    toolDiffStats.set(tool, cached);
  }
  return cached.stats;
}

export interface SessionFileChange {
  path: string;
  sourcePath?: string;
  /** 该路径最近一次已知操作。 */
  operation: "create" | "update" | "delete" | "move";
  /** 该路径上的文件变更调用次数（≥2 时展示「N 次」）。 */
  changeCount: number;
  /** 各次操作的 diff 按时间顺序拼接；尚未完成的工具可能没有 diff。 */
  diff: string;
  add: number;
  del: number;
  status: "writing" | "completed";
}

const IGNORED_STATUSES = new Set(["failed", "denied", "aborted", "cancelled", "skipped", "unknown"]);

function changeOperation(tool: TimelineTool): SessionFileChange["operation"] | undefined {
  if (tool.fileChange) return tool.fileChange.operation;
  if (tool.status !== "running" && tool.status !== "waiting") return undefined;
  if (tool.display?.kind !== "file_io") return undefined;
  if (tool.display.operation === "write") return "create";
  if (["update", "delete", "move"].includes(tool.display.operation)) return tool.display.operation as SessionFileChange["operation"];
  return undefined;
}

export function collectSessionChanges(turns: TimelineTurn[]): SessionFileChange[] {
  const changes = new Map<string, SessionFileChange>();
  const seen = new Set<string>();
  for (const turn of turns) {
    for (const tool of turn.tools) {
      if (tool.fileChange?.server) continue;
      const identity = tool.operationId ?? `${turn.id}:${tool.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const operation = changeOperation(tool);
      const display = tool.display?.kind === "file_io" ? tool.display : undefined;
      const path = tool.fileChange?.destinationPath ?? tool.fileChange?.path ?? display?.destinationPath ?? display?.path;
      if (!operation || !path || !tool.fileChange && IGNORED_STATUSES.has(tool.status)) continue;
      const diff = typeof tool.diff === "string" ? tool.diff : "";
      const stats = countToolDiffStats(tool);
      const existing = changes.get(path);
      if (existing) {
        changes.delete(path);
        changes.set(path, {
          path,
          sourcePath: operation === "move" ? tool.fileChange?.path ?? display?.path : undefined,
          operation,
          changeCount: existing.changeCount + 1,
          diff: existing.diff ? `${existing.diff}\n${diff}` : diff,
          add: existing.add + stats.add,
          del: existing.del + stats.del,
          status: tool.fileChange ? "completed" : "writing"
        });
      } else {
        changes.set(path, {
          path,
          sourcePath: operation === "move" ? tool.fileChange?.path ?? display?.path : undefined,
          operation,
          changeCount: 1,
          diff,
          add: stats.add,
          del: stats.del,
          status: tool.fileChange ? "completed" : "writing"
        });
      }
    }
  }
  // Map 保序：最后写入的排在末尾，反转后最近修改的排最前。
  return [...changes.values()].reverse();
}

export interface SessionChangeTotals {
  files: number;
  writes: number;
  edits: number;
  add: number;
  del: number;
}

export function sessionChangeTotals(changes: SessionFileChange[]): SessionChangeTotals {
  const totals: SessionChangeTotals = { files: changes.length, writes: 0, edits: 0, add: 0, del: 0 };
  for (const change of changes) {
    if (change.operation === "create") totals.writes += 1;
    else totals.edits += 1;
    totals.add += change.add;
    totals.del += change.del;
  }
  return totals;
}
