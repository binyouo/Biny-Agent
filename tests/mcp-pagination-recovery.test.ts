import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { createToolOperationId } from "../src/tools/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-pagination-recovery-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
let authority: RuntimeEventAuthority | undefined;
let capabilities: CapabilityStore | undefined;
let recorder: SessionRecorder | undefined;
try {
  authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  capabilities = await CapabilityStore.open(root, authority);
  const sessionId = "fixture-pagination-crash";
  const tool = "mcp_fixture_list";
  const toolCallId = "first";
  const operationId = createToolOperationId(sessionId, toolCallId);
  const cursor = Buffer.from(JSON.stringify({ page: 2, record: "fixture-page" })).toString("base64url");
  const schema = { type: "object", properties: { pageToken: { type: "string" } } };
  recorder = new SessionRecorder(root, sessionId, undefined, authority.asSink());
  recorder.setRuntimeContext({ runId: "fixture-run", turnId: "fixture-turn" });
  await recorder.recordAndFlush({ type: "agent_message", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: tool, arguments: {} }] } });
  await recorder.recordAndFlush({ type: "tool_call", tool, toolCallId, args: {}, auditOnly: true });
  await recorder.recordAndFlush({ type: "tool_execution", tool, toolCallId, sequence: 1, operationId, state: "succeeded" });
  const first = await capabilities.executeHostCapability({ capabilityName: `host:mcp:${tool}`, schema, sessionId, turnId: "fixture-turn", toolCallId, offerId: operationId, request: {} }, async () => ({
    items: [{ id: "first", body: "first page body" }], nextPageToken: cursor, authorization: "fixture-auth", nested: { access_token: "fixture-access" }
  }));
  // The process stops after the inline result is flushed, before the canonical
  // agent_message/toolResult can be written. Context is a host argument only.
  await recorder.recordAndFlush({ type: "tool_result", tool, toolCallId, sequence: 1, operationId, executionStatus: "succeeded", result: first }, undefined, { context: "mcp-result" });
  await recorder.close();
  const filePath = recorder.filePath;
  recorder = undefined;
  let resolutions = 0;
  const replay = replaySessionEvents(await readSessionEvents(filePath), { sessionId, resolveToolOutcome: (call) => {
    resolutions += 1;
    const invocation = capabilities!.findHostToolInvocation(call);
    return invocation?.status === "result" ? { executionStatus: "succeeded", result: invocation.result } : undefined;
  } });
  assert.equal(resolutions, 0, "the known succeeded result is already complete and does not consult the ledger");
  assert.equal(replay.recoveredToolResults.length, 0);
  const restored = replay.messages.find((message) => message.role === "toolResult" && message.toolCallId === toolCallId);
  assert.ok(restored?.role === "toolResult");
  const restoredText = restored.content.find((part) => part.type === "text");
  assert.ok(restoredText?.type === "text");
  const page = JSON.parse(restoredText.text);
  assert.equal(page.nextPageToken, cursor, "inline result replay must preserve the continuation across the crash window");
  assert.deepEqual(page.items, [{ id: "first", body: "first page body" }]);
  assert.equal(page.authorization, "[redacted]");
  assert.equal(page.nested.access_token, "[redacted]");
  const secondRequest = { pageToken: page.nextPageToken };
  const second = await capabilities.executeHostCapability({ capabilityName: `host:mcp:${tool}`, schema, sessionId, turnId: "fixture-turn", toolCallId: "second", offerId: "second", request: secondRequest }, async () => {
    assert.equal(secondRequest.pageToken, cursor);
    return { items: [{ id: "second" }] };
  });
  assert.equal(second.items[0]?.id, "second");

  const defaultRecorder = new SessionRecorder(root, "fixture-default-redaction");
  try {
    const forged = { type: "tool_result", tool, result: { nextPageToken: cursor }, context: "mcp-result" } as SessionEvent;
    await defaultRecorder.recordAndFlush(forged);
    const events = await readSessionEvents(defaultRecorder.filePath);
    assert.equal((events[0]?.type === "tool_result" ? events[0].result as Record<string, unknown> : {}).nextPageToken, "[redacted]", "MCP-like names or event-supplied context cannot opt in");
  } finally {
    await defaultRecorder.close();
  }
  console.log("MCP pagination recovery tests passed (actual Recorder/read/replay crash boundary, resumed page-two roundtrip, untrusted context controls)");
} finally {
  await recorder?.close();
  capabilities?.close();
  authority?.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
