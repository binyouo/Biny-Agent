/** VM execution and normal host/approval waits have independent finite budgets. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { codeModePolicy, executeCodeModeCell } from "../src/agent/codeMode.js";
import type { AgentTool, AgentToolResult } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { exerciseCodeModeApprovalGate } from "../scripts/code-mode-approval-fixture.mjs";

const policy = { ...codeModePolicy, timeoutMs: 100, hostCallTimeoutMs: 1_000, maxCellDurationMs: 2_000 };
const value = (details: unknown): AgentToolResult => ({ content: [], details });

for (const key of ["timeoutMs", "hostCallTimeoutMs", "maxCellDurationMs", "maxResultBytes"] as const) {
  await assert.rejects(executeCodeModeCell({ code: "return 1;", parentToolCallId: "widened-policy",
    tools: [], isCurrent: () => false, executionPolicy: { ...policy, [key]: codeModePolicy[key] + 1 } }),
  new RegExp(`Invalid Code Mode limit: ${key}`, "u"));
}

// Waiting longer than the VM budget is valid; each real child is invoked once.
{
  let calls = 0;
  const read: AgentTool = { name: "Read", description: "Fixture delayed host", parameters: { type: "object" },
    async execute() { calls++; await delay(250); return value("host finished"); } };
  const result = await executeCodeModeCell({ code: "return await tools.Read({});", parentToolCallId: "host-wait",
    tools: [read], isCurrent: () => true, executionPolicy: policy });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value, "host finished");
  assert.equal(calls, 1);
}

// CPU remains bounded even while a real host request is pending.
for (const pendingHost of [false, true]) {
  let aborted = false;
  const read: AgentTool = { name: "Read", description: "Fixture pending host", parameters: { type: "object" },
    async execute(_id, _args, signal) {
      assert.ok(signal);
      await abortedBy(signal);
      aborted = true;
      throw signal.reason;
    } };
  const ready: AgentTool = { name: "Glob", description: "Fixture ready bridge", parameters: { type: "object" },
    async execute() { return value(true); } };
  const startedAt = performance.now();
  const result = await executeCodeModeCell({ code: pendingHost
    ? "await Promise.race([tools.Read({}), tools.Glob({})]); while(true){}" : "while(true){}",
    parentToolCallId: `cpu-${String(pendingHost)}`, tools: pendingHost ? [read, ready] : [], isCurrent: () => true, executionPolicy: policy });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /100ms|execution|interrupt|budget/iu);
  assert.ok(performance.now() - startedAt < 1_500, "the VM budget must stop CPU before the whole-cell watchdog");
  assert.equal(result.outcomeUnknown, undefined);
  if (pendingHost) assert.equal(aborted, true);
}

// Host deadlines cancel cooperatively and cannot admit another child after failure.
{
  let calls = 0;
  let aborted = false;
  const read: AgentTool = { name: "Read", description: "Fixture deadline host", parameters: { type: "object" },
    async execute(_id, _args, signal) {
      calls++;
      assert.ok(signal);
      await abortedBy(signal);
      aborted = true;
      throw signal.reason;
    } };
  const result = await executeCodeModeCell({
    code: "try { await tools.Read({}); } catch {} return await tools.Read({});", parentToolCallId: "host-deadline",
    tools: [read], isCurrent: () => true, executionPolicy: { ...policy, hostCallTimeoutMs: 150 } });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /host\/approval deadline/u);
  assert.equal(aborted, true);
  assert.equal(calls, 1, "a deadline is terminal for the cell, not a reason to replay the child");
  assert.equal(result.outcomeUnknown, undefined);
}

// A guest promise with no host operation still has a finite overall deadline.
{
  const result = await executeCodeModeCell({ code: "return await new Promise(() => {});", parentToolCallId: "idle-guest",
    tools: [], isCurrent: () => true, executionPolicy: { ...policy, maxCellDurationMs: 250 } });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /whole-cell deadline|250ms/u);
  assert.deepEqual(result.childCalls, []);
}

// Parallel waits are legitimate; unawaited bridges are rejected before dispatch.
{
  let calls = 0;
  const read: AgentTool = { name: "Read", description: "Fixture parallel host", parameters: { type: "object" },
    async execute() { calls++; await delay(250); return value(calls); } };
  const result = await executeCodeModeCell({ code: "return (await Promise.all([tools.Read({}), tools.Read({})])).length;",
    parentToolCallId: "parallel-waits", tools: [read], isCurrent: () => true, executionPolicy: policy });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value, 2);
  assert.equal(calls, 2);
}
{
  let calls = 0;
  const read: AgentTool = { name: "Read", description: "Fixture detached host", parameters: { type: "object" },
    async execute() { calls++; return value("must not dispatch"); } };
  const result = await executeCodeModeCell({ code: "tools.Read({}); return 'detached';", parentToolCallId: "detached-host",
    tools: [read], isCurrent: () => true, executionPolicy: policy });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /unawaited|detached/iu);
  assert.equal(calls, 0);
}

// An awaited host that ignores its deadline retains the real pending lifetime.
{
  const held = deferred<AgentToolResult>();
  const started = deferred<void>();
  const read: AgentTool = { name: "Read", description: "Fixture ignored abort", parameters: { type: "object" },
    async execute() { started.resolve(); return await held.promise; } };
  let unsettled: readonly { toolCallId: string; settlement: Promise<unknown> }[] = [];
  const pending = executeCodeModeCell({ code: "return await tools.Read({});", parentToolCallId: "unknown-host-deadline",
    tools: [read], isCurrent: () => true, executionPolicy: { ...policy, hostCallTimeoutMs: 150 },
    onUnsettled: (operations) => { unsettled = operations; } });
  try {
    await started.promise;
    const result = await pending;
    assert.equal(result.outcomeUnknown, true);
    assert.equal(unsettled.length, 1);
    held.resolve(value("late"));
    await Promise.allSettled(unsettled.map(({ settlement }) => settlement));
  } finally { held.resolve(value("late")); await pending; }
}

// Serialization limits remain independent from both clocks.
{
  const result = await executeCodeModeCell({ code: "return 'x'.repeat(1000);", parentToolCallId: "serialization-limit",
    tools: [], isCurrent: () => true, executionPolicy: { ...policy, maxResultBytes: 128 } });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /size|byte|limit|large/iu);
}

// Exercise Biny's real approval gate, audit path and scheduler after a long wait.
{
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-approval-timing-"));
  try {
    await exerciseCodeModeApprovalGate({ workspace: root, policy, idPrefix: "source",
      ToolExecutionCoordinator, defaultConfig, PermissionManager, SessionRecorder, ensureAgentDirs, ToolRegistry, z });
  } finally { await rm(root, { recursive: true, force: true }); }
}

console.log("code mode timing tests passed");

function abortedBy(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
