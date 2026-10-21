import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

async function fixture(definition: unknown = "inspect", checkpoint: unknown = { prompt: "inspect" }, attempt = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-input-admission-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  tasks.create({ taskRunId: "child", sessionId: "parent", task: definition });
  const current = attempt ? tasks.createAttempt("child") : undefined;
  tasks.transition("child", "queued");
  if (current) tasks.transition("child", "running", { attemptId: current.attemptId, artifacts: { workerExecution: checkpoint } });
  const channel = new TaskCommunication(tasks, "parent");
  return { tasks, channel, current, snapshot: () => JSON.stringify({ task: tasks.get("child"), events: tasks.events("child") }),
    async close() { channel.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const [label, definition, checkpoint] of [
  ["legacy absent", "inspect", { prompt: "inspect" }],
  ["explicit false", { prompt: "inspect", communication: false }, { communication: false }],
  ["truthy not admitted", { communication: "true" }, { communication: 1 }]
] as const) {
  test(`${label}: inspection does not advertise unadmitted input`, async () => {
    const f = await fixture(definition, checkpoint);
    try {
      const before = f.snapshot();
      const full = await f.channel.inspect("child");
      const summary = await f.channel.inspect("child", { summary: true });
      assert.throws(() => f.channel.send("child", "new context", "new-message"), /communication admission/);
      assert.equal(f.snapshot(), before, "inspect and rejected send leave durable state unchanged");
      assert.deepEqual([full.inputOpen, summary.inputOpen], [false, false]);
    } finally { await f.close(); }
  });
}
for (const [label, definition, checkpoint] of [
  ["definition", { prompt: "inspect", communication: true }, { communication: false }],
  ["checkpoint", "inspect", { prompt: "inspect", communication: true }]
] as const) {
  test(`${label}: admitted open input remains available`, async () => {
    const f = await fixture(definition, checkpoint);
    try {
      const before = f.snapshot();
      assert.equal((await f.channel.inspect("child")).inputOpen, true);
      assert.equal((await f.channel.inspect("child", { summary: true })).inputOpen, true);
      assert.equal(f.snapshot(), before);
      assert.equal(f.channel.send("child", "new context", "new-message").content, "new context");
    } finally { await f.close(); }
  });
}
test("sealed admitted input remains closed and idempotent replay works", async () => {
  const f = await fixture({ communication: true });
  try {
    const sent = f.channel.send("child", "context", "original");
    const worker = f.channel.worker("child", f.current!.attemptId);
    worker.delivered([sent.id]); assert.equal(worker.seal(), true);
    assert.equal((await f.channel.inspect("child")).inputOpen, false);
    assert.throws(() => f.channel.send("child", "late", "late"), /no longer accepts/);
    assert.equal(f.channel.send("child", sent.content, sent.id).delivered, true);
  } finally { await f.close(); }
});
test("terminal admitted input remains closed", async () => {
  const f = await fixture({ communication: true });
  try {
    f.tasks.transition("child", "cancelled");
    assert.equal((await f.channel.inspect("child")).inputOpen, false);
    assert.throws(() => f.channel.send("child", "late"), /no longer accepts/);
  } finally { await f.close(); }
});
test("historical admitted attempt remains closed while latest stays open", async () => {
  const f = await fixture({ communication: true });
  try {
    f.tasks.transition("child", "queued", { attemptId: f.current!.attemptId });
    const next = f.tasks.createAttempt("child");
    f.tasks.transition("child", "queued");
    f.tasks.transition("child", "running", { attemptId: next.attemptId });
    const before = f.snapshot();
    assert.equal((await f.channel.inspect("child", { attemptId: f.current!.attemptId })).inputOpen, false);
    assert.equal((await f.channel.inspect("child")).inputOpen, true);
    assert.equal(f.snapshot(), before);
  } finally { await f.close(); }
});
test("foreign session cannot inspect or send, with unchanged durable state", async () => {
  const f = await fixture({ communication: true });
  const foreign = new TaskCommunication(f.tasks, "foreign");
  try {
    const before = f.snapshot();
    await assert.rejects(foreign.inspect("child"), /another session/);
    assert.throws(() => foreign.send("child", "wrong"), /another session/);
    assert.equal(f.snapshot(), before);
  } finally { foreign.close(); await f.close(); }
});
test("unadmitted queued task without an attempt does not advertise input", async () => {
  const f = await fixture("inspect", undefined, false);
  try {
    const before = f.snapshot();
    assert.throws(() => f.channel.send("child", "new context"), /communication admission/);
    assert.equal(f.snapshot(), before);
    assert.equal((await f.channel.inspect("child")).inputOpen, false);
  } finally { await f.close(); }
});

test("admitted queued task without an attempt does not advertise input", async () => {
  const f = await fixture({ communication: true }, undefined, false);
  try {
    const before = f.snapshot();
    assert.throws(() => f.channel.send("child", "new context"), /no admitted Worker attempt/);
    assert.equal(f.snapshot(), before);
    assert.equal((await f.channel.inspect("child")).inputOpen, false);
  } finally { await f.close(); }
});
