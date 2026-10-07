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
    assert.throws(() => worker.report("x".repeat(2001), "overlong"), /2000/);
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

test("inspection waits for Worker events without a task revision change and never exposes checkpoint prompts", async () => {
  const f = await fixture();
  try {
    const before = await f.communication.inspect("child");
    const waiting = f.communication.inspect("child", { waitMs: 1000, afterRevision: before.revision, afterSequence: before.cursor });
    f.authority.appendSessionEvent({ sessionId: workerSessionId(f.attempt.attemptId),
      runtime: { eventId: "worker-tool", eventSeq: 1, runId: "worker", turnId: "worker" },
      event: { type: "tool_call", tool: "Read", toolCallId: "read", args: { path: "src/a.ts" }, assistantContent: "inspect the file" },
      createdAt: new Date().toISOString() });
    f.communication.notify("child");
    const inspected = await waiting;
    assert.equal(inspected.revision, before.revision);
    assert.equal(inspected.activity[0]?.tool, "Read");
    assert.ok(inspected.cursor > before.cursor);
    assert.equal(JSON.stringify(inspected).includes("inspect assigned files"), true, "the finite task description is visible");
    assert.equal(Object.hasOwn(inspected, "artifacts"), false, "execution checkpoints are not UI data");
    await assert.rejects(new TaskCommunication(f.tasks, "other").inspect("child"), /another session/);
    const controller = new AbortController();
    const cancelled = f.communication.inspect("child", { waitMs: 1000, afterRevision: inspected.revision, afterSequence: inspected.cursor }, controller.signal);
    controller.abort(new Error("panel closed"));
    await assert.rejects(cancelled, /panel closed/);
    assert.equal(f.tasks.get("child")?.status, "running");
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

// Distinct reports retain their order within bounded parent input; durable receipts prevent repeated delivery.
test("parent inbox preserves distinct reports in order and acknowledges durable bounded delivery", async () => {
  const f = await fixture();
  try {
    const worker = f.communication.worker("child", f.attempt.attemptId);
    worker.report("early finding", "one"); worker.report("current finding", "two");
    const notices = f.communication.notifications();
    assert.equal(notices.length, 2); assert.match(notices[0]!.content, /early finding/); assert.match(notices[1]!.content, /current finding/);
    const revision = f.tasks.get("child")!.revision;
    const received = f.communication.wait("child", 1000, revision);
    f.communication.acknowledge(notices[0]!);
    assert.ok((await received).revision > revision, "parent delivery is an observable committed update");
    const remaining = new TaskCommunication(f.tasks, "parent").notifications();
    assert.equal(remaining.length, 1); assert.match(remaining[0]!.content, /current finding/);
    f.communication.acknowledge(remaining[0]!);
    assert.deepEqual(f.communication.notifications(), []);
    f.tasks.transition("child", "completed", { attemptId: f.attempt.attemptId, artifacts: { ...f.tasks.get("child")!.attempts[0]!.artifacts as object, output: "x".repeat(10000) } });
    const completed = f.communication.notifications();
    assert.equal(completed.length, 1); assert.match(completed[0]!.content, /completed/);
    assert.ok(completed[0]!.content.length <= 3000);
    f.communication.acknowledge(completed[0]!);
    assert.deepEqual(f.communication.notifications(), []);
    assert.deepEqual(new TaskCommunication(f.tasks, "other").notifications(), []);
  } finally { await f.close(); }
});

// Retired communication handles must release waits and cannot keep writing after runtime cleanup.
test("closing the channel releases waiters and fences delivery receipts without cancelling the child", async () => {
  const f = await fixture();
  try {
    f.communication.worker("child", f.attempt.attemptId).report("material evidence", "report");
    const notice = f.communication.notifications()[0]!;
    const revision = f.tasks.get("child")!.revision;
    const waiting = f.communication.wait("child", 1000, revision);
    f.communication.close();
    assert.equal((await waiting).status, "running");
    assert.throws(() => f.communication.acknowledge(notice), /closed/);
    assert.equal(f.tasks.get("child")!.revision, revision);
  } finally { await f.close(); }
});
