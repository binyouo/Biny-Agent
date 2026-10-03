/** Benign regex semantics plus deterministic hostile worker lifecycle boundaries. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import workerThreads from "node:worker_threads";
import { hashlineAnchor } from "../src/tools/file/hashline.js";
import { visitBoundUtf8Lines } from "../src/tools/file/safeFileIo.js";
import { CancellableRegexMatcher, maxRegexBatchLines, RegexExecutionError } from "../src/tools/search/regexMatcher.js";
import { createSearchFilesTool, type SearchFilesArgs, type SearchFilesResult } from "../src/tools/search/searchFiles.js";

const window = { skipMatches: 0, remainingMatches: 200, contextLines: 0, remainingContext: 0, hasMore: false };

async function search(root: string, args: SearchFilesArgs, signal?: AbortSignal): Promise<SearchFilesResult> {
  const execution = await createSearchFilesTool({ workspaceRoot: root, ignore: ["ignored.txt"] }).resolveExecution(args);
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute({ toolCallId: "grep-test", operationId: "grep-test", signal });
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-grep-cancellation-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("native worker preserves JavaScript u/iu, UTF-16 columns, lookaround, backreferences and zero-width matches", async () => {
  const cases = [
    { query: "(?<=😀)(word)\\1", lines: ["😀wordword", "word", ""], flags: "u" },
    { query: "k", lines: ["K", "K", "x"], flags: "iu" },
    { query: "^|$", lines: ["😀", "", "abc"], flags: "u" },
    { query: "😀$", lines: ["x😀", "😀x", "😀"], flags: "u" },
    { query: "alpha\\nbeta", lines: ["alpha", "beta"], flags: "u" }
  ];
  for (const item of cases) {
    const matcher = await CancellableRegexMatcher.create(item.query, item.flags);
    try {
      const expected = item.lines.map((line) => new RegExp(item.query, item.flags).exec(line)?.index);
      assert.deepEqual(await matcher.match(item.lines, window), expected);
    } finally { await matcher.close(); }
  }
});

test("Grep retains context, cross-batch pagination, CRLF/EOF, filters and anchors", async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, "scope"));
    const lines = Array.from({ length: 310 }, (_, i) => i % 5 === 0 ? `😀wordword ${i}` : `context ${i}`);
    await writeFile(path.join(root, "scope", "a.txt"), lines.join("\r\n"));
    await writeFile(path.join(root, "scope", "b.md"), "😀wordword excluded\n");
    await writeFile(path.join(root, "ignored.txt"), "😀wordword ignored\n");
    const first = await search(root, { query: "(?<=😀)(word)\\1", mode: "regex", path: "scope", glob: "scope/**/*.txt", offset: 25, limit: 2, contextLines: 2 });
    assert.deepEqual(first.matches.map((match) => [match.path, match.line, match.column]), [["scope/a.txt", 126, 3], ["scope/a.txt", 131, 3]]);
    assert.deepEqual(first.matches[0]?.before, [{ line: 124, text: lines[123] }, { line: 125, text: lines[124] }]);
    assert.deepEqual(first.matches[1]?.after, [{ line: 132, text: lines[131] }, { line: 133, text: lines[132] }]);
    assert.equal(first.matches[0]?.anchor, hashlineAnchor(lines[125]!, 126));
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 27);
    assert.equal(first.skippedFiles, undefined);
    const final = await search(root, { query: "^context 309$", mode: "regex", path: "scope", glob: "scope/**/*.txt" });
    assert.equal(final.matches[0]?.line, 310);
    assert.equal(final.hasMore, false);
    assert.equal((await search(root, { query: "(word)\\1", path: "scope" })).matches.length, 0, "literal default stays literal");
    assert.throws(() => createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ query: "[", mode: "regex" }), SyntaxError);
    assert.throws(() => createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ query: "a".repeat(65537), mode: "regex" }), RegexExecutionError);
  });
});

test("batch read-ahead preserves early pagination before a later invalid line", async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, "a.txt"), `hit\nhit\n${"x".repeat(1024 * 1024 + 1)}\n`);
    const result = await search(root, { query: "^hit$", mode: "regex", limit: 1 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.hasMore, true);
    assert.equal(result.skippedFiles, undefined);
  });
});

test("regex still streams past the old file prefix, rolls back rejected files, and rejects escaping paths", async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, "a.txt"), `${"filler\n".repeat(170000)}suffix-hit\n`);
    assert.equal((await search(root, { query: "^suffix-hit$", mode: "regex" })).matches[0]?.line, 170001);
    await writeFile(path.join(root, "b.txt"), `suffix-hit\n${"x".repeat(1024 * 1024 + 1)}\n`);
    const result = await search(root, { query: "^suffix-hit$", mode: "regex" });
    assert.deepEqual(result.matches.map((match) => match.path), ["a.txt"]);
    assert.deepEqual(result.skippedFiles, ["b.txt"]);
    assert.throws(() => createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ query: "x", mode: "regex", path: ".." }), /escapes workspace/u);
    if (process.platform !== "win32") {
      await symlink(os.tmpdir(), path.join(root, "outside"), "dir");
      assert.throws(() => createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ query: "x", mode: "regex", path: "outside" }), /escapes workspace/u);
    }
  });
});

test("reader awaits buffered matching before validating the file snapshot and closes on cancellation", async () => {
  await fixture(async (root) => {
    const target = path.join(root, "a.txt");
    await writeFile(target, "first\nlast");
    let changed = false;
    await assert.rejects(visitBoundUtf8Lines(target, () => undefined, undefined, async () => {
      if (!changed) { changed = true; await writeFile(target, "externally changed"); }
    }), /File changed while it was being read/u);
    const controller = new AbortController();
    await assert.rejects(visitBoundUtf8Lines(target, async () => { controller.abort(); }, controller.signal), { name: "AbortError" });
    await rm(target);
  });
});

