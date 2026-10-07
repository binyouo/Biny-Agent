/** Missing edit targets must retain their filesystem error instead of a misleading text-match error. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const mode of ["replace", "hashline"] as const) {
  test(`${mode} Edit preserves ENOENT for a vanished file in returned and persisted failures`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-edit-missing-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent-state");
    const workspaceRoot = path.join(root, "workspace");
    let recorder: SessionRecorder | undefined;
    try {
      await mkdir(workspaceRoot);
      await ensureAgentDirs(workspaceRoot);
      const target = path.join(workspaceRoot, "vanished.txt");
      await writeFile(target, "before\n");
      await rm(target);
      await assert.rejects(readFile(target), { code: "ENOENT" });
      const config = structuredClone(defaultConfig);
      const registry = new ToolRegistry();
      registry.register(createEditFileTool({ workspaceRoot, ignore: [] }));
      registry.register(createWriteFileTool({ workspaceRoot, ignore: [] }));
      recorder = new SessionRecorder(workspaceRoot, `missing-${mode}`);
      const events: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
      let approvals = 0;
      const coordinator = new ToolExecutionCoordinator({
        workspaceRoot, config, recorder, toolRegistry: registry,
        confirmPermission: async () => { approvals += 1; return { approved: false }; }
      }, new PermissionManager(config.permission), (event) => events.push(event));
      await recorder.recordAndFlush({ type: "user_message", content: "update vanished.txt" });
      const edit = coordinator.createAgentTools({ mode }).find((tool) => tool.name === "Edit")!;
      const result = await edit.execute("missing-edit", mode === "replace"
        ? { path: "vanished.txt", old_string: "before", new_string: "after" }
        : { operation: "update", path: "vanished.txt", edits: [{ op: "replace", pos: "1#00000000", lines: ["after"] }] });
      await coordinator.waitForIdle();
      await recorder.flush();
      const persisted = await readSessionEvents(recorder.filePath);
      const toolResult = persisted.find((event) => event.type === "tool_result" && event.toolCallId === "missing-edit");
      assert.equal(result.isError, true);
      assert.ok(toolResult?.type === "tool_result");
      assert.equal(toolResult.executionStatus, "failed");
      const error = (result.details as { error: string }).error;
      assert.match(error, /ENOENT:.*vanished\.txt/u, "a missing file is not an absent text or stale-anchor match");
      assert.equal((toolResult.result as { error: string }).error, error);
      assert.equal(persisted.some((event) => event.type === "error" && event.message === error), true);
      assert.equal(persisted.some((event) => event.type === "tool_execution" && (event.change || event.state === "side_effect_committed" || event.state === "succeeded")), false);
      assert.equal(events.some((event) => event.type === "tool.failed" && event.error === error), true);
      assert.equal(events.some((event) => event.type === "tool.completed" || event.type === "tool.change_committed"), false);
      assert.equal(approvals, 0, "a missing edit target cannot produce an actionable permission preview");
      assert.deepEqual(await readdir(workspaceRoot), []);
    } finally {
      await recorder?.close();
      await rm(root, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
    }
  });
}

// Existing file mismatches remain edit errors; only create-capable operations accept a missing target.
test("permission previews distinguish existing text mismatches from valid file creation", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-edit-preview-controls-"));
  try {
    for (const content of ["", "unrelated text\n"]) {
      await writeFile(path.join(workspaceRoot, "existing.txt"), content);
      await assert.rejects(createToolPermissionRequest({ id: "mismatch", name: "Edit", args: {
        path: "existing.txt", old_string: "before", new_string: "after"
      } }, { workspaceRoot, ignore: [] }), /old_string was not found/u);
      assert.equal(await readFile(path.join(workspaceRoot, "existing.txt"), "utf8"), content);
    }
    const write = await createToolPermissionRequest({ id: "create-write", name: "Write", args: {
      path: "new/write.txt", content: "new content\n"
    } }, { workspaceRoot, ignore: [] });
    assert.equal(write.changeSummary, "Create new/write.txt");
    assert.match(write.preview ?? "", /new content/u);
    const patch = await createToolPermissionRequest({ id: "create-patch", name: "apply_patch", args: {
      callId: "create-patch", operation: { type: "create_file", path: "new/patch.txt", diff: "+new content\n" }
    } }, { workspaceRoot, ignore: [] });
    assert.match(patch.diff ?? "", /\+new content/u);
    assert.deepEqual(await readdir(workspaceRoot), ["existing.txt"], "preview generation never creates missing files or parents");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
