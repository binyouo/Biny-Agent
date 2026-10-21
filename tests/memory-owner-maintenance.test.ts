import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentMemoryOwner } from "../src/runtime/memory/owner.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { defaultConfig } from "../src/config/schema.js";
import type { EmbeddingModelRuntime, LocalEmbeddingModelId } from "../src/llm/embedding/types.js";

class Models extends LocalEmbeddingManager {
  attempts = 0;
  failures = 0;
  override async list() { return this.descriptors().map(descriptor => ({ descriptor, installed: true })); }
  override async createRuntime(id: LocalEmbeddingModelId): Promise<EmbeddingModelRuntime> {
    this.attempts++;
    if (this.attempts <= this.failures) throw new Error("Model temporarily unavailable");
    const descriptor = this.descriptors().find(item => item.ref.kind === "local" && item.ref.model === id)!;
    return { descriptor, fingerprint: descriptor.fingerprint, embed: async request => ({
      fingerprint: descriptor.fingerprint, model: descriptor.ref, dimensions: 384,
      embeddings: request.texts.map(() => Float32Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0))
    }) };
  }
}

for (const gate of ["enabled", "memory-disabled", "sleep-disabled", "not-due"] as const) {
  test(`global scheduled Sleep respects policy and runs once per day (${gate})`, { timeout: 10_000 }, async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-owner-policy-"));
    const config = structuredClone(defaultConfig);
    config.context.memory.enabled = gate !== "memory-disabled";
    config.context.memory.sleepEnabled = gate !== "sleep-disabled";
    config.context.memory.sleepTime = gate === "not-due" ? "03:00" : "00:00";
    config.context.memory.useLlm = false;
    context.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 6, 2, 59) });
    const owner = new AgentMemoryOwner(root, { load: async () => config, save: async () => {} }, new Models(root));
    const storage = new MemoryStorage(root, { agentDir: root });
    try {
      await owner.execute("maintain");
      await owner.execute("maintain");
      const status = await storage.readMaintenanceStatus();
      assert.equal(status.sleepRuns?.length ?? 0, gate === "enabled" ? 1 : 0);
      if (gate === "enabled") assert.equal(status.sleepRuns?.[0]?.status, "completed");
    } finally { await owner.close(); storage.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("embedding maintenance retries with backoff and resets it when the pending fact set changes", { timeout: 10_000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-owner-retry-"));
  const config = structuredClone(defaultConfig);
  config.context.memory.sleepEnabled = false;
  const local = new Models(root);
  local.failures = 2;
  const owner = new AgentMemoryOwner(root, { load: async () => config, save: async () => {} }, local);
  const storage = new MemoryStorage(root, { agentDir: root });
  context.mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    await storage.writeEntry({ content: "first durable fact" });
    await owner.execute("maintain");
    assert.equal(local.attempts, 1);
    context.mock.timers.setTime(59_999);
    await owner.execute("maintain");
    assert.equal(local.attempts, 1);
    context.mock.timers.setTime(60_000);
    await owner.execute("maintain");
    assert.equal(local.attempts, 2);
    context.mock.timers.setTime(179_999);
    await owner.execute("maintain");
    assert.equal(local.attempts, 2);
    await storage.writeEntry({ content: "second durable fact" });
    await owner.execute("maintain");
    assert.equal(local.attempts, 3);
    await owner.execute("maintain");
    assert.equal(local.attempts, 3);
  } finally { await owner.close(); storage.close(); await rm(root, { recursive: true, force: true }); }
});

test("owner shutdown prevents dispatch after delayed configuration preparation", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-owner-preparation-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = new AgentMemoryOwner(root, { load: async () => {
    entered.resolve(); await release.promise; return structuredClone(defaultConfig);
  }, save: async () => {} }, new Models(root));
  const pending = assert.rejects(owner.execute("sleep.run"), /closed/i);
  await entered.promise;
  const closing = owner.close();
  release.resolve();
  await closing;
  await pending;
  const storage = new MemoryStorage(root, { agentDir: root });
  try { assert.equal((await storage.readMaintenanceStatus()).sleepRuns?.length ?? 0, 0); }
  finally { storage.close(); await rm(root, { recursive: true, force: true }); }
});
