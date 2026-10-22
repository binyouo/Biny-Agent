/**
 * Diff 预览行模型。
 *
 * 将已提交 patch 的行按上下文聚类，生成带行号和 +/- 标记的文本摘要。
 */

export type DiffLineKind = "context" | "add" | "delete";

export interface DiffLine {
  kind: DiffLineKind;
  lineNum: number;
  content: string;
}

export type DiffPreviewLine =
  | { kind: "header"; content: string; path: string; additions: number; deletions: number }
  | { kind: DiffLineKind; content: string; lineNum: number; marker: "+" | "-" | " " }
  | { kind: "meta"; content: string };

export interface ClusteredDiffOptions {
  contextLines?: number;
  maxLines?: number;
  expandKeyHint?: string;
}

interface Cluster {
  start: number;
  end: number;
}

/** 按上下文聚类展示 patch 行；行数预算只算正文，标题行不计入。 */
export function renderDiffLineSetClustered(
  diffLines: readonly DiffLine[],
  filePath: string,
  options: ClusteredDiffOptions = {}
): DiffPreviewLine[] {
  const contextLines = options.contextLines ?? 3;
  const { clusters, changedCount, additions, deletions } = buildClusters(diffLines, contextLines);
  const rendered: DiffPreviewLine[] = [createHeader(filePath, additions, deletions)];
  if (clusters.length === 0) return rendered;

  const maxLines = options.maxLines !== undefined && options.maxLines >= 0 ? options.maxLines : Number.POSITIVE_INFINITY;
  let bodyLines = 0;
  let previousEnd = -1;
  let truncated = false;
  let shownChanges = 0;

  outer: for (const cluster of clusters) {
    if (bodyLines >= maxLines) {
      truncated = true;
      break;
    }
    if (previousEnd >= 0) {
      const gap = cluster.start - previousEnd - 1;
      if (gap > 0) {
        if (bodyLines + 1 > maxLines) {
          truncated = true;
          break;
        }
        rendered.push(createMeta(`     … ${String(gap)} unchanged line${gap > 1 ? "s" : ""} …`));
        bodyLines += 1;
      }
    }
    for (let index = cluster.start; index <= cluster.end; index += 1) {
      if (bodyLines >= maxLines) {
        truncated = true;
        break outer;
      }
      const line = diffLines[index];
      if (!line) continue;
      rendered.push(diffLineToPreviewLine(line));
      bodyLines += 1;
      if (line.kind !== "context") shownChanges += 1;
      previousEnd = index;
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges;
    if (hidden > 0) {
      const hint = options.expandKeyHint ?? "ctrl+o";
      rendered.push(createMeta(`     … ${String(hidden)} more change${hidden > 1 ? "s" : ""} hidden (${hint} to expand)`));
    }
  }
  return rendered;
}

export function formatDiffPreviewLines(lines: readonly DiffPreviewLine[]): string {
  return lines.map(formatDiffPreviewLine).join("\n");
}

export function formatDiffPreviewLine(line: DiffPreviewLine): string {
  if (line.kind === "header" || line.kind === "meta") return line.content;
  return `${String(line.lineNum).padStart(4, " ")} ${line.marker} ${line.content}`;
}

function createHeader(filePath: string, additions: number, deletions: number): DiffPreviewLine {
  const parts: string[] = [];
  if (additions > 0) parts.push(`+${String(additions)}`);
  if (deletions > 0) parts.push(`-${String(deletions)}`);
  parts.push(filePath);
  return {
    kind: "header",
    content: parts.join(" "),
    path: filePath,
    additions,
    deletions
  };
}

function diffLineToPreviewLine(line: DiffLine): DiffPreviewLine {
  if (line.kind === "add") {
    return { kind: "add", lineNum: line.lineNum, marker: "+", content: line.content };
  }
  if (line.kind === "delete") {
    return { kind: "delete", lineNum: line.lineNum, marker: "-", content: line.content };
  }
  return { kind: "context", lineNum: line.lineNum, marker: " ", content: line.content };
}

function createMeta(content: string): DiffPreviewLine {
  return { kind: "meta", content };
}

/**
 * 把变更行按位置聚成若干块，每块向两侧各扩 `contextLines` 行上下文。
 * 两个变更之间的间隔不超过 `2 * contextLines` 时合并成一块，否则中间的未改动行没必要
 * 全部展开。
 */
function buildClusters(diffLines: readonly DiffLine[], contextLines: number): { clusters: Cluster[]; changedCount: number; additions: number; deletions: number } {
  const changedIndexes: number[] = [];
  let additions = 0;
  let deletions = 0;
  diffLines.forEach((line, index) => {
    if (line.kind === "add") {
      additions += 1;
      changedIndexes.push(index);
    } else if (line.kind === "delete") {
      deletions += 1;
      changedIndexes.push(index);
    }
  });
  if (changedIndexes.length === 0) return { clusters: [], changedCount: 0, additions, deletions };

  const clusters: Cluster[] = [];
  const mergeGap = 2 * contextLines;
  let groupStart = changedIndexes[0]!;
  let groupEnd = changedIndexes[0]!;
  for (let index = 1; index < changedIndexes.length; index += 1) {
    const changedIndex = changedIndexes[index]!;
    if (changedIndex - groupEnd <= mergeGap) {
      groupEnd = changedIndex;
      continue;
    }
    clusters.push({ start: Math.max(0, groupStart - contextLines), end: Math.min(diffLines.length - 1, groupEnd + contextLines) });
    groupStart = changedIndex;
    groupEnd = changedIndex;
  }
  clusters.push({ start: Math.max(0, groupStart - contextLines), end: Math.min(diffLines.length - 1, groupEnd + contextLines) });
  return { clusters, changedCount: changedIndexes.length, additions, deletions };
}
