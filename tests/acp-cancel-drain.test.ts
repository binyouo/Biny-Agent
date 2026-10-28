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
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const fixtureArgs = [path.resolve("tests/fixtures/acp-agent.mjs")];
const finalText = "Stopped after reading the fixture.";
const launch = () => acpConfigSchema.parse({ command: process.execPath, args: fixtureArgs });

// Primary regression: cancellation is correct already; durable evidence must not become unknown.
test("ACP cancelled session durably retains the drained read result and final text", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-drain-session-"));
  await ensureAgentDirs(root);
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
    providers: { external: { type: "acp", acp: launch() } },
    models: { external: { provider: "external", model: "default" } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, permissionManager: new PermissionManager(),
    toolRegistry: new ToolRegistry(), model: new ModelRuntime(config).createModelSettings().model });
  try {
    await agent.initialize();
    const controller = new AbortController();
    const emitted: AgentSessionEvent[] = [];
    let permissions = 0;
    for await (const event of agent.prompt("cancel-drain-fixture:completed", { abortSignal: controller.signal,
      confirmPermission: async () => { permissions++; return { approved: true }; } })) {
      emitted.push(event);
      if (event.type === "tool.started") controller.abort();
    }
    assert.equal(emitted.find((event) => event.type === "done")?.outcome.status, "cancelled");
    assert.equal(permissions, 0);
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    assert.deepEqual(events.filter((event) => event.type === "turn_status").map((event) => event.status), ["cancelled"]);
    const results = events.filter((event) => event.type === "tool_result");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.result, "fixture contents", "cancelled history must retain the received terminal read result");
    assert.notEqual(results[0]!.executionStatus, "unknown");
    const calls = events.filter((event) => event.type === "tool_call");
    assert.equal(calls.length, 1);
    assert.equal(results[0]!.toolCallId, calls[0]!.toolCallId);
    assert.deepEqual(events.filter((event) => event.type === "assistant_message").map((event) => event.content), [finalText]);
    const canonical = events.find((event) => event.type === "agent_message");
    assert.ok(canonical && canonical.message.role === "assistant");
    assert.deepEqual(canonical.message.content, [{ type: "text", text: finalText }]);
    await assert.rejects(readFile(path.join(root, "fixture.txt")), { code: "ENOENT" }, "fixture reports evidence without running a read tool");
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
});

for (const terminal of ["completed", "failed", "missing"] as const) {
  test(`ACP cancelled turn drains ${terminal} evidence without granting permission`, { timeout: 10000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-drain-turn-"));
    const client = new AcpClient({ cwd: root, launch: launch() });
    const controller = new AbortController();
    const events: AgentSessionEvent[] = [];
    let permissions = 0;
    try {
      for await (const event of runAcpTurn(client, { content: [{ type: "text", text: `cancel-drain-fixture:${terminal}` }],
        model: "default", workspaceRoot: root, sessionId: "test", signal: controller.signal,
        confirmPermission: async () => { permissions++; return { approved: true }; } })) {
        events.push(event);
        if (event.type === "tool.started") controller.abort();
      }
      const done = events.find((event) => event.type === "done");
      assert.equal(done?.outcome.status, "cancelled");
      assert.equal(done?.outcome.stopReason, "cancelled");
      assert.equal(permissions, 0);
      const results = events.filter((event) => event.type === "tool.completed" || event.type === "tool.failed");
      assert.equal(results.length, 1);
      const result = results[0]!;
      if (terminal === "missing") {
        assert.equal(result.type, "tool.failed");
        assert.equal(result.executionStatus, "unknown", "missing terminal evidence must still remain unknown");
      } else {
        assert.equal(result.type, terminal === "completed" ? "tool.completed" : "tool.failed");
        assert.deepEqual(result.result, terminal === "completed" ? "fixture contents" : { error: "fixture read failed" });
        assert.notEqual(result.executionStatus, "unknown");
      }
      assert.equal(done?.content, finalText);
      assert.equal(events.filter((event) => event.type === "tool.started").length, 1);
      // Cancellation closes the old process; the next turn must contain only its own reply.
      const next: AgentSessionEvent[] = [];
      for await (const event of runAcpTurn(client, { content: [{ type: "text", text: "hello" }],
        model: "default", workspaceRoot: root, sessionId: "test" })) next.push(event);
      assert.equal(next.find((event) => event.type === "done")?.content, "Reply 1");
      assert.equal(next.filter((event) => event.type === "tool.started").length, 0);
    } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("ACP client drains current-session notifications after abort and detaches the old callback", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-drain-client-"));
  const client = new AcpClient({ cwd: root, launch: launch() });
  const controller = new AbortController();
  const updates: SessionNotification[] = [];
  let permissions = 0;
  try {
    assert.equal(await client.prompt({ content: [{ type: "text", text: "cancel-drain-fixture:completed" }], model: "default", signal: controller.signal,
      onUpdate(notification) {
        updates.push(notification);
        if (notification.update.sessionUpdate === "tool_call") controller.abort();
      }, onPermission: async () => { permissions++; return { outcome: { outcome: "selected", optionId: "yes" } }; } }), "cancelled");
    assert.equal(permissions, 0);
    assert.deepEqual(updates.map(({ update }) => update.sessionUpdate), ["tool_call", "tool_call_update", "agent_message_chunk"]);
    assert.ok(updates.every((notification) => notification.sessionId === "fixture-session"));
    const terminal = updates[1]!.update;
    assert.ok(terminal.sessionUpdate === "tool_call_update");
    assert.equal(terminal.rawOutput, "fixture contents");
    const before = updates.length;
    const next: SessionNotification[] = [];
    assert.equal(await client.prompt({ content: [{ type: "text", text: "hello" }], model: "default",
      onUpdate: (notification) => next.push(notification),
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), "end_turn");
    assert.equal(updates.length, before, "settled callback must not receive another turn's updates");
    assert.equal(next.length, 1);
    assert.deepEqual(next[0]!.update, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reply 2" } });
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
