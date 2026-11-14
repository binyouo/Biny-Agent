import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

await test("task pages batch attempt reads without changing order, filters or workspace isolation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-task-list-batch-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const foreign = await RuntimeEventAuthority.open(root, { workspaceId: "foreign", reconcileSessions: false });
  const foreignTasks = await DurableTaskRunStore.open(root, foreign);
  try {
    const ids = Array.from({ length: 1_001 }, (_, i) => i === 0 ? "任务'🦋" : `task-${i}`);
    for (const [i, id] of ids.entries()) tasks.create({ taskRunId: id, task: { prompt: id }, sessionId: i % 2 ? "odd" : "even" });
    // Interleave attempts globally; each task must retain insertion, not timestamp or lexical order.
    for (const n of [2, 0, 1]) for (const id of ids.slice(0, 100)) {
      tasks.createAttempt(id, { attemptId: `${id}:attempt:${n}`, runId: `${id}:run:${n}`, turnId: `${id}:turn:${n}` });
    }
    foreignTasks.create({ taskRunId: "foreign-task", task: "foreign" });
    foreignTasks.createAttempt("foreign-task", { attemptId: "foreign-attempt" });
    tasks.transition(ids[1]!, "cancelled");
    const expected = new Map(ids.map(id => [id, tasks.get(id)!]));
    const before = authority.readEvents();
    const database = authority.databaseHandle();
    const original = database.prepare.bind(database);
    const calls: string[] = [];
    const spy = t.mock.method(database, "prepare", (sql: string) => { calls.push(sql); return original(sql); });
    const read = (options: Parameters<DurableTaskRunStore["list"]>[0], selected: string[], hasMore: boolean) => {
      calls.length = 0;
      const page = tasks.list(options);
      assert.deepEqual(page.tasks, selected.map(id => expected.get(id)));
      assert.equal(page.hasMore, hasMore);
      assert.ok(calls.length <= (selected.length ? 2 : 1), `page used ${calls.length} SQL preparations instead of at most two`);
      return page;
    };
    read({ limit: 100 }, ids.slice(0, 100), true);
    const first = read({ limit: 1_000 }, ids.slice(0, 1_000), true);
    read({ limit: 1_000, cursor: first.nextCursor }, ids.slice(1_000), false);
    const desc = read({ limit: 100, order: "desc" }, ids.slice(-100).reverse(), true);
    read({ limit: 1, order: "desc", cursor: desc.nextCursor }, [ids[900]!], true);
    read({ sessionId: "even", status: "created", limit: 100 }, ids.filter((_, i) => i % 2 === 0).slice(0, 100), true);
    read({ status: "cancelled", limit: 100 }, [ids[1]!], false);
    read({ sessionId: "missing" }, [], false);
    database.exec("DROP INDEX IF EXISTS task_attempts_task_run_idx");
    read({ limit: 100 }, ids.slice(0, 100), true);
    spy.mock.restore();
    assert.deepEqual(authority.readEvents(), before, "listing adds no runtime events");
    assert.deepEqual(tasks.get(ids[0]!)!.attempts.map(a => a.attemptId), [2, 0, 1].map(n => `${ids[0]}:attempt:${n}`));
    assert.equal(foreignTasks.list().tasks.length, 1);
  } finally {
    foreignTasks.close(); foreign.close(); tasks.close(); authority.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
