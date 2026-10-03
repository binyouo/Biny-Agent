/** 日期详情按会话内消息 ID 去重，优先 canonical 内容及时间，再应用日期范围和结果上限。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import type { DateReferenceRange } from "../src/session/dateReference.js";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";
import type { SessionEvent } from "../src/session/recorder.js";

const range: DateReferenceRange = { startDate: "2026-10-03", endDate: "2026-10-04", timeZone: "UTC" };
const time = "2026-10-03T03:00:00Z";

function canonical(messageId: string, content: string, sentAt: string | undefined = time, parentMessageId?: string): SessionEvent {
  return { type: "agent_message", messageId, parentMessageId, time: sentAt,
    message: { role: "assistant", content: [{ type: "text", text: content }] } };
}

function flat(messageId: string, content: string, sentAt: string | undefined = time): SessionEvent {
  return { type: "assistant_message", messageId, content, time: sentAt };
}

async function query(sessions: SessionEvent[][], selectedRange = range) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-date-dedupe-"));
  let service: DateReferenceDetailService | undefined;
  try {
    const workspace = path.join(root, "project");
    await mkdir(workspace);
    const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
    await mkdir(directory, { recursive: true });
    const files = sessions.map((events, index) => ({ file: path.join(directory, `thread-${index}.jsonl`),
      content: events.map((event) => JSON.stringify(event) + "\n").join("") }));
    for (const file of files) await writeFile(file.file, file.content);
    service = new DateReferenceDetailService(root);
    const detail = await service.query(selectedRange, [{ id: "p1", path: workspace }]);
    for (const file of files) assert.equal(await readFile(file.file, "utf8"), file.content, "query must leave raw session events unchanged");
    return detail;
  } finally {
    service?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const normal = await query([[
  { type: "user_message", messageId: "u1", content: "request", time },
  canonical("a1", "reply", "2026-10-03T03:00:01Z", "u1"),
  flat("a1", "reply", "2026-10-03T03:00:02Z")
]]);
assert.deepEqual(normal.conversations.map((hit) => hit.messageId), ["u1", "a1"], "a normal turn must include its assistant only once");
assert.equal(normal.conversations[1]?.time, "2026-10-03T03:00:01Z", "the canonical timestamp must win over the later projection");
assert.equal(normal.hasMore.conversations, false);

const reversed = await query([[
  flat("a1", "flat projection", "2026-10-03T03:00:01Z"),
  { type: "agent_message", messageId: "a1", time: "2026-10-03T03:00:02Z", message: { role: "assistant", content: [
    { type: "reasoning", text: "private reasoning" },
    { type: "text", text: "canonical first" },
    { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
    { type: "text", text: "canonical second" }
  ] } }
]]);
assert.deepEqual(reversed.conversations.map((hit) => ({ id: hit.messageId, quote: hit.quote, time: hit.time })),
  [{ id: "a1", quote: "canonical first\ncanonical second", time: "2026-10-03T03:00:02Z" }], "source priority must not depend on event order");

const midnight: SessionEvent[] = [canonical("a1", "canonical day", "2026-10-02T23:59:59Z"), flat("a1", "projection day", "2026-10-03T00:00:01Z")];
assert.deepEqual((await query([midnight])).conversations, [], "a projection must not move a canonical message into the following date");
assert.equal((await query([midnight], { ...range, startDate: "2026-10-02", endDate: "2026-10-03" })).conversations[0]?.quote, "canonical day");

const legacy = await query([[flat("a1", "same text"), flat("a1", "repeated event"), flat("a2", "same text")]]);
assert.deepEqual(legacy.conversations.map((hit) => [hit.messageId, hit.quote]), [["a1", "same text"], ["a2", "same text"]],
  "legacy-only assistants must remain visible, and distinct IDs must not be deduplicated by text");

const fallback = await query([[
  { ...canonical("a1", "undated"), time: undefined }, flat("a1", "dated legacy"),
  canonical("a2", "invalid timestamp", "invalid", "a1"), flat("a2", "valid timestamp"),
  canonical("a3", "", time, "a2"), flat("a3", "nonempty legacy")
]]);
assert.deepEqual(fallback.conversations.map((hit) => hit.quote), ["dated legacy", "valid timestamp", "nonempty legacy"],
  "unusable canonical records must not hide usable legacy projections");

const invalid = await query([[
  flat("", "empty ID"), flat("   ", "blank ID"), { type: "assistant_message", content: "missing ID", time },
  { ...flat("undated", "missing time"), time: undefined }, flat("invalid", "invalid time", "invalid"), flat("empty", ""),
  { ...flat("a1", "audit projection"), auditOnly: true }, flat("a1", "visible legacy"),
  { type: "message_metadata", messageId: "a1", metadata: { note: "control event" }, time },
  { type: "message_version_selected", messageId: "a1", slotId: "s1", time },
  { type: "turn_interrupted", reason: "interrupted", content: "control event", time }
]]);
assert.deepEqual(invalid.conversations.map((hit) => [hit.messageId, hit.quote]), [["a1", "visible legacy"]],
  "empty IDs, unusable records, audit events and timestamped control events must not create hits");

const separateSessions = await query([[canonical("a1", "first session"), flat("a1", "first projection")],
  [canonical("a1", "second session"), flat("a1", "second projection")]]);
assert.deepEqual(separateSessions.conversations.map((hit) => [hit.sessionId, hit.quote]),
  [["thread-0", "first session"], ["thread-1", "second session"]], "message IDs are scoped to their owning session");

function repeatedTurns(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `a${index}`;
    const sentAt = new Date(Date.parse(time) + index * 1_000).toISOString();
    return [canonical(id, `reply ${index}`, sentAt, index > 0 ? `a${index - 1}` : undefined), flat(id, `reply ${index}`, sentAt)];
  }).flat();
}

const fullPage = await query([repeatedTurns(100)]);
assert.deepEqual(fullPage.conversations.map((hit) => hit.messageId), Array.from({ length: 100 }, (_, index) => `a${index}`),
  "duplicate projections must not consume the 100-message limit");
assert.equal(fullPage.hasMore.conversations, false, "exactly 100 unique messages must not imply another page");
const overflow = await query([repeatedTurns(101)]);
assert.equal(overflow.conversations.length, 100);
assert.equal(new Set(overflow.conversations.map((hit) => hit.messageId)).size, 100);
assert.equal(overflow.conversations.at(-1)?.messageId, "a99");
assert.equal(overflow.hasMore.conversations, true, "hasMore must count unique messages");

console.log("local reference date detail dedupe tests passed");
