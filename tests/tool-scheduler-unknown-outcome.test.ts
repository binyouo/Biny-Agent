import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolAccesses } from "../src/tools/access.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolScheduler, type ToolSchedulerTask } from "../src/tools/scheduler.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const mode of [
  "transport-unknown", "capability-cancelled", "success", "failure",
  "success-after-abort", "safe-cancelled", "capability-before-dispatch"
] as const) {
  await test(`queued resource successor respects ${mode} before release`, { timeout: 10_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-scheduler-outcome-"));
    await ensureAgentDirs(root);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    config.agent.maxConcurrentTools = 2;
    config.agent.maxQueuedToolCalls = 1;
    const capabilityMode = mode === "capability-cancelled" || mode === "capability-before-dispatch";
    const authority = capabilityMode ? await RuntimeEventAuthority.open(root, { backfillLegacySessions: false }) : undefined;
    const capabilities = authority ? await CapabilityStore.open(root, authority) : undefined;
    const recorder = new SessionRecorder(root, `scheduler-${mode}`, undefined, authority?.asSink());
    recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
    const firstStarted = deferred();
    const secondQueued = deferred();
    const releaseFirst = deferred();
    const controller = new AbortController();
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "scheduler_fixture",
      description: "Deferred fake tool with one shared resource.",
      parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
      schema: z.object({ label: z.string() }),
      risk: "execute",
      resolveExecution: ({ label }) => ({
        approvalRule: "scheduler_fixture",
        accesses: ToolAccesses.browser("scheduler-fixture"),
        retrySafety: mode === "safe-cancelled" ? "safe" : "unsafe",
        async execute(context) {
          calls.push(label);
          if (mode !== "capability-before-dispatch" || label !== "first") context.onDispatched?.();
          if (label === "first") {
            firstStarted.resolve();
            await releaseFirst.promise;
            if (mode === "transport-unknown") throw new ToolOutcomeUnknownError("transport_error", "Fixture lost its response after dispatch.");
            if (mode === "failure") throw new Error("Fixture failed with a known outcome.");
            if (mode === "safe-cancelled") context.signal?.throwIfAborted();
          }
          return { label };
        }
      })
    }, capabilityMode ? "mcp" : "builtin");
    const quarantined: Promise<unknown>[] = [];
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot: root, config, recorder, toolRegistry: registry, capabilities,
      runId: "run", turnId: "turn",
      quarantineExternalTool: (_name, _id, settlement) => { quarantined.push(settlement); }
    }, new PermissionManager(config.permission), () => undefined);
    const tool = coordinator.createAgentTools().find((entry) => entry.name === "scheduler_fixture")!;

    // Observe the real public queue, without pausing or replacing its behavior.
    // The second tool must already be blocked on the resource when first settles.
    const originalSchedule = ToolScheduler.prototype.schedule;
    t.mock.method(ToolScheduler.prototype, "schedule", function (this: ToolScheduler<unknown>, task: ToolSchedulerTask<unknown>) {
      const result = originalSchedule.call(this, task);
      if (task.accesses.some((access) => access.kind === "browser") && this.getSnapshot().queued === 1) secondQueued.resolve();
      return result;
    });
    try {
      const first = tool.execute("first", { label: "first" }, controller.signal);
      await firstStarted.promise;
      const second = tool.execute("second", { label: "second" });
      await secondQueued.promise;
      assert.deepEqual(calls, ["first"]);
      if (capabilityMode || mode === "success-after-abort" || mode === "safe-cancelled") controller.abort(new Error("Cancel the first fixture only."));
      if (!capabilityMode) releaseFirst.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await coordinator.waitForIdle();
      const unknown = mode === "transport-unknown" || mode === "capability-cancelled";
      const firstStatus = unknown ? "unknown" : mode === "failure" ? "failed"
        : mode === "safe-cancelled" || mode === "capability-before-dispatch" ? "cancelled" : "succeeded";
      assert.deepEqual(calls, unknown ? ["first"] : ["first", "second"],
        "a queued successor must check the authoritative unknown outcome before dispatch");
      assert.equal(secondResult.isError, unknown);
      if (unknown) {
        assert.equal(firstResult.isError, true);
        assert.match(JSON.stringify(secondResult.details), /unknown side effect/u);
        assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
      } else {
        assert.equal(firstResult.isError, firstStatus !== "succeeded");
        assert.doesNotThrow(() => coordinator.assertCanContinue());
      }
      // A late executor settlement is not authority to replay an unknown call.
      // Known outcomes must still admit fresh work after cancellation/failure.
      releaseFirst.resolve();
      await Promise.allSettled(quarantined);
      const thirdResult = await tool.execute("third", { label: "third" });
      assert.equal(thirdResult.isError, unknown);
      assert.deepEqual(calls, unknown ? ["first"] : ["first", "second", "third"]);
      if (unknown) assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
      else assert.doesNotThrow(() => coordinator.assertCanContinue());
      const events = await readSessionEvents(recorder.filePath);
      const results = events.filter((event) => event.type === "tool_result");
      assert.equal(results.length, 3, "each accepted public call must settle exactly once");
      assert.equal(results.find((event) => event.toolCallId === "first")?.executionStatus, firstStatus);
      assert.equal(results.find((event) => event.toolCallId === "second")?.executionStatus, unknown ? "failed" : "succeeded");
      assert.equal(results.find((event) => event.toolCallId === "third")?.executionStatus, unknown ? "failed" : "succeeded");
      if (unknown) {
        assert.equal(results.find((event) => event.toolCallId === "first")?.outcomeUnknownReason,
          capabilityMode ? "cancelled" : "transport_error");
        assert.equal(events.some((event) => event.type === "tool_execution" && event.toolCallId === "second" && event.state === "admitted"), false);
        assert.equal(events.some((event) => event.type === "tool_execution" && event.toolCallId === "third" && event.state === "admitted"), false);
      }
      if (capabilityMode) assert.equal(quarantined.length, 1, "the unresolved external executor stays quarantined");
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(quarantined);
      await coordinator.waitForIdle();
      await recorder.close();
      capabilities?.close();
      authority?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
