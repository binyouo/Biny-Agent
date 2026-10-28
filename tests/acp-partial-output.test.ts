import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "../src/acp/client.js";
import { runAcpTurn } from "../src/acp/turn.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { acpConfigSchema, configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const content = (text: string) => [{ type: "content", content: { type: "text", text } }];
const start = (id = "read-1", fields: Record<string, unknown> = {}) => ({
  sessionUpdate: "tool_call", toolCallId: id, title: "Read fixture", kind: "read", status: "in_progress", ...fields
});
const update = (fields: Record<string, unknown>, id = "read-1") => ({ sessionUpdate: "tool_call_update", toolCallId: id, ...fields });
const complete = (fields: Record<string, unknown> = {}, id = "read-1") => update({ status: "completed", ...fields }, id);
const prompt = (updates: unknown[]) => `acp-partial-output-v1:${JSON.stringify(updates)}`;
const launch = () => acpConfigSchema.parse({ command: process.execPath, args: [path.resolve("tests/fixtures/acp-agent.mjs")] });

test("ACP partial output survives status-only completion in the durable public session", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-partial-session-"));
  await ensureAgentDirs(root);
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "external",
    providers: { external: { type: "acp", acp: launch() } }, models: { external: { provider: "external", model: "default" } },
    context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  const recorder = new SessionRecorder(root);
  const agent = new AgentSession({ workspaceRoot: root, config, recorder, permissionManager: new PermissionManager(),
    toolRegistry: new ToolRegistry(), model: new ModelRuntime(config).createModelSettings().model });
  try {
    await agent.initialize();
    const expected = content("fixture contents");
    const outcome = await agent.runTask(prompt([start(), update({ content: expected }), complete()]));
    assert.equal(outcome.status, "completed", outcome.error);
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    assert.deepEqual(events.filter((event) => event.type === "turn_status").map((event) => event.status), ["completed"]);
    const calls = events.filter((event) => event.type === "tool_call");
    const results = events.filter((event) => event.type === "tool_result");
    assert.equal(calls.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.toolCallId, calls[0]!.toolCallId);
    assert.match(results[0]!.toolCallId!, /:read-1$/u);
    assert.deepEqual(results[0]!.result, expected, "status-only completion must persist the earlier content snapshot");
    assert.notEqual(results[0]!.executionStatus, "unknown");
  } finally { await agent.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP output snapshots retain partial fields without changing terminal semantics", { timeout: 30000 }, async (t) => {
  const first = content("first");
  const latest = content("latest");
  const cases: Array<{ name: string; updates: unknown[]; result: unknown; failed?: boolean }> = [
    { name: "initial content", updates: [start("read-1", { content: first }), complete()], result: first },
    { name: "initial raw output", updates: [start("read-1", { rawOutput: "initial raw" }), complete()], result: "initial raw" },
    { name: "content snapshot replaces", updates: [start(), update({ content: first }), update({ content: latest }), complete()], result: latest },
    { name: "empty content replaces", updates: [start(), update({ content: first }), update({ content: [] }), complete()], result: [] },
    { name: "null content retains", updates: [start(), update({ content: first }), update({ content: null }), complete()], result: first },
    { name: "raw output replaces opaque object", updates: [start("read-1", { rawOutput: { old: true } }), update({ rawOutput: { latest: true } }), complete()], result: { latest: true } },
    { name: "null raw output retains", updates: [start(), update({ rawOutput: "saved" }), update({ rawOutput: null }), complete()], result: "saved" },
    ...[false, 0, ""].map((value) => ({ name: `falsy raw output ${JSON.stringify(value)}`, updates: [start(), update({ rawOutput: value }), complete()], result: value })),
    { name: "retained raw output precedes terminal content", updates: [start(), update({ rawOutput: "raw" }), complete({ content: latest })], result: "raw" },
    { name: "terminal content replaces", updates: [start(), update({ content: first }), complete({ content: latest })], result: latest },
    { name: "terminal raw output replaces and wins", updates: [start(), update({ rawOutput: "old", content: first }), complete({ rawOutput: "terminal", content: latest })], result: "terminal" },
    { name: "failed retains content", updates: [start(), update({ content: first }), update({ status: "failed" })], result: first, failed: true },
    { name: "duplicate terminal emits once", updates: [start(), update({ content: first }), complete(), complete({ content: latest })], result: first },
    { name: "initial terminal", updates: [start("read-1", { status: "completed", rawOutput: "initial", content: first })], result: "initial" },
    { name: "payload-free completion", updates: [start(), complete()], result: "completed" },
    { name: "payload-free failure", updates: [start(), update({ status: "failed" })], result: "failed", failed: true }
  ];
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-acp-partial-turn-"));
  const client = new AcpClient({ cwd: root, launch: launch() });
  const collect = async (updates: unknown[]) => {
    const events: AgentSessionEvent[] = [];
    for await (const event of runAcpTurn(client, { content: [{ type: "text", text: prompt(updates) }], model: "default", workspaceRoot: root, sessionId: "partial-output" })) events.push(event);
    return events;
  };
  const seenIds = new Set<string>();
  const terminals = (events: AgentSessionEvent[]) => events.filter((event) => event.type === "tool.completed" || event.type === "tool.failed");
  try {
    for (const item of cases) await t.test(item.name, async () => {
      const events = await collect(item.updates);
      assert.equal(events.filter((event) => event.type === "tool.started").length, 1);
      const results = terminals(events);
      assert.equal(results.length, 1);
      assert.equal(seenIds.has(results[0]!.toolCallId), false, "agent-local IDs must not collide across turns");
      seenIds.add(results[0]!.toolCallId);
      assert.equal(results[0]!.type, item.failed ? "tool.failed" : "tool.completed");
      assert.deepEqual(results[0]!.result, item.result);
      assert.equal(events.find((event) => event.type === "done")?.outcome.status, "completed");
    });
    await t.test("interleaved IDs keep independent snapshots", async () => {
      const events = await collect([start("a"), start("b"), update({ content: first }, "a"), update({ rawOutput: "second" }, "b"), complete({}, "b"), complete({}, "a")]);
      const results = terminals(events);
      assert.equal(events.filter((event) => event.type === "tool.started").length, 2);
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((event) => [event.toolCallId.split(":").at(-1), event.result]), [["b", "second"], ["a", first]]);
      assert.notEqual(results[0]!.toolCallId, results[1]!.toolCallId);
    });
    await t.test("nonterminal output remains unknown without terminal confirmation", async () => {
      const events = await collect([start(), update({ content: first, rawOutput: "unconfirmed" })]);
      const results = terminals(events);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.type, "tool.failed");
      assert.equal(results[0]!.executionStatus, "unknown");
      assert.equal(results[0]!.result, undefined);
      const done = events.find((event) => event.type === "done");
      assert.equal(done?.outcome.status, "incomplete");
      assert.equal(done?.outcome.stopReason, "missing_terminal_event");
    });
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
