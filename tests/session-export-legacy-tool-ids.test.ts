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
  assert.equal((await exportSessionClaudeCode(workspace, label)).content, exported.content, "generated IDs are deterministic");
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

test("public Claude export preserves a supported ID-less call/result through import and replay", async () => {
  const fixture = await exportedFixture("legacy-single", [
    { type: "tool_call", tool: "Read", args: { path: "文件.txt" } },
    { type: "tool_result", tool: "Read", result: 'first\n"quoted" 🌍', executionStatus: "succeeded" }
  ]);
  const sourceReplay = replaySessionEvents(fixture.events);
  assert.equal(sourceReplay.recoveredToolResults.length, 0, "legacy source has a completed result");
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

test("generated IDs avoid later explicit call IDs and retain mixed explicit/result identities", async () => {
  const fixture = await exportedFixture("legacy-collision", [
    { type: "tool_call", tool: "Read", args: { path: "a.txt" } },
    { type: "tool_call", tool: "Bash", args: { command: "pwd" }, toolCallId: "call_1" },
    { type: "tool_result", tool: "Bash", result: "workspace", toolCallId: "call_1" },
    { type: "tool_result", tool: "Read", result: "file" }
  ]);
  assert.notEqual(fixture.calls[0]?.id, "call_1");
  assert.equal(fixture.calls[1]?.id, "call_1");
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["call_1", fixture.calls[0]?.id]);
  const imported = await roundTrip(fixture);
  assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => event.tool), ["Bash", "Read"]);
  assert.equal(replaySessionEvents(imported).recoveredToolResults.length, 0);
});

test("same-name calls link uniquely by legacy sequence despite interleaved results", async () => {
  const fixture = await exportedFixture("legacy-sequences", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" }, sequence: 1 },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" }, sequence: 2 },
    { type: "tool_result", tool: "Read", result: "second", sequence: 2 },
    { type: "tool_result", tool: "Read", result: "first", sequence: 1 }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), [fixture.calls[1]?.id, fixture.calls[0]?.id]);
  const imported = await roundTrip(fixture);
  assert.equal(replaySessionEvents(imported).recoveredToolResults.length, 0);
  assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => event.result), ["second", "first"]);
});

test("ID-less results can match a unique explicit same-name sequence, leaving other calls pending", async () => {
  const fixture = await exportedFixture("legacy-mixed-sequences", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" }, toolCallId: "explicit", sequence: 1 },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" }, sequence: 2 },
    { type: "tool_result", tool: "Read", result: "second", sequence: 2 },
    { type: "tool_result", tool: "Read", result: "first", toolCallId: "explicit", sequence: 1 }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), [fixture.calls[1]?.id, "explicit"]);
  assert.equal(replaySessionEvents(await roundTrip(fixture)).recoveredToolResults.length, 0);
});

test("ambiguous, mismatched-sequence, and unmatched results retain unresolved links", async () => {
  const fixture = await exportedFixture("legacy-ambiguous", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" } },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" } },
    { type: "tool_result", tool: "Read", result: "which file?" },
    { type: "tool_call", tool: "Bash", args: { command: "pwd" }, sequence: 4 },
    { type: "tool_result", tool: "Bash", result: "wrong sequence", sequence: 5 },
    { type: "tool_result", tool: "Unknown", result: "orphan" },
    { type: "tool_result", tool: "Unknown", result: "explicit orphan", toolCallId: "call_1" }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", "", "", "call_1"]);
  assert.notEqual(fixture.calls[0]?.id, "call_1", "result IDs are reserved too");
});

