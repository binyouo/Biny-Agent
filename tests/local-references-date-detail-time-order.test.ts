/** 日期详情按真实时刻排序导入的会话，再应用结果上限；原始时间戳保持不变。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DateReferenceDetailService, type DateReferenceDetail } from "../src/session/dateReferenceDetail.js";
import type { DateReferenceRange } from "../src/session/dateReference.js";
import { readSessionEvents, type SessionEvent } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { BINY_BUNDLE_FORMAT, BINY_BUNDLE_VERSION, importSessionFile } from "../src/session/transfer.js";

const range: DateReferenceRange = { startDate: "2027-01-01", endDate: "2027-01-02", timeZone: "UTC" };

function messages(entries: Array<[string, string | undefined]>): SessionEvent[] {
  return entries.map(([messageId, time], index) => ({ type: "user_message", messageId, content: messageId, time,
    parentMessageId: index === 0 ? undefined : entries[index - 1]![0] }));
}

async function queryImported(sessions: SessionEvent[][], selectedRange = range): Promise<{
  detail: DateReferenceDetail; sessionIds: string[];
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-date-detail-time-order-")));
  const previousRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const service = new DateReferenceDetailService(root);
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await ensureAgentDirs(workspace);
    const importedFiles: Array<{ path: string; contents: string }> = [];
    const sessionIds: string[] = [];
    for (const [index, events] of sessions.entries()) {
      const source = path.join(root, `source-${index}.json`);
      const contents = JSON.stringify({ format: BINY_BUNDLE_FORMAT, version: BINY_BUNDLE_VERSION,
        manifest: { sessionId: `source-${index}`, exportedAt: "2027-01-02T00:00:00.000Z", eventCount: events.length,
          attachmentCount: 0, skippedAttachments: [] }, events, attachments: [] });
      await writeFile(source, contents);
      // CLI session import and Desktop import both call this public file importer.
      const imported = await importSessionFile(workspace, source);
      assert.equal(imported.format, "biny");
      assert.deepEqual((await readSessionEvents(imported.filePath)).map((event) => event.time), events.map((event) => event.time),
        "the supported import/read path must preserve timestamp spelling");
      importedFiles.push({ path: source, contents }, { path: imported.filePath, contents: await readFile(imported.filePath, "utf8") });
      sessionIds.push(imported.sessionId);
    }
    const detail = await service.query(selectedRange, [{ id: "synthetic-project", path: workspace }]);
    for (const file of importedFiles) assert.equal(await readFile(file.path, "utf8"), file.contents,
      "date lookup must not rewrite either source bundles or imported session events");
    return { detail, sessionIds };
  } finally {
    service.close();
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

await test("imported offsets sort by instant across a year boundary", async () => {
  const { detail } = await queryImported([messages([
    ["earlier", "2027-01-01T09:00:00+09:00"],
    ["middle", "2026-12-31T23:45:00-01:00"],
    ["later", "2027-01-01T01:00:00Z"]
  ])]);
  assert.deepEqual(detail.conversations.map((hit) => hit.messageId), ["earlier", "middle", "later"]);
  assert.deepEqual(detail.conversations.map((hit) => hit.time), [
    "2027-01-01T09:00:00+09:00", "2026-12-31T23:45:00-01:00", "2027-01-01T01:00:00Z"
  ]);
  assert.equal(detail.hasMore.conversations, false);
});

await test("UTC timestamps with optional fractions retain chronological order", async () => {
  const { detail } = await queryImported([messages([
    ["whole-second", "2027-01-01T00:00:00Z"],
    ["millisecond", "2027-01-01T00:00:00.001Z"],
    ["tenth-second", "2027-01-01T00:00:00.1Z"]
  ])]);
  assert.deepEqual(detail.conversations.map((hit) => hit.messageId), ["whole-second", "millisecond", "tenth-second"]);
});

await test("the 100-message cap keeps the earliest instants from an imported active path", async () => {
  const entries: Array<[string, string]> = [["first", "2027-01-01T09:00:00+09:00"],
    ...Array.from({ length: 100 }, (_, index): [string, string] => [
      `later-${index}`, new Date(Date.parse("2027-01-01T00:00:00Z") + (index + 1) * 60_000).toISOString()
    ])];
  const { detail } = await queryImported([messages(entries)]);
  assert.deepEqual(detail.conversations.map((hit) => hit.messageId), entries.slice(0, 100).map(([id]) => id));
  assert.equal(detail.hasMore.conversations, true);
  const full = await queryImported([messages(entries.slice(0, 100))]);
  assert.equal(full.detail.conversations.length, 100);
  assert.equal(full.detail.hasMore.conversations, false);
});

await test("equal instants retain session-ID ordering and stable in-session order", async () => {
  const { detail, sessionIds } = await queryImported([
    messages([["a-first", "2027-01-01T09:00:00+09:00"], ["a-second", "2027-01-01T00:00:00Z"]]),
    messages([["b-first", "2027-01-01T00:00:00.000Z"], ["b-second", "2026-12-31T19:00:00-05:00"]])
  ]);
  const expected = sessionIds.map((sessionId, index) => ({ sessionId, ids: index === 0 ? ["a-first", "a-second"] : ["b-first", "b-second"] }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  assert.deepEqual(detail.conversations.map((hit) => [hit.sessionId, hit.messageId]),
    expected.flatMap((session) => session.ids.map((id) => [session.sessionId, id])));
});

await test("identically serialized ties keep the existing session and source ordering", async () => {
  const time = "2027-01-01T00:00:00.000Z";
  const { detail, sessionIds } = await queryImported([
    messages([["a-first", time], ["a-second", time]]),
    messages([["b-first", time], ["b-second", time]])
  ]);
  const expected = sessionIds.map((sessionId, index) => ({ sessionId, ids: index === 0 ? ["a-first", "a-second"] : ["b-first", "b-second"] }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  assert.deepEqual(detail.conversations.map((hit) => [hit.sessionId, hit.messageId]),
    expected.flatMap((session) => session.ids.map((id) => [session.sessionId, id])));
});

await test("invalid, missing and half-open boundary timestamps remain filtered", async () => {
  const { detail } = await queryImported([messages([
    ["before", "2027-01-01T08:59:59.999+09:00"],
    ["start", "2027-01-01T09:00:00+09:00"],
    ["invalid", "not-a-timestamp"], ["missing", undefined],
    ["last", "2027-01-01T18:59:59.999-05:00"],
    ["end", "2027-01-02T09:00:00+09:00"]
  ])]);
  assert.deepEqual(detail.conversations.map((hit) => hit.messageId), ["start", "last"]);
});

await test("selected branches and canonical timestamps still determine the eligible messages", async () => {
  const { detail } = await queryImported([[
    { type: "user_message", messageId: "root", content: "root", time: "2027-01-01T00:00:00Z" },
    { type: "user_message", messageId: "old", parentMessageId: "root", slotId: "choice", content: "old", time: "2027-01-01T00:00:01Z" },
    { type: "user_message", messageId: "selected", parentMessageId: "root", slotId: "choice", content: "selected", time: "2027-01-01T00:00:02Z" },
    { type: "message_version_selected", slotId: "choice", messageId: "selected" },
    { type: "agent_message", messageId: "reply", parentMessageId: "selected", time: "2027-01-01T09:00:03+09:00",
      message: { role: "assistant", content: [{ type: "text", text: "canonical reply" }] } },
    { type: "assistant_message", messageId: "reply", content: "later projection", time: "2027-01-02T00:00:00Z" }
  ]]);
  assert.deepEqual(detail.conversations.map((hit) => [hit.messageId, hit.quote]),
    [["root", "root"], ["selected", "selected"], ["reply", "canonical reply"]]);
  assert.equal(detail.conversations[2]?.time, "2027-01-01T09:00:03+09:00");
});
