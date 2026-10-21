import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createRuntimeHostBusinessComposition } from "../src/runtime/host/composition.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { createHostTestStores } from "./helpers/hostStores.js";

const runtime = {} as InteractiveRuntimeHandle;
const commands = await createHostTestStores() as unknown as CommandRuntime;
const composition = createRuntimeHostBusinessComposition({
  getRuntime: () => runtime,
  getCommands: () => commands,
  resolveSessionRuntime: async () => runtime,
  resolveSessionCommands: async () => commands,
  createFreshRuntime: async () => { throw new Error("Missing automation cannot dispatch"); },
  admitGoal: async (_sessionId, execute) => execute()
});
try {
  composition.start();
  composition.recoverGraphs();
  await assert.rejects(composition.runAutomation("automation-1"), /not found|does not exist/u);
  const deadline = Date.now() + 2_000;
  while (composition.hasActiveWork() && Date.now() < deadline) await setImmediate();
  assert.equal(composition.hasActiveWork(), false);
} finally { composition.stop(); }
composition.start();
assert.equal(composition.hasActiveWork(), false);
console.log("runtime-host composition tests passed");