test("pending legacy links do not cross public conversation boundaries", async () => {
  const fixture = await exportedFixture("legacy-boundaries", [
    { type: "tool_call", tool: "Read", args: {} },
    { type: "user_message", content: "new turn" },
    { type: "tool_result", tool: "Read", result: "late" },
    { type: "tool_call", tool: "Bash", args: {} },
    { type: "assistant_message", content: "finished" },
    { type: "tool_result", tool: "Bash", result: "late too" }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", ""]);
});

test("an ambiguous result cannot become an invented later link after an explicit completion", async () => {
  const fixture = await exportedFixture("legacy-consumed-ambiguity", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" }, toolCallId: "explicit" },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" } },
    { type: "tool_result", tool: "Read", result: "ambiguous" },
    { type: "tool_result", tool: "Read", result: "explicit", toolCallId: "explicit" },
    { type: "tool_result", tool: "Read", result: "possibly duplicate" }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", "explicit", ""]);
});

test("duplicate explicit IDs and duplicate sequences do not collapse ambiguous candidates", async () => {
  const fixture = await exportedFixture("legacy-duplicate-identities", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" }, toolCallId: "duplicate", sequence: 1 },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" }, toolCallId: "duplicate", sequence: 1 },
    { type: "tool_result", tool: "Read", result: "ambiguous", sequence: 1 },
    { type: "tool_result", tool: "Read", result: "explicit reference", toolCallId: "duplicate" }
  ]);
  assert.deepEqual(fixture.calls.map((call) => call.id), ["duplicate", "duplicate"]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", "duplicate"]);
});

test("audit-only facts and interrupted/canonical boundaries cannot gain synthesized links", async () => {
  const fixture = await exportedFixture("legacy-projection-boundaries", [
    { type: "tool_call", tool: "Read", args: {}, auditOnly: true },
    { type: "tool_result", tool: "Read", result: "audit result", auditOnly: true },
    { type: "tool_call", tool: "Bash", args: {} },
    { type: "turn_interrupted", reason: "interrupted", content: "context only" },
    { type: "tool_result", tool: "Bash", result: "after interruption" },
    { type: "tool_call", tool: "Read", args: {} },
    { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "canonical-only marker" }] } },
    { type: "tool_result", tool: "Read", result: "after canonical message" }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", "", ""]);
  assert.doesNotMatch(fixture.exported.content, /context only|canonical-only marker/u, "existing omitted event types stay omitted");
});

test("uncertain old calls block late unsequenced results from attaching to a newly opened call", async () => {
  const fixture = await exportedFixture("legacy-late-uncertainty", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" }, sequence: 1 },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" }, sequence: 2 },
    { type: "tool_result", tool: "Read", result: "ambiguous old completion" },
    { type: "tool_call", tool: "Read", args: { path: "third.txt" }, sequence: 3 },
    { type: "tool_result", tool: "Read", result: "late old completion" },
    { type: "tool_result", tool: "Read", result: "third completion", sequence: 3 }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", "", ""], "an unsequenced late result may already have consumed the new call too");
  const imported = await roundTrip(fixture);
  assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => event.toolCallId), ["", "", ""]);
  const replay = replaySessionEvents(imported);
  const lateResult = replay.messages.find((message) => message.role === "toolResult" && message.details === "late old completion");
  assert.equal(lateResult?.role === "toolResult" && lateResult.toolCallId, "", "public roundtrip must not attach the old late result to the third call");
  assert.notEqual(lateResult?.role === "toolResult" && lateResult.toolCallId, fixture.calls[2]?.id);
});

test("a sequenced new completion can link while old calls remain uncertain", async () => {
  const fixture = await exportedFixture("legacy-new-sequence", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" }, sequence: 1 },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" }, sequence: 2 },
    { type: "tool_result", tool: "Read", result: "ambiguous old completion" },
    { type: "tool_call", tool: "Read", args: { path: "third.txt" }, sequence: 3 },
    { type: "tool_result", tool: "Read", result: "third completion", sequence: 3 }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", fixture.calls[2]?.id]);
  const imported = await roundTrip(fixture);
  assert.equal(imported.filter((event) => event.type === "tool_result").at(-1)?.toolCallId, fixture.calls[2]?.id);
});

