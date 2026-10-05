import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { archiveToolResult, readToolResultArchive, resolveToolResultArchivePath } from "../src/session/toolResultArchive.js";
import { createReadToolResultTool, type ReadToolResultArgs } from "../src/tools/file/readToolResult.js";
import { ToolRegistry } from "../src/tools/registry.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-archive-cancellation-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const content = "A😀中\r\nB𐐷".repeat(200);
const archived = await archiveToolResult({ workspaceRoot: root, sessionId: "cancellation", toolCallId: "original",
  sequence: 1, tool: "fixture_result", result: content });
const target = resolveToolResultArchivePath(root, archived.archivePath);
const reader = createReadToolResultTool({ workspaceRoot: root, ignore: [] });
async function readPage(args: ReadToolResultArgs, signal?: AbortSignal) {
  const execution = await reader.resolveExecution(args);
  assert.ok("execute" in execution);
  return await execution.execute({ signal, toolCallId: "page", operationId: "page-read" });
}

/** Real files and file handles; only abort timing is controlled at I/O boundaries. */
function abortDuring(t: TestContext, controller: AbortController, stage: "read-start" | "read-pending" | "read-end" | "close") {
  const originalOpen = fs.open;
  const state = { opened: 0, closed: 0, readResolved: false };
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] !== target) return handle;
    state.opened++;
    const originalRead = handle.readFile.bind(handle);
    const originalClose = handle.close.bind(handle);
    t.mock.method(handle, "readFile", async (options?: Parameters<FileHandle["readFile"]>[0]) => {
      if (stage === "read-start") controller.abort(new Error("cancel at read start"));
      const pending = originalRead(options);
      if (stage === "read-pending") controller.abort(new Error("cancel pending read"));
      const data = await pending;
      state.readResolved = true;
      if (stage === "read-end") controller.abort(new Error("cancel at read end"));
      return data;
    });
    t.mock.method(handle, "close", async () => {
      await originalClose();
      state.closed++;
      if (stage === "close") controller.abort(new Error("cancel during close"));
    });
    return handle;
  });
  return state;
}

try {
  await test("a pre-cancelled public archive read opens no file", async (t) => {
    const controller = new AbortController();
    controller.abort(new Error("cancel before read"));
    const state = abortDuring(t, controller, "read-start");
    await assert.rejects(readPage({ archivePath: archived.archivePath }, controller.signal), /cancel before read/u);
    assert.equal(state.opened, 0);
  });

  for (const stage of ["read-start", "read-pending", "read-end", "close"] as const) {
    await test(`public archive read rejects cancellation at ${stage} and closes its handle`, async (t) => {
      const controller = new AbortController();
      const state = abortDuring(t, controller, stage);
      await assert.rejects(readPage({ archivePath: archived.archivePath, length: 10 }, controller.signal),
        (error: unknown) => error === controller.signal.reason || (error instanceof Error && error.name === "AbortError" && error.cause === controller.signal.reason));
      assert.equal(state.opened, 1);
      assert.equal(state.closed, 1, "cancellation must close the real archive handle");
      if (stage === "read-start" || stage === "read-pending") assert.equal(state.readResolved, false, "pass AbortSignal to the underlying file read");
    });
  }

  await test("coordinator records an interrupted archive read as cancelled without returning its page", async (t) => {
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    registry.register(reader);
    const events: AgentSessionEvent[] = [];
    const recorder = new SessionRecorder(root, "cancelled-reader");
    try {
      const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
        new PermissionManager(config.permission), (event) => events.push(event));
      const tool = coordinator.createAgentTools().find((entry) => entry.name === "read_tool_result");
      assert.ok(tool);
      const controller = new AbortController();
      const state = abortDuring(t, controller, "read-end");
      const result = await tool.execute("interrupted-page", { archivePath: archived.archivePath, length: 10 }, controller.signal);
      const details = result.details as Record<string, unknown>;
      assert.equal(details.status, "cancelled");
      assert.equal(details.content, undefined);
      const completed = events.find((event) => event.type === "tool.completed" && event.toolCallId === "interrupted-page");
      assert.equal(completed?.type === "tool.completed" ? completed.executionStatus : undefined, "cancelled");
      assert.equal(state.closed, 1);
      const persisted = (await fs.readFile(recorder.filePath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; toolCallId?: string; executionStatus?: string })
        .find((event) => event.type === "tool_result" && event.toolCallId === "interrupted-page");
      assert.equal(persisted?.executionStatus, "cancelled");
    } finally {
      await recorder.close();
    }
  });

  await test("successful archive reads preserve exact content and original lineage", async () => {
    const envelope = await readToolResultArchive(root, archived.archivePath);
    assert.equal(envelope.sessionId, "cancellation");
    assert.equal(envelope.toolCallId, "original");
    assert.equal(envelope.sequence, 1);
    assert.equal(envelope.tool, "fixture_result");
    assert.equal(envelope.output, content);
    let offset = 0;
    let restored = "";
    do {
      const page = await readPage({ archivePath: archived.archivePath, offset, length: 7 }, new AbortController().signal);
      assert.equal(page.archivePath, archived.archivePath);
      assert.equal(page.tool, envelope.tool);
      assert.equal(page.archivedAt, envelope.archivedAt);
      assert.equal(page.totalCharacters, content.length);
      assert.equal(page.offset, offset);
      assert.equal(page.nextOffset, offset + page.content.length);
      restored += page.content;
      offset = page.nextOffset;
      if (!page.hasMore) break;
      assert.ok(offset < content.length);
    } while (offset < content.length);
    assert.equal(restored, content);
  });
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await fs.rm(root, { recursive: true, force: true });
}
