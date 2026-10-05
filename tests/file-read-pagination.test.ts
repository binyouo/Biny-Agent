import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatHashlineLine } from "../src/tools/file/hashline.js";
import { createReadFileTool, type ReadFileArgs } from "../src/tools/file/readFile.js";
import { visitBoundUtf8Lines } from "../src/tools/file/safeFileIo.js";

const workspaceRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-read-pagination-")));
const target = path.join(workspaceRoot, "page.txt");
const lineLimit = 1024 * 1024;
try {
  for (const hashline of [false, true]) {
    for (const ending of ["", "\n"]) {
      await writeFile(target, `skip\nrequested\n${"x".repeat(lineLimit + 1)}${ending}`);
      const page = await readPage({ startLine: 2, lineCount: 1 }, hashline);
      assert.deepEqual(page, {
        path: "page.txt",
        content: hashline ? formatHashlineLine("requested", 2) : "requested",
        startLine: 2,
        endLine: 2,
        hasMore: true,
        nextStartLine: 3
      }, "an oversized unrequested next line must not invalidate the requested page");
      await assert.rejects(readPage({ startLine: 3, lineCount: 1 }, hashline), /streamed line limit/u);
    }
  }

  for (const content of ["", "one", "one\n", "one\r\n", "\n"]) {
    await writeFile(target, content);
    const page = await readPage({ lineCount: 1 });
    assert.equal(page.hasMore, false, JSON.stringify(content));
    assert.equal(page.nextStartLine, undefined);
    assert.equal(page.endLine, content === "" ? 0 : 1);
  }
  for (const suffix of ["two", "two\n", "\n", "二", "二\r\n"]) {
    await writeFile(target, `one\n${suffix}`);
    const page = await readPage({ lineCount: 1 });
    assert.equal(page.content, "one");
    assert.equal(page.hasMore, true, JSON.stringify(suffix));
    assert.equal(page.nextStartLine, 2);
    const last = await readPage({ startLine: page.nextStartLine, lineCount: 1 });
    assert.equal(last.content, suffix.replace(/\r?\n$/u, ""));
    assert.equal(last.hasMore, false);
  }

  // The page can end exactly on a read chunk, or leave a partial UTF-8 character in the decoder.
  for (const firstLine of ["x".repeat(64 * 1024 - 1), "x".repeat(64 * 1024 - 2)]) {
    await writeFile(target, `${firstLine}\n😀`);
    assert.equal((await readPage({ lineCount: 1 })).hasMore, true);
    assert.equal((await readPage({ startLine: 2, lineCount: 1 })).content, "😀");
    await writeFile(target, `${firstLine}\n`);
    assert.equal((await readPage({ lineCount: 1 })).hasMore, false);
  }
  await writeFile(target, Buffer.from([0x6f, 0x6b, 0x0a, 0xe4]));
  assert.equal((await readPage({ lineCount: 1 })).hasMore, true, "decoder-buffered trailing bytes still form another line");

  await writeFile(target, `${"x".repeat(600_000)}\n${"y".repeat(600_000)}\n`);
  await assert.rejects(readPage({ lineCount: 2 }), /output limit/u);

  for (const [content, hasRemaining] of [["one", false], ["one\n", false], ["one\ntwo", true]] as const) {
    await writeFile(target, content);
    const stopped = await visitBoundUtf8Lines(target, async () => false);
    assert.deepEqual({ completed: stopped.completed, hasRemaining: stopped.hasRemaining, linesVisited: stopped.linesVisited }, {
      completed: false, hasRemaining, linesVisited: 1
    }, "async stop remains distinct from whether another line exists");
    const drained = await visitBoundUtf8Lines(target, () => undefined, undefined, async () => false);
    assert.equal(drained.completed, false);
    assert.equal(drained.hasRemaining, !content.endsWith("\n"), "batch drain retains the unterminated final line until visited");
  }

  // Early page completion must still enforce the shared reader's cancellation and version checks.
  await writeFile(target, "one\ntwo\n");
  const controller = new AbortController();
  await assert.rejects(visitBoundUtf8Lines(target, () => {
    controller.abort();
    return false;
  }, controller.signal), { name: "AbortError" });
  await assert.rejects(visitBoundUtf8Lines(target, async () => {
    await writeFile(target, "changed\n");
    return false;
  }), /changed while it was being read/u);
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}

async function readPage(args: Omit<ReadFileArgs, "path">, hashline = false) {
  const execution = createReadFileTool({ workspaceRoot, ignore: [] }, hashline).resolveExecution({ path: "page.txt", ...args });
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution.execute({ toolCallId: "read-page" });
}

console.log("file read pagination tests passed");
