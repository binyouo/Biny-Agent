import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryPolicySchema, resolveChatPersonalization } from "../src/personalization/index.js";
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