test("reused explicit IDs with different tools never gain inferred links", async () => {
  const fixture = await exportedFixture("legacy-reused-id-names", [
    { type: "tool_call", tool: "Read", args: { path: "file.txt" }, toolCallId: "duplicate", sequence: 1 },
    { type: "tool_call", tool: "Bash", args: { command: "pwd" }, toolCallId: "duplicate", sequence: 2 },
    { type: "tool_result", tool: "Read", result: "file content", sequence: 1 },
    { type: "tool_result", tool: "Bash", result: "workspace", sequence: 2 }
  ]);
  assert.deepEqual(fixture.calls.map((call) => call.id), ["duplicate", "duplicate"], "explicit IDs are not rewritten");
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", ""], "duplicate ID cannot represent a proven unique call");
  const imported = await roundTrip(fixture);
  assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => [event.toolCallId, event.tool, event.result]), [
    ["", "tool", "file content"], ["", "tool", "workspace"]
  ], "existing importer unresolved representation is retained, rather than falsely naming both Bash");
  const replay = replaySessionEvents(imported);
  assert.deepEqual(replay.messages.flatMap((message) => message.role === "toolResult" && typeof message.details === "string"
    ? [[message.toolCallId, message.toolName, message.details]] : []), [["", "tool", "file content"], ["", "tool", "workspace"]]);
});

test("a missing call sequence remains a possible match beside a known same-name sequence", async () => {
  const fixture = await exportedFixture("legacy-unknown-sequence", [
    { type: "tool_call", tool: "Read", args: { path: "first.txt" } },
    { type: "tool_call", tool: "Read", args: { path: "second.txt" }, sequence: 2 },
    { type: "tool_result", tool: "Read", result: "could belong to either", sequence: 2 }
  ]);
  assert.equal(fixture.results[0]?.tool_use_id, "");
});

test("a unique unsequenced call can retain a sequenced result without a conflicting candidate", async () => {
  const fixture = await exportedFixture("legacy-single-unknown-sequence", [
    { type: "tool_call", tool: "Read", args: { path: "file.txt" } },
    { type: "tool_result", tool: "Read", result: "file", sequence: 2 }
  ]);
  assert.equal(fixture.results[0]?.tool_use_id, fixture.calls[0]?.id);
  assert.equal(replaySessionEvents(await roundTrip(fixture)).recoveredToolResults.length, 0);
});

for (const { label, tools, nextTool } of [
  { label: "same-name", tools: ["Read", "Read"], nextTool: "Read" },
  { label: "mixed-new-read", tools: ["Read", "Bash"], nextTool: "Read" },
  { label: "mixed-new-bash", tools: ["Read", "Bash"], nextTool: "Bash" }
]) {
  test(`an explicit reused-ID completion retains old uncertainty before a new ${label} call`, async () => {
    const fixture = await exportedFixture(`legacy-explicit-uncertainty-${label}`, [
      { type: "tool_call", tool: tools[0]!, args: { input: "first" }, toolCallId: "duplicate", sequence: 1 },
      { type: "tool_call", tool: tools[1]!, args: { input: "second" }, toolCallId: "duplicate", sequence: 2 },
      { type: "tool_result", tool: tools[0]!, toolCallId: "duplicate", result: "explicit completion", sequence: 1 },
      { type: "tool_call", tool: nextTool, args: { input: "third" }, sequence: 3 },
      { type: "tool_result", tool: nextTool, result: "late old completion" },
      { type: "tool_result", tool: nextTool, result: "third completion", sequence: 3 }
    ]);
    assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["duplicate", "", ""], "explicit reference stays verbatim but cannot erase duplicated call uncertainty");
    const imported = await roundTrip(fixture);
    assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => event.toolCallId), ["duplicate", "", ""]);
    const replay = replaySessionEvents(imported);
    const lateResult = replay.messages.find((message) => message.role === "toolResult" && message.details === "late old completion");
    assert.equal(lateResult?.role === "toolResult" && lateResult.toolCallId, "");
    assert.notEqual(lateResult?.role === "toolResult" && lateResult.toolCallId, fixture.calls[2]?.id);
  });
}

