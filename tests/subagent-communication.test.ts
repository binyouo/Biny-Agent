import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { WorkerSession, workerSessionId } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { runSubagentTask } from "../src/extensions/subagent.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-task-mail-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  tasks.create({ taskRunId: "child", sessionId: "parent", task: { prompt: "inspect assigned files", communication: true } });
  const attempt = tasks.createAttempt("child");
  tasks.transition("child", "queued");
  tasks.transition("child", "running", { attemptId: attempt.attemptId });
  const communication = new TaskCommunication(tasks, "parent");
  return { root, tasks, attempt, authority, communication,
    async close() { communication.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
  };
}

test("messages are durable, ordered, idempotent and confined to their owning session and attempt", async () => {
  const f = await fixture();
  try {
    const first = f.communication.send("child", "inspect src/a.ts", "message-one");
    assert.deepEqual(f.communication.send("child", first.content, first.id), first);
    assert.throws(() => f.communication.send("child", "different", first.id), /different content/);
    const worker = f.communication.worker("child", f.attempt.attemptId);
    worker.report("found a boundary", "report-one");
    f.communication.send("child", "also inspect src/b.ts", "message-two");
    assert.deepEqual(worker.pending().map((message) => message.id), ["message-one", "message-two"]);
    assert.deepEqual(new TaskCommunication(f.tasks, "parent").messages("child").map((message) => message.direction), ["parent", "worker", "parent"]);
    assert.throws(() => new TaskCommunication(f.tasks, "other").send("child", "inject"), /another session/);
    assert.throws(() => f.communication.worker("child", "stale").pending(), /stale attempt/);
    assert.throws(() => f.communication.send("child", " "), /between 1/);
    assert.throws(() => f.communication.send("child", "x".repeat(8001)), /8000/);
    assert.throws(() => f.communication.send("child", "text", ""), /identity/);
    assert.equal(worker.seal(), false);
    worker.delivered(["message-one", "message-two"]);
    assert.equal(worker.seal(), true);
    assert.throws(() => f.communication.send("child", "too late"), /no longer accepts/);
    assert.deepEqual(f.communication.send("child", first.content, first.id), { ...first, delivered: true });
    assert.ok(f.tasks.events("child").some((event) => event.eventType === "task.attempt.updated"));
  } finally { await f.close(); }
});

test("wait observes committed updates, has a deadline and does not cancel the task", async () => {
  const f = await fixture();
  try {
    const revision = f.communication.read("child").revision;
    const waiting = f.communication.wait("child", 1000, revision);
    f.communication.send("child", "new context");
    assert.ok((await waiting).revision > revision);
    const current = f.communication.read("child");
    assert.equal((await f.communication.wait("child", 5, current.revision)).status, "running");
    const controller = new AbortController();
    const aborted = f.communication.wait("child", 1000, undefined, controller.signal);
    controller.abort(new Error("parent stopped waiting"));
    await assert.rejects(aborted, /stopped waiting/);
    assert.equal(f.communication.read("child").status, "running");
    await assert.rejects(f.communication.wait("child", -1), /between 0/);
    await assert.rejects(f.communication.wait("child", 60001), /60000/);
    await assert.rejects(f.communication.wait("child", 0, -1), /revision/);
  } finally { await f.close(); }
});

test("a Worker resumes a received message exactly once if delivery acknowledgement was interrupted", async () => {
  const f = await fixture();
  let worker: WorkerSession | undefined;
  try {
    const execution = { taskId: f.attempt.attemptId, persistenceRoot: f.root, parentSessionId: "parent", runtimeEventSink: f.authority.asSink() };
    const channel = f.communication.worker("child", f.attempt.attemptId);
    f.communication.send("child", "preserve the original checks", "correction");
    worker = await WorkerSession.open(execution, "inspect", f.root, { accessMode: "read-only" }, "bounded worker");
    assert.equal((await worker.receiveMessages(channel.pending())).length, 1);
    await worker.close();
    worker = await WorkerSession.open({ ...execution, resume: true }, "inspect", f.root, { accessMode: "read-only" }, "bounded worker");
    assert.equal((await worker.receiveMessages(channel.pending())).length, 0);
    channel.delivered(channel.pending().map((message) => message.id));
    const events = await readSessionEvents(sessionFilePath(f.root, workerSessionId(f.attempt.attemptId)));
    assert.equal(events.filter((event) => event.type === "user_message" && event.messageId === "correction").length, 1);
    assert.equal(channel.pending().length, 0);
  } finally { await worker?.close(); await f.close(); }
});

test("the mailbox bounds total messages and rejects terminal tasks", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 128; index += 1) f.communication.send("child", `context ${String(index)}`);
    assert.throws(() => f.communication.send("child", "overflow"), /limit reached/);
    f.tasks.transition("child", "cancelled");
    assert.throws(() => f.communication.send("child", "after cancellation"), /no longer accepts/);
  } finally { await f.close(); }
});

test("a resumed legacy Worker cannot accept messages absent from its admitted policy", async () => {
  const f = await fixture();
  try {
    f.tasks.create({ taskRunId: "legacy", sessionId: "parent", task: "inspect" });
    const attempt = f.tasks.createAttempt("legacy");
    f.tasks.transition("legacy", "queued");
    f.tasks.transition("legacy", "running", { attemptId: attempt.attemptId, artifacts: { workerExecution: { prompt: "inspect" } } });
    assert.throws(() => f.communication.send("legacy", "new context"), /communication admission/);
  } finally { await f.close(); }
});

for (const maxSteps of [1, 2]) {
  test(`a message arriving with the final response respects the ${String(maxSteps)}-step budget`, async () => {
    const f = await fixture();
    let requests = 0;
    try {
      const model: AgentModel = { provider: "synthetic", modelId: "synthetic", supportsTools: true,
        stream: async (context) => {
          requests += 1;
          if (requests === 1) f.communication.send("child", "include the new finding", "late-context");
          else assert.match(JSON.stringify(context.messages), /include the new finding/);
          return textResponse(requests === 1 ? "initial candidate" : "updated result");
        }
      };
      const config = structuredClone(defaultConfig);
      config.extensions.subagent.maxSteps = maxSteps;
      const run = runSubagentTask({ workspaceRoot: f.root, config, toolRegistry: new ToolRegistry(),
        getModelSettings: () => ({ model, contextWindow: undefined })
      }, "inspect", undefined, "read-only", undefined, { taskId: f.attempt.attemptId, persistenceRoot: f.root, parentSessionId: "parent",
        communication: f.communication.worker("child", f.attempt.attemptId)
      });
      if (maxSteps === 1) await assert.rejects(run, /step_limit/);
      else {
        assert.equal(await run, "updated result");
        assert.throws(() => f.communication.send("child", "after handoff"), /no longer accepts/);
      }
      assert.equal(requests, maxSteps);
    } finally { await f.close(); }
  });
}

async function* textResponse(text: string): AsyncGenerator<ModelStreamEvent> {
  yield { type: "start" };
  yield { type: "text-delta", text };
  yield { type: "finish", reason: "stop" };
}
