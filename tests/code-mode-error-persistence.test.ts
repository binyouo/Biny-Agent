import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readSessionEvents } from "../src/session/events.js";
import { maxSessionEventLineBytes } from "../src/session/limits.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readToolResultArchive, toolResultPreview } from "../src/session/toolResultArchive.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { redactSecrets } from "../src/utils/secrets.js";

// Fresh coverage for the additional outer-evidence callsite found during review.
// Real QuickJS, coordinator, capability ledger, archive and recorder are used;
// only external discovery is injected to fail deterministically before dispatch.
for (const bytes of [128 * 1024, 17 * 1024 * 1024]) {
  await test(`Code Mode persists a ${String(bytes)}-byte discovery error without losing its outcome`, { timeout: 20_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-error-persistence-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    await ensureAgentDirs(root);
    const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const capabilities = await CapabilityStore.open(root, authority);
    const recorder = new SessionRecorder(root, "code-mode-error-persistence", undefined, authority.asSink());
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const secret = "fixture-secret-in-diagnostic";
    const message = `BEGIN discovery failure password=${secret}; ${"x".repeat(bytes)} END recover configuration`;
    const expectedError = redactSecrets(message);
    const expectedEvidence = toolResultPreview(expectedError);
    let discoveries = 0;
    const emitted: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, capabilities, toolRegistry: new ToolRegistry(),
      prepareToolDiscovery: async () => { discoveries += 1; throw new Error(message); }
    }, new PermissionManager(config.permission), (event) => emitted.push(event));
    try {
      const result = await coordinator.createCodeModeTool().execute("outer", { code: "return await tools.mcp_missing_tool({});" });
      assert.equal(result.isError, true);
      assert.equal(discoveries, 1);
      await coordinator.waitForIdle();
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const terminal = events.find((event) => event.type === "tool_execution" && event.toolCallId === "outer" && event.state === "failed");
      assert.ok(terminal?.type === "tool_execution");
      assert.ok(terminal.evidence && terminal.evidence.length < 8_300, "outer evidence must be a bounded excerpt");
      assert.equal(terminal.evidence, expectedEvidence);
      assert.equal(terminal.retrySafety, "unsafe");
      const saved = events.filter((event) => event.type === "tool_result" && event.toolCallId === "outer");
      assert.equal(saved.length, 1);
      const savedResult = saved[0]!;
      assert.ok(savedResult.type === "tool_result");
      assert.equal(savedResult.executionStatus, "failed");
      assert.equal(savedResult.outcomeUnknownReason, undefined);
      const envelope = savedResult.result as { archived: boolean; archivePath: string; resultBytes: number };
      assert.equal(envelope.archived, true);
      const archive = await readToolResultArchive(root, envelope.archivePath);
      const full = JSON.parse(archive.output) as { ok: boolean; error: string; executionStatus: string; operationId: string; childCalls: unknown[] };
      assert.equal(full.ok, false);
      assert.equal(full.error, expectedError, "full redacted host error is archived, not replaced by the evidence preview");
      assert.equal(full.executionStatus, "failed");
      assert.equal(full.operationId, savedResult.operationId);
      assert.deepEqual(full.childCalls, [], "discovery failure must never claim a child dispatch");
      assert.equal(envelope.resultBytes, Buffer.byteLength(archive.output));
      assert.equal(events.filter((event) => event.type === "tool_call").length, 1, "only the parent cell is called");
      const errorEvent = events.find((event) => event.type === "error");
      assert.ok(errorEvent?.type === "error");
      assert.equal(errorEvent.message, expectedEvidence);
      for (const event of emitted) {
        if (event.type === "error") assert.equal(event.message, expectedEvidence);
        if (event.type === "tool.failed") assert.equal(event.error, expectedEvidence);
      }
      const raw = await readFile(recorder.filePath, "utf8");
      assert.ok(!raw.includes(secret));
      assert.ok(!archive.output.includes(secret));
      for (const line of raw.trimEnd().split("\n")) assert.ok(Buffer.byteLength(line) <= maxSessionEventLineBytes);
      const replay = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.filter((entry) => entry.role === "toolResult");
      assert.equal(replay.length, 1);
      assert.deepEqual(replay[0]!.details, savedResult.result);
      assert.doesNotThrow(() => coordinator.assertCanContinue(), "failed discovery never dispatched a side effect");
      const next = await coordinator.createCodeModeTool().execute("fresh", { code: "return 7;" });
      assert.equal(next.isError, false);
      assert.equal(discoveries, 1, "a fresh cell must not replay failed discovery");
      t.diagnostic(JSON.stringify({ errorBytes: Buffer.byteLength(message), evidenceBytes: Buffer.byteLength(terminal.evidence),
        sessionBytes: Buffer.byteLength(raw), archivedResultBytes: Buffer.byteLength(archive.output), discoveries, childCalls: full.childCalls.length }));
    } finally {
      await coordinator.waitForIdle();
      await recorder.close();
      capabilities.close();
      authority.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
