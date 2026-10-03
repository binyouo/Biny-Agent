import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { CapabilityOutcomeResolver } from "../src/session/capabilityOutcomeResolver.js";
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

  const missingResultSession = "fixture-pagination-no-inline-result";
  const missingCallId = "missing-inline";
  const missingOperationId = createToolOperationId(missingResultSession, missingCallId);
  recorder = new SessionRecorder(root, missingResultSession, undefined, authority.asSink());
  recorder.setRuntimeContext({ runId: "missing-result-run", turnId: "missing-result-turn" });
  await recorder.recordAndFlush({ type: "agent_message", message: { role: "assistant", content: [{ type: "toolCall", id: missingCallId, name: tool, arguments: {} }] } });
  await recorder.recordAndFlush({ type: "tool_call", tool, toolCallId: missingCallId, args: {}, auditOnly: true });
  await recorder.recordAndFlush({ type: "tool_execution", tool, toolCallId: missingCallId, sequence: 1, operationId: missingOperationId, state: "admitted" });
  await capabilities.executeHostCapability({ capabilityName: `host:mcp:${tool}`, schema, sessionId: missingResultSession, turnId: "missing-result-turn", toolCallId: missingCallId, offerId: missingOperationId, request: {} }, async () => ({
    items: [{ id: "first", body: "recovered first page body" }], nextPageToken: cursor,
    nested: { access_token: "fixture-access", authorization: "fixture-auth", cookie: "fixture-cookie" }
  }));
  const missingFilePath = recorder.filePath;
  await recorder.close();
  recorder = undefined;
  const outcomeResolver = new CapabilityOutcomeResolver(() => capabilities);
  let resolvedResult: unknown;
  const resolveOutcome: typeof outcomeResolver.resolve = (call) => {
    const outcome = outcomeResolver.resolve(call);
    resolvedResult = outcome?.result;
    return outcome;
  };
  const firstRecovery = replaySessionEvents(await readSessionEvents(missingFilePath), { sessionId: missingResultSession, resolveToolOutcome: resolveOutcome });
  assert.equal(firstRecovery.recoveredToolResults.length, 1);
  const recoveryEvent = firstRecovery.recoveredToolResults[0]!;
  assert.equal(recoveryEvent.result, resolvedResult, "replay retains the exact trusted result object returned by the resolver");
  assert.deepEqual((recoveryEvent.result as Record<string, unknown>).nested, { access_token: "[REDACTED]", authorization: "[REDACTED]", cookie: "[REDACTED]" });
  recorder = new SessionRecorder(root, missingResultSession, missingFilePath, authority.asSink());
  recorder.repairTailForAppend();
  for (const event of firstRecovery.recoveredToolResults) {
    assert.deepEqual(outcomeResolver.redactionOptionsFor(event.result), { context: "mcp-result" });
    assert.deepEqual(outcomeResolver.redactionOptionsFor(structuredClone(event.result)), {}, "clones do not inherit host trust");
    await recorder.recordAndFlush(event, undefined, outcomeResolver.redactionOptionsFor(event.result));
  }
  await recorder.close();
  recorder = undefined;
  const secondRecovery = replaySessionEvents(await readSessionEvents(missingFilePath), { sessionId: missingResultSession, resolveToolOutcome: resolveOutcome });
  assert.equal(secondRecovery.recoveredToolResults.length, 0, "the recovered result is now durable");
  const twiceRestored = secondRecovery.messages.find((message) => message.role === "toolResult" && message.toolCallId === missingCallId);
  assert.ok(twiceRestored?.role === "toolResult");
  const twiceRestoredText = twiceRestored.content.find((part) => part.type === "text");
  assert.ok(twiceRestoredText?.type === "text");
  const recoveredPage = JSON.parse(twiceRestoredText.text);
  assert.equal(recoveredPage.nextPageToken, cursor, "a second resume must preserve the authoritative recovered continuation");
  assert.deepEqual(recoveredPage.items, [{ id: "first", body: "recovered first page body" }]);
  assert.deepEqual(recoveredPage.nested, { access_token: "[redacted]", authorization: "[redacted]", cookie: "[redacted]" });
  const recoveredRequest = { pageToken: recoveredPage.nextPageToken };
  await capabilities.executeHostCapability({ capabilityName: `host:mcp:${tool}`, schema, sessionId: missingResultSession, turnId: "missing-result-turn", toolCallId: "recovered-second", offerId: "recovered-second", request: recoveredRequest }, async () => {
    assert.equal(recoveredRequest.pageToken, cursor, "page two works after the second resume");
    return { items: [{ id: "second" }] };
  });

  const pluginIdentity = { tool: "fixture_plugin_list", sessionId: "plugin-session", turnId: "plugin-turn", toolCallId: "plugin-call", operationId: "plugin-operation", request: {} };
  await capabilities.executeHostCapability({ capabilityName: `host:plugin:${pluginIdentity.tool}`, schema, ...pluginIdentity, offerId: pluginIdentity.operationId }, async () => ({ nextPageToken: cursor }));
  const pluginOutcome = outcomeResolver.resolve(pluginIdentity);
  assert.equal(pluginOutcome?.executionStatus, "succeeded");
  assert.deepEqual(outcomeResolver.redactionOptionsFor(pluginOutcome?.result), {}, "plugin outcomes never acquire MCP context");
  assert.deepEqual(outcomeResolver.redactionOptionsFor({ nextPageToken: cursor, context: "mcp-result", evidence: `capability:${missingOperationId}` }), {}, "flags and evidence do not confer host trust");
  const clientIdentity = { tool: "fixture_client_list", sessionId: "client-session", turnId: "client-turn", toolCallId: "client-call", operationId: "client-operation", request: {} };
  const clientRegistration = capabilities.register({ ownerType: "client", ownerId: "host", capabilityName: `host:mcp:${clientIdentity.tool}`, schema });
  capabilities.admit(clientRegistration.registrationId);
  const clientInvocation = capabilities.invoke({ registrationId: clientRegistration.registrationId, ...clientIdentity, offerId: clientIdentity.operationId });
  capabilities.accept(clientInvocation.invocationId);
  capabilities.start(clientInvocation.invocationId);
  capabilities.result(clientInvocation.invocationId, { nextPageToken: cursor });
  assert.equal(outcomeResolver.resolve(clientIdentity), undefined, "client registrations with host-looking names cannot confer trust");

  const defaultRecorder = new SessionRecorder(root, "fixture-default-redaction");
  try {
    const forged = { type: "tool_result", tool, result: { nextPageToken: cursor }, context: "mcp-result" } as SessionEvent;
    await defaultRecorder.recordAndFlush(forged);
    const events = await readSessionEvents(defaultRecorder.filePath);
    assert.equal((events[0]?.type === "tool_result" ? events[0].result as Record<string, unknown> : {}).nextPageToken, "[redacted]", "MCP-like names or event-supplied context cannot opt in");
  } finally {
    await defaultRecorder.close();
  }
  console.log("MCP pagination recovery tests passed (inline crash boundary, authoritative resolver/Recorder/second replay, resumed page-two roundtrips, exact-object and untrusted-context controls)");
} finally {
  await recorder?.close();
  capabilities?.close();
  authority?.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
