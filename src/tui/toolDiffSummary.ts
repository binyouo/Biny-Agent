/**
 * 工具 diff 摘要投影模块。
 *
 * 把已提交 change 转成适合 TUI 展示的文件级摘要。
 */
import { formatDiffPreviewLines, renderDiffLineSetClustered, type DiffLine } from "./diffPreview.js";
import { parseFileChange } from "../tools/file/fileChange.js";
import { classifyDiffLines } from "../utils/diffLines.js";

export type ToolDiffOperation = "Created" | "Edited" | "Deleted";

export interface ToolDiffFileSummary {
  path: string;
  operation: ToolDiffOperation;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

const maxRenderedDiffLines = 160;

export function formatToolDiffSummary(_tool: string, result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const change = parseFileChange((result as { change?: unknown }).change);
  if (!change) return undefined;
  const diff = change.diff;
  const source = change.server ? `Remote (${change.server}) ` : "";
  if (change.operation === "move") return `${source}Moved ${change.path} → ${change.destinationPath}`;
  if (!diff) return `${source}${change.operation} ${change.path}`;
  const fallbackPath = change.path;
  const files = parseDiffFiles(diff, fallbackPath);
  if (!files.length) return undefined;

  const rendered: string[] = [];
  let remaining = maxRenderedDiffLines;
  for (const file of files) {
    if (rendered.length > 0) rendered.push("");
    const preview = renderDiffLineSetClustered(file.lines, file.path, { contextLines: 3, maxLines: remaining });
    const formatted = formatDiffPreviewLines(preview).split("\n");
    for (const line of formatted) {
      rendered.push(line);
    }
    remaining -= Math.max(0, formatted.length - 1);
    if (remaining <= 0) {
      rendered.push("     … diff truncated");
      return rendered.join("\n");
    }
  }

  return `${source}${rendered.join("\n")}`;
}

export function formatToolResultSummary(tool: string, result: unknown): string | undefined {
  return formatToolDiffSummary(tool, result) ?? formatReadFileSummary(tool, result);
}

function parseDiffFiles(diff: string, fallbackPath: string | undefined): ToolDiffFileSummary[] {
  const files: ToolDiffFileSummary[] = [];
  let current: MutableDiffFile | undefined;

  for (const part of classifyDiffLines(diff)) {
    const { line } = part;
    const gitPath = parseGitDiffPath(line);
    if (gitPath) {
      pushCurrent(files, current, fallbackPath);
      current = createMutableFile(gitPath);
      continue;
    }

    if (part.kind === "old-header") {
      if (current?.lines.length) {
        pushCurrent(files, current, fallbackPath);
        current = undefined;
      }
      if (!current) current = createMutableFile(normalizeDiffPath(line.slice(4)) ?? fallbackPath ?? "changes");
      current.oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (part.kind === "new-header") {
      if (!current) current = createMutableFile(normalizeDiffPath(line.slice(4)) ?? fallbackPath ?? "changes");
      current.newPath = normalizeDiffPath(line.slice(4));
      current.path = current.newPath ?? current.oldPath ?? current.path;
      continue;
    }

    if (part.kind === "meta") continue;
    if (!current) current = createMutableFile(fallbackPath ?? "changes");
    if (part.kind === "hunk") {
      current.oldLine = part.oldStart;
      current.newLine = part.newStart;
      continue;
    }
    const parsed = parseDiffLine(line, current);
    if (!parsed) continue;
    current.lines.push(parsed);
    if (parsed.kind === "add") current.additions += 1;
    if (parsed.kind === "delete") current.deletions += 1;
  }

  pushCurrent(files, current, fallbackPath);
  return files.filter((file) => file.additions > 0 || file.deletions > 0);
}

interface MutableDiffFile extends ToolDiffFileSummary {
  oldPath?: string;
  newPath?: string;
  oldLine: number;
  newLine: number;
}

function createMutableFile(filePath: string): MutableDiffFile {
  return { path: filePath, operation: "Edited", additions: 0, deletions: 0, lines: [], oldLine: 1, newLine: 1 };
}

function pushCurrent(files: ToolDiffFileSummary[], current: MutableDiffFile | undefined, fallbackPath: string | undefined): void {
  if (!current) return;
  const operation = diffOperation(current);
  files.push({
    path: diffDisplayPath(current, operation, fallbackPath),
    operation,
    additions: current.additions,
    deletions: current.deletions,
    lines: current.lines
  });
}

function parseGitDiffPath(line: string): string | undefined {
  const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
  return match?.[2] ? normalizeDiffPath(match[2]) : undefined;
}

function parseDiffLine(line: string, file: MutableDiffFile): DiffLine | undefined {
  if (line.startsWith("+")) {
    const parsed = { kind: "add" as const, lineNum: file.newLine, content: line.slice(1) };
    file.newLine += 1;
    return parsed;
  }
  if (line.startsWith("-")) {
    const parsed = { kind: "delete" as const, lineNum: file.oldLine, content: line.slice(1) };
    file.oldLine += 1;
    return parsed;
  }
  if (line.startsWith(" ")) {
    const parsed = { kind: "context" as const, lineNum: file.newLine, content: line.slice(1) };
    file.oldLine += 1;
    file.newLine += 1;
    return parsed;
  }
  return undefined;
}

function diffOperation(file: MutableDiffFile): ToolDiffOperation {
  if (!file.oldPath && file.newPath) return "Created";
  if (file.oldPath && !file.newPath) return "Deleted";
  return "Edited";
}

function diffDisplayPath(file: MutableDiffFile, operation: ToolDiffOperation, fallbackPath: string | undefined): string {
  if (operation === "Deleted") return file.oldPath ?? file.path ?? fallbackPath ?? "changes";
  return file.newPath ?? file.oldPath ?? file.path ?? fallbackPath ?? "changes";
}

function formatReadFileSummary(tool: string, result: unknown): string | undefined {
  if (tool !== "Read" || typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content : undefined;
  if (content === undefined) return undefined;
  const path = typeof record.path === "string" ? record.path : "file";
  return `Read ${path}\n${content.slice(0, 4000)}`;
}

function normalizeDiffPath(value: string): string | undefined {
  const token = value.trim().split(/\s+/)[0] ?? "";
  if (!token || token === "/dev/null") return undefined;
  if (token.startsWith("a/") || token.startsWith("b/")) return token.slice(2);
  return token;
}