test("old explicit-ID uncertainty does not block a new uniquely sequenced completion", async () => {
  const fixture = await exportedFixture("legacy-explicit-new-sequence", [
    { type: "tool_call", tool: "Read", args: { input: "first" }, toolCallId: "duplicate", sequence: 1 },
    { type: "tool_call", tool: "Read", args: { input: "second" }, toolCallId: "duplicate", sequence: 2 },
    { type: "tool_result", tool: "Read", toolCallId: "duplicate", result: "explicit completion", sequence: 1 },
    { type: "tool_call", tool: "Read", args: { input: "third" }, sequence: 3 },
    { type: "tool_result", tool: "Read", result: "third completion", sequence: 3 }
  ]);
  assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["duplicate", fixture.calls[2]?.id]);
  const imported = await roundTrip(fixture);
  assert.equal(imported.filter((event) => event.type === "tool_result").at(-1)?.toolCallId, fixture.calls[2]?.id);
});

for (const { label, resultTool, resultId, sequence } of [
  { label: "inferred-empty", resultTool: "Read", resultId: undefined, sequence: 1 },
  { label: "explicit-empty", resultTool: "Read", resultId: "", sequence: 1 },
  { label: "mismatched-empty", resultTool: "Bash", resultId: "", sequence: 2 }
]) {
  test(`an ${label} result cannot erase the uncertainty of an empty-ID call`, async () => {
    const fixture = await exportedFixture(`legacy-empty-identity-${label}`, [
      { type: "tool_call", tool: "Read", args: { input: "old" }, toolCallId: "", sequence: 1 },
      { type: "tool_result", tool: resultTool, toolCallId: resultId, result: "old unresolved completion", sequence },
      { type: "tool_call", tool: "Read", args: { input: "new" }, sequence: 3 },
      { type: "tool_result", tool: "Read", result: "late old completion" }
    ]);
    assert.equal(fixture.calls[0]?.id, "", "explicit empty call IDs remain verbatim");
    assert.deepEqual(fixture.results.map((result) => result.tool_use_id), ["", ""], "empty IDs cannot establish completion identity");
    const imported = await roundTrip(fixture);
    assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => event.toolCallId), ["", ""]);
    const replay = replaySessionEvents(imported);
    const lateResult = replay.messages.find((message) => message.role === "toolResult" && message.details === "late old completion");
    assert.equal(lateResult?.role === "toolResult" && lateResult.toolCallId, "");
    assert.notEqual(lateResult?.role === "toolResult" && lateResult.toolCallId, fixture.calls[1]?.id);
  });
}

// Bounded provenance matrix: 4 ID classes × 3 sequence classes × 2 late-result positions.
for (const identity of ["missing", "empty", "unique", "reused"] as const) {
  for (const sequences of ["known", "unknown", "reused"] as const) {
    for (const latePosition of ["before", "after"] as const) {
      test(`provenance matrix ${identity}/${sequences}/late-${latePosition}-new-call`, async () => {
        const oldIds = identity === "missing" ? [undefined, undefined]
          : identity === "empty" ? ["", ""]
          : identity === "unique" ? ["old-a", "old-b"] : ["duplicate", "duplicate"];
        const oldSequences = sequences === "known" ? [1, 2]
          : sequences === "unknown" ? [undefined, undefined] : [1, 1];
        const nextCall: SessionEvent = { type: "tool_call", tool: "Read", args: { input: "new" }, sequence: 3 };
        const lateResult: SessionEvent = { type: "tool_result", tool: "Read", result: "late old completion" };
        const fixture = await exportedFixture(`matrix-${identity}-${sequences}-${latePosition}`, [
          { type: "tool_call", tool: "Read", args: { input: "old-a" }, toolCallId: oldIds[0], sequence: oldSequences[0] },
          { type: "tool_call", tool: "Read", args: { input: "old-b" }, toolCallId: oldIds[1], sequence: oldSequences[1] },
          { type: "tool_result", tool: "Read", result: "first completion", toolCallId: oldIds[0] },
          ...(latePosition === "before" ? [lateResult, nextCall] : [nextCall, lateResult]),
          { type: "tool_result", tool: "Read", result: "new completion", sequence: 3 }
        ]);
        const lateId = latePosition === "before" && identity === "unique" ? oldIds[1] : "";
        const newId = latePosition === "before" && (identity === "unique" || sequences !== "unknown")
          ? fixture.calls[2]?.id : "";
        const expected = [oldIds[0] ?? "", lateId, newId];
        assert.deepEqual(fixture.results.map((result) => result.tool_use_id), expected);
        const imported = await roundTrip(fixture);
        assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => event.toolCallId), expected);
        const replay = replaySessionEvents(imported);
        const lateMessage = replay.messages.find((message) => message.role === "toolResult" && message.details === "late old completion");
        assert.equal(lateMessage?.role === "toolResult" && lateMessage.toolCallId, lateId);
        assert.notEqual(lateMessage?.role === "toolResult" && lateMessage.toolCallId, fixture.calls[2]?.id, "late old output never acquires the new call identity");
      });
    }
  }
}

