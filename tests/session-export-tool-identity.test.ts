/** Legacy session export must keep provable tool identities without inventing ambiguous links. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentMessage } from "../src/agent/core/types.js";
import type { SessionEvent } from "../src/session/recorder.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-export-identities-")));
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const { readStoredSessionEvents } = await import("../src/session/events.js");
const { replaySessionEvents } = await import("../src/session/replay.js");
const { createSessionFile, ensureAgentDirs } = await import("../src/session/store.js");
const { exportSessionBundle, exportSessionClaudeCode, importSessionFile } = await import("../src/session/transfer.js");
const { sessionExportCommand } = await import("../src/cli/commands/sessionTransfer.js");
after(async () => { await rm(root, { recursive: true, force: true }); });
const workspace = path.join(root, "workspace");
await mkdir(workspace);
await ensureAgentDirs(workspace);

interface ClaudeLine {
  type: string;
  timestamp?: string;
  message: { role: string; content: string | Array<{ type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string; is_error?: boolean }> };
}

async function exportedFixture(label: string, facts: SessionEvent[]) {
  const events: SessionEvent[] = [
    { type: "user_message", content: "Read the files", time: "2026-01-01T00:00:00.000Z" },
    ...facts,
    { type: "assistant_message", content: "Done", time: "2026-01-01T00:00:01.000Z" }
  ];
  const sourceEvents = events.map((event) => JSON.parse(JSON.stringify(event)) as SessionEvent);
  const raw = sourceEvents.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const sourcePath = await createSessionFile(workspace, label, Buffer.from(raw));
  const exported = await exportSessionClaudeCode(workspace, label);
  const lines = exported.content.trim().split("\n").map((line) => JSON.parse(line) as ClaudeLine);
  const calls = lines.flatMap((line) => Array.isArray(line.message.content) ? line.message.content.filter((block) => block.type === "tool_use") : []);
  const results = lines.flatMap((line) => Array.isArray(line.message.content) ? line.message.content.filter((block) => block.type === "tool_result") : []);
  assert.equal(await readFile(sourcePath, "utf8"), raw, "export does not rewrite persisted facts");
  assert.equal((await exportSessionClaudeCode(workspace, label)).content, exported.content, "export is deterministic");
  assert.deepEqual(JSON.parse((await exportSessionBundle(workspace, label)).content).events, sourceEvents, "native bundle retains original persisted optional IDs");
  return { label, events: sourceEvents, exported, lines, calls, results };
}

async function roundTrip(fixture: Awaited<ReturnType<typeof exportedFixture>>) {
  const file = path.join(root, `${fixture.label}.claude.jsonl`);
  await writeFile(file, fixture.exported.content);
  const imported = await importSessionFile(workspace, file);
  return (await readStoredSessionEvents(workspace, imported.sessionId)).events;
}

function withoutCallIds(messages: AgentMessage[]) {
  return messages.map((message) => message.role === "assistant"
    ? { ...message, content: message.content.map((part) => part.type === "toolCall" ? { ...part, id: undefined } : part) }
    : message.role === "toolResult" ? { ...message, toolCallId: undefined } : message);
}

test("public Claude export preserves explicit call identity through import and replay", async () => {
  const fixture = await exportedFixture("explicit-single", [
    { type: "tool_call", tool: "Read", toolCallId: "read-file", args: { path: "文件.txt" } },
    { type: "tool_result", tool: "Read", toolCallId: "read-file", result: 'first\n"quoted" 🌍', executionStatus: "succeeded" }
  ]);
  const sourceReplay = replaySessionEvents(fixture.events);
  assert.equal(sourceReplay.recoveredToolResults.length, 0, "source has a completed result");
  const imported = await roundTrip(fixture);
  const replay = replaySessionEvents(imported);
  assert.equal(replay.recoveredToolResults.length, 0, "export/import must not turn a completed call into unknown recovery");
  assert.deepEqual(withoutCallIds(replay.messages), withoutCallIds(sourceReplay.messages));
  assert.ok(fixture.calls[0]?.id);
  assert.equal(fixture.results[0]?.tool_use_id, fixture.calls[0]?.id);
  assert.equal(fixture.results[0]?.content, 'first\n"quoted" 🌍');

  const target = path.join(root, "cli-export.jsonl");
  const output: string[] = [];
  const log = console.log;
  try {
    console.log = (line: string) => { output.push(line); };
    await sessionExportCommand(workspace, fixture.label, { format: "claude", out: target, json: true });
  } finally { console.log = log; }
  assert.equal(await readFile(target, "utf8"), fixture.exported.content);
  assert.equal(JSON.parse(output[0]!).format, "claude");
});

for (const status of ["succeeded", "failed", "cancelled"] as const) {
  test(`Claude roundtrip preserves explicit ${status} protocol status`, async () => {
    const fixture = await exportedFixture(`explicit-status-${status}`, [
      { type: "tool_call", tool: "Read", toolCallId: "read-status", args: { path: "status.txt" } },
      { type: "tool_result", tool: "Read", toolCallId: "read-status", result: 'status\n"quoted" 🌍', executionStatus: status }
    ]);
    const isError = status !== "succeeded";
    assert.equal(fixture.results[0]?.is_error, isError);
    const imported = await roundTrip(fixture);
    const facts = imported.filter((event) => event.type === "tool_result");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.executionStatus, isError ? "failed" : "succeeded", "Claude retains binary failure, not cancellation metadata");
    const canonical = imported.find((event) => event.type === "agent_message" && event.message.role === "toolResult");
    assert.ok(canonical?.type === "agent_message" && canonical.message.role === "toolResult");
    assert.equal(Object.hasOwn(canonical.message, "isError"), true, "the explicit boolean survives persistence");
    assert.equal(canonical.message.isError, isError);
    const replay = replaySessionEvents(imported);
    const results = replay.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, isError);
    assert.equal(replay.recoveredToolResults.length, 0);
    assert.deepEqual(withoutCallIds(replay.messages), withoutCallIds(replaySessionEvents(fixture.events).messages));
  });
}

for (const isError of [true, false, undefined] as const) {
  test(`raw Claude ${String(isError)} error flag agrees across persisted projections`, async () => {
    const file = path.join(root, `raw-status-${String(isError)}.claude.jsonl`);
    const lines: ClaudeLine[] = [
      { type: "user", message: { role: "user", content: "Read status.txt" } },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "raw-call", name: "Read", input: { path: "status.txt" } }
      ] } },
      { type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "raw-call", content: 'raw\n"quoted" 🌍',
          ...(isError === undefined ? {} : { is_error: isError }) }
      ] } }
    ];
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const imported = await importSessionFile(workspace, file);
    const events = (await readStoredSessionEvents(workspace, imported.sessionId)).events;
    const facts = events.filter((event) => event.type === "tool_result");
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.executionStatus, isError === true ? "failed" : "succeeded");
    assert.equal(facts[0]?.toolCallId, "raw-call");
    const canonical = events.find((event) => event.type === "agent_message" && event.message.role === "toolResult");
    assert.ok(canonical?.type === "agent_message" && canonical.message.role === "toolResult");
    assert.equal(Object.hasOwn(canonical.message, "isError"), true);
    assert.equal(canonical.message.isError, isError === true);
    const replay = replaySessionEvents(events);
    assert.equal(replay.recoveredToolResults.length, 0);
    assert.deepEqual(replay.messages.filter((message) => message.role === "toolResult"), [{
      role: "toolResult", toolCallId: "raw-call", toolName: "Read",
      content: [{ type: "text", text: 'raw\n"quoted" 🌍' }], details: 'raw\n"quoted" 🌍', isError: isError === true
    }]);
  });
}


for (const sequence of [undefined, 1]) {
  test(`export preserves missing identities without guessing from sequence ${sequence}`, async () => {
    const fixture = await exportedFixture(`missing-${sequence}`, [
      { type: "tool_call", tool: "Read", args: {}, sequence },
      { type: "tool_result", tool: "Read", result: "unattributed", sequence },
      { type: "tool_call", tool: "Read", args: {}, toolCallId: "known", sequence: 2 },
      { type: "tool_result", tool: "Read", result: "known result", toolCallId: "known", sequence: 2 }
    ]);
    assert.deepEqual(fixture.calls.map(call => call.id), ["", "known"]);
    assert.deepEqual(fixture.results.map(result => result.tool_use_id), ["", "known"]);
    assert.throws(() => replaySessionEvents(fixture.events), /explicit toolCallId/);
    const imported = await roundTrip(fixture);
    const audits = imported.filter(event => event.type === "tool_call" || event.type === "tool_result");
    assert.equal(audits.length, 4, "unidentified facts remain available for inspection");
    assert.equal(audits.filter(event => event.auditOnly).length, 2);
    const replay = replaySessionEvents(imported);
    assert.deepEqual(replay.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId), ["known"]);
    assert.equal(replay.recoveredToolResults.length, 0);
  });
}

test("export preserves explicit identity for interleaved same-name results", async () => {
  const fixture = await exportedFixture("interleaved", [
    { type: "tool_call", tool: "Read", args: { path: "a" }, toolCallId: "a" },
    { type: "tool_call", tool: "Read", args: { path: "b" }, toolCallId: "b" },
    { type: "tool_result", tool: "Read", result: "second", toolCallId: "b" },
    { type: "tool_result", tool: "Read", result: "first", toolCallId: "a" }
  ]);
  assert.deepEqual(fixture.results.map(result => result.tool_use_id), ["b", "a"]);
  const replay = replaySessionEvents(await roundTrip(fixture));
  assert.deepEqual(replay.messages.filter(message => message.role === "toolResult").map(message => [message.toolCallId, message.details]), [["b", "second"], ["a", "first"]]);
  assert.equal(replay.recoveredToolResults.length, 0);
});
