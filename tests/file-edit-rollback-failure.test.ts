/** Preserve uncertain delete/move side effects when rollback cannot be confirmed. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { FileChangeUncertainError } from "../src/tools/file/fileChange.js";
import { deleteBoundRegularFile, moveBoundRegularFile, snapshotRegularFile } from "../src/tools/file/safeFileIo.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function fixture(run: (root: string, recorder: SessionRecorder, coordinator: ToolExecutionCoordinator) => Promise<void>): Promise<void> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-edit-uncertainty-")));
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
    registry.registerBuiltinTool(createEditFileTool({ workspaceRoot: root, ignore: [] }));
    registry.registerBuiltinTool(createWriteFileTool({ workspaceRoot: root, ignore: [] }));
    recorder = new SessionRecorder(root, "edit-rollback");
    await recorder.recordAndFlush({ type: "user_message", content: "edit synthetic target" });
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry }, new PermissionManager(config.permission), () => undefined);
    await run(root, recorder, coordinator);
  } finally {
    await recorder?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}


function failure(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EIO" });
}

for (const operation of ["delete", "move"] as const) {
  for (const rollback of ["success", "syscall-error", "binding-error", "ambiguous-completed"] as const) {
    test(`${operation}: ${rollback} rollback preserves actual files and the correct durable outcome`, async (t) => {
      await fixture(async (root, recorder, coordinator) => {
        const source = path.join(root, "target.txt");
        const destination = path.join(root, "destination.txt");
        const original = "user-content-must-survive\n";
        await fs.writeFile(source, original);
        const originalUnlink = fs.unlink;
        const originalRename = fs.rename;
        const originalLstat = fs.lstat;
        const primary = failure("primary removal EIO");
        const secondary = failure("secondary rollback EIO");
        let failedPrimary = false;
        let failedSecondary = false;
        t.mock.method(fs, "unlink", async (value: Parameters<typeof fs.unlink>[0]) => {
          if (operation === "delete" && path.dirname(String(value)) === root && path.basename(String(value)).startsWith(".biny-delete-")
            || operation === "move" && String(value) === source) {
            failedPrimary = true;
            throw primary;
          }
          if (operation === "move" && rollback !== "success" && rollback !== "binding-error" && String(value) === destination) {
            if (rollback === "ambiguous-completed") await originalUnlink(value);
            failedSecondary = true;
            throw secondary;
          }
          return originalUnlink(value);
        });
        t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
          if (operation === "delete" && rollback !== "success" && rollback !== "binding-error" && String(args[1]) === source && path.basename(String(args[0])).startsWith(".biny-delete-")) {
            if (rollback === "ambiguous-completed") await originalRename(...args);
            failedSecondary = true;
            throw secondary;
          }
          return originalRename(...args);
        });
        t.mock.method(fs, "lstat", ((...args: Parameters<typeof fs.lstat>) => {
          if (failedPrimary && rollback === "binding-error" && (
            operation === "delete" && path.basename(String(args[0])).startsWith(".biny-delete-")
            || operation === "move" && String(args[0]) === destination)) {
            failedSecondary = true;
            return Promise.reject(secondary);
          }
          return originalLstat(...args);
        }) as typeof fs.lstat);
        const result = await coordinator.createAgentTools().find((entry) => entry.name === "Edit")!.execute("edit-rollback", {
          operation, path: "target.txt", ...(operation === "move" ? { to: "destination.txt" } : {})
        });
        await coordinator.waitForIdle();
        await recorder.flush();
        assert.equal(failedPrimary, true);
        assert.equal(failedSecondary, rollback !== "success");
        const files = await fs.readdir(root);
        const contents = await Promise.all(files.map((file) => fs.readFile(path.join(root, file), "utf8")));
        assert.ok(contents.every((content) => content === original));
        const restored = rollback === "success" || rollback === "ambiguous-completed";
        if (operation === "delete" && !restored) {
          assert.equal(files.length, 1);
          assert.ok(files[0]!.startsWith(".biny-delete-"));
          await assert.rejects(fs.readFile(source), { code: "ENOENT" });
        } else {
          assert.equal(await fs.readFile(source, "utf8"), original);
          assert.equal(files.length, operation === "move" && !restored ? 2 : 1);
        }
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.details), /primary removal EIO/u);
        assert.doesNotMatch(JSON.stringify(result.details), /secondary rollback EIO/u, "secondary cleanup must not mask the initiating failure");
        await assertOutcome(recorder, coordinator, rollback === "success" ? "failed" : "unknown");
      });
    });
  }
}

async function assertOutcome(recorder: SessionRecorder, coordinator: ToolExecutionCoordinator, expected: "failed" | "unknown"): Promise<void> {
  const events = await readSessionEvents(recorder.filePath);
  const persisted = events.find((event) => event.type === "tool_result" && event.toolCallId === "edit-rollback");
  assert.ok(persisted?.type === "tool_result");
  assert.equal(persisted.executionStatus, expected);
  assert.equal(events.filter((event) => event.type === "tool_execution" && event.change).length, 0);
  if (expected === "failed") {
    assert.doesNotThrow(() => coordinator.assertCanContinue());
    return;
  }
  assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
  const replay = replaySessionEvents(events, { sessionId: recorder.sessionId });
  const replayed = replay.messages.find((message) => message.role === "toolResult" && message.toolCallId === "edit-rollback");
  assert.ok(replayed?.role === "toolResult");
  assert.deepEqual(replayed.details, persisted.result);
  const replayedEvent = replay.events.find((event) => event.type === "tool_result" && event.toolCallId === "edit-rollback");
  assert.ok(replayedEvent?.type === "tool_result");
  assert.equal(replayedEvent.executionStatus, "unknown");
  assert.equal(replay.recoveredToolResults.length, 0);
  const attempted = await coordinator.createAgentTools().find((entry) => entry.name === "Write")!.execute("after-uncertain-edit", { path: "later.txt", content: "not authorized after uncertainty" });
  assert.equal(attempted.isError, true);
  assert.match(JSON.stringify(attempted.details), /unknown side effect/u);
  const later = await readSessionEvents(recorder.filePath);
  assert.equal(later.some((event) => event.type === "tool_execution" && event.toolCallId === "after-uncertain-edit" && event.state === "admitted"), false);
  assert.equal(events.filter((event) => event.type === "tool_execution" && event.toolCallId === "edit-rollback" && event.state === "admitted").length, 1);
}

test("move retains its destination and reports uncertainty when the source is already absent during recovery", async (t) => {
  await fixture(async (root, recorder, coordinator) => {
    const source = path.join(root, "target.txt");
    const destination = path.join(root, "destination.txt");
    await fs.writeFile(source, "original\n");
    const originalUnlink = fs.unlink;
    let removed = false;
    t.mock.method(fs, "unlink", async (value: Parameters<typeof fs.unlink>[0]) => {
      await originalUnlink(value);
      if (String(value) === source) {
        removed = true;
        throw failure("source unlink outcome was ambiguous");
      }
    });
    const result = await coordinator.createAgentTools().find((entry) => entry.name === "Edit")!.execute("edit-rollback", { operation: "move", path: "target.txt", to: "destination.txt" });
    await coordinator.waitForIdle();
    await recorder.flush();
    assert.equal(removed, true);
    assert.equal(result.isError, true);
    await assert.rejects(fs.readFile(source), { code: "ENOENT" });
    assert.equal(await fs.readFile(destination, "utf8"), "original\n");
    assert.deepEqual(await fs.readdir(root), ["destination.txt"]);
    await assertOutcome(recorder, coordinator, "unknown");
  });
});

test("delete preserves both the quarantined original and a concurrently created source pathname", async (t) => {
  await fixture(async (root, recorder, coordinator) => {
    const source = path.join(root, "target.txt");
    await fs.writeFile(source, "original\n");
    const originalUnlink = fs.unlink;
    t.mock.method(fs, "unlink", async (value: Parameters<typeof fs.unlink>[0]) => {
      if (path.basename(String(value)).startsWith(".biny-delete-")) {
        await fs.writeFile(source, "new external file\n");
        throw failure("quarantine unlink failed");
      }
      return originalUnlink(value);
    });
    await coordinator.createAgentTools().find((entry) => entry.name === "Edit")!.execute("edit-rollback", { operation: "delete", path: "target.txt" });
    await coordinator.waitForIdle();
    await recorder.flush();
    const files = await fs.readdir(root);
    assert.equal(files.length, 2);
    assert.equal(await fs.readFile(source, "utf8"), "new external file\n");
    assert.equal(await fs.readFile(path.join(root, files.find((name) => name.startsWith(".biny-delete-"))!), "utf8"), "original\n");
    await assertOutcome(recorder, coordinator, "unknown");
  });
});

for (const operation of ["delete", "move"] as const) {
  test(`${operation} preserves the primary cause and already-classified committed callback errors`, async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-edit-cause-")));
    try {
      const source = path.join(root, "source.txt");
      const destination = path.join(root, "destination.txt");
      await fs.writeFile(source, "original\n");
      const snapshot = await snapshotRegularFile(source);
      const originalUnlink = fs.unlink;
      const originalRename = fs.rename;
      const primary = failure("primary operation failure");
      const unlinkHook = t.mock.method(fs, "unlink", async (value: Parameters<typeof fs.unlink>[0]) => {
        if (String(value) === source || path.basename(String(value)).startsWith(".biny-delete-")) throw primary;
        if (String(value) === destination) throw failure("secondary recovery failure");
        return originalUnlink(value);
      });
      const renameHook = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === source) throw failure("secondary restore failure");
        return originalRename(...args);
      });
      const run = () => operation === "delete" ? deleteBoundRegularFile(source, snapshot) : moveBoundRegularFile(source, destination, snapshot);
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof FileChangeUncertainError);
        assert.equal(error.cause, primary);
        return true;
      });
      unlinkHook.mock.restore();
      renameHook.mock.restore();
      const callbackSource = path.join(root, "callback.txt");
      await fs.writeFile(callbackSource, "callback original\n");
      const callbackSnapshot = await snapshotRegularFile(callbackSource);
      const callbackFailure = new Error("callback failed");
      const callback = (): never => { throw callbackFailure; };
      const callbackRun = () => operation === "delete"
        ? deleteBoundRegularFile(callbackSource, callbackSnapshot, undefined, callback)
        : moveBoundRegularFile(callbackSource, path.join(root, "callback-moved.txt"), callbackSnapshot, undefined, callback);
      await assert.rejects(callbackRun(), (error: unknown) => {
        assert.ok(error instanceof FileChangeUncertainError);
        assert.equal(error.cause, callbackFailure);
        assert.match(error.message, /evidence callback failed/u);
        return true;
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
