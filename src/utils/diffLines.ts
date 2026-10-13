/** Display-only line classification for unified and locally generated bare-@@ diffs. */
export type DisplayDiffLine =
  | { kind: "hunk"; line: string; oldStart: number; newStart: number }
  | { kind: "old-header" | "new-header" | "meta" | "add" | "delete" | "context"; line: string };

export function* classifyDiffLines(diff: string): Generator<DisplayDiffLine> {
  const lines = diff.split("\n");
  let inHunk = false;
  let oldRemaining: number | undefined;
  let newRemaining: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const hunk = /^@@(?:\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@.*)?$/u.exec(line);
    if (hunk) {
      oldRemaining = hunk[1] === undefined ? undefined : Number(hunk[2] ?? 1);
      newRemaining = hunk[3] === undefined ? undefined : Number(hunk[4] ?? 1);
      inHunk = oldRemaining !== 0 || newRemaining !== 0;
      yield { kind: "hunk", line, oldStart: Number(hunk[1] ?? 1), newStart: Number(hunk[3] ?? 1) };
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      oldRemaining = newRemaining = undefined;
      yield { kind: "meta", line };
      continue;
    }
    // Session changes concatenate complete local diffs. Their bare hunks have no
    // counts; only the producer's exact header/header/@@ boundary ends one.
    if (inHunk && oldRemaining === undefined && line.startsWith("--- ")
      && lines[index + 1]?.startsWith("+++ ") && lines[index + 2] === "@@") {
      inHunk = false;
    }
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      yield { kind: line.startsWith("--- ") ? "old-header" : "new-header", line };
      continue;
    }
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "delete" : line.startsWith(" ") ? "context" : "meta";
    if (kind !== "meta") {
      // Keep accepting headerless/partial display snippets; this is not a patch validator.
      if (!inHunk) {
        inHunk = true;
        oldRemaining = newRemaining = undefined;
      }
      if (oldRemaining !== undefined && kind !== "add") oldRemaining -= 1;
      if (newRemaining !== undefined && kind !== "delete") newRemaining -= 1;
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
    }
    yield { kind, line };
  }
}
