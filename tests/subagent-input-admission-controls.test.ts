import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-input-controls-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  const channel = new TaskCommunication(tasks, "parent");
  return { tasks, channel,
    async close() { channel.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
  };
}

test("queued attempts retain exact-true admission through either source", async () => {
  const f = await fixture();
  try {
    for (const source of ["definition", "checkpoint"]) {
      for (const value of [true, false, "true", 1, null, undefined]) {
        const id = `${source}-${typeof value}-${String(value)}`;
        f.tasks.create({ taskRunId: id, sessionId: "parent", task: source === "definition" ? { communication: value } : "inspect" });
        const attempt = f.tasks.createAttempt(id);
        f.tasks.transition(id, "queued", { attemptId: attempt.attemptId, artifacts: { workerExecution: source === "checkpoint" ? { communication: value } : {} } });
        const snapshot = JSON.stringify({ task: f.tasks.get(id), events: f.tasks.events(id) });
        assert.equal((await f.channel.inspect(id)).inputOpen, value === true, id);
        assert.equal((await f.channel.inspect(id, { summary: true })).inputOpen, value === true, id);
        assert.equal(JSON.stringify({ task: f.tasks.get(id), events: f.tasks.events(id) }), snapshot);
        if (value === true) assert.equal(f.channel.send(id, "context").content, "context");
        else {
          assert.throws(() => f.channel.send(id, "context"), /communication admission/);
          assert.equal(JSON.stringify({ task: f.tasks.get(id), events: f.tasks.events(id) }), snapshot);
        }
      }
    }
  } finally { await f.close(); }
});

test("no-attempt inspection is closed and read-only in full and summary mode", async () => {
  const f = await fixture();
  try {
    for (const communication of [true, false]) {
      const id = String(communication);
      f.tasks.create({ taskRunId: id, sessionId: "parent", task: { communication } });
      f.tasks.transition(id, "queued");
      const snapshot = JSON.stringify({ task: f.tasks.get(id), events: f.tasks.events(id) });
      assert.equal((await f.channel.inspect(id)).inputOpen, false);
      assert.equal((await f.channel.inspect(id, { summary: true })).inputOpen, false);
      assert.equal(JSON.stringify({ task: f.tasks.get(id), events: f.tasks.events(id) }), snapshot);
    }
  } finally { await f.close(); }
});

test("input eligibility does not bypass payload limits, capacity, or duplicate identity checks", async () => {
  const f = await fixture();
  try {
    f.tasks.create({ taskRunId: "child", sessionId: "parent", task: { communication: true } });
    const attempt = f.tasks.createAttempt("child");
    f.tasks.transition("child", "running", { attemptId: attempt.attemptId });
    assert.equal((await f.channel.inspect("child")).inputOpen, true);
    assert.throws(() => f.channel.send("child", " "), /between 1/);
    assert.throws(() => f.channel.send("child", "x".repeat(8001)), /8000/);
    assert.throws(() => f.channel.send("child", "context", ""), /identity/);
    const original = f.channel.send("child", "first", "first");
    assert.throws(() => f.channel.send("child", "changed", "first"), /different content/);
    for (let index = 1; index < 128; index += 1) f.channel.send("child", `context ${String(index)}`, `message-${String(index)}`);
    assert.equal((await f.channel.inspect("child")).inputOpen, true);
    assert.throws(() => f.channel.send("child", "overflow", "overflow"), /limit reached/);
    assert.deepEqual(f.channel.send("child", original.content, original.id), original);
  } finally { await f.close(); }
});
