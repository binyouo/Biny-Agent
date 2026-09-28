import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySession, replaySessionEvents } from "../src/session/replay.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-tool-identity-"));
try {
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
  recorder.record({ type: "tool_call", tool: "skill_lookup", toolCallId: "call", sequence: 1, args: {} });
  recorder.record({ type: "tool_execution", tool: "skill_lookup", toolCallId: "call", sequence: 1,
    operationId: "op", state: "succeeded", evidence: "token=private-value" });
  recorder.record({ type: "tool_result", tool: "skill_lookup", toolCallId: "call", sequence: 1,
    operationId: "op", result: { ok: true } });
  await recorder.close();
  const stored = await readSessionEvents(recorder.filePath);
  assert.equal(stored.find((event) => event.type === "tool_execution")?.tool, "skill_lookup");
  const replay = await replaySession(recorder.filePath);
  const execution = replay.events.find((event) => event.type === "tool_execution");
  assert.equal(execution?.tool, "skill_lookup");
  assert.equal(execution?.evidence, "token=[redacted]");
  assert.equal(replay.recoveredToolResults.length, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

const historical: SessionEvent[] = [
  { type: "tool_call", tool: "skill_lookup", toolCallId: "call", sequence: 1,
    runtime: { eventId: "e1", eventSeq: 1, turnId: "turn" } },
  { type: "tool_execution", tool: "[redacted]", toolCallId: "call", sequence: 1, operationId: "op", state: "running",
    runtime: { eventId: "e2", eventSeq: 2, turnId: "turn" } }
];
const recovered = replaySessionEvents(historical);
assert.equal(recovered.events.find((event) => event.type === "tool_execution")?.tool, "skill_lookup");
assert.equal(recovered.recoveredToolResults[0]?.executionStatus, "unknown");
assert.equal(historical[1]?.type === "tool_execution" && historical[1].tool, "[redacted]");
for (const tool of ["read_file", "other_tool"]) {
  assert.throws(() => replaySessionEvents(historical.map((event) => event.type === "tool_call" ? { ...event, tool } : event)), /changed tool identity/);
}
assert.throws(() => replaySessionEvents(historical.map((event) => event.type === "tool_execution"
  ? { ...event, tool: "other_tool" } : event)), /changed tool identity/);
assert.throws(() => replaySessionEvents(historical.map((event) => event.type === "tool_execution"
  ? { ...event, runtime: { ...event.runtime!, turnId: "other" } } : event)), /changed (tool|turn) identity/);

assert.throws(() => replaySessionEvents(historical.map((event) => event.type === "tool_execution"
  ? { ...event, sequence: 2 } : event)), /changed tool identity/);
assert.throws(() => replaySessionEvents([...historical, {
  type: "tool_result", tool: "skill_lookup", toolCallId: "call", operationId: "other-op", result: {},
  runtime: { eventId: "e3", eventSeq: 3, turnId: "turn" }
}]), /mismatched operation identity/);
const completed = replaySessionEvents([...historical, {
  type: "tool_result", tool: "skill_lookup", toolCallId: "call", operationId: "op", result: {},
  runtime: { eventId: "e3", eventSeq: 3, turnId: "turn" }
}]);
assert.equal(completed.recoveredToolResults.length, 0);
