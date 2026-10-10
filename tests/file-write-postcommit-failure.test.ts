/** A committed file write must not become a definite failure if later filesystem checks fail. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { FileChangeUncertainError } from "../src/tools/file/fileChange.js";
import { atomicWriteUtf8File } from "../src/tools/file/safeFileIo.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function fixture(run: (root: string, recorder: SessionRecorder, coordinator: ToolExecutionCoordinator) => Promise<void>): Promise<void> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-postcommit-write-")));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(directory, "agent-state");
  let recorder: SessionRecorder | undefined;
  try {
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    config.checkpoints.enabled = false;
    const registry = new ToolRegistry();
    registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot: root, ignore: [] }));
    recorder = new SessionRecorder(root, "postcommit-write");
    await recorder.recordAndFlush({ type: "user_message", content: "write synthetic target" });
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    await run(root, recorder, coordinator);
  } finally {
    await recorder?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function ioError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EIO" });
}

async function write(coordinator: ToolExecutionCoordinator, id = "write", content = "after\n") {
  return coordinator.createAgentTools().find((tool) => tool.name === "Write")!.execute(id, { path: "target.txt", content });
}

async function assertOutcome(recorder: SessionRecorder, coordinator: ToolExecutionCoordinator, status: "failed" | "unknown" | "succeeded") {
  await coordinator.waitForIdle();
  await recorder.flush();
  const events = await readSessionEvents(recorder.filePath);
  const result = events.find((event) => event.type === "tool_result" && event.toolCallId === "write");
  assert.ok(result?.type === "tool_result");
  assert.equal(result.executionStatus, status);
  if (status === "unknown") {
    assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
    assert.equal(events.some((event) => event.type === "tool_execution" && event.state === "unknown"), true);
    assert.equal(events.some((event) => event.type === "tool_execution" && event.change), false, "uncertainty must not invent durable commit evidence");
    const replay = replaySessionEvents(events, { sessionId: recorder.sessionId });
    const replayed = replay.messages.find((message) => message.role === "toolResult" && message.toolCallId === "write");
    assert.ok(replayed?.role === "toolResult");
    assert.deepEqual(replayed.details, result.result);
    const replayedResult = replay.events.find((event) => event.type === "tool_result" && event.toolCallId === "write");
    assert.ok(replayedResult?.type === "tool_result");
    assert.equal(replayedResult.executionStatus, "unknown");
    assert.equal(replay.recoveredToolResults.length, 0, "reopening a terminal unknown result must not fabricate an automatic retry");
  } else assert.doesNotThrow(() => coordinator.assertCanContinue());
  return events;
}

for (const existing of [false, true]) for (const persistent of [false, true]) {
  test(`${existing ? "replacement" : "creation"} cleanup ${persistent ? "and retry both fail" : "fails once"}: preserve bytes, persist uncertainty and block replay`, async (t) => {
    await fixture(async (root, recorder, coordinator) => {
      const target = path.join(root, "target.txt");
      if (existing) await fs.writeFile(target, "before\n");
      const primary = ioError("primary postcommit unlink failure");
      const secondary = ioError("secondary cleanup retry failure");
      const originalUnlink = fs.unlink;
      let failures = 0;
      t.mock.method(fs, "unlink", async (value: Parameters<typeof fs.unlink>[0]) => {
        const name = path.basename(String(value));
        if (path.dirname(String(value)) === root && name.startsWith(existing ? ".biny-backup-" : ".biny-write-") && (persistent || failures === 0)) {
          failures += 1;
          throw failures === 1 ? primary : secondary;
        }
        return originalUnlink(value);
      });
      const result = await write(coordinator);
      assert.equal(result.isError, true);
      assert.equal(await fs.readFile(target, "utf8"), "after\n");
      assert.ok(failures >= 1);
      assert.match(JSON.stringify(result.details), /primary postcommit unlink failure/u);
      assert.doesNotMatch(JSON.stringify(result.details), /secondary cleanup retry failure/u, "cleanup must not mask the primary failure");
      await assertOutcome(recorder, coordinator, "unknown");
      const beforeRetry = await fs.stat(target);
      const denied = await write(coordinator, "blind-retry", "must-not-write\n");
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied.details), /unknown side effect/u);
      assert.equal(await fs.readFile(target, "utf8"), "after\n");
      assert.equal((await fs.stat(target)).ino, beforeRetry.ino, "denied retry must not replace the committed inode");
      const events = await readSessionEvents(recorder.filePath);
      assert.equal(events.filter((event) => event.type === "tool_execution" && event.toolCallId === "write" && event.state === "admitted").length, 1);
      assert.equal(events.some((event) => event.type === "tool_execution" && event.toolCallId === "blind-retry" && event.state === "admitted"), false);
      const auxiliary = (await fs.readdir(root)).filter((name) => name.startsWith(".biny-"));
      assert.equal(auxiliary.length, existing && !persistent ? 0 : 1, "existing guarded auxiliary cleanup behavior stays unchanged");
    });
  });
}

for (const existing of [false, true]) {
  test(`${existing ? "replacement" : "creation"}: final binding verification failure is uncertain after content committed`, async (t) => {
    await fixture(async (root, recorder, coordinator) => {
      const target = path.join(root, "target.txt");
      if (existing) await fs.writeFile(target, "before\n");
      const originalLink = fs.link;
      const originalRename = fs.rename;
      const originalLstat = fs.lstat;
      let committed = false;
      t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
        await originalLink(...args);
        if (!existing && String(args[1]) === target) committed = true;
      });
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await originalRename(...args);
        if (existing && String(args[1]) === target) committed = true;
      });
      t.mock.method(fs, "lstat", ((...args: Parameters<typeof fs.lstat>) => {
        if (committed && String(args[0]) === target) return Promise.reject(ioError("final target verification failed"));
        return originalLstat(...args);
      }) as typeof fs.lstat);
      const result = await write(coordinator);
      assert.equal(committed, true);
      assert.equal(result.isError, true);
      assert.equal(await fs.readFile(target, "utf8"), "after\n");
      await assertOutcome(recorder, coordinator, "unknown");
    });
  });
}

for (const existing of [false, true]) {
  test(`${existing ? "replacement" : "creation"}: precommit primary and cleanup failures remain ordinary failure`, async (t) => {
    await fixture(async (root, recorder, coordinator) => {
      const target = path.join(root, "target.txt");
      if (existing) await fs.writeFile(target, "before\n");
      const originalLink = fs.link;
      const originalRename = fs.rename;
      const originalUnlink = fs.unlink;
      t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
        if (!existing && String(args[1]) === target) throw ioError("primary precommit failure");
        return originalLink(...args);
      });
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (existing && String(args[1]) === target) throw ioError("primary precommit failure");
        return originalRename(...args);
      });
      t.mock.method(fs, "unlink", async (value: Parameters<typeof fs.unlink>[0]) => {
        if (path.dirname(String(value)) === root && path.basename(String(value)).startsWith(".biny-")) throw ioError("secondary precommit cleanup failure");
        return originalUnlink(value);
      });
      const result = await write(coordinator);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.details), /primary precommit failure/u);
      assert.doesNotMatch(JSON.stringify(result.details), /secondary precommit cleanup failure/u);
      if (existing) assert.equal(await fs.readFile(target, "utf8"), "before\n");
      else await assert.rejects(fs.readFile(target), { code: "ENOENT" });
      await assertOutcome(recorder, coordinator, "failed");
    });
  });
}

test("confirmed restoration of an in-place external change remains an ordinary failure", async (t) => {
  await fixture(async (root, recorder, coordinator) => {
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "before\n");
    const originalRename = fs.rename;
    let injected = false;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (!injected && String(args[1]) === target && path.basename(String(args[0])).startsWith(".biny-write-")) {
        injected = true;
        await fs.writeFile(target, "external in-place version\n");
      }
      return originalRename(...args);
    });
    const result = await write(coordinator);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.details), /external version was restored/u);
    assert.equal(await fs.readFile(target, "utf8"), "external in-place version\n");
    assert.deepEqual(await fs.readdir(root), ["target.txt"]);
    await assertOutcome(recorder, coordinator, "failed");
  });
});

test("no-clobber creation collision remains ordinary failure and preserves the external file", async (t) => {
  await fixture(async (root, recorder, coordinator) => {
    const target = path.join(root, "target.txt");
    const originalLink = fs.link;
    let injected = false;
    t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      if (String(args[1]) === target) {
        injected = true;
        await fs.writeFile(target, "external creation\n");
      }
      return originalLink(...args);
    });
    const result = await write(coordinator);
    assert.equal(injected, true);
    assert.equal(result.isError, true);
    assert.equal(await fs.readFile(target, "utf8"), "external creation\n");
    assert.deepEqual(await fs.readdir(root), ["target.txt"]);
    await assertOutcome(recorder, coordinator, "failed");
  });
});

test("postcommit failure keeps the original cause and does not double-wrap known uncertainty", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-postcommit-cause-")));
  try {
    const primary = ioError("unlink failed after link");
    const originalUnlink = fs.unlink;
    const hook = t.mock.method(fs, "unlink", async (value: Parameters<typeof fs.unlink>[0]) => {
      if (path.basename(String(value)).startsWith(".biny-write-")) throw primary;
      return originalUnlink(value);
    });
    await assert.rejects(atomicWriteUtf8File(path.join(root, "first.txt"), "committed", null), (error: unknown) => {
      assert.ok(error instanceof FileChangeUncertainError);
      assert.equal(error.cause, primary);
      return true;
    });
    hook.mock.restore();
    const callbackFailure = new Error("callback failed");
    await assert.rejects(atomicWriteUtf8File(path.join(root, "second.txt"), "committed", null, undefined, () => { throw callbackFailure; }), (error: unknown) => {
      assert.ok(error instanceof FileChangeUncertainError);
      assert.equal(error.cause, callbackFailure, "already-classified callback uncertainty must retain its direct cause");
      assert.match(error.message, /evidence callback failed/u);
      return true;
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
