/** Localized file edits must not transcode untouched bytes; full rewrites remain explicit. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import type { FileChangeResult } from "../src/tools/file/fileChange.js";
import { hashlineAnchor } from "../src/tools/file/hashline.js";
import { maxEditFileBytes } from "../src/tools/file/safeFileIo.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import type { Tool, ToolExecutionContext } from "../src/tools/types.js";

type EditMode = "replace" | "hashline" | "patch";
const editModes: EditMode[] = ["replace", "hashline", "patch"];
const invalidSequences = [
  { name: "Latin-1 text", bytes: [0xe9] },
  { name: "isolated continuation", bytes: [0x80] },
  { name: "overlong code point", bytes: [0xc0, 0xaf] },
  { name: "UTF-8 encoded surrogate", bytes: [0xed, 0xa0, 0x80] },
  { name: "out-of-range code point", bytes: [0xf4, 0x90, 0x80, 0x80] },
  { name: "incomplete final code point", bytes: [0xf0, 0x9f, 0x92] }
];

for (const mode of editModes) {
  for (const invalid of invalidSequences) {
    test(`${mode} rejects ${invalid.name} without a write or commit evidence`, async () => {
      await withWorkspace(async (root) => {
        const filePath = path.join(root, "target.txt");
        const original = Buffer.concat([Buffer.from("before\nuntouched: "), Buffer.from(invalid.bytes)]);
        await writeFile(filePath, original);
        const commits: unknown[] = [];
        let error: unknown;
        try {
          await edit(root, mode, { onFileChangeCommitted: async (change) => { commits.push(change); } });
        } catch (caught) { error = caught; }
        assert.deepEqual(await readFile(filePath), original, "a rejected localized edit must preserve every original byte");
        assert.match(String(error), /valid UTF-8/u);
        assert.deepEqual(commits, []);
        assert.deepEqual(await readdir(root), ["target.txt"], "rejection must not create temporary or backup files");
      });
    });
  }
}

const validSources = [
  { name: "literal replacement character", text: "before\nuntouched: \uFFFD\n" },
  { name: "leading UTF-8 BOM", text: "\uFEFFbefore\nuntouched: text\n" },
  { name: "BOM and Unicode scalar boundaries", text: "before\n\uFEFF\u0000\u007F\u0080\u07FF\u0800\uD7FF\uE000\uFFFF\u{10000}\u{10FFFF}\n" },
  { name: "CRLF and surrogate pair", text: "before\r\nuntouched: 中文 😀\r\n" },
  { name: "multibyte character crossing the read chunk", text: `before\n${"x".repeat(64 * 1024 - 8)}😀\n` },
  { name: "complete multibyte EOF at the exact byte limit", text: `before\n${"x".repeat(maxEditFileBytes - 11)}😀` },
  { name: "unterminated final line", text: "before\nuntouched: café" }
];
for (const mode of editModes) {
  for (const source of validSources) {
    test(`${mode} preserves ${source.name} outside the localized edit`, async () => {
      await withWorkspace(async (root) => {
        await writeFile(path.join(root, "target.txt"), source.text);
        const result = await edit(root, mode);
        assert.equal(result.change.committed, true);
        // The native patch protocol replaces a complete line, including its terminator.
        // Its existing LF output on the changed line does not affect untouched CRLF lines.
        const expected = mode === "patch" ? source.text.replace("before\r\n", "after\n").replace("before", "after") : source.text.replace("before", "after");
        assert.deepEqual(await readFile(path.join(root, "target.txt")), Buffer.from(expected));
      });
    });
  }
}

for (const mode of editModes) {
  test(`${mode} rejects malformed content after the first read chunk`, async () => {
    await withWorkspace(async (root) => {
      const original = Buffer.concat([Buffer.from(`before\n${"x".repeat(64 * 1024)}`), Buffer.from([0x80])]);
      await writeFile(path.join(root, "target.txt"), original);
      await assert.rejects(edit(root, mode), /valid UTF-8/u);
      assert.deepEqual(await readFile(path.join(root, "target.txt")), original);
      assert.deepEqual(await readdir(root), ["target.txt"]);
    });
  });
  test(`${mode} retains the byte limit before decoding`, async () => {
    await withWorkspace(async (root) => {
      const original = Buffer.from(`before\n${"x".repeat(maxEditFileBytes)}`);
      await writeFile(path.join(root, "target.txt"), original);
      await assert.rejects(edit(root, mode), /exceeding the .*byte read limit/u);
      assert.deepEqual(await readFile(path.join(root, "target.txt")), original);
      assert.deepEqual(await readdir(root), ["target.txt"]);
    });
  });
}

test("patch rechecks a malformed target at execution without overwriting the external version", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "target.txt"), "before\nuntouched\n");
    const tool = createApplyPatchTool({ workspaceRoot: root, ignore: [] });
    const execution = await tool.resolveExecution({ callId: "encoding-test", operation: { type: "update_file", path: "target.txt", diff: "@@\n-before\n+after\n" } });
    if ("isError" in execution) throw new Error(execution.errorMessage);
    const external = Buffer.from([0xff, 0xfe, 0x80]);
    await writeFile(path.join(root, "target.txt"), external);
    const commits: unknown[] = [];
    await assert.rejects(execution.execute({ toolCallId: "encoding-test", operationId: "encoding-test-operation", onFileChangeCommitted: async (change) => { commits.push(change); } }));
    assert.deepEqual(await readFile(path.join(root, "target.txt")), external);
    assert.deepEqual(commits, []);
    assert.deepEqual(await readdir(root), ["target.txt"]);
  });
});

test("Write can intentionally replace a non-UTF8 file with complete UTF-8 content", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "target.txt"), Buffer.from([0xff, 0xfe, 0x80]));
    const content = "\uFEFFcomplete 😀\r\n";
    const result = await run(createWriteFileTool({ workspaceRoot: root, ignore: [] }), { path: "target.txt", content });
    assert.equal(result.change.operation, "update");
    assert.equal(result.change.bytes, Buffer.byteLength(content));
    assert.deepEqual(await readFile(path.join(root, "target.txt")), Buffer.from(content));
  });
});

test("patch deletion retains the existing non-UTF8 whole-file behavior", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "target.txt"), Buffer.from([0xff, 0xfe, 0x80]));
    const result = await run(createApplyPatchTool({ workspaceRoot: root, ignore: [] }), { callId: "encoding-test", operation: { type: "delete_file", path: "target.txt" } });
    assert.equal(result.change.operation, "delete");
    await assert.rejects(readFile(path.join(root, "target.txt")), { code: "ENOENT" });
  });
});

for (const operation of ["move", "delete"] as const) {
  test(`Edit ${operation} retains the existing non-UTF8 whole-file behavior`, async () => {
    await withWorkspace(async (root) => {
      const original = Buffer.from([0xff, 0xfe, 0x80]);
      await writeFile(path.join(root, "target.txt"), original);
      const result = await run(createEditFileTool({ workspaceRoot: root, ignore: [] }), { operation, path: "target.txt", ...(operation === "move" ? { to: "moved.txt" } : {}) });
      assert.equal(result.change.operation, operation);
      await assert.rejects(readFile(path.join(root, "target.txt")), { code: "ENOENT" });
      if (operation === "move") assert.deepEqual(await readFile(path.join(root, "moved.txt")), original);
    });
  });
}

async function edit(root: string, mode: EditMode, input: Partial<ToolExecutionContext> = {}): Promise<FileChangeResult> {
  const context = { workspaceRoot: root, ignore: [] };
  const firstLine = (await readFile(path.join(root, "target.txt"), "utf8")).split("\n")[0]!.replace(/\r$/u, "");
  const replacement = firstLine.replace("before", "after");
  if (mode === "patch") {
    return await run(createApplyPatchTool(context), { callId: "encoding-test", operation: { type: "update_file", path: "target.txt", diff: `@@\n-${firstLine}\n+${replacement}\n` } }, input);
  }
  return await run(createEditFileTool(context, mode === "hashline"), mode === "hashline"
    ? { operation: "update", path: "target.txt", edits: [{ op: "replace", pos: hashlineAnchor(firstLine, 1), lines: [replacement] }] }
    : { path: "target.txt", old_string: "before", new_string: "after" }, input);
}

async function run<TArgs>(tool: Tool<TArgs, FileChangeResult>, args: unknown, input: Partial<ToolExecutionContext> = {}): Promise<FileChangeResult> {
  const execution = await tool.resolveExecution(tool.schema.parse(args));
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute({ toolCallId: "encoding-test", operationId: "encoding-test-operation", ...input });
}

async function withWorkspace(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-edit-encoding-"));
  try { await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
