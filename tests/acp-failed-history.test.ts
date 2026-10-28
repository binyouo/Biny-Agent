import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/acp/client.js";
import { runAcpTurn } from "../src/acp/turn.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { acpConfigSchema, configSchema, defaultConfig } from "../src/config/schema.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const launch = () => acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] });
const terminals = (events: AgentSessionEvent[]) => events.filter((event) => event.type === "tool.completed" || event.type === "tool.failed");

test("ACP permission tool results keep their live classification after reading durable history", { timeout: 30000 }, async (t) => {
  for (const approved of [false, true]) await t.test(approved ? "completed string control" : "failed string survives reload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-failed-history-"));
    await ensureAgentDirs(root);
    const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
      providers: { external: { type: "acp", acp: launch() } }, models: { external: { provider: "external", model: "default" } },
      permission: { ...defaultConfig.permission, mode: "ask" },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
    });
    const recorder = new SessionRecorder(root);
    const agent = new AgentSession({ workspaceRoot: root, config, recorder, permissionManager: new PermissionManager({ mode: "ask" }),
      toolRegistry: new ToolRegistry(), model: new ModelRuntime(config).createModelSettings().model });
    try {
      await agent.initialize();
      let confirmations = 0;
      const emitted: AgentSessionEvent[] = [];
      for await (const event of agent.prompt("permission-fixture", { confirmPermission: async () => {
        confirmations++; return { approved };
      } })) emitted.push(event);
      const expected = approved ? "written" : "denied";
      assert.equal(confirmations, 1);
      const done = emitted.find((event) => event.type === "done");
      assert.ok(done);
      assert.equal(done.outcome.status, approved ? "completed" : "blocked");
      assert.equal(done.content, expected);
      if (approved) assert.equal(await readFile(path.join(root, "effect.txt"), "utf8"), "one external write");
      else await assert.rejects(readFile(path.join(root, "effect.txt")), { code: "ENOENT" });
      const starts = emitted.filter((event) => event.type === "tool.started");
      const results = terminals(emitted);
      assert.equal(starts.length, 1);
      assert.equal(results.length, 1);
      const terminal = results[0]!;
      assert.equal(terminal.toolCallId, starts[0]!.toolCallId);
      assert.equal(terminal.type, approved ? "tool.completed" : "tool.failed");
      assert.equal(terminal.result, expected);
      // Only add the host envelope; the tool events are the actual public session output.
      const envelope = { sessionId: recorder.sessionId, runId: "fixture-run", timestamp: "2026-10-13T00:00:00.000Z" };
      const live: AgentHostEvent[] = [
        { ...envelope, type: "run.started", messageId: "fixture-user", input: "permission-fixture",
          model: { alias: "external", provider: "external", label: "Fixture", reasoning: "" }, skills: [] },
        ...[...starts, ...results].map((event) => ({ ...envelope, ...event }))
      ];
      const liveTools = buildSessionTimeline([], live).flatMap((turn) => turn.tools);
      assert.equal(liveTools.length, 1);
      assert.equal(liveTools[0]!.status, approved ? "success" : "failed");
      assert.equal(liveTools[0]!.result, expected);
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const calls = events.filter((event) => event.type === "tool_call");
      const saved = events.filter((event) => event.type === "tool_result");
      assert.equal(calls.length, 1);
      assert.equal(saved.length, 1);
      assert.equal(calls[0]!.toolCallId, terminal.toolCallId);
      assert.equal(saved[0]!.toolCallId, terminal.toolCallId);
      assert.equal(saved[0]!.result, expected);
      assert.deepEqual(events.filter((event) => event.type === "turn_status").map((event) => event.status), [done.outcome.status]);
      const restored = buildSessionTimeline(events, []).flatMap((turn) => turn.tools);
      assert.equal(restored.length, 1);
      assert.equal(restored[0]!.id, terminal.toolCallId);
      assert.equal(restored[0]!.result, expected);
      // Main reaches this assertion with undefined/success despite the verified live failure above.
      assert.deepEqual({ durable: saved[0]!.executionStatus, history: restored[0]!.status },
        { durable: approved ? undefined : "failed", history: approved ? "success" : "failed" });
    } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
  });
});

type Update = SessionNotification["update"];
const start: Update = { sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read fixture", kind: "read", status: "in_progress" };
const terminalUpdate = (status: "failed" | "completed", fields: Partial<Extract<Update, { sessionUpdate: "tool_call_update" }>> = {}): Update =>
  ({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status, ...fields });

// Exercise the real producer with typed notifications without adding another subprocess fixture.
class NotificationClient extends AcpClient {
  private readonly updates: Update[];
  constructor(updates: Update[]) {
    super({ cwd: process.cwd(), launch: launch() });
    this.updates = updates;
  }
  override async prompt(input: Parameters<AcpClient["prompt"]>[0]): Promise<string> {
    for (const update of this.updates) input.onUpdate({ sessionId: "fixture-session", update });
    return "end_turn";
  }
  override async close(): Promise<void> {}
}

test("ACP terminal classification preserves payloads, completion, unknown outcomes and first-terminal deduplication", async (t) => {
  const content = [{ type: "content" as const, content: { type: "text" as const, text: "No such file" } }];
  const cases: Array<{ name: string; updates: Update[]; result: unknown; type: "tool.failed" | "tool.completed"; status?: "failed" | "unknown" }> = [
    { name: "failed string", updates: [terminalUpdate("failed", { rawOutput: "No such file" })], result: "No such file", type: "tool.failed", status: "failed" },
    { name: "failed content", updates: [terminalUpdate("failed", { content })], result: content, type: "tool.failed", status: "failed" },
    { name: "failed without payload", updates: [terminalUpdate("failed")], result: "failed", type: "tool.failed", status: "failed" },
    { name: "failed error object", updates: [terminalUpdate("failed", { rawOutput: { error: "No such file" } })], result: { error: "No such file" }, type: "tool.failed", status: "failed" },
    { name: "completed string", updates: [terminalUpdate("completed", { rawOutput: "read" })], result: "read", type: "tool.completed" },
    { name: "unfinished remains unknown", updates: [], result: undefined, type: "tool.failed", status: "unknown" },
    { name: "failed first terminal wins", updates: [terminalUpdate("failed", { rawOutput: "denied" }), terminalUpdate("completed", { rawOutput: "late" })], result: "denied", type: "tool.failed", status: "failed" },
    { name: "completed first terminal wins", updates: [terminalUpdate("completed", { rawOutput: "read" }), terminalUpdate("failed", { rawOutput: "late" })], result: "read", type: "tool.completed" }
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const client = new NotificationClient([start, ...item.updates]);
    const emitted: AgentSessionEvent[] = [];
    try {
      for await (const event of runAcpTurn(client, { content: [{ type: "text", text: "fixture" }], model: "default",
        workspaceRoot: process.cwd(), sessionId: "fixture-session" })) emitted.push(event);
      const starts = emitted.filter((event) => event.type === "tool.started");
      const results = terminals(emitted);
      assert.equal(starts.length, 1);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.toolCallId, starts[0]!.toolCallId);
      assert.equal(results[0]!.type, item.type);
      assert.deepEqual(results[0]!.result, item.result);
      const done = emitted.find((event) => event.type === "done");
      assert.ok(done);
      assert.equal(done.outcome.status, item.status === "unknown" ? "incomplete" : "completed");
      assert.equal(done.outcome.stopReason, item.status === "unknown" ? "missing_terminal_event" : "model_stop");
      assert.equal(results[0]!.executionStatus, item.status);
    } finally { await client.close(); }
  });
});
