/** 自动化只创建和读取快照；日期详情与时间线索按真实时刻排序，不执行任务。 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scheduledTemporalRows } from "../src/desktop/temporalMemoryService.js";
import { AutomationStore, type AutomationRecord } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readAutomationCreateInput } from "../src/runtime/host/validation.js";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";

const range = { startDate: "2035-06-12", endDate: "2035-06-13", timeZone: "UTC" };

async function withAutomations(inputs: Array<{ id: string; at: string }>, run: (
  snapshot: AutomationRecord[], service: DateReferenceDetailService
) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-scheduled-display-order-")));
  const previousRoot = process.env.BINY_AGENT_DIR;
  const stateRoot = path.join(root, "state");
  process.env.BINY_AGENT_DIR = stateRoot;
  let authority: RuntimeEventAuthority | undefined;
  let store: AutomationStore | undefined;
  const service = new DateReferenceDetailService(stateRoot);
  try {
    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    store = await AutomationStore.open(root, authority);
    for (const input of inputs) {
      const created = store.create(readAutomationCreateInput({ automationId: input.id, name: input.id,
        triggerType: "once", schedule: { at: input.at }, executionTemplate: { prompt: "Synthetic fixture; never execute" } }));
      assert.equal(created.schedule.at, input.at, "the public Host/create path preserves the original spelling");
      assert.equal(created.nextFireAt, new Date(input.at).toISOString());
    }
    store.close();
    authority.close();
    authority = await RuntimeEventAuthority.openReadOnly(root);
    assert.ok(authority);
    store = await AutomationStore.open(root, authority);
    const snapshot = store.list();
    const before = structuredClone(snapshot);
    await run(snapshot, service);
    assert.deepEqual(snapshot, before, "display queries must not mutate their input snapshot");
    assert.deepEqual(store.list(), before, "display queries must not rewrite persisted schedules or derived nextFireAt");
    assert.deepEqual(store.listPending(), [], "creating and displaying fixtures must not execute or discover fires");
  } finally {
    service.close();
    store?.close();
    authority?.close();
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

await test("both scheduled displays order persisted offsets and optional fractions by instant", async () => {
  await withAutomations([
    { id: "earlier", at: "2035-06-12T20:00:00+08:00" },
    { id: "whole-second", at: "2035-06-12T12:30:00Z" },
    { id: "plus-100ms", at: "2035-06-12T12:30:00.1Z" },
    { id: "later", at: "2035-06-12T09:00:00-04:00" }
  ], async (snapshot, service) => {
    const detail = await service.query(range, [], { automations: snapshot });
    const rows = scheduledTemporalRows([{ projectId: "p1", automations: snapshot }], range, range.timeZone, 0);
    const expected = ["earlier", "whole-second", "plus-100ms", "later"];
    assert.deepEqual(detail.scheduled.map((hit) => hit.automationId), expected);
    assert.deepEqual(rows.map((hit) => hit.automationId), expected);
    for (const hit of [...detail.scheduled, ...rows]) {
      assert.equal(hit.dueAt, snapshot.find((record) => record.automationId === hit.automationId)?.schedule.at);
      assert.equal("instant" in hit, false, "parsed sort keys are private to this query");
    }
    assert.equal(detail.hasMore.scheduled, false);
    assert.deepEqual(detail.runs, []);
  });
});

for (const sameSpelling of [false, true]) {
  await test(`scheduled ties preserve each surface's existing policy (${sameSpelling ? "same spelling" : "equivalent instants"})`, async () => {
    await withAutomations([
      { id: "z-first", at: sameSpelling ? "2035-06-12T12:00:00Z" : "2035-06-12T20:00:00+08:00" },
      { id: "a-second", at: "2035-06-12T12:00:00Z" },
      { id: "m-third", at: sameSpelling ? "2035-06-12T12:00:00Z" : "2035-06-12T08:00:00-04:00" }
    ], async (snapshot, service) => {
      const detail = await service.query(range, [], { automations: snapshot });
      assert.deepEqual(detail.scheduled.map((hit) => hit.automationId), snapshot.map((record) => record.automationId),
        "date detail preserves stable snapshot order for equal instants");
      const rows = scheduledTemporalRows([{ projectId: "p1", automations: snapshot }], range, range.timeZone, 0);
      assert.deepEqual(rows.map((hit) => hit.automationId), ["a-second", "m-third", "z-first"],
        "Time Clues retains its row-ID tie-breaker");
      const projects = scheduledTemporalRows([{ projectId: "z-project", automations: snapshot },
        { projectId: "a-project", automations: snapshot }], range, range.timeZone, 0);
      assert.deepEqual(projects.map((hit) => hit.id), ["a-project", "z-project"].flatMap((projectId) =>
        ["a-second", "m-third", "z-first"].map((automationId) => `automation:${projectId}:${automationId}`)),
      "the existing tie key includes project identity");
    });
  });
}

await test("date detail caps the earliest 100 schedules while Time Clues remains uncapped", async () => {
  await withAutomations([
    ...Array.from({ length: 100 }, (_, index) => ({ id: `later-${String(index).padStart(3, "0")}`, at: "2035-06-12T08:00:00-04:00" })),
    { id: "first", at: "2035-06-12T17:00:00+08:00" }
  ], async (snapshot, service) => {
    const detail = await service.query(range, [], { automations: snapshot });
    assert.deepEqual(detail.scheduled.map((hit) => hit.automationId), ["first", ...snapshot.slice(0, 99).map((record) => record.automationId)]);
    assert.equal(detail.hasMore.scheduled, true);
    const full = await service.query(range, [], { automations: snapshot.slice(0, 100) });
    assert.equal(full.scheduled.length, 100);
    assert.equal(full.hasMore.scheduled, false);
    const rows = scheduledTemporalRows([{ projectId: "p1", automations: snapshot }], range, range.timeZone, 0);
    assert.equal(rows.length, 101);
    assert.equal(rows[0]?.automationId, "first");
    assert.deepEqual(scheduledTemporalRows([{ projectId: "p1", automations: snapshot }], range, range.timeZone, 50), []);
  });
});

await test("scheduled displays keep half-open local-day bounds and skip unusable snapshot rows", async () => {
  await withAutomations([
    { id: "before", at: "2035-06-12T07:59:59.999+08:00" },
    { id: "start", at: "2035-06-12T08:00:00+08:00" },
    { id: "last", at: "2035-06-12T18:59:59.999-05:00" },
    { id: "end", at: "2035-06-13T08:00:00+08:00" }
  ], async (snapshot, service) => {
    const template = snapshot[0]!;
    const rows: AutomationRecord[] = [...snapshot,
      { ...template, automationId: "invalid", schedule: { at: "invalid" } },
      { ...template, automationId: "missing", schedule: {} },
      { ...template, automationId: "cron", triggerType: "cron", schedule: { at: "2035-06-12T12:00:00Z", cron: "* * * * *" } }
    ];
    const detail = await service.query(range, [], { automations: rows });
    assert.deepEqual(detail.scheduled.map((hit) => hit.automationId), ["start", "last"]);
    const clues = scheduledTemporalRows([{ projectId: "p1", automations: rows }], range, range.timeZone, 0);
    assert.deepEqual(clues.map((hit) => hit.automationId), ["start", "last"]);
    const localRange = { startDate: "2035-06-12", endDate: "2035-06-13", timeZone: "Asia/Shanghai" };
    const localDetail = await service.query(localRange, [], { automations: snapshot });
    assert.deepEqual(localDetail.scheduled.map((hit) => hit.automationId), ["before", "start"]);
    assert.deepEqual(scheduledTemporalRows([{ projectId: "p1", automations: snapshot }], localRange, localRange.timeZone, 0)
      .map((hit) => hit.automationId), ["before", "start"]);
  });
});
