import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

for (const scenario of ["malformed-later", "malformed-selected", "latest-callers"] as const) {
  test(`inspection mailbox selection control: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-mailbox-controls-"));
    const old = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "config");
    let authority: RuntimeEventAuthority | undefined;
    let tasks: DurableTaskRunStore | undefined;
    let channel: TaskCommunication | undefined;
    try {
      authority = await RuntimeEventAuthority.open(root);
      tasks = await DurableTaskRunStore.open(root, authority);
      channel = new TaskCommunication(tasks, "parent");
      tasks.create({ taskRunId: "child", sessionId: "parent", task: { prompt: "Synthetic mailbox controls", communication: true } });
      tasks.createAttempt("child", { attemptId: "first" });
      tasks.transition("child", "running", { artifacts: scenario === "malformed-selected" ? { communication: { messages: "invalid", inputClosed: false } } : undefined });
      tasks.transition("child", "failed");
      tasks.retry("child");
      tasks.createAttempt("child", { attemptId: "second" });
      tasks.transition("child", "running", { artifacts: scenario === "malformed-later" ? { communication: { messages: "invalid", inputClosed: false } } : undefined });
      if (scenario === "latest-callers") {
        const input = channel.send("child", "second attempt input", "input");
        const worker = channel.worker("child", "second");
        assert.deepEqual(worker.pending(), [input]);
        const report = worker.report("second attempt report", "report");
        worker.delivered([input.id]);
        assert.deepEqual(worker.pending(), []);
        assert.equal(worker.seal(), true);
        const notice = channel.notifications()[0]!;
        assert.equal(notice.attemptId, "second");
        channel.acknowledge(notice);
        const expected = [{ ...input, delivered: true }, { ...report, delivered: true }];
        const before = tasks.get("child");
        const events = tasks.events("child");
        assert.deepEqual(channel.messages("child"), expected);
        assert.deepEqual((await channel.inspect("child")).messages, expected);
        assert.deepEqual((await channel.inspect("child", { attemptId: "second" })).messages, expected);
        assert.equal((await channel.inspect("child")).inputOpen, false);
        assert.deepEqual((await channel.inspect("child", { attemptId: "first" })).messages, []);
        assert.deepEqual(channel.notifications(), []);
        assert.deepEqual(tasks.get("child"), before);
        assert.deepEqual(tasks.events("child"), events);
      } else {
        const before = tasks.get("child");
        const events = tasks.events("child");
        if (scenario === "malformed-later") {
          for (const summary of [false, true]) assert.deepEqual((await channel.inspect("child", { attemptId: "first", summary })).messages, []);
          await assert.rejects(channel.inspect("child"), /array/);
          assert.throws(() => channel!.messages("child"), /array/);
        } else {
          for (const summary of [false, true]) await assert.rejects(channel.inspect("child", { attemptId: "first", summary }), /array/);
          assert.deepEqual((await channel.inspect("child")).messages, []);
        }
        assert.deepEqual(tasks.get("child"), before);
        assert.deepEqual(tasks.events("child"), events);
      }
    } finally {
      channel?.close(); tasks?.close(); authority?.close();
      if (old === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = old;
      await rm(root, { recursive: true, force: true });
    }
  });
}