test("a real native worker blocked in matching is terminated before cancellation settles", async () => {
  const OriginalWorker = workerThreads.Worker;
  const activity = new Int32Array(new SharedArrayBuffer(4));
  class PausedWorker extends OriginalWorker {
    static instances: PausedWorker[] = [];
    constructor(_source: string, options: workerThreads.WorkerOptions) {
      super(`
        const { parentPort, workerData } = require("node:worker_threads");
        const activity = new Int32Array(workerData.activity);
        parentPort.on("message", () => {
          Atomics.store(activity, 0, 1);
          // Bounded deterministic blocking, without a costly crafted regex.
          Atomics.wait(activity, 0, 1, 1000);
          parentPort.postMessage([0]);
        });
        parentPort.postMessage("ready");
      `, { ...options, workerData: { activity: activity.buffer } });
      PausedWorker.instances.push(this);
    }
  }
  workerThreads.Worker = PausedWorker;
  syncBuiltinESMExports();
  const controller = new AbortController();
  let matcher: CancellableRegexMatcher | undefined;
  try {
    matcher = await CancellableRegexMatcher.create("x", "u", controller.signal);
    const result = matcher.match(["x"], window);
    const rejected = assert.rejects(result, { name: "AbortError" });
    const deadline = Date.now() + 500;
    while (Atomics.load(activity, 0) === 0) {
      assert.ok(Date.now() < deadline, "native worker should enter the bounded fixture");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let timerRan = false;
    setTimeout(() => { timerRan = true; controller.abort(); }, 5);
    await rejected;
    await matcher.close();
    assert.equal(timerRan, true);
    assert.equal(PausedWorker.instances.at(-1)?.threadId, -1, "cancellation must stop the underlying native thread");
  } finally {
    await matcher?.close();
    workerThreads.Worker = OriginalWorker;
    syncBuiltinESMExports();
  }
});

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  static autoReady = true;
  terminateCalls = 0;
  sent: unknown[] = [];
  constructor() {
    super();
    FakeWorker.instances.push(this);
    if (FakeWorker.autoReady) setImmediate(() => this.emit("message", "ready"));
  }
  postMessage(value: unknown): void { this.sent.push(value); }
  async terminate(): Promise<number> { this.terminateCalls += 1; return 0; }
}

// Only the worker boundary is replaced. No expensive crafted regex runs on the Host.
test("host stays responsive; abort/error/exit/deadline settle once and release worker slots", async (t) => {
  const original = workerThreads.Worker;
  workerThreads.Worker = FakeWorker as unknown as typeof workerThreads.Worker;
  syncBuiltinESMExports();
  try {
    const preaborted = new AbortController();
    preaborted.abort();
    await assert.rejects(CancellableRegexMatcher.create("x", "u", preaborted.signal), { name: "AbortError" });
    assert.equal(FakeWorker.instances.length, 0);
    const controller = new AbortController();
    const matcher = await CancellableRegexMatcher.create("x", "u", controller.signal);
    const worker = FakeWorker.instances.at(-1)!;
    const pending = matcher.match(["ordinary line"], window);
    const reason = new Error("cancel this exact search");
    setImmediate(() => controller.abort(reason));
    await assert.rejects(pending, (error) => error === reason);
    await Promise.all([matcher.close(), matcher.close()]);
    worker.emit("message", [0]);
    assert.equal(worker.terminateCalls, 1);

    for (const failure of ["error", "exit", "invalid"] as const) {
      const current = await CancellableRegexMatcher.create("x", "u");
      const fake = FakeWorker.instances.at(-1)!;
      const result = current.match(["x"], window);
      if (failure === "error") fake.emit("error", new Error("synthetic worker failure"));
      else if (failure === "exit") fake.emit("exit", 9);
      else fake.emit("message", [3]);
      await assert.rejects(result, RegexExecutionError);
      await current.close();
      assert.equal(fake.terminateCalls, 1);
    }

    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stalled = await CancellableRegexMatcher.create("x", "u");
    const stalledWorker = FakeWorker.instances.at(-1)!;
    const stalledResult = stalled.match(["x"], window);
    const rejected = assert.rejects(stalledResult, /matching timed out/u);
    t.mock.timers.tick(1000);
    await rejected;
    await stalled.close();
    assert.equal(stalledWorker.terminateCalls, 1);
    t.mock.timers.reset();

    const bounded = await CancellableRegexMatcher.create("x", "u");
    await assert.rejects(bounded.match(Array.from({ length: maxRegexBatchLines + 1 }, () => "x"), window), /line or byte limit/u);
    await assert.rejects(bounded.match(["x".repeat(2 * 1024 * 1024)], window), /line or byte limit/u);
    await bounded.close();
    const occupied = await Promise.all(Array.from({ length: 8 }, () => CancellableRegexMatcher.create("x", "u")));
    await assert.rejects(CancellableRegexMatcher.create("x", "u"), /worker limit reached/u);
    await Promise.all(occupied.map((item) => item.close()));
    const reused = await CancellableRegexMatcher.create("x", "u");
    await reused.close();

    FakeWorker.autoReady = false;
    const startupAbort = new AbortController();
    const startup = CancellableRegexMatcher.create("x", "u", startupAbort.signal);
    startupAbort.abort();
    await assert.rejects(startup, { name: "AbortError" });
    assert.equal(FakeWorker.instances.at(-1)?.terminateCalls, 1);
  } finally {
    workerThreads.Worker = original;
    syncBuiltinESMExports();
    FakeWorker.autoReady = true;
  }
});
