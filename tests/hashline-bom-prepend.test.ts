/** A prepend must not relocate the existing UTF-8 file signature into the body. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import type { CommittedFileChange } from "../src/tools/file/fileChange.js";
import type { HashlineEdit } from "../src/tools/file/hashline.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import type { Tool, ToolExecutionContext } from "../src/tools/types.js";

interface Fixture {
  edit(edits: HashlineEdit[], preview?: boolean): Promise<void>;
  anchors(): Promise<string[]>;
  bytes(): Promise<Buffer>;
  text(): Promise<string>;
}

async function withFile(original: string, work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-hashline-bom-"));
  const file = path.join(root, "owned.txt");
  try {
    await writeFile(file, original);
    const context = { workspaceRoot: root, ignore: [] };
    await work({
      async edit(edits, preview = true) {
        const args = { operation: "update", path: "owned.txt", edits };
        const prompt = preview ? await createToolPermissionRequest({ id: "bom-test", name: "Edit", args }, context) : undefined;
        const committed: CommittedFileChange[] = [];
        const result = await invoke(createEditFileTool(context, true), args, {
          onFileChangeCommitted: async (change) => { committed.push(change); }
        }).catch((error: unknown) => {
          assert.deepEqual(committed, [], "rejection must not publish committed-file evidence");
          throw error;
        });
        assert.equal(result.change.committed, true);
        assert.deepEqual(committed, [result.change]);
        if (prompt) assert.equal(result.change.diff, prompt.diff);
      },
      async anchors() {
        const result = await invoke(createReadFileTool(context, true), { path: "owned.txt" });
        assert.ok("startLine" in result);
        return result.content.split("\n").map((line) => {
          const anchor = line.split(":", 1)[0];
          assert.ok(anchor);
          return anchor;
        });
      },
      bytes: () => readFile(file),
      text: () => readFile(file, "utf8")
    });
    assert.deepEqual(await readdir(root), ["owned.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function invoke<TArgs, TResult>(tool: Tool<TArgs, TResult>, args: unknown, input: Partial<ToolExecutionContext> = {}): Promise<TResult> {
  const execution = await tool.resolveExecution(tool.schema.parse(args));
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution.execute({ toolCallId: "bom-test", operationId: "bom-test-operation", ...input });
}

async function anchor(fixture: Fixture, index = 0): Promise<string> {
  const value = (await fixture.anchors())[index];
  assert.ok(value);
  return value;
}

for (const ending of ["\n", "\r\n"]) {
  for (const anchored of [false, true]) {
    test(`prepend retains the file signature with ${JSON.stringify(ending)} and anchored=${String(anchored)}`, async () => {
      await withFile(`\uFEFFprint("old")${ending}# untouched${ending}`, async (fixture) => {
        const pos = await anchor(fixture);
        await fixture.edit([{ op: "prepend", ...(anchored ? { pos } : {}), lines: ["# header"] }]);
        assert.deepEqual(await fixture.bytes(), Buffer.from(`\uFEFF# header${ending}print("old")${ending}# untouched${ending}`));
      });
    });
  }
}

for (const fixture of [
  { name: "no BOM prepend", original: "first\nsecond\n", op: "prepend", expected: "# header\nfirst\nsecond\n" },
  { name: "BOM append", original: "\uFEFFfirst\nsecond\n", op: "append", expected: "\uFEFFfirst\nsecond\n# header\n" },
  { name: "interior FEFF prepend", original: "first\n\uFEFFsecond\n", op: "prepend", expected: "# header\nfirst\n\uFEFFsecond\n" },
  { name: "empty prepend", original: "", op: "prepend", expected: "# header" },
  { name: "unterminated no BOM prepend", original: "first", op: "prepend", expected: "# header\nfirst" }
] as const) {
  test(fixture.name, () => withFile(fixture.original, async (file) => {
    await file.edit([{ op: fixture.op, lines: ["# header"] }]);
    assert.equal(await file.text(), fixture.expected);
  }));
}

test("repeated public Read and prepend retains one source signature", () => withFile("\uFEFFfirst\nsecond\n", async (file) => {
  await file.edit([{ op: "prepend", pos: await anchor(file), lines: ["# one"] }]);
  await file.edit([{ op: "prepend", pos: await anchor(file), lines: ["# two"] }]);
  assert.equal(await file.text(), "\uFEFF# two\n# one\nfirst\nsecond\n");
}));

for (const original of ["\uFEFF", "\uFEFF\n", "\uFEFF\uFEFFfirst\n"]) {
  test(`source signature boundary ${JSON.stringify(original)}`, () => withFile(original, async (file) => {
    await file.edit([{ op: "prepend", lines: ["# header"] }]);
    assert.equal(await file.text(), `\uFEFF# header\n${original.slice(1)}`);
  }));
}

for (const anchored of [false, true]) {
  test(`first-line replacement plus prepend rejects unchanged anchored=${String(anchored)}`, () => withFile("\uFEFFfirst\nsecond\n", async (file) => {
    const before = await file.bytes();
    const pos = await anchor(file);
    await assert.rejects(file.edit([
      { op: "prepend", ...(anchored ? { pos } : {}), lines: ["header"] },
      { op: "replace", pos, lines: ["replaced"] }
    ]), /overlapping|same boundary/u);
    assert.deepEqual(await file.bytes(), before);
  }));
}

for (const replacement of ["replaced", "\uFEFFreplaced"]) {
  test(`whole first-line replacement explicitly controls signature ${JSON.stringify(replacement)}`, () => withFile("\uFEFFfirst\nsecond\n", async (file) => {
    await file.edit([{ op: "replace", pos: await anchor(file), lines: [replacement] }]);
    assert.equal(await file.text(), `${replacement}\nsecond\n`);
  }));
}

test("no source BOM retains intentionally inserted FEFF", () => withFile("first\n", async (file) => {
  await file.edit([{ op: "prepend", lines: ["\uFEFFheader"] }]);
  assert.equal(await file.text(), "\uFEFFheader\nfirst\n");
}));

test("interior prepend leaves source marker and literal FEFF unchanged", () => withFile("\uFEFFfirst\n\uFEFFsecond\n", async (file) => {
  await file.edit([{ op: "prepend", pos: await anchor(file, 1), lines: ["header"] }]);
  assert.equal(await file.text(), "\uFEFFfirst\nheader\n\uFEFFsecond\n");
}));

test("prepend and independent later replacement preserve source marker", () => withFile("\uFEFFfirst\nsecond\n", async (file) => {
  await file.edit([{ op: "prepend", lines: ["header"] }, { op: "replace", pos: await anchor(file, 1), lines: ["replaced"] }]);
  assert.equal(await file.text(), "\uFEFFheader\nfirst\nreplaced\n");
}));

test("multiple start-zero insertions reject before mutation", () => withFile("\uFEFFfirst\n", async (file) => {
  const before = await file.bytes();
  await assert.rejects(file.edit([
    { op: "prepend", lines: ["one"] },
    { op: "prepend", pos: await anchor(file), lines: ["two"] }
  ]), /same boundary/u);
  assert.deepEqual(await file.bytes(), before);
}));

test("source marker and explicitly inserted leading FEFF remain separate", () => withFile("\uFEFFfirst\n", async (file) => {
  await file.edit([{ op: "prepend", lines: ["\uFEFFheader"] }]);
  assert.equal(await file.text(), "\uFEFF\uFEFFheader\nfirst\n");
}));

test("source marker and inserted interior FEFF remain separate", () => withFile("\uFEFFfirst\n", async (file) => {
  await file.edit([{ op: "prepend", lines: ["head\uFEFFer", "\uFEFFsecond"] }]);
  assert.equal(await file.text(), "\uFEFFhead\uFEFFer\n\uFEFFsecond\nfirst\n");
}));

test("unterminated BOM-bearing source stays unterminated", () => withFile("\uFEFFfirst", async (file) => {
  await file.edit([{ op: "prepend", pos: await anchor(file), lines: ["header"] }]);
  assert.equal(await file.text(), "\uFEFFheader\nfirst");
}));

test("inserted blank first line keeps the signature at byte zero", () => withFile("\uFEFFfirst\n", async (file) => {
  await file.edit([{ op: "prepend", lines: [""] }]);
  assert.equal(await file.text(), "\uFEFF\nfirst\n");
}));

test("unanchored prepend and anchored append retain original anchor meaning", () => withFile("\uFEFFfirst\nsecond\n", async (file) => {
  await file.edit([{ op: "prepend", lines: ["header"] }, { op: "append", pos: await anchor(file), lines: ["between"] }]);
  assert.equal(await file.text(), "\uFEFFheader\nfirst\nbetween\nsecond\n");
}));

for (const invalid of ["not-an-anchor", "1#00000000"]) {
  test(`invalid or stale anchor rejects before signature handling: ${invalid}`, () => withFile("\uFEFFfirst\n", async (file) => {
    const before = await file.bytes();
    await assert.rejects(file.edit([{ op: "prepend", pos: invalid, lines: ["header"] }]), /Invalid Hashline|Stale Hashline/u);
    assert.deepEqual(await file.bytes(), before);
  }));
}

for (const kind of ["invalid", "stale", "anchored-replace", "unanchored-replace", "duplicate-insert"] as const) {
  test(`execution-only ${kind} rejection leaves original signature and bytes unchanged`, () => withFile("\uFEFFfirst\n", async (file) => {
    const before = await file.bytes();
    const pos = await anchor(file);
    const edits: HashlineEdit[] = kind === "invalid" || kind === "stale"
      ? [{ op: "prepend", pos: kind === "invalid" ? "not-an-anchor" : "1#00000000", lines: ["header"] }]
      : [
          { op: "prepend", ...(kind === "anchored-replace" ? { pos } : {}), lines: ["header"] },
          kind === "duplicate-insert" ? { op: "prepend", pos, lines: ["another"] } : { op: "replace", pos, lines: ["replaced"] }
        ];
    await assert.rejects(file.edit(edits, false), /Invalid Hashline|Stale Hashline|overlapping|same boundary/u);
    assert.deepEqual(await file.bytes(), before);
  }));
}
