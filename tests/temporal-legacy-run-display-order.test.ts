/** 旧版真实 create/claimDue 投影：只验证显示顺序，不改写或执行旧任务。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";

interface PendingProjection { fireId: string; automationId: string; scheduledAt: string; status: string }
interface LegacyFixture {
  range: { startDate: string; endDate: string; timeZone: string };
  cases: Array<{ name: string; pendingFires: PendingProjection[]; expectedAutomationIds: string[] }>;
}

// The fixture records e62a055 Host validation -> create -> claimDue output after
// reopening through the supported schema 12-to-13 migration. Only random fire
// IDs are relabeled; timestamps, status and source order are preserved.
const fixture = JSON.parse(await readFile(new URL("./fixtures/legacy-pending-date-projection.json", import.meta.url), "utf8")) as LegacyFixture;

async function query(pendingFires: PendingProjection[], tasks: { tasks: unknown[] } = { tasks: [] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-legacy-run-display-"));
  const service = new DateReferenceDetailService(root);
  const before = structuredClone({ pendingFires, tasks });
  try {
    const result = await service.query(fixture.range, [], { pendingFires, tasks });
    assert.deepEqual({ pendingFires, tasks }, before, "display must leave the input projection unchanged");
    return result;
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const example of fixture.cases) {
  await test(example.name, async () => {
    const detail = await query(example.pendingFires);
    assert.deepEqual(detail.runs.map((run) => example.pendingFires.find((fire) => fire.fireId === run.id)?.automationId),
      example.expectedAutomationIds);
    assert.equal(detail.hasMore.runs, false);
    for (const run of detail.runs) {
      assert.equal(run.kind, "automation");
      assert.equal(run.status, "pending");
      assert.equal(run.occurredAt, example.pendingFires.find((fire) => fire.fireId === run.id)?.scheduledAt);
      assert.deepEqual(Object.keys(run).sort(), ["id", "kind", "occurredAt", "status"]);
    }
  });
}

await test("legacy run display applies its cap after chronological ordering", async () => {
  const examples = fixture.cases[0]!.pendingFires;
  const earlier = examples.find((fire) => fire.automationId === "earlier")!;
  const later = examples.find((fire) => fire.automationId === "later")!;
  // Scale the captured projection shapes; these copies are display fixtures,
  // not claims that new current-version discovery emits legacy timestamp forms.
  const pending = [...Array.from({ length: 100 }, (_, index) => ({ ...later, fireId: `later-${index}` })), earlier];
  const detail = await query(pending);
  assert.deepEqual(detail.runs.map((run) => run.id), [earlier.fireId, ...pending.slice(0, 99).map((fire) => fire.fireId)]);
  assert.equal(detail.hasMore.runs, true);
  const full = await query(pending.slice(0, 100));
  assert.equal(full.runs.length, 100);
  assert.equal(full.hasMore.runs, false);
});

await test("run display skips invalid records and preserves task-before-fire ties", async () => {
  const legacy = fixture.cases[0]!.pendingFires.find((fire) => fire.automationId === "earlier")!;
  const detail = await query([legacy, { ...legacy, fireId: "invalid", scheduledAt: "invalid" }], { tasks: [
    { taskRunId: "before", createdAt: "2035-06-12T11:00:00.000Z", status: "completed" },
    { taskRunId: "tied", createdAt: "2035-06-12T12:00:00.000Z", status: "completed" },
    { taskRunId: "after", createdAt: "2035-06-12T13:00:00.000Z", status: "running" },
    { taskRunId: "invalid-task", createdAt: "invalid", status: "failed" },
    { taskRunId: "missing-task-time", status: "failed" }
  ] });
  assert.deepEqual(detail.runs.map((run) => [run.id, run.kind]),
    [["before", "task"], ["tied", "task"], [legacy.fireId, "automation"], ["after", "task"]]);
  assert.equal(detail.runs[2]?.occurredAt, legacy.scheduledAt);
});
