import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { CapabilityOutcomeResolver } from "../src/session/capabilityOutcomeResolver.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents, sessionEventsToConversation } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createToolOperationId } from "../src/tools/types.js";

// The fixture uses the existing legitimate ledger-result/missing-session-result
// state. No recorder failure, killed process, real MCP service or model is used.
for (const example of [
  { name: "text error", payload: { error: "Calendar not found", structuredContent: { code: "MISSING" } }, failed: true },
  { name: "boolean error", payload: { error: true, structuredContent: {} }, failed: true },
  { name: "empty error string", payload: { error: "" }, failed: true },
  { name: "empty error envelope", payload: { isError: true, content: [] }, failed: true },
  { name: "success", payload: { items: [1], nextPageToken: "ordinary-cursor" }, failed: false },
  { name: "successful envelope with error-like data", payload: { isError: false, content: [], structuredContent: { error: "child failed" } }, failed: false }
]) test(`flat capability recovery retains MCP ${example.name} exactly once`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-recovered-status-"));
  await ensureAgentDirs(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const capabilities = await CapabilityStore.open(root, authority);
  const sessionId = "recovery";
  const tool = "mcp_fixture_lookup";
  const toolCallId = "call";
  const operationId = createToolOperationId(sessionId, toolCallId);
  let recorder = new SessionRecorder(root, sessionId, undefined, authority.asSink());
  const file = recorder.filePath;
  let executions = 0;
  try {
    recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
    await recorder.recordAndFlush({ type: "tool_call", tool, toolCallId, sequence: 1, args: {} });
    await recorder.recordAndFlush({ type: "tool_execution", tool, toolCallId, sequence: 1, operationId, state: "admitted" });
    await capabilities.executeHostCapability({ capabilityName: `host:mcp:${tool}`, schema: { type: "object" },
      sessionId, turnId: "turn", toolCallId, offerId: operationId, request: {} }, async () => {
      executions += 1;
      return example.payload;
    });
    await recorder.close();
    const events = await readSessionEvents(file);
    assert.equal(events.some(event => event.type === "agent_message"), false, "the step has not become canonical");
    assert.equal(events.some(event => event.type === "tool_result"), false);
    const resolver = new CapabilityOutcomeResolver(() => capabilities);
    const replay = replaySessionEvents(events, { sessionId, resolveToolOutcome: resolver.resolve });
    assert.equal(replay.recoveredToolResults.length, 1);
    const recovered = replay.recoveredToolResults[0]!;
    assert.equal(recovered.executionStatus, example.failed ? "failed" : "succeeded");
    assert.deepEqual(recovered.result, example.payload);
    assert.match(recovered.evidence ?? "", /^capability:/u);
    assert.deepEqual(resolver.redactionOptionsFor(recovered.result), { context: "mcp-result" });
    const message = replay.messages.find(message => message.role === "toolResult");
    assert.ok(message?.role === "toolResult");
    assert.equal(message.isError, example.failed);
    assert.equal(message.details, recovered.result);
    const model = toModelMessages([message]);
    assert.ok(model[0]?.role === "tool");
    const output = model[0].content[0];
    assert.ok(output?.type === "tool-result");
    assert.equal(output.output.type, example.failed ? "error-text" : "text");

    recorder = new SessionRecorder(root, sessionId, file, authority.asSink());
    recorder.repairTailForAppend();
    await recorder.recordAndFlush(recovered, undefined, resolver.redactionOptionsFor(recovered.result));
    await recorder.close();
    let lookups = 0;
    const second = replaySessionEvents(await readSessionEvents(file), { sessionId, resolveToolOutcome: call => {
      lookups += 1;
      return resolver.resolve(call);
    } });
    assert.equal(lookups, 0, "the now-durable result does not query or replay its capability");
    assert.equal(second.recoveredToolResults.length, 0);
    assert.equal(second.events.filter(event => event.type === "tool_result").length, 1);
    const twice = second.messages.filter(message => message.role === "toolResult");
    assert.equal(twice.length, 1);
    assert.equal(twice[0]?.isError, example.failed);
    assert.deepEqual(twice[0]?.details, example.payload);
    assert.equal(executions, 1);
  } finally {
    await recorder.close();
    capabilities.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const status of ["succeeded", "failed", "cancelled", "unknown", undefined] as const) {
  test(`flat and canonical protocol flags honor durable status ${String(status)}`, () => {
    const payload = { status: "failed", error: "A child task outcome is data" };
    const call: Extract<SessionEvent, { type: "tool_call" }> = { type: "tool_call", tool: "TaskStatus", toolCallId: "status", args: {} };
    const result: Extract<SessionEvent, { type: "tool_result" }> = { type: "tool_result", tool: call.tool, toolCallId: call.toolCallId,
      result: payload, ...(status === undefined ? {} : { executionStatus: status }) };
    const flat = sessionEventsToConversation([call, result]).find(message => message.role === "toolResult");
    assert.ok(flat?.role === "toolResult");
    assert.equal(flat.details, payload);
    if (status === undefined) assert.equal(Object.hasOwn(flat, "isError"), false, "legacy bodies are not reclassified");
    else assert.equal(flat.isError, status !== "succeeded");
    const canonical: SessionEvent = { type: "agent_message", message: { role: "assistant", content: [
      { type: "toolCall", id: "status", name: call.tool, arguments: {} }
    ] } };
    const completed = sessionEventsToConversation([canonical, result]).find(message => message.role === "toolResult");
    assert.ok(completed?.role === "toolResult");
    if (status !== undefined) assert.equal(completed.isError, flat.isError);
    assert.equal(sessionEventsToConversation([{ ...call, auditOnly: true }, { ...result, auditOnly: true }]).length, 0);
    assert.equal(sessionEventsToConversation([call, result], { discardedToolCallIds: new Set(["status"]) }).length, 0);
  });
}
