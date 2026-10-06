/** 日期详情复用单次查询内的日期格式器，不跨查询缓存时区或改变校验、来源及日期边界。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import type { DateReferenceRange } from "../src/session/dateReference.js";
import { DateReferenceDetailService, type DateReferenceDetail } from "../src/session/dateReferenceDetail.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-date-formatter-"));
const NativeDateTimeFormat = Intl.DateTimeFormat;
const constructions: Array<{ timeZone?: string; day: boolean }> = [];
Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, {
  construct(target, args: [Intl.LocalesArgument?, Intl.DateTimeFormatOptions?]) {
    const options = args[1];
    constructions.push({ timeZone: options?.timeZone,
      day: options?.year === "numeric" && options.month === "2-digit" && options.day === "2-digit" });
    return Reflect.construct(target, args);
  }
});
const dayConstructions = () => constructions.filter((item) => item.day);
const range: DateReferenceRange = { startDate: "2026-11-01", endDate: "2026-11-02", timeZone: "America/New_York" };
const service = new DateReferenceDetailService(root);
try {
  await service.query(range, []);
  assert.deepEqual(dayConstructions(), [], "an empty query does not need a day formatter");
  assert.equal(constructions.length, 1, "range time zone validation still runs");

  constructions.length = 0;
  await service.query(range, [], {
    automations: [{ automationId: "invalid", name: "Invalid", triggerType: "once", schedule: { at: "invalid" } }],
    tasks: { tasks: [{ taskRunId: "invalid", createdAt: "invalid" }] },
    pendingFires: [{ fireId: "invalid", scheduledAt: "invalid" }]
  });
  assert.deepEqual(dayConstructions(), [], "invalid timestamps must be rejected before formatter creation");

  const controller = new AbortController();
  const aborted = new Error("Query cancelled");
  controller.abort(aborted);
  for (const [invalidRange, message, validationCount] of [
    [{ ...range, startDate: "2026-02-30" }, "Invalid date reference day.", 0],
    [{ ...range, endDate: range.startDate }, "Invalid date reference range.", 0],
    [{ ...range, timeZone: "Invalid/Zone" }, "Invalid date reference time zone.", 1]
  ] as const) {
    constructions.length = 0;
    await assert.rejects(service.query(invalidRange, [], {}, controller.signal), { message });
    assert.equal(constructions.length, validationCount, "range validation must still precede abort handling");
    assert.equal(dayConstructions().length, 0);
  }
  constructions.length = 0;
  await assert.rejects(service.query(range, [], {}, controller.signal), (error: unknown) => error === aborted);
  assert.equal(constructions.length, 1);
  assert.equal(dayConstructions().length, 0, "a pre-aborted query must not create a day formatter");

  const blockedRoot = path.join(root, "not-a-directory");
  await writeFile(blockedRoot, "synthetic obstruction");
  const blocked = new DateReferenceDetailService(blockedRoot);
  constructions.length = 0;
  try {
    await assert.rejects(blocked.query(range, [], { tasks: { tasks: [{ taskRunId: "t", createdAt: "2026-11-01T12:00:00Z" }] } }),
      (error: unknown) => error instanceof Error && "code" in error && ["EEXIST", "ENOTDIR"].includes(String(error.code)));
    assert.equal(dayConstructions().length, 0, "an index failure still happens before day formatter construction");
  } finally { blocked.close(); }

  const instants = [
    "2026-11-01T03:59:59Z", // Just before New York's local day.
    "2026-11-01T00:00:00-04:00",
    "2026-11-01T01:30:00-04:00", // Both sides of the DST fold belong to the same day.
    "2026-11-01T01:30:00-05:00",
    "2026-11-02T04:59:59Z",
    "2026-11-02T00:00:00-05:00" // Exclusive local end.
  ];
  const workspace = path.join(root, "project");
  await mkdir(workspace);
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  const files: Array<{ file: string; content: string }> = [];
  for (let session = 0; session < 2; session += 1) {
    const events = instants.flatMap((time, index) => [
      { type: "agent_message", messageId: `m-${index}`, parentMessageId: index ? `m-${index - 1}` : undefined,
        time, message: { role: "assistant", content: [{ type: "text", text: `Canonical quote ${index}` }] } },
      { type: "assistant_message", messageId: `m-${index}`, time: "2026-11-01T12:00:00Z", content: "Later flat projection" }
    ]);
    const content = [...events,
      { type: "assistant_message", messageId: "invalid", time: "invalid", content: "Invalid date" },
      { type: "assistant_message", messageId: "audit", time: "2026-11-01T12:00:00Z", content: "Audit only", auditOnly: true },
      { type: "assistant_message", messageId: "blank", time: "2026-11-01T12:00:00Z", content: " \t " }
    ].map((event) => `${JSON.stringify(event)}\n`).join("");
    const file = path.join(directory, `thread-${session}.jsonl`);
    await writeFile(file, content);
    files.push({ file, content });
  }
  const runtime = {
    automations: instants.map((time, index) => ({ automationId: `a-${index}`, name: `Reminder ${index}`,
      triggerType: "once", schedule: { at: time }, status: "active", fireCount: index % 2 })),
    tasks: { tasks: instants.map((time, index) => ({ taskRunId: `t-${index}`, createdAt: time, status: "running" })) },
    pendingFires: instants.map((time, index) => ({ fireId: `f-${index}`, scheduledAt: time, status: "pending" }))
  };
  const projects = [{ id: "project", path: workspace }];
  function verify(detail: DateReferenceDetail, included: number[]): void {
    assert.deepEqual(detail.conversations.map((hit) => `${hit.sessionId}:${hit.messageId}`).sort(),
      [0, 1].flatMap((session) => included.map((index) => `thread-${session}:m-${index}`)).sort());
    for (const hit of detail.conversations) {
      const index = Number(hit.messageId.slice(2));
      assert.equal(hit.projectId, "project");
      assert.equal(hit.quote, `Canonical quote ${index}`);
      assert.equal(hit.time, instants[index], "original timestamp spelling and canonical provenance are retained");
    }
    assert.deepEqual(detail.scheduled.map((hit) => hit.automationId).sort(), included.map((index) => `a-${index}`).sort());
    assert.deepEqual(detail.runs.map((hit) => hit.id).sort(), included.flatMap((index) => [`t-${index}`, `f-${index}`]).sort());
    for (const hit of detail.scheduled) {
      const index = Number(hit.automationId.slice(2));
      assert.equal(hit.dueAt, instants[index]);
      assert.equal(hit.fired, index % 2 === 1);
      assert.equal(hit.status, "active");
    }
    assert.deepEqual(detail.hasMore, { conversations: false, clues: false, facts: false, scheduled: false, runs: false });
    assert.deepEqual(detail.clues, []);
    assert.deepEqual(detail.facts, []);
  }
  constructions.length = 0;
  const first = await service.query(range, projects, runtime);
  verify(first, [1, 2, 3, 4]);
  assert.deepEqual(dayConstructions(), [{ timeZone: range.timeZone, day: true }],
    "all conversations, schedules, tasks and fires share one query-local formatter");
  constructions.length = 0;
  assert.deepEqual(await service.query(range, projects, runtime), first);
  assert.equal(dayConstructions().length, 1, "a later query must create its own formatter");

  constructions.length = 0;
  const honolulu = { ...range, timeZone: "Pacific/Honolulu" };
  const [newYorkDetail, honoluluDetail] = await Promise.all([
    service.query(range, projects, runtime), service.query(honolulu, projects, runtime)
  ]);
  assert.deepEqual(newYorkDetail, first);
  verify(honoluluDetail, [4, 5]);
  assert.deepEqual(dayConstructions().map((item) => item.timeZone).sort(), [range.timeZone, honolulu.timeZone].sort(),
    "overlapping queries on one service must not share a formatter or time zone");

  for (const file of files) assert.equal(await readFile(file.file, "utf8"), file.content, "query leaves authoritative source bytes unchanged");
  console.log("local reference date detail formatter tests passed");
} finally {
  Intl.DateTimeFormat = NativeDateTimeFormat;
  service.close();
  await rm(root, { recursive: true, force: true });
}
