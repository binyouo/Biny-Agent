import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

const laterMessage = { id: "later-message", direction: "worker", content: "Only the second attempt reported this", createdAt: "2026-10-21T00:00:00Z" };
const earlierMessage = { ...laterMessage, id: "earlier-message", content: "Only the first attempt reported this" };
const scenarios = ["absent", "empty", "own", "latest", "second", "summary", "invalid", "foreign", "no-attempt"] as const;
for (const scenario of scenarios) {
  test(`inspection keeps historical mailboxes isolated: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-historical-mailbox-"));
    const previous = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "config");
    const authority = await RuntimeEventAuthority.open(root);
    const tasks = await DurableTaskRunStore.open(root, authority);
    const channel = new TaskCommunication(tasks, "parent");
    const foreign = new TaskCommunication(tasks, "other");
    try {
      tasks.create({ taskRunId: "child", sessionId: "parent", task: { prompt: "Synthetic history fixture", communication: true } });
      if (scenario !== "no-attempt") {
        tasks.createAttempt("child", { attemptId: "first" });
        tasks.transition("child", "running", { attemptId: "first",
          ...(scenario === "empty" ? { artifacts: {} } : scenario === "own" ? { artifacts: { communication: { messages: [earlierMessage], inputClosed: true } } } : {}) });
        tasks.transition("child", "failed", { attemptId: "first", failure: { message: "Synthetic first attempt failure" } });
        tasks.retry("child");
        tasks.createAttempt("child", { attemptId: "second" });
        tasks.transition("child", "running", { attemptId: "second", artifacts: { communication: { messages: [laterMessage], inputClosed: false } } });
      }
      const before = tasks.get("child");
      const events = tasks.events("child");
      let inspected;
      if (scenario === "invalid") await assert.rejects(channel.inspect("child", { attemptId: "not-an-attempt" }), /does not belong/);
      else if (scenario === "foreign") await assert.rejects(foreign.inspect("child", { attemptId: "first" }), /another session/);
      else inspected = await channel.inspect("child", scenario === "latest" || scenario === "no-attempt" ? {} : { attemptId: scenario === "second" ? "second" : "first", summary: scenario === "summary" });
      assert.deepEqual(tasks.get("child"), before, "inspection must not alter durable attempts or task revision");
      assert.deepEqual(tasks.events("child"), events, "inspection must not add durable events or receipts");
      if (!inspected) return;
      assert.deepEqual(inspected.activity, []);
      if (scenario === "latest" || scenario === "second") {
        assert.equal(inspected.attemptId, "second");
        assert.deepEqual(inspected.messages, [laterMessage]);
        assert.equal(inspected.inputOpen, true);
      } else {
        assert.equal(inspected.attemptId, scenario === "no-attempt" ? undefined : "first");
        assert.deepEqual(inspected.messages, scenario === "own" ? [earlierMessage] : [], "historical inspection must not inherit a later attempt's mailbox");
        assert.equal(inspected.inputOpen, false);
      }
    } finally {
      foreign.close(); channel.close(); tasks.close(); authority.close();
      if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
