import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSessionEvents, readSessionEvents, repairSessionTailForAppend } from "../src/session/events.js";
import { clearSessionParseCache } from "../src/session/parseCache.js";
import { activeSessionMessageIds, sessionMessageTree } from "../src/session/messageTree.js";
import { maxSessionEvents, maxSessionEventLineBytes, maxSessionFileBytes } from "../src/session/limits.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { measureSessionRead } from "./helpers/sessionReadMetrics.js";

const row = (event: SessionEvent): string => `${JSON.stringify(event)}\n`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-hot-"));
let failures = 0;
async function test(name: string, run: (file: string) => Promise<void>): Promise<void> {
  clearSessionParseCache();
  const file = path.join(root, `${name.replaceAll(/[^a-z0-9]/gu, "-")}.jsonl`);
  try { await run(file); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
async function parity(file: string): Promise<SessionEvent[]> {
  const expected = parseSessionEvents(await fs.readFile(file, "utf8"));
  const actual = await readSessionEvents(file);
  assert.deepEqual(actual, expected);
  assert.deepEqual(sessionMessageTree(actual), sessionMessageTree(expected));
  assert.deepEqual(activeSessionMessageIds(actual), activeSessionMessageIds(expected));
  return actual;
}
try {
  await test("unchanged reads reuse validated parsing without reading bytes", async (file) => {
    await fs.writeFile(file, row({ type: "user_message", content: "hello", messageId: "u" }));
    const first = await readSessionEvents(file);
    const second = await measureSessionRead(() => readSessionEvents(file));
    assert.deepEqual(second.value, first);
    assert.equal(second.metrics.parsedRows, 0);
    assert.equal(second.metrics.bytesRead, 0);
  });
  await test("append only parses new rows preserving previous snapshots", async (file) => {
    const events: SessionEvent[] = Array.from({ length: 200 }, (_, index) => ({ type: "user_message", content: "你好🌍", messageId: `u${index}`, parentMessageId: index ? `u${index - 1}` : undefined }));
    await fs.writeFile(file, events.map(row).join(""));
    const first = await readSessionEvents(file);
    await fs.appendFile(file, row({ type: "agent_message", messageId: "a", parentMessageId: "u199", message: { role: "assistant", content: [{ type: "text", text: "回答" }] } }));
    const next = await measureSessionRead(() => readSessionEvents(file));
    assert.equal(next.metrics.parsedRows, 1, "only appended JSON rows should be parsed");
    assert.equal(first.length, 200, "previous snapshot must stay immutable");
    assert.equal(next.value.length, 201);
    assert.equal(next.value[0], first[0], "validated prefix event objects should be reused");
    await parity(file);
  });
  await test("branches switches and hidden canonical messages match full projection", async (file) => {
    const events: SessionEvent[] = [
      { type: "user_message", messageId: "u", content: "question" },
      { type: "user_message", messageId: "audit", auditOnly: true, content: "queued" },
      { type: "agent_message", messageId: "a1", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
      { type: "agent_message", messageId: "tool", parentMessageId: "a1", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "private tool content" }] } },
      { type: "agent_message", messageId: "a2", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "alternate" }] } },
      { type: "message_version_selected", slotId: "answer", messageId: "a1" },
      { type: "message_metadata", messageId: "a1", metadata: { usage: { tokens: 2 } } },
      { type: "message_version_selected", slotId: "answer", messageId: "a2" }
    ];
    await fs.writeFile(file, "");
    for (const event of events) { await fs.appendFile(file, row(event)); await parity(file); }
    assert.deepEqual([...activeSessionMessageIds(await readSessionEvents(file))], ["a2", "u"]);
  });
  await test("truncate replacement same size and rewrite plus append invalidate", async (file) => {
    const a = row({ type: "user_message", content: "old", messageId: "u" });
    const b = row({ type: "user_message", content: "new", messageId: "v" });
    await fs.writeFile(file, a); await parity(file);
    const times = await fs.stat(file);
    await fs.writeFile(file, b); await fs.utimes(file, times.atime, times.mtime); await parity(file);
    await fs.appendFile(file, a); await parity(file);
    await fs.writeFile(file, a + b + b); await parity(file);
    await fs.truncate(file, a.length); await parity(file);
    await fs.writeFile(`${file}.replace`, b); await fs.rename(`${file}.replace`, file); await parity(file);
  });
  await test("incomplete utf8 tail and recovery match strict parser", async (file) => {
    const first = row({ type: "user_message", content: "start" });
    const tail = Buffer.from(row({ type: "user_message", content: "你好🌍" }));
    const split = tail.indexOf(Buffer.from("🌍")) + 2;
    await fs.writeFile(file, first); await parity(file);
    await fs.appendFile(file, tail.subarray(0, split)); await parity(file);
    await fs.appendFile(file, tail.subarray(split)); await parity(file);
    await fs.appendFile(file, '{"type":"user_message",'); await parity(file);
    await repairSessionTailForAppend(file); await parity(file);
    await fs.appendFile(file, row({ type: "user_message", content: "valid tail" }).trimEnd()); await parity(file);
    await repairSessionTailForAppend(file); await parity(file);
  });
  await test("recovery facts append without duplicating synthetic results", async (file) => {
    const events: SessionEvent[] = [
      { type: "user_message", content: "crashed during a tool" },
      { type: "tool_call", tool: "Read", toolCallId: "call", sequence: 1, args: { path: "file.txt" } },
      { type: "tool_execution", tool: "Read", toolCallId: "call", sequence: 1, operationId: "op", state: "unknown", outcomeUnknownReason: "host_restarted" }
    ];
    await fs.writeFile(file, events.map(row).join(""));
    const before = await readSessionEvents(file);
    const recovered = replaySessionEvents(before);
    assert.equal(recovered.recoveredToolResults.length, 1);
    await fs.appendFile(file, recovered.recoveredToolResults.map(row).join(""));
    const after = await parity(file);
    const replay = replaySessionEvents(after);
    assert.equal(replay.recoveredToolResults.length, 0);
    assert.deepEqual(replay.messages, replaySessionEvents(parseSessionEvents(await fs.readFile(file, "utf8"))).messages);
    assert.equal(JSON.stringify(replay.messages), JSON.stringify(recovered.messages), "persistence only removes undefined fields");
    assert.equal(before.length, 3, "recovery must not mutate the cached source snapshot");
  });
  await test("corrupt rows retain exact line numbers and invalid runtime rejects", async (file) => {
    await fs.writeFile(file, row({ type: "user_message", content: "start" }) + "\n"); await parity(file);
    await fs.appendFile(file, "{broken}\n");
    await assert.rejects(readSessionEvents(file), /Invalid JSONL event at line 3/u);
    await fs.writeFile(file, row({ type: "user_message", content: "start" })); await parity(file);
    await fs.appendFile(file, '{"type":"user_message","content":"bad","runtime":{"eventSeq":-1}}\n');
    await assert.rejects(readSessionEvents(file), /Invalid runtime event metadata at line 2/u);
  });
  await test("warm cache cannot bypass symlink hardlink or size guards", async (file) => {
    await fs.writeFile(file, row({ type: "user_message", content: "start" })); await readSessionEvents(file);
    await fs.link(file, `${file}.link`); await assert.rejects(readSessionEvents(file), /single-link/u);
    await fs.unlink(`${file}.link`); await parity(file);
    await fs.rename(file, `${file}.real`); await fs.symlink(`${file}.real`, file); await assert.rejects(readSessionEvents(file));
    await fs.unlink(file); await fs.rename(`${file}.real`, file); await parity(file);
    await fs.truncate(file, maxSessionFileBytes + 1); await assert.rejects(readSessionEvents(file), /maximum size/u);
  });
  await test("appended event and line caps apply to full history", async (file) => {
    const event = row({ type: "user_message", content: "x" });
    await fs.writeFile(file, event.repeat(maxSessionEvents)); await readSessionEvents(file);
    await fs.appendFile(file, event); await assert.rejects(readSessionEvents(file), /more than 50000 events/u);
    await fs.writeFile(file, event); await readSessionEvents(file);
    await fs.appendFile(file, "x".repeat(maxSessionEventLineBytes + 1));
    await assert.rejects(readSessionEvents(file), /line 2 exceeds/u);
  });
  await test("prebuilt tree avoids reconstructing canonical nodes", async () => {
    let reads = 0;
    const event: SessionEvent = { type: "user_message", content: "question", messageId: "u" };
    const events = [new Proxy(event, { get(target, property, receiver): unknown { if (property === "content") reads++; return Reflect.get(target, property, receiver); } })];
    const nodes = sessionMessageTree(events);
    const before = reads;
    assert.deepEqual([...activeSessionMessageIds(events, nodes)], ["u"]);
    assert.equal(reads, before, "activity selection must reuse supplied tree");
  });
} finally { await fs.rm(root, { recursive: true, force: true }); clearSessionParseCache(); }
assert.equal(failures, 0, `${failures} history hot-path tests failed`);
console.log("session history hot-path tests passed");
