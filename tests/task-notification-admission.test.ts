/** Real communication, task store, authority and SQLite reopen; no Worker/provider execution. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";

async function fixture(run: (f: {
  tasks: DurableTaskRunStore; channel: TaskCommunication;
  create: (definition: unknown, checkpoint: unknown, id?: string, owner?: string) => string;
  reopen: () => Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-notification-admission-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let authority: RuntimeEventAuthority | undefined;
  let tasks: DurableTaskRunStore | undefined;
  let channel: TaskCommunication | undefined;
  const open = async () => {
    authority = await RuntimeEventAuthority.open(workspace, { reconcileSessions: false });
    tasks = await DurableTaskRunStore.open(workspace, authority); channel = new TaskCommunication(tasks, "parent");
  };
  const close = () => { channel?.close(); tasks?.close(); authority?.close(); };
  try {
    await open();
    await run({
      get tasks() { return tasks!; }, get channel() { return channel!; },
      create(definition, checkpoint, id = "child", owner = "parent") {
        tasks!.create({ taskRunId: id, sessionId: owner, task: definition });
        const attempt = tasks!.createAttempt(id);
        tasks!.transition(id, "queued");
        tasks!.transition(id, "running", { attemptId: attempt.attemptId, artifacts: { workerExecution: checkpoint } });
        return attempt.attemptId;
      },
      async reopen() { close(); await open(); }
    });
  } finally {
    close(); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

for (const [label, definition, checkpoint] of [
  ["definition only", { prompt: "inspect", communication: true }, { prompt: "inspect", communication: false }],
  ["legacy string checkpoint", "inspect", { prompt: "inspect", communication: true }],
  ["object checkpoint", { prompt: "inspect" }, { prompt: "inspect", communication: true }],
  ["checkpoint with false definition", { prompt: "inspect", communication: false }, { prompt: "inspect", communication: true }],
  ["checkpoint without definition", undefined, { prompt: "inspect", communication: true }]
] as const) {
  test(`${label} admission delivers durable reports and terminal evidence exactly once`, async () => {
    await fixture(async f => {
      const attemptId = f.create(definition, checkpoint);
      assert.equal((await f.channel.inspect("child")).inputOpen, true);
      const input = f.channel.send("child", "parent context", "context");
      const worker = f.channel.worker("child", attemptId); worker.delivered([input.id]);
      const report = worker.report("material finding", "report");
      assert.equal(f.channel.messages("child").filter(message => message.direction === "worker").length, 1);
      assert.equal(f.channel.notifications().length, 1);
      await f.reopen();
      const notices = f.channel.notifications(); assert.equal(notices.length, 1);
      assert.deepEqual(notices[0]!.messageIds, [report.id]); assert.equal(notices[0]!.terminal, false);
      assert.match(notices[0]!.content, /material finding/u);
      f.channel.acknowledge(notices[0]!);
      const revision = f.tasks.get("child")!.revision;
      f.channel.acknowledge(notices[0]!); assert.equal(f.tasks.get("child")!.revision, revision);
      const artifacts = f.tasks.get("child")!.attempts.at(-1)!.artifacts as Record<string, unknown>;
      f.tasks.transition("child", "completed", { attemptId, artifacts: { ...artifacts, output: "final result" } });
      const terminal = f.channel.notifications(); assert.equal(terminal.length, 1); assert.equal(terminal[0]!.terminal, true);
      assert.match(terminal[0]!.content, /final result/u); f.channel.acknowledge(terminal[0]!);
      await f.reopen(); assert.deepEqual(f.channel.notifications(), []);
      assert.equal(f.channel.messages("child").find(message => message.id === report.id)?.delivered, true);
    });
  });
}

for (const [label, definition, checkpoint] of [
  ["missing", "inspect", { prompt: "inspect" }],
  ["false", { communication: false }, { communication: false }],
  ["truthy", { communication: "true" }, { communication: 1 }],
  ["null", null, null]
] as const) {
  test(`${label} admission never leaks stored historical reports or terminal output`, async () => {
    await fixture(async f => {
      const attemptId = f.create(definition, checkpoint);
      assert.equal((await f.channel.inspect("child")).inputOpen, false);
      assert.throws(() => f.channel.send("child", "context"), /communication admission/u);
      const artifacts = { workerExecution: checkpoint, communication: { inputClosed: false, messages: [{ id: "old-report", direction: "worker", content: "historical", createdAt: "2026-01-01T00:00:00.000Z" }] } };
      f.tasks.transition("child", "running", { attemptId, artifacts });
      assert.deepEqual(f.channel.notifications(), []);
      f.tasks.transition("child", "completed", { attemptId, artifacts: { ...artifacts, output: "terminal" } });
      await f.reopen(); assert.deepEqual(f.channel.notifications(), []);
    });
  });
}

test("notifyParent=false suppresses terminal notices but not admitted checkpoint progress reports", async () => {
  await fixture(async f => {
    const attemptId = f.create({ prompt: "inspect", notifyParent: false }, { prompt: "inspect", communication: true });
    f.channel.worker("child", attemptId).report("progress", "one");
    const notices = f.channel.notifications(); assert.equal(notices.length, 1); assert.equal(notices[0]!.terminal, false);
    f.channel.acknowledge(notices[0]!);
    const artifacts = f.tasks.get("child")!.attempts.at(-1)!.artifacts as Record<string, unknown>;
    f.tasks.transition("child", "completed", { attemptId, artifacts: { ...artifacts, output: "done" } });
    await f.reopen(); assert.deepEqual(f.channel.notifications(), []);
  });
});

test("checkpoint reports remain confined to the receiving session and foreign acknowledgements fail", async () => {
  await fixture(async f => {
    const attemptId = f.create("inspect", { prompt: "inspect", communication: true }, "foreign", "other");
    const other = new TaskCommunication(f.tasks, "other");
    try {
      other.worker("foreign", attemptId).report("private report", "one");
      assert.deepEqual(f.channel.notifications(), []);
      const notices = other.notifications(); assert.equal(notices.length, 1);
      assert.throws(() => f.channel.acknowledge(notices[0]!), /another session/u);
      assert.equal(other.notifications().length, 1); other.acknowledge(notices[0]!);
      assert.deepEqual(other.notifications(), []);
    } finally { other.close(); }
  });
});

test("checkpoint source is read fresh and report delivery keeps the existing budget and order", async () => {
  await fixture(async f => {
    const attemptId = f.create("inspect", { prompt: "inspect", communication: true });
    const worker = f.channel.worker("child", attemptId);
    for (let i = 0; i < 6; i++) worker.report(`finding ${String(i)}`, String(i));
    const initial = f.channel.notifications(); assert.equal(initial.length, 4);
    assert.ok(initial.reduce((sum, notice) => sum + notice.content.length, 0) <= 6000);
    assert.deepEqual(f.channel.notifications(0), []);
    const artifacts = f.tasks.get("child")!.attempts.at(-1)!.artifacts as Record<string, unknown>;
    f.tasks.transition("child", "running", { attemptId, artifacts: { ...artifacts, workerExecution: { prompt: "inspect", communication: false } } });
    assert.deepEqual(f.channel.notifications(), []);
    f.tasks.transition("child", "running", { attemptId, artifacts });
    for (const notice of f.channel.notifications()) f.channel.acknowledge(notice);
    const remaining = f.channel.notifications(); assert.equal(remaining.length, 2);
    assert.match(remaining[0]!.content, /finding 4/u); assert.match(remaining[1]!.content, /finding 5/u);
  });
});

test("admitted tasks without an attempt or after channel closure do not create receipts", async () => {
  await fixture(async f => {
    f.tasks.create({ taskRunId: "empty", sessionId: "parent", task: { communication: true } });
    assert.deepEqual(f.channel.notifications(), []);
    const attemptId = f.create("inspect", { prompt: "inspect", communication: true });
    f.channel.worker("child", attemptId).report("report", "one");
    const notice = f.channel.notifications()[0]!; assert.ok(notice);
    const revision = f.tasks.get("child")!.revision; f.channel.close();
    assert.throws(() => f.channel.acknowledge(notice), /closed/u); assert.equal(f.tasks.get("child")!.revision, revision);
  });
});

test("only the latest attempt supplies admission and stale notices cannot create receipts", async () => {
  await fixture(async f => {
    const first = f.create("inspect", { prompt: "inspect", communication: true });
    f.channel.worker("child", first).report("old finding", "old");
    const stale = f.channel.notifications()[0]!; assert.ok(stale);
    f.tasks.transition("child", "queued", { attemptId: first });
    const next = f.tasks.createAttempt("child");
    f.tasks.transition("child", "running", { attemptId: next.attemptId, artifacts: { workerExecution: { prompt: "next", communication: false } } });
    assert.deepEqual(f.channel.notifications(), []);
    const revision = f.tasks.get("child")!.revision;
    f.channel.acknowledge(stale); assert.equal(f.tasks.get("child")!.revision, revision);
    assert.equal(f.tasks.hasMessageReceipt("child", stale.id), false);
    f.tasks.transition("child", "running", { attemptId: next.attemptId, artifacts: { workerExecution: { prompt: "next", communication: true } } });
    f.channel.worker("child", next.attemptId).report("new finding", "new");
    const notices = f.channel.notifications(); assert.equal(notices.length, 1);
    assert.equal(notices[0]!.attemptId, next.attemptId); assert.match(notices[0]!.content, /new finding/u); assert.doesNotMatch(notices[0]!.content, /old finding/u);
  });
});
