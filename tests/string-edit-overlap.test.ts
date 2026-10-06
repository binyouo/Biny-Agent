/** Default Edit must reject every ambiguous exact start, including overlapping ones. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import type { FileChangeResult } from "../src/tools/file/fileChange.js";
import { maxEditFileBytes } from "../src/tools/file/safeFileIo.js";
import { applyStringEdit } from "../src/tools/file/stringEdit.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import type { ToolExecutionContext } from "../src/tools/types.js";

const overlapping = [
  { name: "single-line context with default replace_all", content: "ababa", old: "aba" },
  { name: "single-line context with explicit replace_all false", content: "ababa", old: "aba", replace_all: false },
  { name: "multiline context", content: "head\na\na\na\ntail\n", old: "a\na" },
  { name: "CRLF context", content: "head\r\na\r\na\r\na\r\ntail\r\n", old: "a\r\na" },
  { name: "BOM-prefixed Unicode context", content: "\uFEFF😀中😀中😀\n", old: "😀中😀" }
];

for (const fixture of overlapping) {
  test(`Edit rejects overlapping ${fixture.name} without changing the file`, async () => {
    await withWorkspace(async (root) => {
      const original = Buffer.from(fixture.content);
      await writeFile(path.join(root, "target.txt"), original);
      const committed: FileChangeResult["change"][] = [];
      let error: unknown;
      try {
        await edit(root, {
          path: "target.txt", old_string: fixture.old, new_string: "replaced",
          ...(fixture.replace_all === undefined ? {} : { replace_all: fixture.replace_all })
        }, { onFileChangeCommitted: async (change) => { committed.push(change); } });
      } catch (caught) { error = caught; }
      assert.deepEqual(await readFile(path.join(root, "target.txt")), original);
      assert.match(String(error), /old_string matches overlapping locations/u);
      assert.deepEqual(committed, []);
      assert.deepEqual(await readdir(root), ["target.txt"]);
    });
  });
}

test("permission preview rejects the same overlapping exact context", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "target.txt"), "ababa");
    await assert.rejects(createToolPermissionRequest({ id: "overlap-preview", name: "Edit", args: {
      path: "target.txt", old_string: "aba", new_string: "replaced"
    } }, { workspaceRoot: root, ignore: [] }), /old_string matches overlapping locations/u);
    assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), "ababa");
  });
});

const successful = [
  { name: "explicit replace_all keeps left-to-right non-overlapping matches", content: "abababa", old: "aba", replacement: "X", all: true, expected: "XbX", count: 2, line: 1 },
  { name: "explicit replace_all keeps an overlapping suffix", content: "aaaaa", old: "aa", replacement: "X", all: true, expected: "XXa", count: 2, line: 1 },
  { name: "explicit replace_all keeps multiline behavior", content: "a\na\na", old: "a\na", replacement: "X", all: true, expected: "X\na", count: 1, line: 1 },
  { name: "explicit replace_all replaces disjoint occurrences", content: "old old", old: "old", replacement: "new", all: true, expected: "new new", count: 2, line: 1 },
  { name: "unique exact context preserves BOM and CRLF", content: "\uFEFFhead\r\nold\r\ntail\r\n", old: "old", replacement: "new", all: false, expected: "\uFEFFhead\r\nnew\r\ntail\r\n", count: 1, line: 2 },
  { name: "replacement metacharacters remain literal", content: "head\nold\ntail", old: "old", replacement: "$& $$ $` $' $1 😀", all: false, expected: "head\n$& $$ $` $' $1 😀\ntail", count: 1, line: 2 },
  { name: "newline-normalized matching retains its replacement contract", content: "head\r\nold\r\nnext\r\ntail\r\n", old: "old\nnext\n", replacement: "new\n", all: false, expected: "head\r\nnew\ntail\r\n", count: 1, line: 2 },
  { name: "whitespace-normalized matching retains its replacement contract", content: "head\n  old  text\nnext\n", old: "old text", replacement: "new", all: false, expected: "head\nnew\nnext\n", count: 1, line: 2 },
  { name: "exact matching still takes precedence over normalized matching", content: "a\nb\n a\n b\n", old: "a\nb", replacement: "X", all: true, expected: "X\n a\n b\n", count: 1, line: 1 }
];

for (const fixture of successful) {
  test(fixture.name, async () => {
    await withWorkspace(async (root) => {
      await writeFile(path.join(root, "target.txt"), fixture.content);
      const args = { path: "target.txt", old_string: fixture.old, new_string: fixture.replacement, replace_all: fixture.all };
      const preview = await createToolPermissionRequest({ id: "control-preview", name: "Edit", args }, { workspaceRoot: root, ignore: [] });
      const result = await edit(root, args);
      assert.deepEqual(await readFile(path.join(root, "target.txt")), Buffer.from(fixture.expected));
      assert.equal(result.change.edits, fixture.count);
      assert.equal(result.change.firstChangedLine, fixture.line);
      assert.equal(result.change.committed, true);
      assert.equal(result.change.diff, preview.diff);
      assert.deepEqual(await readdir(root), ["target.txt"]);
    });
  });
}

test("normalized overlapping matches retain existing rejection in both modes", async () => {
  await withWorkspace(async (root) => {
    const content = " a\n a\n a\n";
    await writeFile(path.join(root, "target.txt"), content);
    for (const all of [false, true]) {
      await assert.rejects(edit(root, { path: "target.txt", old_string: "a\na", new_string: "X", replace_all: all }),
        all ? /Replacement spans overlap/u : /matches 2 locations/u);
      assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), content);
    }
  });
});

test("disjoint ambiguity and invalid replacements still fail without writing", async () => {
  await withWorkspace(async (root) => {
    const content = "old old";
    await writeFile(path.join(root, "target.txt"), content);
    for (const [old, replacement, message] of [
      ["old", "new", /matches 2 locations/u],
      ["missing", "new", /not found/u],
      ["old", "old", /identical/u],
      ["", "new", /at least 1 character/u]
    ] as const) {
      await assert.rejects(edit(root, { path: "target.txt", old_string: old, new_string: replacement }), message);
      assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), content);
    }
  });
});

test("Write retains literal full replacement and create behavior", async () => {
  await withWorkspace(async (root) => {
    const tool = createWriteFileTool({ workspaceRoot: root, ignore: [] });
    for (const content of ["ababa", "\uFEFF😀\r\n$&\n", ""]) {
      const execution = await tool.resolveExecution(tool.schema.parse({ path: "target.txt", content }));
      if ("isError" in execution) throw new Error(execution.errorMessage);
      const result = await execution.execute({ toolCallId: "write-control", operationId: "write-control-operation" });
      assert.deepEqual(await readFile(path.join(root, "target.txt")), Buffer.from(content));
      assert.equal(result.change.bytes, Buffer.byteLength(content));
    }
  });
});

test("all short exact substrings agree with independent ambiguity and replace-all oracles", () => {
  let cases = 0;
  let frontier = [""];
  for (let length = 1; length <= 5; length += 1) {
    frontier = frontier.flatMap((prefix) => ["a", "b", "\n"].map((character) => prefix + character));
    for (const content of frontier) {
      const needles = new Set<string>();
      for (let start = 0; start < content.length; start += 1) {
        for (let end = start + 1; end <= content.length; end += 1) needles.add(content.slice(start, end));
      }
      for (const needle of needles) {
        const starts = Array.from({ length: content.length }, (_, index) => index)
          .filter((index) => content.slice(index, index + needle.length) === needle);
        if (starts.length > 1) assert.throws(() => applyStringEdit(content, needle, "X"), /old_string matches/u);
        else {
          const start = starts[0]!;
          assert.deepEqual(applyStringEdit(content, needle, "X"), {
            content: content.slice(0, start) + "X" + content.slice(start + needle.length),
            firstChangedLine: content.slice(0, start).split("\n").length,
            replacements: 1
          });
        }
        const pieces = content.split(needle);
        const all = applyStringEdit(content, needle, "X", true);
        assert.equal(all.content, pieces.join("X"));
        assert.equal(all.replacements, pieces.length - 1);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 3711);
});

test("large repetitive needles require only one additional exact lookup", (context) => {
  const content = "a".repeat(maxEditFileBytes);
  const needle = "a".repeat(maxEditFileBytes / 2 + 1);
  const indexOf = String.prototype.indexOf;
  const offsets: Array<number | undefined> = [];
  const lookup = context.mock.method(String.prototype, "indexOf", function (this: string, search: string, position?: number): number {
    if (String(this) === content && search === needle) offsets.push(position);
    return indexOf.call(this, search, position);
  });
  try {
    assert.throws(() => applyStringEdit(content, needle, "X"), /old_string matches overlapping locations/u);
    assert.deepEqual(offsets, [0, 1], "do not enumerate all overlapping occurrences");
    offsets.length = 0;
    const all = applyStringEdit(content, needle, "X", true);
    assert.equal(all.content, "X" + "a".repeat(maxEditFileBytes - needle.length));
    assert.equal(all.replacements, 1);
    assert.deepEqual(offsets, [0], "explicit replace_all keeps the original lookup behavior");
  } finally { lookup.mock.restore(); }
});

async function edit(root: string, args: unknown, input: Partial<ToolExecutionContext> = {}): Promise<FileChangeResult> {
  const tool = createEditFileTool({ workspaceRoot: root, ignore: [] });
  const execution = await tool.resolveExecution(tool.schema.parse(args));
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution.execute({ toolCallId: "overlap-edit", operationId: "overlap-edit-operation", ...input });
}

async function withWorkspace(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-string-edit-overlap-"));
  try { await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
