import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolAccesses } from "../src/tools/access.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("recursive access includes real child names beginning with two dots", () => {
  const root = path.resolve("/workspace");
  for (const child of ["src/file", "..cache/file", "...notes"]) {
    assert.equal(ToolAccesses.conflict(ToolAccesses.writeTree(root), ToolAccesses.readFile(path.join(root, child))), true, child);
    assert.equal(ToolAccesses.conflict(ToolAccesses.writeFile(path.join(root, child)), ToolAccesses.readTree(root)), true, child);
  }
  assert.equal(ToolAccesses.conflict(ToolAccesses.writeTree(root), ToolAccesses.writeFile(path.resolve(root, "../sibling/file"))), false);
});

test("parallel file writes share the pre-write checkpoint barrier", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-checkpoint-barrier-"));
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.agent.maxConcurrentTools = 2;
  const registry = new ToolRegistry();
  registry.register(createWriteFileTool({ workspaceRoot: root, ignore: [] }));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "checkpoint-barrier");
  let earlyCompletion!: () => void;
  const completedBeforeCheckpoint = new Promise<void>((resolve) => { earlyCompletion = resolve; });
  const baseline: string[][] = [];
  const coordinator = new ToolExecutionCoordinator({
    workspaceRoot: root, config, recorder, toolRegistry: registry,
    createCheckpoint: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 验证真实文件调度：给旁路写入最多 1 秒的机会；断言快照内容而非等待时长。
        await Promise.race([completedBeforeCheckpoint, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
        baseline.push(await Promise.all(["a.txt", "b.txt"].map((file) => readFile(path.join(root, file), "utf8"))));
      } finally {
        clearTimeout(timer);
      }
    }
  }, new PermissionManager(config.permission), (event) => {
    if (event.type === "tool.completed") earlyCompletion();
  }, () => ({}));
  try {
    await writeFile(path.join(root, "a.txt"), "before a");
    await writeFile(path.join(root, "b.txt"), "before b");
    const tool = coordinator.createAgentTools().find((entry) => entry.name === "Write")!;
    await Promise.all([
      tool.execute("write-a", { path: "a.txt", content: "after a" }),
      tool.execute("write-b", { path: "b.txt", content: "after b" })
    ]);
    await coordinator.waitForIdle();
    assert.deepEqual(baseline, [["before a", "before b"]]);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "after a");
    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "after b");
    await recorder.close();
    const results = (await readSessionEvents(recorder.filePath)).filter((event) => event.type === "tool_result");
    assert.equal(results.length, 2);
    assert.ok(results.every((event) => event.executionStatus === "succeeded"));
  } finally {
    await coordinator.waitForIdle();
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});
