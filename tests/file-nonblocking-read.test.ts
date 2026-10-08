/** Nonregular pipes must reach the existing type check without waiting for a writer. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { archiveToolResult, resolveToolResultArchivePath } from "../src/session/toolResultArchive.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";
import { readBoundedBinaryFile, snapshotRegularFile } from "../src/tools/file/safeFileIo.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

const unsupported = process.platform === "win32" || typeof constants.O_NONBLOCK !== "number";
const skip = unsupported ? "Requires a supported POSIX FIFO/nonblocking-open environment" : false;

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-nonblocking-read-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function makePipe(target: string): Promise<void> {
  execFileSync("mkfifo", [target]);
  assert.equal((await fs.lstat(target)).isFIFO(), true);
}

function observePipeOpen(t: TestContext, target: string, abort?: AbortController) {
  const originalOpen = fs.open;
  const state = { opened: 0, closed: 0, dataReads: 0 };
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) !== target) return originalOpen(...args);
    assert.equal(typeof args[1], "number");
    const flags = Number(args[1]);
    // This guard prevents a regression test itself hanging; separate evidence
    // demonstrates the original real blocking open and its controlled release.
    assert.ok(flags & constants.O_NONBLOCK, "unsupported-file checks must not issue a blocking FIFO open");
    assert.ok(flags & constants.O_NOFOLLOW, "retain final-component symlink protection");
    assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), 0, "a read must not acquire write/create permissions");
    const handle = await originalOpen(...args);
    state.opened += 1;
    const close = handle.close.bind(handle);
    t.mock.method(handle, "read", () => { state.dataReads += 1; throw new Error("FIFO content must not be read"); });
    t.mock.method(handle, "readFile", () => { state.dataReads += 1; throw new Error("FIFO content must not be read"); });
    t.mock.method(handle, "close", async () => { await close(); state.closed += 1; });
    abort?.abort(new Error("cancel after descriptor open"));
    return handle;
  });
  return state;
}

async function execute<TArgs, TResult>(tool: Tool<TArgs, TResult>, args: TArgs, signal?: AbortSignal): Promise<TResult> {
  const execution = await tool.resolveExecution(args);
  assert.ok("execute" in execution);
  return execution.execute({ signal, toolCallId: "nonblocking", operationId: "nonblocking" });
}

for (const kind of ["workspace", "archive"] as const) {
  test(`public ${kind} reader rejects an actual FIFO without a writer and closes once`, { skip }, async (t) => {
    await fixture(async (root) => {
      let target: string;
      let run: () => Promise<unknown>;
      if (kind === "workspace") {
        target = path.join(root, "input.pipe");
        run = () => execute(createReadFileTool({ workspaceRoot: root, ignore: [] }), { path: "input.pipe" });
      } else {
        const archive = await archiveToolResult({ workspaceRoot: root, sessionId: "fifo", toolCallId: "archive", sequence: 1, tool: "fixture", result: "original" });
        target = resolveToolResultArchivePath(root, archive.archivePath);
        await fs.rm(target);
        run = () => execute(createReadToolResultTool({ workspaceRoot: root, ignore: [] }), { archivePath: archive.archivePath });
      }
      await makePipe(target);
      const inode = (await fs.lstat(target)).ino;
      const state = observePipeOpen(t, target);
      await assert.rejects(run(), /regular file|File path changed during access/u);
      assert.deepEqual(state, { opened: 1, closed: 1, dataReads: 0 });
      assert.equal((await fs.lstat(target)).ino, inode);
      assert.equal((await fs.lstat(target)).isFIFO(), true);
    });
  });
}

for (const operation of ["write", "edit", "snapshot", "binary"] as const) {
  test(`${operation} rejects a FIFO through the shared regular-file reader without modifying it`, { skip }, async (t) => {
    await fixture(async (root) => {
      const target = path.join(root, "input.pipe");
      await makePipe(target);
      const before = await fs.lstat(target);
      const state = observePipeOpen(t, target);
      const context = { workspaceRoot: root, ignore: [] };
      const run = () => operation === "write" ? execute(createWriteFileTool(context), { path: "input.pipe", content: "must not write" })
        : operation === "edit" ? execute(createEditFileTool(context), { operation: "delete", path: "input.pipe" })
        : operation === "snapshot" ? snapshotRegularFile(target)
        : readBoundedBinaryFile(target, 1024);
      await assert.rejects(run(), /File path changed during access/u);
      assert.deepEqual(state, { opened: 1, closed: 1, dataReads: 0 });
      assert.equal((await fs.lstat(target)).ino, before.ino);
      assert.deepEqual(await fs.readdir(root), ["input.pipe"]);
    });
  });
}

test("existing-archive reuse rejects a FIFO without overwriting it or publishing a reference", { skip }, async (t) => {
  await fixture(async (root) => {
    const args = { workspaceRoot: root, sessionId: "fifo", toolCallId: "reuse", sequence: 1, tool: "fixture", result: "original" };
    const archive = await archiveToolResult(args);
    const target = resolveToolResultArchivePath(root, archive.archivePath);
    await fs.rm(target);
    await makePipe(target);
    const state = observePipeOpen(t, target);
    await assert.rejects(archiveToolResult(args), /not a regular file/u);
    assert.deepEqual(state, { opened: 1, closed: 1, dataReads: 0 });
    assert.equal((await fs.lstat(target)).isFIFO(), true);
  });
});

for (const cancel of [false, true]) {
  for (const kind of ["workspace", "archive"] as const) {
    test(`coordinator ${kind} FIFO result is ${cancel ? "cancelled" : "failed"}, never unknown, and releases the reader`, { skip }, async (t) => {
      await fixture(async (root) => {
        const context = { workspaceRoot: root, ignore: [] };
        const registry = new ToolRegistry();
        registry.registerBuiltinTool(createReadFileTool(context));
        registry.registerBuiltinTool(createReadToolResultTool(context));
        const archive = await archiveToolResult({ workspaceRoot: root, sessionId: "setup", toolCallId: "setup", sequence: 1, tool: "fixture", result: "original" });
        const target = kind === "workspace" ? path.join(root, "input.pipe") : resolveToolResultArchivePath(root, archive.archivePath);
        if (kind === "archive") await fs.rm(target);
        await makePipe(target);
        await fs.writeFile(path.join(root, "regular.txt"), "afterwards\n");
        const controller = new AbortController();
        const state = observePipeOpen(t, target, cancel ? controller : undefined);
        const config = structuredClone(defaultConfig);
        config.permission.mode = "full-access";
        const recorder = new SessionRecorder(root, `fifo-${kind}-${String(cancel)}`);
        try {
          await recorder.recordAndFlush({ type: "user_message", content: "read synthetic file" });
          const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
          const tools = coordinator.createAgentTools();
          const name = kind === "workspace" ? "Read" : "read_tool_result";
          const result = await tools.find((tool) => tool.name === name)!.execute("fifo-call", kind === "workspace" ? { path: "input.pipe" } : { archivePath: archive.archivePath }, controller.signal);
          await coordinator.waitForIdle();
          await recorder.flush();
          const events = await readSessionEvents(recorder.filePath);
          const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "fifo-call");
          assert.ok(persisted?.type === "tool_result");
          assert.equal(persisted.executionStatus, cancel ? "cancelled" : "failed");
          assert.equal(result.isError, true);
          assert.equal((result.details as Record<string, unknown>).content, undefined);
          assert.deepEqual(state, { opened: 1, closed: 1, dataReads: 0 });
          assert.doesNotThrow(() => coordinator.assertCanContinue());
          const next = await tools.find((tool) => tool.name === "Read")!.execute("next-read", { path: "regular.txt" });
          assert.equal(next.isError, false);
          assert.equal((next.details as Record<string, unknown>).content, "afterwards");
        } finally { await recorder.close(); }
      });
    });
  }
}

test("pre-aborted reads still open no FIFO", { skip }, async (t) => {
  await fixture(async (root) => {
    const target = path.join(root, "input.pipe");
    await makePipe(target);
    const state = observePipeOpen(t, target);
    const controller = new AbortController();
    const reason = new Error("cancel before file access");
    controller.abort(reason);
    await assert.rejects(execute(createReadFileTool({ workspaceRoot: root, ignore: [] }), { path: "input.pipe" }, controller.signal), (error: unknown) => error === reason);
    assert.deepEqual(state, { opened: 0, closed: 0, dataReads: 0 });
  });
});

test("regular UTF-8 and binary reads plus canonical workspace aliases remain unchanged", async () => {
  await fixture(async (root) => {
    const target = path.join(root, "regular.txt");
    const content = "first 😀\n中文 second\n";
    await fs.writeFile(target, content);
    const result = await execute(createReadFileTool({ workspaceRoot: root, ignore: [] }), { path: "regular.txt" });
    assert.equal(result.content, content.slice(0, -1));
    assert.deepEqual(await readBoundedBinaryFile(target, 1024), Buffer.from(content));
    if (process.platform !== "win32") {
      const alias = path.join(root, "alias.txt");
      await fs.symlink(target, alias);
      assert.equal((await execute(createReadFileTool({ workspaceRoot: root, ignore: [] }), { path: "alias.txt" })).content, content.slice(0, -1));
      await assert.rejects(snapshotRegularFile(alias), /symbolic link/u, "the lower-level nofollow contract is unchanged");
    }
  });
});

test("regular-file open failures preserve the original error", async (t) => {
  await fixture(async (root) => {
    const target = path.join(root, "regular.txt");
    await fs.writeFile(target, "original");
    const originalOpen = fs.open;
    const expected = Object.assign(new Error("synthetic open EACCES"), { code: "EACCES" });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === target) throw expected;
      return originalOpen(...args);
    });
    await assert.rejects(execute(createReadFileTool({ workspaceRoot: root, ignore: [] }), { path: "regular.txt" }), (error: unknown) => error === expected);
  });
});
