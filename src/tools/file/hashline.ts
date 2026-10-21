/**
 * Hashline 文本定位协议。
 *
 * Read 用「行号#内容摘要」输出可引用锚点；Edit 只接受这些锚点，并在当前文件上重新校验。
 * 锚点过期时直接失败，避免行号漂移或近似匹配把修改落到错误位置。
 */
import { createHash } from "node:crypto";

export type HashlineEdit =
  | { op: "replace"; pos: string; end?: string; lines: string[] }
  | { op: "append"; pos?: string; lines: string[] }
  | { op: "prepend"; pos?: string; lines: string[] };

export interface AppliedHashlineEdits {
  content: string;
  firstChangedLine: number;
}

interface TextLines {
  lines: string[];
  lineEnding: "\n" | "\r\n";
  trailingNewline: boolean;
}

interface ResolvedEdit {
  index: number;
  start: number;
  deleteCount: number;
  lines: string[];
  touchedLines: number[];
}

const anchorPattern = /^(\d+)#([0-9A-F]{8})$/u;

export function formatHashlineContent(content: string): string {
  const { lines } = splitTextLines(content);
  return formatHashlineLines(lines, 1);
}

export function formatHashlineLines(lines: readonly string[], startLine: number): string {
  return lines.map((line, index) => formatHashlineLine(line, startLine + index)).join("\n");
}

export function formatHashlineLine(line: string, lineNumber: number): string {
  return `${String(lineNumber)}#${lineHash(lineNumber, line)}:${line}`;
}

export function hashlineAnchor(line: string, lineNumber: number): string {
  return `${String(lineNumber)}#${lineHash(lineNumber, line)}`;
}

export function applyHashlineEdits(content: string, edits: readonly HashlineEdit[]): AppliedHashlineEdits {
  if (edits.length === 0) throw new Error("Edit requires at least one operation.");
  assertSupportedLineEndings(content);
  const parsed = splitTextLines(content);
  const resolved = edits.map((edit, index) => resolveEdit(edit, index, parsed.lines));
  assertIndependentEdits(resolved);

  const nextLines = [...parsed.lines];
  // Preserve the existing file signature when inserting before its original first line.
  // Resolve anchors first; explicit line replacements and inserted FEFF stay literal.
  const preserveBom = content.startsWith("\uFEFF") && resolved.some((edit) => edit.start === 0 && edit.deleteCount === 0);
  if (preserveBom) nextLines[0] = nextLines[0]!.slice(1);
  for (const edit of [...resolved].sort((left, right) => right.start - left.start)) {
    nextLines.splice(edit.start, edit.deleteCount, ...edit.lines);
  }
  if (preserveBom) nextLines[0] = `\uFEFF${nextLines[0]!}`;
  const next = joinTextLines(nextLines, parsed);
  if (next === content) throw new Error("Edit operations would not change the file.");
  return { content: next, firstChangedLine: Math.min(...resolved.map((edit) => edit.start + 1)) };
}

function assertSupportedLineEndings(content: string): void {
  const withoutCrLf = content.replace(/\r\n/gu, "");
  if (withoutCrLf.includes("\n") && content.includes("\r\n")) {
    throw new Error("Edit does not rewrite files with mixed LF and CRLF line endings; normalize the file explicitly with Write first.");
  }
  if (withoutCrLf.includes("\r")) {
    throw new Error("Edit does not support bare CR line endings; normalize the file explicitly with Write first.");
  }
}

function resolveEdit(edit: HashlineEdit, index: number, lines: readonly string[]): ResolvedEdit {
  if (edit.lines.some((line) => line.includes("\n") || line.includes("\r"))) {
    throw new Error(`Edit operation ${String(index + 1)} contains an embedded line break; pass each line separately.`);
  }
  if (edit.op === "replace") {
    const startLine = resolveAnchor(edit.pos, lines);
    const endLine = edit.end === undefined ? startLine : resolveAnchor(edit.end, lines);
    if (endLine < startLine) throw new Error(`Edit operation ${String(index + 1)} has an end anchor before its start anchor.`);
    return {
      index,
      start: startLine - 1,
      deleteCount: endLine - startLine + 1,
      lines: edit.lines,
      touchedLines: integerRange(startLine, endLine)
    };
  }
  if (edit.lines.length === 0) throw new Error(`Edit operation ${String(index + 1)} must insert at least one line.`);
  if (edit.pos === undefined) {
    return { index, start: edit.op === "prepend" ? 0 : lines.length, deleteCount: 0, lines: edit.lines, touchedLines: [] };
  }
  const anchorLine = resolveAnchor(edit.pos, lines);
  return {
    index,
    start: edit.op === "prepend" ? anchorLine - 1 : anchorLine,
    deleteCount: 0,
    lines: edit.lines,
    touchedLines: [anchorLine]
  };
}

function resolveAnchor(anchor: string, lines: readonly string[]): number {
  const match = anchorPattern.exec(anchor);
  if (!match) throw new Error(`Invalid Hashline anchor: ${anchor}`);
  const lineNumber = Number(match[1]);
  const line = lines[lineNumber - 1];
  if (line === undefined || lineHash(lineNumber, line) !== match[2]) {
    const current = line === undefined ? "the line no longer exists" : `${String(lineNumber)}#${lineHash(lineNumber, line)}`;
    throw new Error(`Stale Hashline anchor ${anchor}; current reference is ${current}. Read the file again before editing.`);
  }
  return lineNumber;
}

function assertIndependentEdits(edits: readonly ResolvedEdit[]): void {
  const owners = new Map<number, number>();
  const boundaryOwners = new Map<number, number>();
  for (const edit of edits) {
    for (const line of edit.touchedLines) {
      const owner = owners.get(line);
      if (owner !== undefined) throw new Error(`Edit operations ${String(owner + 1)} and ${String(edit.index + 1)} reference overlapping lines.`);
      owners.set(line, edit.index);
    }
    const boundaryOwner = boundaryOwners.get(edit.start);
    if (boundaryOwner !== undefined) throw new Error(`Edit operations ${String(boundaryOwner + 1)} and ${String(edit.index + 1)} target the same boundary.`);
    boundaryOwners.set(edit.start, edit.index);
  }
}

function splitTextLines(content: string): TextLines {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/gu, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: content === "" ? [] : body.split("\n"), lineEnding, trailingNewline };
}

function joinTextLines(lines: readonly string[], source: TextLines): string {
  const normalized = lines.join("\n") + (source.trailingNewline && lines.length > 0 ? "\n" : "");
  return source.lineEnding === "\r\n" ? normalized.replace(/\n/gu, "\r\n") : normalized;
}

function lineHash(lineNumber: number, line: string): string {
  return createHash("sha256").update(`${String(lineNumber)}\0${line}`).digest("hex").slice(0, 8).toUpperCase();
}

function integerRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
