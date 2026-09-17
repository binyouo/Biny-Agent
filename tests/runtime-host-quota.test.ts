import assert from "node:assert/strict";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { HostDrainingError, RuntimeConcurrencyLimitError, RuntimeHostQuota } from "../src/runtime/host/quota.js";
import { SessionRuntimeRegistry } from "../src/runtime/host/registry.js";

function fakeRuntime(sessionId: string, busy = false): InteractiveRuntimeHandle {
  const snapshot = {
    revision: 0,
    info: {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      workspaceRoot: "/tmp/biny-quota-test",
      provider: "test",
      modelAlias: "test",
      modelLabel: "Test",
      reasoningLabel: "Off",
      thinking: "off",
      skills: []
    },
    permissionMode: "ask",
    state: busy ? { kind: "runs", activeRun: { runId: `run-${sessionId}`, status: "thinking" } } : { kind: "idle" }
  } as unknown as InteractiveRuntimeSnapshot;
  return {
    submitPrompt: () => { throw new Error("not used"); },
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
    resumeSession: async () => { throw new Error("not used"); },
    runExclusiveOperation: async () => { throw new Error("not used"); },
    startBackgroundOperation: () => { throw new Error("not used"); },
    compactConversation: async () => "",
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: async () => undefined
  };
}

const commands = {} as CommandRuntime;
const registry = new SessionRuntimeRegistry(
  { runtime: fakeRuntime("primary"), commands },
  {
    maxSessionRuntimes: 3,
    createRuntime: async (sessionId) => ({ runtime: fakeRuntime(sessionId ?? "missing", sessionId === "busy"), commands }),
    onUpdate: () => undefined
  }
);
const quota = new RuntimeHostQuota(1);
await registry.ensure("busy");
assert.equal(quota.canStartRun(registry), false);
assert.throws(() => quota.assertRunCapacity(registry, registry.primary()), (error: unknown) => error instanceof RuntimeConcurrencyLimitError);

quota.beginDrain();
assert.equal(quota.isDraining(), true);
assert.throws(() => quota.assertAdmission(), (error: unknown) => error instanceof HostDrainingError);
assert.equal(quota.canStartRun(registry), false);

console.log("runtime-host quota tests passed");
