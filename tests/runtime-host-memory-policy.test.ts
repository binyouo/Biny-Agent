import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import type { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { memoryPolicySchema, resolveChatPersonalization } from "../src/personalization/index.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { createRuntimeHostMemoryMaintenance } from "../src/runtime/host/maintenance.js";
import { createRuntimeHostMemoryPolicy } from "./helpers/runtime-host-memory-policy.js";

test("the Host memory fixture is canonical with maintenance enabled and conversational memory disabled", () => {
  const memory = createRuntimeHostMemoryPolicy();
  const resolved = resolveChatPersonalization(memory);
  assert.deepEqual(memory, memoryPolicySchema.parse(memory), "the Host must expose the schema-normalized policy");
  assert.equal(memory.enabled, true);
  assert.equal(memory.enabled, resolved.memoryEnabled);
  assert.equal(memory.sleepEnabled, true);
  assert.equal(memory.sleepEnabled, resolved.sleepEnabled);
  assert.equal(memory.sleepTime, "00:00");
  assert.equal(memory.sleepTime, resolved.sleepTime);
  assert.equal(memory.useMemories, false);
  assert.equal(resolved.useMemories, false);
  assert.equal(memory.generateMemories, false);
  assert.equal(resolved.contributeMemories, false);
  assert.equal(memory.extractModel, undefined);
  assert.equal(memory.excludeExternalContext, true);
  assert.equal(memory.maxRecalled, 3);
});

for (const gate of ["enabled", "memory-disabled", "sleep-disabled"] as const) {
  test(`the Host memory fixture preserves scheduled maintenance admission (${gate})`, async (context) => {
    context.mock.method(net, "createServer", () => { throw new Error("Real Host listeners are forbidden in this regression"); });
    context.mock.method(net, "createConnection", () => { throw new Error("Real Host connections are forbidden in this regression"); });
    context.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 9, 6, 0, 0) });
    const memory = gate === "enabled"
      ? createRuntimeHostMemoryPolicy()
      : memoryPolicySchema.parse({
        ...createRuntimeHostMemoryPolicy(),
        ...(gate === "memory-disabled" ? { enabled: false } : { sleepEnabled: false })
      });
    const resolved = resolveChatPersonalization(memory);
    const runs: Array<Parameters<LocalMemory["runMemoryMaintenance"]>[0]> = [];
    let statusReads = 0;
    // Only the scheduler's collaborators are faked; it consumes the same policy factory as the Host test.
    const commands = {
      agent: {
        getPersonalizationState: async () => ({ memory, resolved }),
        getLocalMemory: () => ({
          loadMaintenanceStatus: async () => {
            statusReads += 1;
            return { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
          },
          runMemoryMaintenance: async (options: Parameters<LocalMemory["runMemoryMaintenance"]>[0]) => {
            runs.push(options);
          }
        })
      }
    } as unknown as CommandRuntime;
    const maintenance = createRuntimeHostMemoryMaintenance({
      getCommands: () => commands,
      getRuntime: () => { throw new Error("The explicit idle check must not need a real runtime"); },
      isBusy: () => false
    });
    try {
      maintenance.start();
      assert.equal(statusReads, 1, "startup still heals persisted maintenance status immediately");
      context.mock.timers.tick(4_999);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runs.length, 0, "the fixture must not shorten the five-second startup delay");
      context.mock.timers.tick(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runs.length, gate === "enabled" ? 1 : 0);
      if (gate === "enabled") {
        assert.equal(runs[0]?.trigger, "scheduled", "runNow would bypass the policy gates");
        assert.equal(runs[0]?.signal?.aborted, false);
        assert.equal(resolved.memoryEnabled, true, "a scheduled run must not rely on a missing raw enabled field");
        assert.equal(resolved.sleepEnabled, true);
      } else {
        context.mock.timers.tick(60_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(runs.length, 0, "disabled maintenance stays suppressed on the periodic check");
      }
      assert.equal(maintenance.hasActiveWork(), false);
    } finally {
      maintenance.stop();
    }
  });
}