// Boundaries add no completion evidence: repeat the same 24-path matrix in four contexts.
for (const boundary of ["user", "assistant", "canonical", "interrupted"] as const) {
  for (const identity of ["missing", "empty", "unique", "reused"] as const) {
    for (const sequences of ["known", "unknown", "reused"] as const) {
      for (const latePosition of ["before", "after"] as const) {
        test(`boundary matrix ${boundary}/${identity}/${sequences}/late-${latePosition}-new-call`, async () => {
          const oldIds = identity === "missing" ? [undefined, undefined]
            : identity === "empty" ? ["", ""]
            : identity === "unique" ? ["old-a", "old-b"] : ["duplicate", "duplicate"];
          const oldSequences = sequences === "known" ? [1, 2]
            : sequences === "unknown" ? [undefined, undefined] : [1, 1];
          const boundaryEvent: SessionEvent = boundary === "user" ? { type: "user_message", content: "next public turn" }
            : boundary === "assistant" ? { type: "assistant_message", content: "public answer" }
            : boundary === "canonical" ? { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "canonical-only marker" }] } }
            : { type: "turn_interrupted", reason: "interrupted", content: "interruption-only marker" };
          const nextCall: SessionEvent = { type: "tool_call", tool: "Read", args: { input: "new" }, sequence: 3 };
          const lateResult: SessionEvent = { type: "tool_result", tool: "Read", result: "late old completion" };
          const fixture = await exportedFixture(`boundary-${boundary}-${identity}-${sequences}-${latePosition}`, [
            { type: "tool_call", tool: "Read", args: { input: "old-a" }, toolCallId: oldIds[0], sequence: oldSequences[0] },
            { type: "tool_call", tool: "Read", args: { input: "old-b" }, toolCallId: oldIds[1], sequence: oldSequences[1] },
            { type: "tool_result", tool: "Read", result: "first completion", toolCallId: oldIds[0] },
            ...(latePosition === "before" ? [lateResult, boundaryEvent, nextCall] : [boundaryEvent, nextCall, lateResult]),
            { type: "tool_result", tool: "Read", result: "new completion", sequence: 3 }
          ]);
          const lateId = latePosition === "before" && identity === "unique" ? oldIds[1] : "";
          const newId = latePosition === "before" && (identity === "unique" || sequences !== "unknown")
            ? fixture.calls[2]?.id : "";
          const expected = [oldIds[0] ?? "", lateId, newId];
          assert.deepEqual(fixture.results.map((result) => result.tool_use_id), expected);
          assert.doesNotMatch(fixture.exported.content, /canonical-only marker|interruption-only marker/u);
          const imported = await roundTrip(fixture);
          assert.deepEqual(imported.filter((event) => event.type === "tool_result").map((event) => event.toolCallId), expected);
          const replay = replaySessionEvents(imported);
          const lateMessage = replay.messages.find((message) => message.role === "toolResult" && message.details === "late old completion");
          assert.equal(lateMessage?.role === "toolResult" && lateMessage.toolCallId, lateId);
          assert.notEqual(lateMessage?.role === "toolResult" && lateMessage.toolCallId, fixture.calls[2]?.id, "boundaries cannot make late old output unique to a new call");
        });
      }
    }
  }
}
