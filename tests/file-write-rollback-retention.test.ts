/** Retain a detected external file version if rollback cannot safely restore it. */
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


for (const boundary of ["restore-error", "unsafe-target-binding", "restored", "ambiguous-restoration"] as const) {
  test(`detected external version survives ${boundary}`, async (t) => {
    await fixture(async (root, recorder, coordinator) => {
      const target = path.join(root, "target.txt");
      await fs.writeFile(target, "approved\n");
      const originalRename = fs.rename;
      const restoreFailure = ioError("restore rename EIO");
      let committed = false;
      let restoreAttempted = false;
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === target && path.basename(String(args[0])).startsWith(".biny-write-")) {
          await fs.writeFile(target, "external in-place version\n");
          await originalRename(...args);
          committed = true;
          if (boundary === "unsafe-target-binding") {
            const late = path.join(root, "late-save.tmp");
            await fs.writeFile(late, "late external replacement\n");
            await originalRename(late, target);
          }
          return;
        }
        if (String(args[1]) === target && path.basename(String(args[0])).startsWith(".biny-backup-")) {
          restoreAttempted = true;
          if (boundary === "restore-error") throw restoreFailure;
          if (boundary === "ambiguous-restoration") {
            await originalRename(...args);
            throw restoreFailure;
          }
        }
        return originalRename(...args);
      });
      const result = await write(coordinator);
      assert.equal(result.isError, true);
      assert.equal(committed, true);
      assert.equal(restoreAttempted, boundary !== "unsafe-target-binding");
      const files = await fs.readdir(root);
      const contents = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await fs.readFile(path.join(root, file), "utf8")])));
      assert.ok(Object.values(contents).includes("external in-place version\n"), "the detected external version must survive every failed restoration boundary");
      if (boundary === "restore-error" || boundary === "unsafe-target-binding") {
        const backups = files.filter((name) => name.startsWith(".biny-backup-"));
        assert.equal(backups.length, 1);
        assert.equal(contents[backups[0]!], "external in-place version\n");
        assert.equal(contents["target.txt"], boundary === "restore-error" ? "after\n" : "late external replacement\n");
        assert.equal(files.length, 2);
      } else {
        assert.deepEqual(files, ["target.txt"]);
        assert.equal(contents["target.txt"], "external in-place version\n");
      }
      if (boundary === "restore-error" || boundary === "ambiguous-restoration") assert.match(JSON.stringify(result.details), /restore rename EIO/u);
      await assertOutcome(recorder, coordinator, boundary === "restored" ? "failed" : "unknown");
      if (boundary !== "restored") {
        const retry = await write(coordinator, "retry", "must not overwrite retained data\n");
        assert.equal(retry.isError, true);
        assert.match(JSON.stringify(retry.details), /unknown side effect/u);
        const afterRetry = Object.fromEntries(await Promise.all((await fs.readdir(root)).map(async (file) => [file, await fs.readFile(path.join(root, file), "utf8")])));
        assert.deepEqual(afterRetry, contents);
      }
    });
  });
}

test("unchanged original write still removes its backup and records success", async () => {
  await fixture(async (root, recorder, coordinator) => {
    await fs.writeFile(path.join(root, "target.txt"), "before\n");
    const result = await write(coordinator);
    assert.equal(result.isError, false);
    assert.equal(await fs.readFile(path.join(root, "target.txt"), "utf8"), "after\n");
    assert.deepEqual(await fs.readdir(root), ["target.txt"]);
    await assertOutcome(recorder, coordinator, "succeeded");
  });
});

test("retained-backup uncertainty preserves the exact failed-restore cause", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-retained-cause-")));
  try {
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "approved\n");
    const originalRename = fs.rename;
    const cause = ioError("retain this exact restore failure");
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === target && path.basename(String(args[0])).startsWith(".biny-write-")) await fs.writeFile(target, "external\n");
      if (String(args[1]) === target && path.basename(String(args[0])).startsWith(".biny-backup-")) throw cause;
      return originalRename(...args);
    });
    await assert.rejects(atomicWriteUtf8File(target, "agent\n", undefined), (error: unknown) => {
      assert.ok(error instanceof FileChangeUncertainError);
      assert.equal(error.cause, cause);
      return true;
    });
    const files = await fs.readdir(root);
    assert.equal(files.length, 2);
    const backup = files.find((file) => file.startsWith(".biny-backup-"));
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(root, backup), "utf8"), "external\n");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("postcommit callback failure leaves no unnecessary unchanged-original backup", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-retained-callback-")));
  try {
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "before\n");
    const cause = new Error("committed callback EIO");
    await assert.rejects(atomicWriteUtf8File(target, "after\n", undefined, undefined, () => { throw cause; }), (error: unknown) => {
      assert.ok(error instanceof FileChangeUncertainError);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.deepEqual(await fs.readdir(root), ["target.txt"]);
    assert.equal(await fs.readFile(target, "utf8"), "after\n");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
