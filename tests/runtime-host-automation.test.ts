import assert from "node:assert/strict";
import { AutomationScheduler, type AutomationRecord, type AutomationPendingFire, type AutomationStore } from "../src/runtime/AutomationScheduler.js";
import type { InteractiveRuntimeHandle, SubmittedAgentRun } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

function runtime(sessionId: string, busy = false): InteractiveRuntimeHandle {
  const snapshot = {
    revision: 0,
    info: {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      workspaceRoot: "/tmp/biny-automation-test",
      provider: "test",
      modelAlias: "test",
      modelLabel: "Test",
      reasoningLabel: "Off",
      thinking: "off",
      skills: []
    },
    permissionMode: "ask",
    state: busy
      ? { kind: "runs", activeRun: { runId: `run-${sessionId}`, status: "thinking" } }
      : { kind: "idle" }
  } as unknown as InteractiveRuntimeSnapshot;
  return {
    submitPrompt: (_input, _attachments, requestIds) => {
      const submitted: SubmittedAgentRun = {
        runId: requestIds?.runId ?? `run-${sessionId}`,
        messageId: requestIds?.messageId ?? `message-${sessionId}`,
        completion: Promise.resolve({
          runId: requestIds?.runId ?? `run-${sessionId}`,
          status: "completed",
          stopReason: "model_stop",
          steps: 1,
          output: "done",
          durationMs: 1
        })
      };
      return submitted;
    },
    steer: () => { throw new Error("not used"); },
    enqueue: () => { throw new Error("not used"); },
    continueInterruptedTurn: async () => undefined,
    startInterruptedTurn: async () => undefined,
    waitForIdle: async () => undefined,
    cancelCurrentRun: () => undefined,
    cancelRun: () => false,
    answerPermission: () => undefined,
    claimSession: async () => undefined,
    releaseSessionClaim: async () => undefined,
    resumeSession: async () => { throw new Error("automation must not mutate a runtime into its target session"); },
    runExclusiveOperation: async () => { throw new Error("not used"); },
    startBackgroundOperation: () => { throw new Error("not used"); },
    compactConversation: async () => "",
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: async () => undefined
  };
}

function automation(sessionId?: string): AutomationRecord {
  return {
    automationId: "automation-1",
    workspaceId: "workspace-1",
    name: "automation",
    triggerType: "once",
    schedule: {},
    executionTemplate: { prompt: "run automation", sessionId },
    status: "active",
    nextFireAt: undefined,
    lastFireAt: undefined,
    fireCount: 0,
    consecutiveFailures: 0,
    maxFires: undefined,
    expiresAt: undefined,
    revision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function runCase(targetSessionId: string | undefined, primaryBusy = false): Promise<string | undefined> {
  const record = automation(targetSessionId);
  const fire: AutomationPendingFire = {
    fireId: `fire-${targetSessionId ?? "dedicated"}`,
    automationId: record.automationId,
    scheduledAt: new Date().toISOString(),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  let createdFor: string | undefined;
  let boundRunId: string | undefined;
  let completed = false;
  const store = {
    claimDue: () => [fire],
    claimFire: () => fire,
    get: () => record,
    bindFireRun: (_fireId: string, runId: string) => { boundRunId = runId; },
    completeFire: () => { completed = true; },
    failFire: (_fireId: string, error: string) => { throw new Error(error); },
    listPending: () => [fire]
  } as unknown as AutomationStore;
  const scheduler = new AutomationScheduler({
    getRuntime: () => runtime("primary", primaryBusy),
    getStore: () => store,
    createFreshRuntime: async (sessionId) => {
      createdFor = sessionId;
      return runtime(sessionId ?? "automation-dedicated");
    },
    canStartRun: () => true
  });
  await scheduler.tick();
  scheduler.stop();
  assert.equal(completed, true);
  assert.ok(boundRunId);
  return createdFor;
}

assert.equal(await runCase("session-target"), "session-target", "automation must create/use the configured target session runtime");
assert.equal(await runCase(undefined), undefined, "automation without a target must receive a dedicated session runtime");
assert.equal(
  await runCase(undefined, true),
  undefined,
  "a non-heartbeat automation must not wait for the interactive primary runtime"
);

async function runDeferredTargetCase(): Promise<void> {
  const record = automation("session-target");
  const fire: AutomationPendingFire = {
    fireId: "fire-target-busy",
    automationId: record.automationId,
    scheduledAt: new Date().toISOString(),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  let deferredReason: string | undefined;
  const store = {
    claimDue: () => [fire],
    claimFire: () => fire,
    get: () => record,
    deferFire: (_fireId: string, _at: Date, reason?: string) => { deferredReason = reason; },
    bindFireRun: () => undefined,
    completeFire: () => { throw new Error("busy target must not complete"); },
    failFire: (_fireId: string, error: string) => { throw new Error(error); },
    listPending: () => [fire]
  } as unknown as AutomationStore;
  const scheduler = new AutomationScheduler({
    getRuntime: () => runtime("primary"),
    getStore: () => store,
    createFreshRuntime: async () => runtime("session-target", true),
    canStartRun: () => true
  });
  await scheduler.tick();
  scheduler.stop();
  assert.match(deferredReason ?? "", /busy/u, "目标 session 忙时 automation fire 必须延后而不是记失败");
}

await runDeferredTargetCase();

console.log("runtime-host automation tests passed");
